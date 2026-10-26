import { HTTPException } from 'hono/http-exception';
import type { EntryView, SessionView } from '../../../packages/shared/src/types.js';
import { redactApproval, redactEntry } from '../../../packages/shared/src/redaction.js';
import {
  applyViewPatch, isPatchableView, isRevision, isViewPatch, reuseUnchanged, ViewRevisions, type SessionViewPatch,
} from '../../../packages/shared/src/view-patch.js';
import { presentApprovals } from './approval-reviews.js';
import type { ConnectionPin } from './connector-transport.js';
import { fail } from './http.js';
import { requireRunnerAccess, runnerJSON, runnerRequest } from './runner.js';
import { briefEntry, entriesBefore, fullTranscript, latestEntries, type TranscriptDisplay } from '../../../packages/shared/src/transcript-display.js';
import type { AppContext, SessionRow } from './types.js';

/**
 * One feed of each session's view, shared by everyone watching it: a host is asked at most about once a second however
 * many people watch, and only for what changed since the view the server already holds. Each viewer's access is still
 * checked on every read, and callers check it again before showing anything.
 *
 * The server is a single process, so feeds live in memory; a restart or a reconnected host starts again from a whole view.
 *
 * How the session's transcript is shown (transcript-display.ts) is part of a feed's identity: brief tool output is applied
 * after redaction, and a paged feed's views hold each conversation's latest entries while it keeps the whole view to
 * answer reads of earlier ones. Hosts always send whole views.
 */

/** A view stays current this long after it arrives; snapshots reach each viewer about a second apart. */
const freshMs = 900;
/** Feeds nobody read for this long are dropped, and at most this many are kept. */
const idleMs = 60_000;
const maxFeeds = 256;

export interface ShownView {
  revision: string;
  /** Approvals presented and everything redacted, as people see it. */
  view: SessionView;
}

interface Snapshot {
  /** The host's revision of `raw`, when its runner reports revisions; the next request asks only for changes since. */
  hostRevision?: string;
  /** The connector connection `hostRevision` belongs to: a reconnected host may run another connector version. */
  generation: string | null;
  raw: SessionView;
  /** Presented and redacted, with every entry: what earlier pages of a paged view come from. */
  full: SessionView;
  shown: ShownView;
}

interface Feed {
  key: string;
  display: TranscriptDisplay;
  snapshot?: Snapshot;
  fresh: boolean;
  /** Bumped by every change made through the server, so no read after it is served a view fetched before it. */
  epoch: number;
  started: number;
  applied: number;
  inflight?: { epoch: number; promise: Promise<Snapshot> };
  revisions: ViewRevisions;
  usedAt: number;
}

const registries = new WeakMap<object, Map<string, Feed>>();
const redacted = new WeakMap<object, EntryView>();
const briefed = new WeakMap<object, EntryView>();

function registry(env: object): Map<string, Feed> {
  let feeds = registries.get(env);
  if (!feeds) registries.set(env, feeds = new Map());
  return feeds;
}

/** How the session's transcript is shown now: its own tool output setting, and its workspace's paging. */
export async function transcriptDisplay(c: AppContext, row: SessionRow): Promise<TranscriptDisplay> {
  const workspace = await c.env.DB.query<{ transcript_paging: number }>('SELECT transcript_paging FROM workspaces WHERE id = ?')
    .bind(row.workspace_id).first();
  return { toolOutput: row.tool_output === 'brief' ? 'brief' : 'full', paging: workspace?.transcript_paging === 1 };
}

