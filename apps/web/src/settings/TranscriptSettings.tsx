import type { Workspace } from "../../../../packages/shared/src/types";
import { transcriptPage } from "../../../../packages/shared/src/transcript-display";
import { api, segment } from "../api";
import { CardBody, Feedback, ResourceState, Row, Section, StatusBadge, useAction, useResource } from "../ui";

interface TranscriptSettingsResponse { settings: { paging: boolean } }

/** Whether the workspace's session transcripts load latest messages first. */
export function TranscriptSettings({ workspace, admin }: { workspace: Workspace; admin: boolean }) {
  const path = `/api/workspaces/${segment(workspace.id)}/transcripts`;
  const resource = useResource<TranscriptSettingsResponse>(path);
  const action = useAction();
  const paging = resource.data?.settings.paging;
  function save(next: boolean) {
    if (!admin || action.busy || next === paging) return;
    void action.run(async () => {
      await api(path, { method: "PUT", body: { paging: next } });
      resource.refresh();
    }, next ? "Transcripts load latest messages first. Open sessions switch within a few seconds." : "Transcripts load whole again. Open sessions switch within a few seconds.");
  }
  return <Section title="Transcripts" info={<div className="stack">
    {!admin && <p>Only workspace owners and admins can change how transcripts load.</p>}
    <p>With latest messages first, a session opens with the newest {transcriptPage.size} entries of each conversation, and earlier ones load as you scroll up. Long sessions open much faster this way; your browser's find on the page only searches what has loaded.</p>
    <p>Hosts still send Pistead whole transcripts; this changes only what reaches each viewer. Each session's owner can also make its tool output brief, under the session's Details.</p>
  </div>}>
    <ResourceState loading={resource.loading} error={resource.error} retry={resource.refresh}>
      {paging !== undefined && <Row title="Latest messages first" hint={paging ? `Sessions open with the newest ${transcriptPage.size} entries of each conversation` : "Sessions open with their whole transcript"}
        trailing={admin
          ? <input type="checkbox" className="checkbox" role="switch" aria-label="Load latest messages first" checked={paging} disabled={action.busy} onChange={event => save(event.target.checked)} />
          : <StatusBadge tone={paging ? "success" : "neutral"}>{paging ? "On" : "Off"}</StatusBadge>} />}
      {(action.error || action.notice) && <CardBody><Feedback {...action} /></CardBody>}
    </ResourceState>
  </Section>;
}
