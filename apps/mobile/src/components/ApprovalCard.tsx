import type { ReactNode } from "react";
import { Linking, StyleSheet, Text, View } from "react-native";
import { containsRedaction, REDACTED } from "../../../../packages/shared/src/redaction";
import type {
  ApprovalRecord, GitHubMergeMethod, GitHubMergeOperation, GitPushOperation, PermissionNeed, PermissionRequest,
} from "../../../../packages/shared/src/types";
import { timestamp } from "../lib/format";
import { useUsername } from "../lib/people";
import { monospace, usePalette, type Tone } from "../theme";
import { Badge, Banner, Button, Card, styles as ui } from "./ui";

const approvalTone: Record<ApprovalRecord["status"], Tone> = {
  pending: "warning", approved: "info", executing: "running", executed: "success", denied: "neutral", interrupted: "warning", failed: "danger",
};

const permissionNeedText: Record<PermissionNeed, string> = {
  tool: "A tool this agent doesn't include",
  write: "A change in a Read-only message",
  "unbounded-shell": "No resource limits: this host has none set up for commands. The command still runs in the sandbox, offline and for at most the host's command time limit, but with no cap on CPU, memory, processes or disk.",
};
/** Tools whose effect gets its own approval card after the permission, unless the message auto-approves. */
const approvedTools: readonly string[] = ["bash", "git_commit", "git_push", "github_comment", "github_merge", "github_issue", "host_bash", "git_repin"];

const mergeMethodLabels: Record<GitHubMergeMethod, string> = { merge: "Merge commit", squash: "Squash and merge", rebase: "Rebase and merge" };

function Detail({ label, children }: { label: string; children: ReactNode }) {
  const palette = usePalette();
  return <View style={styles.detail}>
    <Text style={[styles.detailLabel, { color: palette.muted }]}>{label}</Text>
    <View style={ui.flex}>{typeof children === "string" ? <Text selectable style={[styles.code, { color: palette.text }]}>{children}</Text> : children}</View>
  </View>;
}

function PermissionSummary({ request, pending }: { request: PermissionRequest; pending: boolean }) {
  const palette = usePalette();
  const text = { color: palette.text };
  return <>
    <Text style={[styles.body, text]}><Text style={styles.code}>{request.tool}</Text> {pending ? "needs the session owner's permission for:" : "asked the session owner's permission for:"}</Text>
    {request.needs.map(need => <Text key={need} style={[ui.small, text]}>• {permissionNeedText[need]}</Text>)}
    {request.target ? <Text selectable style={[styles.pre, text, { backgroundColor: palette.code }]}>{request.target}</Text> : null}
    {pending && containsRedaction(request.target) && <HiddenSecretNote />}
    {pending && approvedTools.includes(request.tool) && <Text style={[ui.small, { color: palette.muted }]}>Allowing it doesn't run anything yet: the operation still gets its own approval, unless the message auto-approves.</Text>}
  </>;
}

/** The server hides what looks like a secret from everyone; a decision still uses the real value. */
function HiddenSecretNote() {
  const palette = usePalette();
  return <Text testID="approval-secret-note" style={[ui.small, { color: palette.text }]}>
    Something that looks like a secret is shown as <Text style={styles.code}>{REDACTED}</Text>. Allowing or approving this uses the real value, so make sure it belongs here.
  </Text>;
}

/** The session a repin created, from the executed approval's result; nothing unless it holds a valid session ID. */
function RepinLink({ result, onOpen }: { result?: string; onOpen: (id: string) => void }) {
  let sessionId: string;
  try {
    const value = JSON.parse(result ?? "null");
    if (typeof value?.sessionId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value.sessionId)) return null;
    sessionId = value.sessionId;
  } catch { return null; }
  return <View style={ui.inline}><Button testID="approval-open-repin" small label="Open repinned session" onPress={() => onOpen(sessionId)} /></View>;
}

function GitPushSummary({ operation }: { operation: GitPushOperation }) {
  const palette = usePalette();
  const pull = operation.pullRequest;
  return <View style={styles.details}>
    <Detail label="Repository">{operation.repository}</Detail>
    {operation.tag !== undefined && <Detail label="New tag">{operation.tag}</Detail>}
    <Detail label={operation.tag !== undefined ? "On branch (not moved)" : "Branch"}>{operation.branch}</Detail>
    <Detail label="Commit">{operation.commit.slice(0, 12)}</Detail>
    {pull && <Detail label="Pull request">
      <Text selectable style={[styles.body, { color: palette.text }]}>{pull.title}{pull.base ? <> → <Text style={styles.code}>{pull.base}</Text></> : " → default branch"}</Text>
    </Detail>}
  </View>;
}

