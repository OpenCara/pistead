import {
  accessLabels, AUTO_MERGE_WARNING, autoApproveWarning, autoMergeAvailable, CONNECTOR_UPDATE_HINT, effectiveLevel, findModel, levelLabels, modelKey, offeredLevels, selectModel,
  type ChatSelection,
} from "@pistead/client";
import { useState } from "react";
import { Text } from "react-native";
import type { ConnectorInfo } from "../../../../packages/shared/src/connector";
import type { AccessMode, ThinkingLevel } from "../../../../packages/shared/src/types";
import { usePalette } from "../theme";
import { Chip, confirm, OptionSheet, styles as ui, type IconName } from "./ui";

const accessIcons: Record<AccessMode, IconName> = { read: "eye-outline", approval: "shield-checkmark-outline", auto: "warning-outline" };

/** Model, reasoning and access pickers for a chat box. Renders nothing until the host is known. */
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
  const palette = usePalette();
  const [open, setOpen] = useState<"model" | "level" | "access" | null>(null);
  if (!host) return null;
  if (!host.capabilities.chatOptions) return <Text style={[ui.small, { color: palette.muted }]}>{CONNECTOR_UPDATE_HINT}</Text>;
  const model = findModel(host, value.model);
  const levels = offeredLevels(model);
  const level = effectiveLevel(model, value.thinkingLevel);
  const close = () => setOpen(null);

  async function selectAccess(access: AccessMode) {
    if (access === "auto" && value.access !== "auto" && !await confirm({
      title: "Auto-approve commands?",
      message: autoApproveWarning(host!, unsandboxed),
      confirmLabel: "Enable auto-approve",
      destructive: true,
    })) return;
    // Leaving Auto-approve also turns Auto-merge off, so it is chosen afresh with it.
    onChange({ ...value, access, ...(access === "auto" ? {} : { autoMerge: false }) });
  }

  async function toggleAutoMerge() {
    if (!value.autoMerge && !await confirm({
      title: "Auto-merge pull requests?", message: AUTO_MERGE_WARNING, confirmLabel: "Enable auto-merge", destructive: true,
    })) return;
    onChange({ ...value, autoMerge: !value.autoMerge });
  }

  const modes: AccessMode[] = owner ? ["read", "approval", "auto"] : ["read", "approval"];
  return <>
    <Chip testID="chat-model" icon="hardware-chip-outline" label={model?.name ?? "Model"} disabled={!host.models.length} onPress={() => setOpen("model")} />
    {levels.length > 0 && <Chip testID="chat-reasoning" icon="bulb-outline" label={level && levels.includes(level) ? levelLabels[level] : "Default"} onPress={() => setOpen("level")} />}
    {showAccess && <Chip testID="chat-access" icon={accessIcons[value.access]} tone={value.access === "auto" ? "danger" : undefined} label={accessLabels[value.access].label} onPress={() => setOpen("access")} />}
    {showAccess && autoMergeAvailable(host, value, owner) && <Chip testID="chat-auto-merge" icon="git-merge-outline" tone={value.autoMerge ? "danger" : undefined}
      label={value.autoMerge ? "Auto-merge on" : "Auto-merge off"} onPress={() => void toggleAutoMerge()} />}
    <OptionSheet<string> visible={open === "model"} title="Model" onClose={close}
      value={value.model && model ? modelKey(value.model) : undefined}
      options={host.models.map(item => ({ value: modelKey(item), label: item.name, hint: item.provider }))}
      onSelect={key => {
        const next = host.models.find(item => modelKey(item) === key);
        if (next) onChange(selectModel(value, next));
      }} />
    <OptionSheet<ThinkingLevel> visible={open === "level"} title="Reasoning" onClose={close} value={level}
      options={levels.map(item => ({ value: item, label: levelLabels[item] }))}
      onSelect={thinkingLevel => onChange({ ...value, thinkingLevel })} />
    <OptionSheet<AccessMode> visible={open === "access"} title="Access" onClose={close} value={value.access}
      options={modes.map(mode => ({ value: mode, label: accessLabels[mode].label, hint: accessLabels[mode].hint, destructive: mode === "auto" }))}
      onSelect={access => void selectAccess(access)} />
  </>;
}
