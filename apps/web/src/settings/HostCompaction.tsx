import { useEffect, useRef, useState } from "react";
import { modelKey } from "../../../../packages/client/src/chat-options";
import type { ConnectorInfo, LocalModelSummary } from "../../../../packages/shared/src/connector";
import { hostConfigLimits, type CompactionTokens, type HostCompaction } from "../../../../packages/shared/src/host-config";
import { api, segment } from "../api";
import { Button, CardBody, Collapsible, Feedback, Row, Section, useAction } from "../ui";

/*
 * When a host's long conversations are summarized: the compaction token counts of Pi's settings.json, set here for every
 * model and per model instead of on the machine. A count left empty keeps the host's Pi setting (or the default).
 */

type Draft = { reserveTokens: string; keepRecentTokens: string };
type Drafts = { overall: Draft; models: Record<string, Draft> };

const tokenKeys = ["reserveTokens", "keepRecentTokens"] as const;
const emptyDraft: Draft = { reserveTokens: "", keepRecentTokens: "" };

const draft = (tokens: CompactionTokens | undefined): Draft =>
  ({ reserveTokens: tokens?.reserveTokens?.toString() ?? "", keepRecentTokens: tokens?.keepRecentTokens?.toString() ?? "" });

function drafts(compaction: HostCompaction): Drafts {
  return { overall: draft(compaction), models: Object.fromEntries(Object.entries(compaction.modelOverrides ?? {}).map(([model, tokens]) => [model, draft(tokens)])) };
}

/** A count as typed: null when empty, the number when it is a whole number in bounds, undefined when it is neither. */
function count(text: string): number | null | undefined {
  const digits = text.trim().replace(/[,_\s]/g, "");
  if (!digits) return null;
  if (!/^\d{1,9}$/.test(digits)) return undefined;
  const value = Number(digits);
  return value <= hostConfigLimits.compactionTokens.max ? value : undefined;
}

function tokens(value: Draft): CompactionTokens | undefined {
  const result: CompactionTokens = {};
  for (const key of tokenKeys) {
    const parsed = count(value[key]);
    if (parsed === undefined) return undefined;
    if (parsed !== null) result[key] = parsed;
  }
  return result;
}

/** The setting the form makes, as the control plane keeps it (models sorted, none without counts); undefined while a count is invalid. */
function compactionOf(value: Drafts): HostCompaction | undefined {
  const overall = tokens(value.overall);
  if (!overall) return undefined;
  const overrides: Record<string, CompactionTokens> = {};
  for (const model of Object.keys(value.models).sort()) {
    const own = tokens(value.models[model]!);
    if (!own) return undefined;
    if (Object.keys(own).length) overrides[model] = own;
  }
  return Object.keys(overrides).length ? { ...overall, modelOverrides: overrides } : overall;
}

const byCodeUnit = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

const compactionInfo = <div className="stack">
  <p>Pi summarizes a long conversation once it comes within <em>reserve</em> tokens of the model's context window, and keeps the most recent <em>keep recent</em> tokens word for word. The summary may use up to 80% of the reserve, thinking included.</p>
  <p>Counts set here replace those of Pi's settings.json on the host (compaction.reserveTokens, compaction.keepRecentTokens and compaction.modelOverrides); an empty one keeps the host's setting, or the default. A model's own count wins over the one for all models, here or in the host's settings.</p>
  <p>By default a reasoning model reserves a tenth of its context window, from 16K to 64K tokens. If messages fail because Pi's summary hit its token limit, raise the reserve for that model.</p>
  <p>Sessions on the host use a change from their next message.</p>
</div>;

function TokenInputs({ value, onChange, disabled, label }: { value: Draft; onChange: (value: Draft) => void; disabled: boolean; label: string }) {
  return <span className="token-inputs">
    {tokenKeys.map(key => {
      const name = key === "reserveTokens" ? "Reserve" : "Keep recent";
      return <label key={key} className="token-field">
        <span className="small muted">{name}</span>
        <input className="input token-input" inputMode="numeric" autoComplete="off" spellCheck={false} placeholder="Host's Pi"
          value={value[key]} disabled={disabled} aria-label={`${name} tokens, ${label}`} aria-invalid={count(value[key]) === undefined || undefined}
          onChange={event => onChange({ ...value, [key]: event.target.value })} />
      </label>;
    })}
  </span>;
}

