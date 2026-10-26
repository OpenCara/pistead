#!/usr/bin/env node
/**
 * Measures how large hosts' session views are, from the hosts' own session databases, to size paging and compression
 * work. It rebuilds each view's transcript entries as the runner does (apps/runner/src/session.ts: the active entries
 * of each branch, from its latest compaction or reset, side asks with the history they forked from), then reports
 * their size raw, gzipped and brotli-compressed, and how much loading only the latest entries or capping tool output
 * would send instead.
 *
 * It only reads: every database is opened read-only, and it prints sizes and counts, never transcript text, tool
 * arguments or file paths. Approvals, the queue and run markers are left out; transcript entries are most of a view.
 *
 *   node scripts/measure-session-views.mjs [--json] [--tail N] [PATH...]
 *
 * PATH is a session.sqlite file or a directory searched for them; the default is the connector's state directory,
 * ~/.local/share/pistead/connector. Needs Node 22.13 or newer (node:sqlite), as any host's connector has.
 * --rows FILE reads one session's rows from JSON ({ conversations: [...], entries: [...] }) instead, for tests.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const args = process.argv.slice(2);
const json = take("--json");
const tail = Number(value("--tail") ?? 50);
const rowsFile = value("--rows");
if (!Number.isSafeInteger(tail) || tail < 1) fail("--tail takes a positive whole number");

function take(flag) {
  const index = args.indexOf(flag);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}
function value(flag) {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const [, given] = args.splice(index, 2);
  if (given === undefined) fail(`${flag} needs a value`);
  return given;
}
function fail(message) {
  console.error(message);
  process.exit(2);
}

/** Session databases under `path`, without following symbolic links. */
function findDatabases(path, found = []) {
  let stat;
  try { stat = statSync(path, { throwIfNoEntry: false }); } catch { return found; }
  if (!stat) return found;
  if (stat.isFile()) {
    if (basename(path) === "session.sqlite") found.push(path);
    return found;
  }
  if (!stat.isDirectory()) return found;
  let names;
  try { names = readdirSync(path, { withFileTypes: true }); } catch { return found; }
  for (const entry of names) {
    // Worktrees and repository caches hold no session databases and can be huge.
    if (entry.isSymbolicLink() || ["node_modules", ".git", "sandbox", "worktree", "repo-cache"].includes(entry.name)) continue;
    const child = join(path, entry.name);
    if (entry.isDirectory()) findDatabases(child, found);
    else if (entry.isFile() && entry.name === "session.sqlite") found.push(child);
  }
  return found;
}

async function readDatabase(path) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name));
    if (!tables.has("conversations") || !tables.has("entries")) return null;
    const conversations = db.prepare("SELECT record FROM conversations ORDER BY id").all().map(row => JSON.parse(row.record));
    const entries = db.prepare("SELECT record FROM entries ORDER BY id").all().map(row => JSON.parse(row.record));
    return { conversations, entries };
  } finally {
    db.close();
  }
}

const bytes = text => Buffer.byteLength(text);
const gzip = text => gzipSync(text).length;
// A quality a server can afford on every response; 11 is for static assets.
const brotli = text => brotliCompressSync(text, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } }).length;

/** The runner's entry view (session.ts entryView), with a typical actor ID; text is never printed. */
function entryView(entry, branch, cap) {
  const messages = entry.model ?? [];
  const parts = messages.flatMap(message => {
    if (typeof message.content === "string") return [message.content];
    return (message.content ?? []).flatMap(block => block.type === "text" ? [block.text]
      : block.type === "toolCall" ? [`${block.name}(${JSON.stringify(block.arguments)})`]
      : block.type === "image" ? [`[image ${block.mimeType}]`] : []);
  });
  let text = parts.join("\n");
  const role = messages[0]?.role ?? "system";
  if (cap !== undefined && role === "toolResult" && text.length > cap) text = text.slice(0, cap);
  const durations = messages.flatMap(message => (message.role === "assistant" || message.role === "toolResult") && message.durationMs !== undefined ? [message.durationMs] : []);
  return { id: `${branch}:${entry.id}`, kind: entry.kind, role, text, actorId: "github:12345678", conversationId: String(branch),
    ...(durations.length ? { durationMs: durations.reduce((a, b) => a + b, 0) } : {}) };
}

