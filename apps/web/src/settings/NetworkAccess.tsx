import { useEffect, useState } from "react";
import type { Workspace } from "../../../../packages/shared/src/types";
import { networkLimits, type NetworkMode, type NetworkPolicy } from "../../../../packages/shared/src/network";
import { api, segment } from "../api";
import { Button, CardBody, Feedback, Field, ResourceState, Row, Section, SegmentedControl, StatusBadge, useAction, useResource } from "../ui";

interface NetworkPolicyResponse {
  policy: NetworkPolicy; packageRegistryDomains: string[];
  /** The server's search provider for web_search; null (or absent, from an older server) when it has none. */
  webSearchProvider?: string | null;
}

const providerLabel: Record<string, string> = { brave: "Brave Search", tavily: "Tavily", searxng: "SearXNG" };

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
  const [webSearch, setWebSearch] = useState(false);
  const saved = resource.data?.policy;
  useEffect(() => {
    if (!saved) return;
    setMode(saved.mode);
    setDomains(saved.domains.join("\n"));
    setRegistries(saved.packageRegistries);
    setWebSearch(saved.webSearch === true);
  }, [saved]);
  const list = domains.split(/[\s,]+/).map(domain => domain.trim().toLowerCase()).filter(Boolean);
  const changed = !!saved && (mode !== saved.mode || registries !== saved.packageRegistries || webSearch !== (saved.webSearch === true)
    || list.join("\n") !== saved.domains.join("\n"));
  const provider = resource.data?.webSearchProvider;
  function save() {
    if (!admin || action.busy) return;
    void action.run(async () => {
      await api(path, { method: "PUT", body: { mode, domains: list, packageRegistries: registries, webSearch } });
      resource.refresh();
    }, "Network access saved. Running sessions pick it up within a minute.");
  }
  return <Section title="Network access" info={<div className="stack">
    {!admin && <p>Only workspace owners and admins can change network access.</p>}
    <p>Sandboxed shell commands have no direct network. Everything goes through the host's egress proxy: Git reads of this workspace's repositories always work, with the session owner's own account, which never leaves Pistead.</p>
    <p>This setting decides what else is reachable over HTTPS. Addresses inside the host's own networks are never reachable. Hosts running without the sandbox aren't confined by it.</p>
    <p>The agent's <code>web_fetch</code> tool reads web pages from the host as far as this reaches, on every host. <code>web_search</code> searches with the server's search provider, only where web search is on: each query leaves for that provider.</p>
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
        <Row title="Web search" hint={provider
          ? `Agents search the web with web_search, through ${providerLabel[provider] ?? provider}. Their queries go to it.`
          : "This server has no search provider: its operator sets one with WEB_SEARCH."} trailing={admin
          ? <label className="check-row small"><input type="checkbox" className="checkbox" checked={webSearch} disabled={!provider && !webSearch}
            onChange={event => setWebSearch(event.target.checked)} /><span>Allow web search</span></label>
          : <StatusBadge tone={saved.webSearch && provider ? "success" : "neutral"}>{saved.webSearch && provider ? "On" : "Off"}</StatusBadge>} />
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