function feedFor(c: AppContext, row: SessionRow, display: TranscriptDisplay): Feed {
  const feeds = registry(c.env);
  const now = Date.now();
  for (const [id, feed] of feeds) if (now - feed.usedAt > idleMs && !feed.inflight) feeds.delete(id);
  const key = JSON.stringify([row.owner_id, row.connector_id ?? null, display.toolOutput, display.paging]);
  let feed = feeds.get(row.id);
  // A session that changed hosts, owners or how it is shown starts over: viewers holding an older revision get a whole view.
  if (!feed || feed.key !== key) {
    feed = { key, display: { ...display }, fresh: false, epoch: 0, started: 0, applied: 0, revisions: new ViewRevisions(8), usedAt: now };
  }
  feeds.delete(row.id);
  feeds.set(row.id, feed);
  feed.usedAt = now;
  for (const id of feeds.keys()) {
    if (feeds.size <= maxFeeds) break;
    feeds.delete(id);
  }
  return feed;
}

/** Makes the next read of the session's view ask its host again, e.g. after a message or a decision. */
export function invalidateSessionView(c: AppContext, sessionId: string): void {
  const feed = registry(c.env).get(sessionId);
  if (!feed) return;
  feed.epoch++;
  feed.fresh = false;
}

/**
 * The session's current view for the signed-in viewer, after checking their access. Callers must recheck access before
 * showing it, as for any view read from a host. `latest` always asks the host, as a page loading the session does.
 */
export async function sessionView(c: AppContext, row: SessionRow, { latest = false, display = fullTranscript }: { latest?: boolean; display?: TranscriptDisplay } = {}): Promise<ShownView> {
  return (await currentSnapshot(c, row, feedFor(c, row, display), latest)).shown;
}

async function currentSnapshot(c: AppContext, row: SessionRow, feed: Feed, latest: boolean): Promise<Snapshot> {
  if (latest) return refresh(c, row, feed);
  if (feed.fresh && feed.snapshot) {
    await requireRunnerAccess(c, c.get('auth').userId, row, 'view');
    return feed.snapshot;
  }
  const inflight = feed.inflight;
  if (inflight && inflight.epoch === feed.epoch) {
    await requireRunnerAccess(c, c.get('auth').userId, row, 'view');
    try { return await inflight.promise; } catch (error) {
      // Access revoked from the viewer who started it says nothing about this one, who fetches as themselves.
      if (!(error instanceof HTTPException) || error.status !== 403) throw error;
    }
  }
  return refresh(c, row, feed);
}

/**
 * Up to `limit` of a conversation's entries before `before`, presented and redacted as the session's views are, and how
 * many come before those; null when the conversation has no such entry any more. Callers must recheck access.
 */
export async function earlierEntries(c: AppContext, row: SessionRow, display: TranscriptDisplay, conversationId: string, before: string,
  limit: number): Promise<{ entries: EntryView[]; older: number } | null> {
  const feed = feedFor(c, row, display);
  const page = entriesBefore((await currentSnapshot(c, row, feed, false)).full, conversationId, before, limit);
  // The viewer may hold a newer view than the feed: ask the host before saying the entry is gone.
  return page ?? entriesBefore((await currentSnapshot(c, row, feed, true)).full, conversationId, before, limit);
}

/** What changed for a viewer holding `since`, or null when they need the whole view. */
export function viewChanges(c: AppContext, row: SessionRow, since: string | undefined, current: ShownView,
  display: TranscriptDisplay = fullTranscript): SessionViewPatch | null {
  return feedFor(c, row, display).revisions.since(since, current);
}

function refresh(c: AppContext, row: SessionRow, feed: Feed): Promise<Snapshot> {
  const sequence = ++feed.started;
  const epoch = feed.epoch;
  const promise = fetchSnapshot(c, row, feed.snapshot, feed.display).then(({ view, ...fetched }) => {
    // A fetch that started earlier but finished later never replaces a newer view.
    if (sequence < feed.applied) return feed.snapshot!;
    feed.applied = sequence;
    const shown = feed.revisions.record(feed.display.paging ? latestEntries(view) : view);
    const snapshot: Snapshot = { ...fetched, full: view, shown };
    feed.snapshot = snapshot;
    if (epoch === feed.epoch) {
      feed.fresh = true;
      const timer = setTimeout(() => { if (feed.snapshot === snapshot) feed.fresh = false; }, freshMs);
      timer.unref?.();
    }
    return snapshot;
  }).finally(() => { if (feed.inflight?.promise === promise) feed.inflight = undefined; });
  feed.inflight = { epoch, promise };
  return promise;
}

