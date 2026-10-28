import type { SessionRecord } from "../../../packages/shared/src/types";
import type { CrossSessionMessage, CrossSessionSummary, SessionConnections } from "../../../packages/shared/src/cross-session";
import { segment } from "./api";
import { Icon } from "./icons";
import { Username } from "./people";
import { href } from "./router";
import { RelativeTime, ResourceState, Row, Section, StatusBadge, useResource, type Tone } from "./ui";

const kindLabel: Record<CrossSessionMessage["kind"], string> = { ask: "Side ask", send: "Message", create: "Opening message", notify: "Notification" };
const notifyLabel: Record<NonNullable<CrossSessionMessage["notify"]>, { label: string; tone: Tone }> = {
  pending: { label: "Will notify", tone: "info" }, delivered: { label: "Notified", tone: "success" },
  failed: { label: "Notification failed", tone: "danger" }, expired: { label: "Notification expired", tone: "neutral" },
};

function SessionRow({ session, relation }: { session: CrossSessionSummary; relation: string }) {
  return <Row href={href({ name: "session", sessionId: session.id })} chevron leading={<Icon name="link" size={16} />}
    title={<span className="truncate">{session.title}</span>} hint={<>{relation} · {session.status === "archived" ? "Archived" : session.activity ?? session.status}</>} />;
}

/**
 * The sessions this one is linked with through the sessions tool: the session that started it, those it started, and
 * the messages either way. The control plane records each one, so this, unlike a message's own first line, shows who
 * really sent what. Only sessions the viewer can open are named.
 */
export function ConnectionsSection({ session }: { session: SessionRecord }) {
  const connections = useResource<SessionConnections>(`/api/sessions/${segment(session.id)}/connections`);
  const data = connections.data;
  if (data && !data.parent && !data.children.length && !data.messages.length) return null;
  return <Section title="Connected sessions" info={<div className="stack">
    <p>Agents work with other sessions through the sessions tool, always as the person whose message they work on, with that person's own permissions there.</p>
    <p>Messages they send name this session and their sender in their first line; Pistead also records each one here. Approvals in another session are decided only by people there.</p>
  </div>}>
    <ResourceState loading={connections.loading} error={connections.error} retry={connections.refresh}>
      {data && <>
        {data.parent && <SessionRow session={data.parent} relation="Started this session" />}
        {data.children.map(child => <SessionRow key={child.id} session={child} relation="Started by this session" />)}
        {data.messages.map(message => {
          const outgoing = message.originSessionId === session.id;
          const other = outgoing ? message.targetSessionId : message.originSessionId;
          const notify = message.notify && notifyLabel[message.notify];
          return <Row key={message.id} href={href({ name: "session", sessionId: other })} leading={<Icon name={outgoing ? "send" : "message"} size={16} />}
            title={<span className="truncate">{kindLabel[message.kind]} {outgoing ? "to" : "from"} {message.otherTitle}</span>}
            hint={<>By <Username id={message.actorId} you /> · hop {message.hops} · <RelativeTime value={message.createdAt} /></>}
            trailing={notify && <StatusBadge tone={notify.tone}>{notify.label}</StatusBadge>} />;
        })}
      </>}
    </ResourceState>
  </Section>;
}