function GitHubMergeSummary({ operation }: { operation: GitHubMergeOperation }) {
  const palette = usePalette();
  const url = `https://github.com/${operation.repository}/pull/${operation.pull}`;
  return <View style={styles.details}>
    <Detail label="Pull request">
      <Text accessibilityRole="link" style={[styles.code, { color: palette.tones.info.text, textDecorationLine: "underline" }]} onPress={() => void Linking.openURL(url)}>
        {operation.repository}#{operation.pull}
      </Text>
    </Detail>
    <Detail label="Head commit">{operation.sha.slice(0, 12)}</Detail>
    <Detail label="Method"><Text style={[styles.body, { color: palette.text }]}>{mergeMethodLabels[operation.method]}</Text></Detail>
  </View>;
}

/**
 * One approval record with the exact operation it covers; decision controls, when allowed, come in as children.
 * `onOpenSession` opens the session an executed repin created.
 */
export function ApprovalCard({ approval, onOpenSession, children }: { approval: ApprovalRecord; onOpenSession?: (id: string) => void; children?: ReactNode }) {
  const palette = usePalette();
  const name = useUsername();
  const { operation } = approval;
  const allowed = (decidedBy: string, scope: ApprovalRecord["scope"]) => ` · Allowed by ${name(decidedBy)} ${scope === "session" ? "for the rest of the session" : "for this call"}`;
  const decision = operation.kind === "permission" && approval.status === "approved" && approval.decidedBy
    ? allowed(approval.decidedBy, approval.scope)
    : `${approval.permission ? allowed(approval.permission.decidedBy, approval.permission.scope) : ""}${approval.decidedBy ? ` · Decision by ${name(approval.decidedBy)}` : ""}`;
  return <Card>
    <View style={ui.inline}>
      <Text style={[styles.kind, { color: palette.text }]}>{operation.kind === "permission" ? "Permission" : operation.kind}</Text>
      <View style={ui.flex} />
      {approval.unbounded && <Badge tone="warning">No resource limits</Badge>}
      {containsRedaction(operation) && <Badge tone="warning">Secret hidden</Badge>}
      {approval.automatic && <Badge tone="warning">Auto-approved</Badge>}
      <Badge tone={approvalTone[approval.status]} dot={approval.status === "executing"}>{approval.status}</Badge>
    </View>
    {operation.kind === "permission" ? <PermissionSummary request={operation} pending={approval.status === "pending"} /> : <>
      {operation.kind === "host.bash" && <Banner tone="danger" title="Runs outside the sandbox">
        {`This command runs as the host's OS user with access to their files, credentials and network, without CPU, memory or disk quotas. It runs in this session's files, which the agent can change, so builds, package scripts and Git hooks or settings there can run the agent's code on the host too. Only the host owner can approve it. The time limit is ${operation.timeoutSeconds} seconds.`}
      </Banner>}
      {operation.kind === "git.repin" && <Banner title="Creates a new private session">
        <Text style={[styles.body, { color: palette.text }]}>
          Resolves <Text style={styles.code}>{operation.repository}</Text> at <Text style={styles.code}>{operation.ref}</Text>. Other repository pins stay unchanged. This session's files, commits and conversation stay here; they are not copied. Only the session owner can approve.
        </Text>
      </Banner>}
      {operation.kind === "git.push" && <GitPushSummary operation={operation} />}
      {operation.kind === "github.merge" && <GitHubMergeSummary operation={operation} />}
      <Text selectable testID="approval-operation" style={[styles.pre, { color: palette.text, backgroundColor: palette.code }]}>{JSON.stringify(operation, null, 2)}</Text>
      {approval.status === "pending" && containsRedaction(operation) && <HiddenSecretNote />}
    </>}
    <Text style={[ui.small, { color: palette.muted }]}>
      Requested by {name(approval.requestedBy)} · {timestamp(approval.createdAt)}{approval.automatic ? " · Ran under the owner's auto-approve access, without a per-command decision" : decision}
    </Text>
    {approval.result ? <Text selectable testID="approval-result" style={[styles.pre, { color: palette.text, backgroundColor: palette.code }]}>{approval.result}</Text> : null}
    {operation.kind === "git.repin" && approval.status === "executed" && onOpenSession && <RepinLink result={approval.result} onOpen={onOpenSession} />}
    {children}
  </Card>;
}

const styles = StyleSheet.create({
  kind: { fontSize: 14, fontWeight: "700" },
  body: { fontSize: 14, lineHeight: 20 },
  code: { fontFamily: monospace, fontSize: 13 },
  pre: { fontFamily: monospace, fontSize: 12, lineHeight: 17, padding: 10, borderRadius: 8 },
  details: { gap: 4 },
  detail: { flexDirection: "row", gap: 8 },
  detailLabel: { width: 96, fontSize: 13 },
});