export function HostCompactionSection({ connector, refresh }: { connector: ConnectorInfo; refresh: () => void }) {
  const saved: HostCompaction = connector.config?.compaction ?? {};
  const savedJson = JSON.stringify(saved);
  const [value, setValue] = useState<Drafts>(() => drafts(saved));
  const shown = useRef(savedJson);
  const action = useAction();
  // Status refreshes every few seconds: a setting saved meanwhile, by anyone, replaces the form only when it changed.
  useEffect(() => {
    if (shown.current === savedJson) return;
    shown.current = savedJson;
    setValue(drafts(JSON.parse(savedJson) as HostCompaction));
  }, [savedJson]);
  const editable = Boolean(connector.role) && !connector.revokedAt && !action.busy;
  const current = compactionOf(value);
  const changed = current === undefined || JSON.stringify(current) !== savedJson;
  // The host's models, sorted by provider and model id, then the ones only a saved setting still names.
  const offered = [...connector.models, ...(connector.disabledModels ?? [])]
    .sort((a, b) => byCodeUnit(a.provider, b.provider) || byCodeUnit(a.modelId, b.modelId));
  const offeredKeys = new Set(offered.map(model => `${model.provider}/${model.modelId}`));
  const others = Object.keys(value.models).filter(model => !offeredKeys.has(model)).sort(byCodeUnit);
  const overridden = Object.keys(current?.modelOverrides ?? {}).length;

  function save() {
    if (!current) return;
    void action.run(async () => {
      await api(`/api/connectors/${segment(connector.id)}/config`, { method: "PATCH", body: { compaction: current } });
      refresh();
    }, "Compaction saved. Sessions on the host use it from their next message.");
  }

  const modelRow = (model: LocalModelSummary | string) => {
    const key = typeof model === "string" ? model : `${model.provider}/${model.modelId}`;
    return <Row key={typeof model === "string" ? model : modelKey(model)} title={typeof model === "string" ? model : model.name}
      hint={typeof model === "string" ? "Not offered by this host now" : `${model.provider} / ${model.modelId}`}
      trailing={<TokenInputs label={key} value={value.models[key] ?? emptyDraft} disabled={!editable}
        onChange={own => setValue(form => ({ ...form, models: { ...form.models, [key]: own } }))} />} />;
  };
  return <Section title="Compaction" bare info={compactionInfo}>
    <div className="card">
      <Row title="All models" hint="Tokens kept free for compaction, and recent tokens kept unsummarized. Empty keeps the host's Pi setting"
        trailing={<TokenInputs label="all models" value={value.overall} disabled={!editable} onChange={overall => setValue(form => ({ ...form, overall }))} />} />
      {offered.length + others.length > 0 && <Collapsible title="Per model"
        hint={overridden ? `${overridden} ${overridden === 1 ? "model has its" : "models have their"} own counts` : "Counts for one model, over those for all models"}>
        {offered.map(modelRow)}
        {others.map(modelRow)}
      </Collapsible>}
      {connector.capabilities.hostConfig && !connector.capabilities.compactionConfig && <Row title="Update the host's connector"
        hint="This host's connector predates compaction settings in Pistead and follows its Pi settings alone until it is updated (npx pistead@latest connect). What you save here applies then." />}
      {(changed || action.error || action.notice) && <CardBody>
        <div className="stack">
          <Feedback {...action} />
          {!current && <span className="small muted">Token counts are whole numbers from 0 to {hostConfigLimits.compactionTokens.max.toLocaleString()}.</span>}
          {changed && <div className="inline">
            <Button variant="default" size="sm" disabled={action.busy || !current} onClick={save}>Save compaction</Button>
            <Button variant="ghost" size="sm" disabled={action.busy} onClick={() => setValue(drafts(saved))}>Discard</Button>
          </div>}
        </div>
      </CardBody>}
    </div>
  </Section>;
}
