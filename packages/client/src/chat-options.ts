import type { ConnectorInfo, LocalModelSummary } from "../../shared/src/connector";
// Declares the host command and repin capabilities on ConnectorCapabilities.
import type {} from "../../shared/src/host-operations";
import { thinkingLevels, type AccessMode, type ChatOptions, type SessionView, type ThinkingLevel } from "../../shared/src/types";

/** What the user picked in the chat box. Unset model/reasoning means "the conversation's current one". */
export interface ChatSelection {
  model?: { provider: string; modelId: string };
  thinkingLevel?: ThinkingLevel;
  access: AccessMode;
}

export const levelLabels: Record<ThinkingLevel, string> = {
  off: "Off", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max",
};

export const accessLabels: Record<AccessMode, { label: string; hint: string }> = {
  read: { label: "Read only", hint: "Inspect files; edits, commands and commits ask the session owner first" },
  approval: { label: "Ask before acting", hint: "Edits are automatic; commands, commits, GitHub comments and merges need approval" },
  auto: { label: "Auto-approve", hint: "Commands, commits and pushes run immediately as the owner, without asking" },
};

/** What turning on Auto-approve means on `host`, confirmed before it applies. */
export function autoApproveWarning(host: Pick<ConnectorInfo, "name" | "capabilities">, unsandboxed: boolean): string {
  return (unsandboxed
    ? `Commands, commits and pushes the agent writes will run immediately on ${host.name}, an UNSANDBOXED host: commands run directly on the owner's machine with their full user permissions and network access, and no resource limits. Tools outside the agent won't ask either. GitHub comments and merges still need approval.`
    : "Commands, commits and pushes the agent writes will run immediately as you, without asking, as will tools outside the agent and commands on a host without resource limits. GitHub comments and merges still need approval.")
    + (host.capabilities.hostCommands ? " On your own host, host_bash also runs OUTSIDE the sandbox without asking, with access to your host files, credentials and network. On someone else's host it still needs their approval." : "")
    + (host.capabilities.gitRepin ? " Repinning may create new private sessions without asking." : "");
}

export const CONNECTOR_UPDATE_HINT = "Update the host's connector (npx pistead@latest connect) to choose model, reasoning and access";

export const modelKey = (model: { provider: string; modelId: string }) => `${model.provider}\n${model.modelId}`;

export function findModel(host: ConnectorInfo | undefined, model: ChatSelection["model"]): LocalModelSummary | undefined {
  return model && host?.models.find(item => item.provider === model.provider && item.modelId === model.modelId);
}

/** Reasoning levels worth offering: none when the model advertises nothing beyond "off". */
export function offeredLevels(model: LocalModelSummary | undefined): ThinkingLevel[] {
  const levels = model?.thinkingLevels ?? [];
  return levels.some(level => level !== "off") ? levels : [];
}

/** Keeps the level if supported, else the highest supported level below it, else "off" or the first one. */
export function clampLevel(levels: ThinkingLevel[] | undefined, level: ThinkingLevel | undefined): ThinkingLevel | undefined {
  if (!level || !levels?.length || levels.includes(level)) return level;
  const rank = thinkingLevels.indexOf(level);
  const lower = levels.filter(item => thinkingLevels.indexOf(item) <= rank).sort((a, b) => thinkingLevels.indexOf(b) - thinkingLevels.indexOf(a))[0];
  return lower ?? (levels.includes("off") ? "off" : levels[0]);
}

/**
 * The reasoning level that applies to `model`: the picked one when the model supports it, else the level the host's Pi
 * starts that model at, else the nearest supported level. The picker shows it and the request sends it, so the two
 * always match the model.
 */
export function effectiveLevel(model: LocalModelSummary | undefined, level: ThinkingLevel | undefined): ThinkingLevel | undefined {
  const levels = model?.thinkingLevels;
  if (!model || !levels?.length) return undefined;
  if (level && levels.includes(level)) return level;
  if (model.thinkingLevel && levels.includes(model.thinkingLevel)) return model.thinkingLevel;
  return clampLevel(levels, level);
}

/** The selection after picking `next`: a model brings its own level on the host's Pi; older connectors report none, so the current level is kept. */
export function selectModel(selection: ChatSelection, next: LocalModelSummary): ChatSelection {
  return { ...selection, model: { provider: next.provider, modelId: next.modelId }, thinkingLevel: next.thinkingLevel ?? clampLevel(next.thinkingLevels, selection.thinkingLevel) };
}

/** Starting selection for an existing session: its current model, reasoning and shared-run access. */
export function initialSelection(view: SessionView, owner: boolean): ChatSelection {
  const access = view.access ?? "approval";
  return {
    model: view.agent && { provider: view.agent.provider, modelId: view.agent.modelId },
    thinkingLevel: view.agent?.thinkingLevel,
    access: access === "auto" && !owner ? "approval" : access,
  };
}

/**
 * Why a shared message can't be sent with `selection` yet, if it can't: until the host is known its options can't go
 * with the message, which would then run as "Ask before acting" instead of the access shown.
 */
export function accessUnavailable(host: ConnectorInfo | undefined, selection: ChatSelection, mode: "submit" | "ask"): string | undefined {
  if (mode !== "submit" || host || selection.access === "approval") return undefined;
  return `Still checking this session's host, so "${accessLabels[selection.access].label}" can't be applied yet. Try again in a moment.`;
}

/**
 * Request options for a selection, or undefined when the host's connector cannot apply them.
 * Only choices the host advertises are sent; access only applies to the shared conversation.
 */
export function chatOptionsBody(host: ConnectorInfo | undefined, selection: ChatSelection, mode: "submit" | "ask"): ChatOptions | undefined {
  if (!host?.capabilities.chatOptions) return undefined;
  const model = findModel(host, selection.model);
  const options: ChatOptions = {};
  if (model) options.model = { provider: model.provider, modelId: model.modelId };
  const thinkingLevel = effectiveLevel(model, selection.thinkingLevel);
  if (thinkingLevel) options.thinkingLevel = thinkingLevel;
  if (mode === "submit") options.access = selection.access;
  return options;
}
