import { useCallback, useEffect, useRef, useState } from "react";
import type { ConnectorInfo } from "../../../packages/shared/src/connector";
import { api, errorMessage } from "./api";
import { Alert, Collapsible, StatusBadge, type Tone } from "./ui";

export interface ConnectionsResource {
  data: { connectors: ConnectorInfo[] } | null;
  loading: boolean;
  error: string;
  refresh: () => void;
}

/** Polls a connector listing every 10 seconds while the tab is visible. */
export function useConnections(path: string | null): ConnectionsResource {
  const [data, setData] = useState<{ connectors: ConnectorInfo[] } | null>(null);
  const [loading, setLoading] = useState(Boolean(path));
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const previousPath = useRef<string | null | undefined>(undefined);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    let pending = false;
    if (previousPath.current !== path) {
      previousPath.current = path;
      setData(null);
      setLoading(Boolean(path));
    }
    setError("");
    if (!path) return () => controller.abort();
    async function load() {
      if (pending) return;
      pending = true;
      try {
        const result = await api<{ connectors: ConnectorInfo[] }>(path!, { signal: controller.signal });
        if (!controller.signal.aborted) { setData(result); setError(""); }
      } catch (reason) {
        // A failed poll keeps the hosts last seen: without them a chat box would send its message without the
        // chosen access, which then runs as "Ask before acting".
        if (!controller.signal.aborted) setError(errorMessage(reason));
      } finally {
        pending = false;
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    const timer = window.setInterval(() => { if (!document.hidden) void load(); }, 10000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [path, revision]);
  return { data, loading, error, refresh };
}

type HostState = "Revoked" | "Offline" | "Unsandboxed" | "Sandbox unverified" | "Online";

export function hostState(connector: ConnectorInfo): HostState {
  return connector.revokedAt ? "Revoked" : !connector.online ? "Offline" : connector.capabilities.unsandboxed ? "Unsandboxed" : !connector.capabilities.sandbox ? "Sandbox unverified" : "Online";
}

export function hostTone(connector: ConnectorInfo): Tone {
  const state = hostState(connector);
  return state === "Online" ? "success" : state === "Unsandboxed" ? "danger" : "warning";
}

export function ConnectionStatus({ connector }: { connector: ConnectorInfo }) {
  const state = hostState(connector);
  return <StatusBadge tone={hostTone(connector)} dot={state === "Online"}>{state}</StatusBadge>;
}

export function HostCapabilities({ connector }: { connector: ConnectorInfo }) {
  const { capabilities } = connector;
  return <>
    {capabilities.unsandboxed && <Alert variant="error" role="note" title="Unsandboxed host">Agent work runs directly on the owner's machine without isolation: approved commands and commits run as their user, with access to their files, credentials and network, and no resource limits. File tools are confined to the session folder by path checks only.</Alert>}
    <Collapsible plain title="Host details" hint={capabilities.platform || "Unknown platform"}>
      <div className="stack small muted">
        <span>Platform: {capabilities.platform || "Unknown"}.{!connector.online && " Offline: it must reconnect before work can run."}</span>
        <span>Sandbox: {capabilities.unsandboxed ? "disabled by the host owner." : !capabilities.sandbox ? "unverified (not necessarily unavailable); the runner checks isolation when preparing each session." : "reported by the host; not a security attestation."} Production shell limits: {capabilities.productionShell ? "reported; still verified per session." : "not confirmed."}</span>
        {capabilities.gitCredentials && <span>Git credentials: offered by the host owner for pushes in their own sessions, where a workspace's push access uses the host's Git credentials.</span>}
        {capabilities.repositoryCache && <span>Repository cache: this host fetches repositories into its own cache with the host owner's Git credentials, after Pistead confirms that the session's owner can read them with their own account.</span>}
        <span>The runner verifies prerequisites for every session and stops work that fails. Production shell needs verified CPU, memory, process and storage limits. Without them, only the host's owner can let a command run unlimited, in their own sessions and still inside the sandbox.</span>
        <span>Native Windows is unsupported: use Linux or WSL2 with Pi configured there, or macOS without isolation.</span>
      </div>
    </Collapsible>
  </>;
}
