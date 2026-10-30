import type { Workspace } from "../../../../packages/shared/src/types";
import { transcriptPage, type ToolOutput } from "../../../../packages/shared/src/transcript-display";
import { api, segment } from "../api";
import { CardBody, Feedback, ResourceState, Row, Section, StatusBadge, useAction, useResource } from "../ui";

interface TranscriptSettingsResponse { settings: { paging: boolean; toolOutput: ToolOutput } }

/** Whether the workspace's session transcripts load latest messages first, and the tool output new sessions start with. */
export function TranscriptSettings({ workspace, admin }: { workspace: Workspace; admin: boolean }) {
  const path = `/api/workspaces/${segment(workspace.id)}/transcripts`;
  const resource = useResource<TranscriptSettingsResponse>(path);
  const action = useAction();
  const settings = resource.data?.settings;
  const paging = settings?.paging;
  const full = settings ? settings.toolOutput !== "brief" : undefined;
  function savePaging(next: boolean) {
    if (!admin || action.busy || next === paging) return;
    void action.run(async () => {
      await api(path, { method: "PUT", body: { paging: next } });
      resource.refresh();
    }, next ? "Transcripts load latest messages first. Open sessions switch within a few seconds." : "Transcripts load whole again. Open sessions switch within a few seconds.");
  }
  function saveFull(next: boolean) {
    if (!admin || action.busy || next === full) return;
    void action.run(async () => {
      await api(path, { method: "PUT", body: { toolOutput: next ? "full" : "brief" } });
      resource.refresh();
    }, next ? "New sessions start with full tool output. Existing sessions keep theirs." : "New sessions start with brief tool output. Existing sessions keep theirs.");
  }
  return <Section title="Transcripts" info={<div className="stack">
    {!admin && <p>Only workspace owners and admins can change these.</p>}
    <p>With latest messages first, a session opens with the newest {transcriptPage.size} entries of each conversation, and earlier ones load as you scroll up. Long sessions open much faster this way; your browser's find on the page only searches what has loaded.</p>
    <p>Full tool output sets how new sessions here start: with every tool result in full, or with one line per tool result and long tool calls cut short. Each session's owner can still change their session's under its Details, and changing this leaves existing sessions as they are.</p>
    <p>Hosts still send Pistead whole transcripts; these change only what reaches each viewer.</p>
  </div>}>
    <ResourceState loading={resource.loading} error={resource.error} retry={resource.refresh}>
      {paging !== undefined && <Row title="Latest messages first" hint={paging ? `Sessions open with the newest ${transcriptPage.size} entries of each conversation` : "Sessions open with their whole transcript"}
        trailing={admin
          ? <input type="checkbox" className="checkbox" role="switch" aria-label="Load latest messages first" checked={paging} disabled={action.busy} onChange={event => savePaging(event.target.checked)} />
          : <StatusBadge tone={paging ? "success" : "neutral"}>{paging ? "On" : "Off"}</StatusBadge>} />}
      {full !== undefined && <Row title="Full tool output" hint={full ? "New sessions show every tool result in full" : "New sessions show one line per tool result"}
        trailing={admin
          ? <input type="checkbox" className="checkbox" role="switch" aria-label="Full tool output for new sessions" checked={full} disabled={action.busy} onChange={event => saveFull(event.target.checked)} />
          : <StatusBadge tone={full ? "success" : "neutral"}>{full ? "On" : "Off"}</StatusBadge>} />}
      {(action.error || action.notice) && <CardBody><Feedback {...action} /></CardBody>}
    </ResourceState>
  </Section>;
}
