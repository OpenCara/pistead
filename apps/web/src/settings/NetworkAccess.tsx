import { useEffect, useState } from "react";
import type { Workspace } from "../../../../packages/shared/src/types";
import { networkLimits, type NetworkMode, type NetworkPolicy } from "../../../../packages/shared/src/network";
import { api, segment } from "../api";
import { Button, CardBody, Feedback, Field, ResourceState, Row, Section, SegmentedControl, StatusBadge, useAction, useResource } from "../ui";

interface NetworkPolicyResponse { policy: NetworkPolicy; packageRegistryDomains: string[] }

const modeLabel: Record<NetworkMode, string> = { off: "Off", allowlist: "Allowlist", open: "Open" };
const modeHint: Record<NetworkMode, string> = {
  off: "Sandboxed commands reach only this workspace's repositories",
  allowlist: "The workspace's repositories, plus the domains below",
  open: "The workspace's repositories, plus any public host",
};

/** What sandboxed sessions may reach through their host's egress proxy, besides the workspace's repositories. */
export function NetworkAccess({ workspace, admin }: { workspace: Workspace; admin: boolean }) {
  const path = `/api/workspaces/${segment(workspace.id)}/network-policy`;
  const resource = useResource<NetworkPolicyResponse>(path);
  const action = useAction();
  const [mode, setMode] = useState<NetworkMode>("off");
  const [domains, setDomains] = useState("");
  const [registries, setRegistries] = useState(true);
  const saved = resource.data?.policy;
  useEffect(() => {
    if (!saved) return;
    setMode(saved.mode);
    setDomains(saved.domains.join("\n"));
    setRegistries(saved.packageRegistries);
  }, [saved]);
  const list = domains.split(/[\s,]+/).map(domain => domain.trim().toLowerCase()).filter(Boolean);
  const changed = !!saved && (mode !== saved.mode || registries !== saved.packageRegistries || list.join("\n") !== saved.domains.join("\n"));
  function save() {
    if (!admin || action.busy) return;
    void action.run(async () => {
      await api(path, { method: "PUT", body: { mode, domains: list, packageRegistries: registries } });
      resource.refresh();
    }, "Network access saved. Running sessions pick it up within a minute.");
  }
  return <Section title="Network access" info={<div className="stack">
    {!admin && <p>Only workspace owners and admins can change network access.</p>}
    <p>Sandboxed shell commands have no direct network. Everything goes through the host's egress proxy: Git reads of this workspace's repositories always work, with the session owner's own account, which never leaves Pistead.</p>
    <p>This setting decides what else is reachable over HTTPS. Addresses inside the host's own networks are never reachable. Hosts running without the sandbox aren't confined by it.</p>
  </div>}>
    <ResourceState loading={resource.loading} error={resource.error} retry={resource.refresh}>
      {saved && <>
        <Row title="Access" hint={modeHint[mode]} trailing={admin
          ? <SegmentedControl label="Network access" value={mode} onChange={setMode} options={(["off", "allowlist", "open"] as const).map(value => ({ value, label: modeLabel[value] }))} />
          : <StatusBadge tone={saved.mode === "off" ? "neutral" : "success"}>{modeLabel[saved.mode]}</StatusBadge>} />
        {mode === "allowlist" && <CardBody>
          <div className="stack">
            <Field label="Allowed domains" hint={`One per line, up to ${networkLimits.domains}. *.example.com allows its subdomains.`}>
              <textarea className="textarea mono" rows={4} disabled={!admin} value={domains} onChange={event => setDomains(event.target.value)} autoComplete="off" spellCheck={false} placeholder="docs.example.com" />
            </Field>
            <label className="check-row small" title={resource.data!.packageRegistryDomains.join(", ")}><input type="checkbox" className="checkbox" checked={registries} disabled={!admin} onChange={event => setRegistries(event.target.checked)} /><span>Allow package registries (npm, PyPI, crates.io, Go, RubyGems, Maven, NuGet, Packagist)</span></label>
          </div>
        </CardBody>}
        {admin && (changed || action.error || action.notice) && <CardBody>
          <div className="stack">
            <Feedback {...action} />
            {changed && <div><Button variant="default" size="sm" disabled={action.busy} onClick={save}>Save network access</Button></div>}
          </div>
        </CardBody>}
      </>}
    </ResourceState>
  </Section>;
}
