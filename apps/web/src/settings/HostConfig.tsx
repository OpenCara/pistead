import { useEffect, useRef, useState } from "react";
import type { ConnectorInfo } from "../../../../packages/shared/src/connector";
import { defaultHostConfig, ownerOnlyHostConfig, type HostConfig, type RepositoryCacheMode } from "../../../../packages/shared/src/host-config";
import { api, segment } from "../api";
import { Button, CardBody, Combobox, confirmDialog, Feedback, Row, Section, SegmentedControl, StatusBadge, useAction } from "../ui";

/*
 * How a host runs its sessions, set here rather than with connector options: its owner and admins change the command time
 * limit and the GPU; only its owner decides whether it uses its Git credentials or keeps a repository cache.
 */

/** The time limits offered; the API takes any whole number of seconds from 30 to 3600. */
const timeouts = [30, 60, 120, 300, 600, 1800, 3600];

function duration(seconds: number): string {
  if (seconds % 3600 === 0) return seconds === 3600 ? "1 hour" : `${seconds / 3600} hours`;
  if (seconds % 60 === 0) return seconds === 60 ? "1 minute" : `${seconds / 60} minutes`;
  return `${seconds} seconds`;
}

/** The settings this form changes; compaction has its own section (HostCompaction). */
const settings = (Object.keys(defaultHostConfig) as (keyof HostConfig)[]).filter(key => key !== "compaction");

const cacheLabels: Record<RepositoryCacheMode, string> = { off: "Off", host: "Shared", owner: "Per owner" };
const cacheHints: Record<RepositoryCacheMode, string> = {
  off: "Each session downloads its clones itself",
  host: "One mirror of each repository, which every session's clones borrow from",
  owner: "A separate mirror of each repository for each session owner",
};

const configInfo = <div className="stack">
  <p>How this host runs sessions. Its owner and admins change the command time limit and the GPU; only its owner decides whether it uses its Git credentials, keeps a repository cache or runs their sessions without the sandbox.</p>
  <p>Running sessions pick up a change within a minute. A repository cache change applies when the host's connector next connects.</p>
  <p>A longer time limit also lifts the per-process limits of short commands (25 seconds of CPU, 64 MiB files, 256 open files) so builds fit. Without provisioned resource limits on the host (connect --resources), a command can use the whole machine for that long.</p>
</div>;

