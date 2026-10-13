import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import type { ModelDefinition } from "../../../packages/shared/src/types.js";
import { RunnerError } from "./protocol.js";

export function runnerModels(model: ModelDefinition, allowFaux: boolean) {
  const models = createModels();
  if (model.provider === "openai") models.setProvider(openaiProvider());
  else if (model.provider === "anthropic") models.setProvider(anthropicProvider());
  else if (model.provider === "faux") {
    if (!allowFaux) throw new RunnerError(403, "The deterministic faux test provider is disabled");
    const faux = fauxProvider({ models: [{ id: model.modelId, name: "Deterministic test provider (not an LLM)" }] });
    const respond: FauxResponseFactory = async (context) => {
      // The same stateless script handles every turn, including recovered/forked turns.
      faux.appendResponses([respond]);
      const latest = context.messages.findLast(message => message.role !== "system");
      if (latest?.role === "toolResult") {
        // An image is named by its type and digest, so tests can tell which bytes the model received.
        const text = latest.content.map(part => part.type === "text" ? part.text
          : `image ${part.mimeType} sha256:${createHash("sha256").update(Buffer.from(part.data, "base64")).digest("hex")}`).join("\n");
        return fauxAssistantMessage(`Deterministic test provider result:\n${text}`);
      }
      const lastUser = context.messages.findLast(message => message.role === "user");
      const prompt = lastUser?.role === "user" ? (typeof lastUser.content === "string" ? lastUser.content : lastUser.content.filter(part => part.type === "text").map(part => part.text).join("\n")) : "";
      let tool: string | undefined;
      let args: Record<string, string> = {};
      if (prompt === "TEST_IDENTITY") tool = "identity";
      else if (/^TEST_READ [^\r\n]+$/.test(prompt)) { tool = "read_file"; args = { path: prompt.slice(10) }; }
      else if (/^TEST_WRITE [^\r\n]+\n[\s\S]*$/.test(prompt)) {
        const newline = prompt.indexOf("\n");
        tool = "write_file";
        args = { path: prompt.slice(11, newline), content: prompt.slice(newline + 1) };
      } else if (/^TEST_BASH [^\r\n]+$/.test(prompt)) { tool = "bash"; args = { command: prompt.slice(10) }; }
      else if (/^TEST_COMMIT [^\r\n]+$/.test(prompt)) { tool = "git_commit"; args = { message: prompt.slice(12) }; }
      else if (/^TEST_HOLD (?:0|[1-9][0-9]{0,3})$/.test(prompt)) {
        const delay = Number(prompt.slice(10));
        if (delay <= 5000) {
          await sleep(delay);
          return fauxAssistantMessage(`Deterministic test provider held for ${delay}ms.`);
        }
      }
      if (!tool) return fauxAssistantMessage("Deterministic test provider only accepts TEST_IDENTITY, TEST_READ <path>, TEST_WRITE <path>\\n<content>, TEST_BASH <command>, TEST_COMMIT <message>, and TEST_HOLD <0..5000>. This is not an LLM.");
      const available = new Set<string>();
      for (const message of context.messages) {
        if (message.role !== "system") continue;
        for (const removed of message.toolsRemoved ?? []) available.delete(removed.name);
        for (const added of message.toolsAdded ?? []) available.add(added.name);
      }
      if (!available.has(tool)) return fauxAssistantMessage(`Denied: ${tool} is not available in this read-only conversation or agent definition.`);
      return fauxAssistantMessage(fauxToolCall(tool, args), { stopReason: "toolUse" });
    };
    faux.setResponses([respond]);
    models.setProvider(faux.provider);
  }
  else throw new RunnerError(400, "Unsupported legacy model provider; use a configured local Pi connector");
  return models;
}
