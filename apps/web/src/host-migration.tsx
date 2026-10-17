import { useMemo, useState, type FormEvent } from "react";
import type { ModelDefinition, SessionRecord, UserProfile } from "../../../packages/shared/src/types";
import { api, errorMessage, segment } from "./api";
import type { ConnectionsResource } from "./hosts";
import { Icon } from "./icons";
import { Alert, Button, confirmDialog, Feedback, Field, Loading, Row, Section, useResource } from "./ui";

type MigrationInfo = {
  id: string; status: "pending" | "completed" | "cancelled"; sourceSessionId: string; targetSessionId: string;
  sourceConnectorId: string; targetConnectorId: string;
};
type MigrationListing = { migrations: (MigrationInfo & { requestId: string; modelId: string; title: string | null; createdAt: string })[] };
type MigrationResponse = { session: SessionRecord; migration: MigrationInfo };

/**
 * Moves the session to a model on another connected host: the source host's live snapshot is restored there into a
 * successor session, and this one is archived. Both hosts must be connected when the move starts; a move that can't finish
 * is retried with the same request, which only needs the target host, or cancelled.
 */
export function MoveHostSection({ session, user, hosts, openSession, changed }: {
  session: SessionRecord; user: UserProfile; hosts: ConnectionsResource; openSession: (id: string) => void; changed: () => void;
}) {
  const models = useResource<{ models: ModelDefinition[] }>(`/api/workspaces/${segment(session.workspaceId)}/models`);
  const listing = useResource<MigrationListing>(`/api/sessions/${segment(session.id)}/migrations`);
  const [modelId, setModelId] = useState("");
  const [title, setTitle] = useState("");
  const [trusted, setTrusted] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const connectors = hosts.data?.connectors ?? [];
  const source = connectors.find(host => host.id === session.connectorId);
  // A move in flight from this session, resumed with its own request so no second successor is ever created.
  const inFlight = listing.data?.migrations.find(item => item.status === "pending" && item.sourceSessionId === session.id);
  // Models offered here by another connected host that accepts moved sessions.
  const choices = useMemo(() => (models.data?.models ?? []).flatMap(model => {
    const host = connectors.find(item => item.id === model.connectorId);
    if (!host || host.id === session.connectorId || host.revokedAt || host.capabilities.hostMigration !== true
      || !host.models.some(item => item.provider === model.provider && item.modelId === model.modelId)) return [];
    return [{ model, host }];
  }), [models.data, connectors, session.connectorId]);
  const choice = choices.find(item => item.model.id === modelId);
  const foreign = Boolean(choice && choice.host.ownerId !== user.id);
  const canMove = Boolean(choice && choice.host.online && source?.online && (!foreign || trusted === choice.host.id) && !pending);

  async function send(body: Record<string, unknown>) {
    setPending(true);
    setError("");
    try {
      const result = await api<MigrationResponse>(`/api/sessions/${segment(session.id)}/migrate`, { method: "POST", body });
      if (result.migration?.status !== "completed" || result.migration.sourceSessionId !== session.id
        || result.migration.targetSessionId !== result.session?.id) {
        throw new Error("The server did not confirm the move. Retry it to resolve its outcome.");
      }
      changed();
      openSession(result.session.id);
    } catch (reason) {
      setError(errorMessage(reason));
      listing.refresh();
    } finally {
      setPending(false);
    }
  }

  async function move(event: FormEvent) {
    event.preventDefault();
    if (!choice || !canMove) return;
    const confirmed = await confirmDialog({
      title: "Move session",
      message: `Move this session to ${choice.host.name} (${choice.model.name})? Its conversation, files and history are copied there into a new session, and this one is archived. ${foreign ? `${choice.host.name}'s owner can access prompts and files processed on it. ` : ""}Session grants aren't copied.`,
      confirmLabel: "Move session",
    });
    if (!confirmed) return;
    const newTitle = title.trim();
    await send({ requestId: crypto.randomUUID(), modelId: choice.model.id, ...(newTitle ? { title: newTitle } : {}),
      ...(foreign ? { trustedConnectorId: choice.host.id } : {}) });
  }

  async function cancel() {
    if (!inFlight) return;
    const confirmed = await confirmDialog({
      title: "Cancel move",
      message: "Cancel this move? This session accepts work again, and the unfinished copy on the other host is archived.",
      confirmLabel: "Cancel move", cancelLabel: "Keep", destructive: true,
    });
    if (!confirmed) return;
    setPending(true);
    setError("");
    try {
      await api(`/api/sessions/${segment(session.id)}/migrations/${segment(inFlight.id)}/cancel`, { method: "POST" });
      listing.refresh();
      changed();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setPending(false);
    }
  }

  return <Section title="Move to another host" info={<><p>Copies this session's conversation, files and history to a model on another connected host, then archives this session. Both hosts must be connected and the session idle. No backup storage is needed.</p><p>The new session keeps the same repositories, visibility and agent instructions, with the tools the new host can carry. Session grants and approvals given for the rest of this session aren't copied.</p></>}>
    {inFlight ? <>
      <Row leading={<Icon name="refresh" size={16} />} title="Move in progress" hint={<>To {connectors.find(host => host.id === inFlight.targetConnectorId)?.name ?? "another host"}. This session accepts only reads until the move finishes or is cancelled</>} />
      <div className="inline">
        <Button variant="secondary" size="sm" disabled={pending} onClick={() => void send({ requestId: inFlight.requestId, modelId: inFlight.modelId,
          ...(inFlight.title !== null ? { title: inFlight.title } : {}), trustedConnectorId: inFlight.targetConnectorId })}>{pending ? "Moving..." : "Retry move"}</Button>
        <Button variant="outline" size="sm" disabled={pending} onClick={() => void cancel()}>Cancel move</Button>
        {pending && <Loading>Waiting for the other host...</Loading>}
      </div>
    </> : models.loading || listing.loading ? <Row title={<Loading>Loading hosts...</Loading>} />
      : !choices.length ? <Row leading={<Icon name="info" size={16} />} title="No other host available" hint="Another connected host in this workspace, with an up-to-date connector on Linux, must offer a model here" />
      : <form className="stack" onSubmit={event => void move(event)}>
        <Field label="Model on the new host">
          <select className="input" value={modelId} disabled={pending} onChange={event => { setModelId(event.target.value); setTrusted(""); }}>
            <option value="">Choose a model...</option>
            {choices.map(({ model, host }) => <option key={model.id} value={model.id}>{host.name} · {model.name}{host.online ? "" : " (offline)"}</option>)}
          </select>
        </Field>
        <Field label="New session title" hint="Optional. Defaults to this session's title">
          <input className="input" autoComplete="off" maxLength={200} value={title} disabled={pending} onChange={event => setTitle(event.target.value)} />
        </Field>
        {choice && foreign && <label className="inline small">
          <input type="checkbox" checked={trusted === choice.host.id} onChange={event => setTrusted(event.target.checked ? choice.host.id : "")} />
          I understand that {choice.host.name}'s owner can access this session's prompts and files
        </label>}
        {choice && !choice.host.online && <Alert variant="warning" title="Host offline">{choice.host.name} must be connected to receive the session.</Alert>}
        {!source?.online && <Alert variant="warning" title="This session's host is offline">Both hosts must be connected to start a move.</Alert>}
        <div className="inline">
          <Button type="submit" variant="secondary" size="sm" disabled={!canMove}>{pending ? "Moving..." : "Move session"}</Button>
          {pending && <Loading>Copying the session to the new host...</Loading>}
        </div>
      </form>}
    <Feedback error={error || models.error || listing.error} />
  </Section>;
}
