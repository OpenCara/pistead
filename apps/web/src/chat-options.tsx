import type { ConnectorInfo } from "../../../packages/shared/src/connector";
import type { AccessMode, ThinkingLevel } from "../../../packages/shared/src/types";
import {
  accessLabels, autoApproveWarning, chatPreference, CONNECTOR_UPDATE_HINT, effectiveLevel, findModel, levelLabels, modelKey, offeredLevels,
  parseChatPreference, selectModel as pickModel, type ChatPreference, type ChatSelection,
} from "../../../packages/client/src/chat-options";
import { Icon, type IconName } from "./icons";
import { Combobox, confirmDialog, DropdownMenu, type MenuItem } from "./ui";
import "./chat-options.css";

export { accessUnavailable, chatOptionsBody, initialSelection, preferredSelection, type ChatPreference, type ChatSelection } from "../../../packages/client/src/chat-options";

/** The model and reasoning last chatted with, in this browser; new chats start from them. */
const LAST_CHAT_KEY = "pistead.lastChat";

export function readChatPreference(): ChatPreference | undefined {
  try { return parseChatPreference(localStorage.getItem(LAST_CHAT_KEY)); } catch { return undefined; }
}

/** Remembers the model and reasoning a message just went to `host` with. */
export function rememberChat(host: ConnectorInfo | undefined, selection: ChatSelection) {
  const preference = chatPreference(host, selection);
  if (!preference) return;
  try { localStorage.setItem(LAST_CHAT_KEY, JSON.stringify(preference)); } catch { /* Private mode: the choice is simply not remembered. */ }
}

const accessIcons: Record<AccessMode, IconName> = { read: "eye", approval: "shield", auto: "alert" };

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
    if (next) onChange(pickModel(value, next));
  }

  async function selectAccess(access: AccessMode) {
    if (access === "auto" && value.access !== "auto" && !await confirmDialog({
      title: "Auto-approve commands?",
      message: autoApproveWarning(host!, unsandboxed),
      confirmLabel: "Enable auto-approve",
      destructive: true,
    })) return;
    onChange({ ...value, access });
  }

  const modes: AccessMode[] = owner ? ["read", "approval", "auto"] : ["read", "approval"];
  const accessItems: MenuItem[] = modes.map(mode => ({
    label: accessLabels[mode].label, icon: accessIcons[mode], hint: accessLabels[mode].hint, destructive: mode === "auto",
    onSelect: () => void selectAccess(mode),
  }));
  const current = accessLabels[value.access];

  return <>
    <Combobox<string> label="Model" side="above" placeholder="Model" disabled={!host.models.length} value={value.model && model ? modelKey(value.model) : ""}
      options={host.models.map(item => ({ value: modelKey(item), label: item.name, hint: item.provider }))} onChange={selectModel} />
    {levels.length > 0 && <Combobox<ThinkingLevel> label="Reasoning" side="above" placeholder="Default" value={level && levels.includes(level) ? level : ""}
      options={levels.map(item => ({ value: item, label: levelLabels[item] }))} onChange={thinkingLevel => onChange({ ...value, thinkingLevel })} />}
    {showAccess && <span className={value.access === "auto" ? "chat-access auto" : "chat-access"} title={`Access: ${current.label}`}>
      <DropdownMenu label="Access" align="end" side="above" items={accessItems} trigger={<><Icon name={accessIcons[value.access]} size={14} /><span className="truncate">{current.label}</span></>} />
    </span>}
  </>;
}