/** The host's current view, presented and redacted, from what the server holds in `base`. */
async function fetchSnapshot(c: AppContext, row: SessionRow, base: Snapshot | undefined,
  display: TranscriptDisplay): Promise<Omit<Snapshot, 'shown' | 'full'> & { view: SessionView }> {
  /** The host's view, as a patch from `since` when given; null when the host should be asked for the whole view instead. */
  const read = async (since?: string): Promise<Omit<Snapshot, 'shown' | 'full'> | null> => {
    const pin: ConnectionPin = since && row.connector_id ? { hash: base!.generation } : {};
    let reply: { view?: SessionView; revision?: unknown; patch?: unknown };
    try {
      reply = await runnerJSON(await runnerRequest(c, row, 'view', since ?? '', undefined, pin));
    } catch (error) {
      // Only hosts that reported a revision on this very connection are asked for changes, as older ones refuse the path.
      if (since && (pin.replaced || (error instanceof HTTPException && [400, 404, 405, 502].includes(error.status)))) return null;
      throw error;
    }
    const generation = row.connector_id ? pin.hash ?? null : null;
    try {
      if (reply.patch !== undefined) {
        if (!since || !isViewPatch(reply.patch) || reply.patch.base !== since) throw new Error('Unexpected view patch');
        return { raw: applyViewPatch(base!.raw, reply.patch), hostRevision: reply.patch.revision, generation };
      }
      if (!isPatchableView(reply.view)) throw new Error('Invalid view');
      // Keep unchanged items' identity, so they are neither redacted nor compared again.
      const raw = base ? reuseUnchanged(base.raw, reply.view) : reply.view;
      return { raw, hostRevision: isRevision(reply.revision) ? reply.revision : undefined, generation };
    } catch {
      // A patch that does not fit what the server holds is not retried: the whole view replaces it.
      if (since) return null;
      fail(502, 'invalid_runner_response', 'The runner returned an invalid view.');
    }
  };
  const since = base?.hostRevision && (!row.connector_id || base.generation) ? base.hostRevision : undefined;
  const result = (since ? await read(since) : null) ?? await read();
  if (!result) fail(502, 'invalid_runner_response', 'The runner returned an invalid view.');
  const { raw } = result;
  if (raw.sessionId !== row.id || raw.owner?.id !== row.owner_id) fail(502, 'invalid_runner_response', 'The runner returned an inconsistent session binding.');
  const approvals = await presentApprovals(c, row, raw.approvals);
  // Secrets are hidden from everyone; approvals keep the review hash committed to the real operation.
  const { olderApprovals, ...rest } = raw;
  const entries = raw.entries.map(redactedEntry);
  const view: SessionView = { ...rest, entries: display.toolOutput === 'brief' ? entries.map(briefedEntry) : entries, approvals: approvals.map(redactApproval),
    ...(Number.isSafeInteger(olderApprovals) && olderApprovals! > 0 ? { olderApprovals } : {}) };
  return { ...result, view };
}

/** A redacted entry as brief tool output shows it, the same object each time so it is neither compared nor sent again. */
function briefedEntry(entry: EntryView): EntryView {
  if (!entry || typeof entry !== 'object') return entry;
  let shown = briefed.get(entry);
  if (!shown) briefed.set(entry, shown = briefEntry(entry));
  return shown;
}

function redactedEntry(entry: EntryView): EntryView {
  if (!entry || typeof entry !== 'object') return redactEntry(entry);
  let shown = redacted.get(entry);
  if (!shown) redacted.set(entry, shown = redactEntry(entry));
  return shown;
}