export function HostConfigSection({ connector, refresh }: { connector: ConnectorInfo; refresh: () => void }) {
  const owner = connector.role !== "admin";
  const saved = connector.config ?? defaultHostConfig;
  const [config, setConfig] = useState<HostConfig>(saved);
  const shown = useRef<HostConfig>(saved);
  const action = useAction();
  // Status refreshes every few seconds: a setting saved meanwhile, by anyone, replaces only its own edit.
  useEffect(() => {
    const before = shown.current;
    shown.current = saved;
    const replaced = settings.filter(key => saved[key] !== before[key]);
    if (replaced.length) setConfig(current => ({ ...current, ...Object.fromEntries(replaced.map(key => [key, saved[key]])) }));
  }, [saved.commandTimeoutSeconds, saved.gpu, saved.gitCredentials, saved.repositoryCache, saved.hostSessions]);
  // A save sends only these, so it never undoes a change someone else saved meanwhile; an admin's never names the owner's.
  const changes = settings.filter(key => config[key] !== saved[key] && (owner || !ownerOnlyHostConfig.includes(key)));
  const changed = changes.length > 0;
  const editable = !connector.revokedAt && !action.busy;
  const { unsandboxed, gpu } = connector.capabilities;
  const choices = [...new Set([...timeouts, saved.commandTimeoutSeconds])].sort((a, b) => a - b);

  function save() {
    void (async () => {
      // What lends the owner's credentials, or the machine's GPU, asks before it is turned on.
      if (config.gitCredentials && !saved.gitCredentials && !await confirmDialog({
        title: "Use this host's Git credentials?",
        message: `Pushes in your own sessions on ${connector.name} will use the credentials Git on that machine would use (its credential helpers), wherever a workspace's push access chooses the host's Git credentials. Other members' sessions never use them.`,
        confirmLabel: "Turn on", destructive: true,
      })) return;
      if (config.repositoryCache !== "off" && saved.repositoryCache === "off" && !await confirmDialog({
        title: "Keep a repository cache on this host?",
        message: `${connector.name} will keep a full mirror of each repository its sessions clone, in its state directory, and their clones will borrow objects from it. It fills the mirrors straight from the repositories' hosts with the credentials Git on that machine would use (its credential helpers), and a session borrows from one only once Pistead confirms that the session's owner can read the repository with their own account.`,
        confirmLabel: "Keep a cache",
      })) return;
      if (config.hostSessions && !saved.hostSessions && !await confirmDialog({
        title: "Let your sessions run directly on this host?",
        message: `When you start a session on ${connector.name}, you'll be able to run it without the sandbox. Its commands then run as that machine's user, with its files, credentials, network and GPU, and no resource limits, and only you, or members you granted host commands, decide them. Other members' sessions stay in the sandbox, and so do yours unless you choose otherwise when you start one.`,
        confirmLabel: "Allow", destructive: true,
      })) return;
      if (config.gpu && !saved.gpu && !await confirmDialog({
        title: "Lend this host's GPU to sandboxed commands?",
        message: `Shell commands in every session on ${connector.name} will be able to use its GPU for rendering and compute. They get its render device only, never the screen, windows or input, but its driver is more of the kernel exposed to them, and they share the GPU with everything else on the machine.`,
        confirmLabel: "Lend GPU", destructive: true,
      })) return;
      await action.run(async () => {
        await api(`/api/connectors/${segment(connector.id)}/config`, { method: "PATCH", body: Object.fromEntries(changes.map(key => [key, config[key]])) });
        refresh();
      }, "Configuration saved. Running sessions pick it up within a minute.");
    })();
  }

  const gpuHint = unsandboxed ? "Commands on an unsandboxed host already run on the machine itself"
    : !gpu ? "No GPU render device found on this host (WSL's /dev/dxg or Linux render nodes)"
    : `${gpu === "dxg" ? "WSL GPU (/dev/dxg)" : "Linux render nodes (/dev/dri)"}: rendering and compute, never the screen, windows or input`;
  return <Section title="Configuration" bare info={configInfo}>
    <div className="card">
      <Row title="Command time limit" hint={unsandboxed ? "How long a shell command may run before it is stopped" : "How long a shell command may run in the sandbox before it is stopped"}
        trailing={<Combobox label="Command time limit" value={String(config.commandTimeoutSeconds)} disabled={!editable}
          options={choices.map(seconds => ({ value: String(seconds), label: duration(seconds), ...(seconds === defaultHostConfig.commandTimeoutSeconds ? { hint: "Default" } : {}) }))}
          onChange={value => setConfig({ ...config, commandTimeoutSeconds: Number(value) })} />} />
      <Row title="GPU" hint={gpuHint} trailing={<label className="check-row small">
        <input type="checkbox" className="checkbox" checked={config.gpu} disabled={!editable || (!config.gpu && (!gpu || unsandboxed))}
          onChange={event => setConfig({ ...config, gpu: event.target.checked })} /><span>Lend to sandboxed commands</span>
      </label>} />
      <Row title="Git credentials" hint={owner ? "Pushes in your own sessions may use this machine's Git credential helpers, where a workspace's push access chooses the host's Git credentials" : "Only the host's owner changes this"}
        trailing={owner
          ? <label className="check-row small"><input type="checkbox" className="checkbox" checked={config.gitCredentials} disabled={!editable}
            onChange={event => setConfig({ ...config, gitCredentials: event.target.checked })} /><span>Use for my pushes</span></label>
          : <StatusBadge tone={saved.gitCredentials ? "warning" : "neutral"}>{saved.gitCredentials ? "On" : "Off"}</StatusBadge>} />
      <Row title="Repository cache" hint={owner ? `${cacheHints[config.repositoryCache]}. Applies when the host next connects.` : "Only the host's owner changes this"}
        trailing={owner && editable
          ? <SegmentedControl label="Repository cache" value={config.repositoryCache} onChange={value => setConfig({ ...config, repositoryCache: value })}
            options={(["off", "host", "owner"] as const).map(value => ({ value, label: cacheLabels[value], hint: cacheHints[value] }))} />
          : <StatusBadge tone={saved.repositoryCache === "off" ? "neutral" : "success"}>{cacheLabels[saved.repositoryCache]}</StatusBadge>} />
      <Row title="Sessions on the host" hint={unsandboxed ? "This host runs every session without the sandbox"
        : owner ? "You, and members you grant it under Host command access, may start sessions that run directly on this machine, without the sandbox, as its user. Turning it off stops their commands within half a minute" : "Only the host's owner changes this"}
        trailing={unsandboxed ? <StatusBadge tone="danger">Every session</StatusBadge>
          : owner
          ? <label className="check-row small"><input type="checkbox" className="checkbox" checked={config.hostSessions} disabled={!editable}
            onChange={event => setConfig({ ...config, hostSessions: event.target.checked })} /><span>Allow sessions on the host</span></label>
          : <StatusBadge tone={saved.hostSessions ? "danger" : "neutral"}>{saved.hostSessions ? "On" : "Off"}</StatusBadge>} />
      {!connector.capabilities.hostConfig && <Row title="Update the host's connector" hint="This host's connector predates configuration in Pistead and keeps its connect options until it is updated (npx pistead@latest connect). What you save here applies then." />}
      {(changed || action.error || action.notice) && <CardBody>
        <div className="stack">
          <Feedback {...action} />
          {changed && <div className="inline">
            <Button variant="default" size="sm" disabled={action.busy} onClick={save}>Save configuration</Button>
            <Button variant="ghost" size="sm" disabled={action.busy} onClick={() => setConfig(saved)}>Discard</Button>
          </div>}
        </div>
      </CardBody>}
    </div>
  </Section>;
}