function measure({ conversations, entries }) {
  const started = performance.now();
  const byId = new Map(conversations.map(conversation => [conversation.id, conversation]));
  const own = new Map();
  for (const entry of entries) {
    if (!own.has(entry.conversationId)) own.set(entry.conversationId, []);
    own.get(entry.conversationId).push(entry);
  }
  const visibleCache = new Map();
  /** A conversation's entries and, for a fork, its parent's through the fork point, oldest first. */
  const visible = id => {
    if (visibleCache.has(id)) return visibleCache.get(id);
    const conversation = byId.get(id);
    const inherited = conversation?.parent ? visible(conversation.parent.conversationId).filter(entry => entry.id <= conversation.parent.at) : [];
    const result = [...inherited, ...(own.get(id) ?? [])].sort((a, b) => a.id - b.id);
    visibleCache.set(id, result);
    return result;
  };
  /** Pi's active entries: the latest head marker, then the entries from its head (harness/context.ts selectActive). */
  const active = id => {
    const all = visible(id);
    const marker = all.findLast(entry => entry.head !== undefined);
    return { all, shown: marker ? [marker, ...all.filter(entry => entry.head === undefined && entry.id >= marker.head)] : all };
  };
  // The runner's branches: the shared conversation and side asks. Conversations a task owns (subagents) are not shown.
  const branches = conversations.filter(conversation => !conversation.owner).map(conversation => {
    const { all, shown } = active(conversation.id);
    return { id: conversation.id, ask: Boolean(conversation.parent), all, shown };
  });

  const views = cap => branches.flatMap(branch => branch.shown.map(entry => entryView(entry, branch.id, cap)));
  const size = list => {
    const text = JSON.stringify({ entries: list });
    return { raw: bytes(text), gzip: gzip(text), brotli: brotli(text) };
  };
  const full = views();
  const built = performance.now() - started;
  const encodeStarted = performance.now();
  const fullSize = size(full);
  const encodeMs = performance.now() - encodeStarted;

  const roles = {};
  for (const view of full) {
    roles[view.role] ??= { count: 0, raw: 0 };
    roles[view.role].count++;
    roles[view.role].raw += bytes(JSON.stringify(view));
  }
  const inherited = branches.flatMap(branch => branch.ask ? branch.shown.filter(entry => entry.conversationId !== branch.id) : []);
  const askViews = branches.filter(branch => branch.ask).flatMap(branch => branch.shown.map(entry => entryView(entry, branch.id)));
  const largest = full.map(view => ({ role: view.role, kind: view.kind, raw: bytes(JSON.stringify(view)) }))
    .sort((a, b) => b.raw - a.raw).slice(0, 5);
  const tailViews = branches.flatMap(branch => branch.shown.slice(-tail).map(entry => entryView(entry, branch.id)));
  // Paging side asks too: each fork's latest entries only, without the history it inherited unless that is the latest.
  return {
    conversations: { branches: branches.length, asks: branches.filter(branch => branch.ask).length, subagents: conversations.length - branches.length },
    entries: { stored: entries.length, shown: full.length, hiddenByCompaction: branches.reduce((total, branch) => total + branch.all.length - branch.shown.length, 0),
      inheritedByAsks: inherited.length },
    view: fullSize,
    roles,
    askShare: { raw: askViews.reduce((total, view) => total + bytes(JSON.stringify(view)), 0) },
    largestEntries: largest,
    tail: { entriesPerBranch: tail, entries: tailViews.length, ...size(tailViews) },
    toolOutputCapped: { at2k: size(views(2048)), at8k: size(views(8192)) },
    timing: { buildMs: Math.round(built), encodeMs: Math.round(encodeMs) },
  };
}

const kb = n => n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${(n / 1024).toFixed(1)} KB`;
const pct = (part, whole) => whole ? `${Math.round(part / whole * 100)}%` : "-";

function report(name, result) {
  const { view, entries, conversations, tail: last, toolOutputCapped: capped } = result;
  console.log(`\n${name}`);
  console.log(`  conversations: ${conversations.branches} shown (${conversations.asks} side asks), ${conversations.subagents} subagent`);
  console.log(`  entries: ${entries.stored} stored, ${entries.shown} in the view, ${entries.hiddenByCompaction} hidden by compaction, ${entries.inheritedByAsks} repeated in side asks`);
  console.log(`  view entries: ${kb(view.raw)} raw, ${kb(view.gzip)} gzip, ${kb(view.brotli)} brotli`);
  console.log(`  by role: ${Object.entries(result.roles).sort((a, b) => b[1].raw - a[1].raw).map(([role, { count, raw }]) => `${role} ${count} × ${kb(raw)} (${pct(raw, view.raw)})`).join(", ")}`);
  console.log(`  side asks: ${kb(result.askShare.raw)} (${pct(result.askShare.raw, view.raw)})`);
  console.log(`  largest entries: ${result.largestEntries.map(entry => `${entry.role} ${kb(entry.raw)}`).join(", ")}`);
  console.log(`  last ${last.entriesPerBranch} per conversation: ${last.entries} entries, ${kb(last.raw)} raw, ${kb(last.gzip)} gzip (${pct(last.gzip, view.gzip)} of the full gzip)`);
  console.log(`  tool output capped at 2 KB: ${kb(capped.at2k.raw)} raw, ${kb(capped.at2k.gzip)} gzip; at 8 KB: ${kb(capped.at8k.raw)} raw, ${kb(capped.at8k.gzip)} gzip`);
  console.log(`  host-side cost per full view (approx.): build ${result.timing.buildMs} ms, encode ${result.timing.encodeMs} ms`);
}

const results = [];
if (rowsFile) {
  results.push({ name: rowsFile, ...measure(JSON.parse(readFileSync(rowsFile, "utf8"))) });
} else {
  const roots = args.length ? args.map(path => resolve(path)) : [join(homedir(), ".local", "share", "pistead", "connector")];
  const databases = [...new Set(roots.flatMap(root => findDatabases(root)))];
  if (!databases.length) fail(`No session.sqlite found under ${roots.join(", ")}`);
  for (const path of databases) {
    try {
      const rows = await readDatabase(path);
      if (rows) results.push({ name: basename(dirname(path)), ...measure(rows) });
    } catch (error) {
      console.error(`${basename(dirname(path))}: skipped (${error instanceof Error ? error.message : String(error)})`);
    }
  }
}
results.sort((a, b) => b.view.raw - a.view.raw);
if (json) {
  console.log(JSON.stringify(results, null, 2));
} else {
  for (const result of results) report(result.name, result);
  if (results.length > 1) {
    const total = key => results.reduce((sum, result) => sum + result.view[key], 0);
    const sizes = results.map(result => result.view.raw).sort((a, b) => a - b);
    const at = q => sizes[Math.min(sizes.length - 1, Math.floor(q * sizes.length))];
    console.log(`\n${results.length} sessions: median ${kb(at(0.5))}, p90 ${kb(at(0.9))}, largest ${kb(sizes.at(-1))} raw; all together ${kb(total("raw"))} raw, ${kb(total("gzip"))} gzip`);
  }
}
