import type { ConnectorInfo, LocalModelSummary } from "../../../packages/shared/src/connector";
import { thinkingLevels, type AccessMode, type ChatOptions, type SessionView, type ThinkingLevel } from "../../../packages/shared/src/types";
import { Icon, type IconName } from "./icons";
import { Combobox, confirmDialog, DropdownMenu, type MenuItem } from "./ui";
import "./chat-options.css";

/** What the user picked in the chat box. Unset model/reasoning means "the conversation's current one". */
export interface ChatSelection {
  model?: { provider: string; modelId: string };
  thinkingLevel?: ThinkingLevel;
  access: AccessMode;
}

const levelLabels: Record<ThinkingLevel, string> = {
  off: "Off", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max",
};

const accessInfo: Record<AccessMode, { label: string; icon: IconName; hint: string }> = {
  read: { label: "Read only", icon: "eye", hint: "Inspect files; edits, commands and commits ask the session owner first" },
  approval: { label: "Ask before acting", icon: "shield", hint: "Edits are automatic; commands, commits and GitHub comments need approval" },
  auto: { label: "Auto-approve", icon: "alert", hint: "Commands and commits run immediately as the owner" },
};

export const CONNECTOR_UPDATE_HINT = "Update the host's connector (npx pistead@latest connect) to choose model, reasoning and access";

const modelKey = (model: { provider: string; modelId: string }) => `${model.provider}\n${model.modelId}`;

function findModel(host: ConnectorInfo | undefined, model: ChatSelection["model"]): LocalModelSummary | undefined {
  return model && host?.models.find(item => item.provider === model.provider && item.modelId === model.modelId);
}

/** Reasoning levels worth offering: none when the model advertises nothing beyond "off". */
function offeredLevels(model: LocalModelSummary | undefined): ThinkingLevel[] {
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

/** Model, reasoning and access pickers for a chat box toolbar. Renders nothing until the host is known. */
export function ChatOptionsBar({ host, value, onChange, owner, showAccess, unsandboxed }: {
  host: ConnectorInfo | undefined;
  value: ChatSelection;
  onChange: (value: ChatSelection) => void;
  /** Session owner: may choose auto-approve. */
  owner: boolean;
  /** Access applies to the shared conversation only, not side asks. */
  showAccess: boolean;
  unsandboxed: boolean;
}) {
  if (!host) return null;
  if (!host.capabilities.chatOptions) return <span className="chat-options-hint truncate" title={CONNECTOR_UPDATE_HINT}>{CONNECTOR_UPDATE_HINT}</span>;
  const model = findModel(host, value.model);
  const levels = offeredLevels(model);
  const level = effectiveLevel(model, value.thinkingLevel);

  function selectModel(key: string) {
    const next = host!.models.find(item => modelKey(item) === key);
    if (!next) return;
    // A model brings its own level on this host's Pi; older connectors don't report one, so keep the current level.
    onChange({ ...value, model: { provider: next.provider, modelId: next.modelId }, thinkingLevel: next.thinkingLevel ?? clampLevel(next.thinkingLevels, value.thinkingLevel) });
  }

  async function selectAccess(access: AccessMode) {
    if (access === "auto" && value.access !== "auto" && !await confirmDialog({
      title: "Auto-approve commands?",
      message: unsandboxed
        ? `Commands the agent writes will run immediately on ${host!.name}, an UNSANDBOXED host: directly on the owner's machine with their full user permissions and network access, and no resource limits. GitHub comments still need approval.`
        : "Commands and commits the agent writes will run immediately as you, without asking. GitHub comments still need approval.",
      confirmLabel: "Enable auto-approve",
      destructive: true,
    })) return;
    onChange({ ...value, access });
  }

  const modes: AccessMode[] = owner ? ["read", "approval", "auto"] : ["read", "approval"];
  const accessItems: MenuItem[] = modes.map(mode => ({
    label: accessInfo[mode].label, icon: accessInfo[mode].icon, hint: accessInfo[mode].hint, destructive: mode === "auto",
    onSelect: () => void selectAccess(mode),
  }));
  const current = accessInfo[value.access];

  return <>
    <Combobox<string> label="Model" side="above" placeholder="Model" disabled={!host.models.length} value={value.model && model ? modelKey(value.model) : ""}
      options={host.models.map(item => ({ value: modelKey(item), label: item.name, hint: item.provider }))} onChange={selectModel} />
    {levels.length > 0 && <Combobox<ThinkingLevel> label="Reasoning" side="above" placeholder="Default" value={level && levels.includes(level) ? level : ""}
      options={levels.map(item => ({ value: item, label: levelLabels[item] }))} onChange={thinkingLevel => onChange({ ...value, thinkingLevel })} />}
    {showAccess && <span className={value.access === "auto" ? "chat-access auto" : "chat-access"} title={`Access: ${current.label}`}>
      <DropdownMenu label="Access" align="end" side="above" items={accessItems} trigger={<><Icon name={current.icon} size={14} /><span className="truncate">{current.label}</span></>} />
    </span>}
  </>;
}
