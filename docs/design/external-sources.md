# Investigation: cloud drives, Obsidian, Notion, Tencent Docs and other document sources

Status: investigation. Nothing here is implemented yet. Claims about third-party APIs (scopes, limits, export formats)
were written from memory and are marked **(verify)** where they decide a design choice. Check them against the
vendors' current docs before building.

## Question

Can sessions read, and with approval change, a team's documents outside Git: cloud drives (Google Drive, OneDrive /
SharePoint, Dropbox, Box, Baidu Netdisk, Alibaba Cloud Drive), note apps (Obsidian, Notion), and online office suites
(Tencent Docs, Feishu/Lark, Google Docs)? And how would that fit Pistead's rules?

## The rules any integration has to keep

These come from [egress.md](egress.md) and the README, and they rule most shortcuts out:

1. **No credential enters the sandbox.** Every Git credential stays on the control plane. The README even refuses
   `APP_` variables named `*TOKEN*`, `*SECRET*` or `*API_KEY*`. A Notion token or a Drive OAuth token in an env var
   would break this.
2. **Sessions act with the session owner's own account**, never the host owner's. On a shared host, Alice's Drive
   token must not serve Bob's session, and it must never reach Bob's machine.
3. **The proxy never looks inside tunnels.** `CONNECT host:443` is opaque (`apps/runner/src/egress.ts`), so the
   proxy can't add an `Authorization` header to `api.notion.com` the way the Git relay does for clones.
4. **Writes need approval** for one exact operation, unless the owner sent the message with Auto-approve. Reads
   happen only within a write admission (`github_read` checks `run_admissions`).
5. **Policy is enforced outside the sandbox** (runner and control plane), and is re-checked on every request.

## What works today, without code

| Source | How | Limits |
|---|---|---|
| Obsidian vault kept in Git (obsidian-git plugin, or a vault folder under version control) | Bind the vault's repository. The agent clones it, edits the Markdown and pushes its session branch. | This is the cleanest path today: Obsidian notes are plain Markdown files. Merge conflicts with the user's own edits are resolved as Git conflicts. |
| Public documents and links | Network access **Allowlist** with the host (e.g. `docs.google.com`) | Anonymous only. No private files. |
| Anything, on an unsandboxed host or an "On this host" session | `rclone`, the Notion CLI or SDKs, using the host's own credentials, via `bash` / `host_bash` | Breaks rule 2 on shared hosts (it uses the host owner's identity), has no isolation and gets no per-source audit. Acceptable only on the owner's own machine. |

Gap: a workspace must have a **bound Git repository** before anyone can start a session in it. A docs-only workspace
would need a placeholder repository until sources count as bindings too.

## Options

### A. Brokered tools, like `github_read` / `github_comment`

New tools such as `docs_search`, `docs_read` and `docs_write` (or one set per provider: `notion_read`, `drive_read`,
and so on). Each one calls `/api/connectors/self/<provider>/…`, as `githubRead` does (`apps/server/src/github-broker.ts`).
The control plane:

- loads the **session owner's** account for the provider from an encrypted table like `git_credentials` (`vault.ts`);
- checks that the target lies inside a **source bound to the workspace** (a Notion page or database, a Drive folder,
  a Dropbox path, a Tencent Docs folder);
- calls the provider, converts the result to Markdown or text with size limits, re-checks authority, audits
  (`docs.read`), and returns it.

Writes become approval kinds (`docs.write {source, path, baseRevision, content}`) and are shown exactly on the card.

- Pros: fits every rule as is; reuses admissions, `requireToolCall`, approval cards and audit; no proxy changes.
- Cons: the agent can't use its file tools, `grep` or scripts on the documents. Large or binary files (xlsx, pptx,
  PDFs) pass through tool results. Each provider needs its own adapter.

### B. Materialize sources into the worktree: "clone" and "push" for documents (recommended for file-like sources)

Copy the Git model the agent already knows:

- `docs_pull {source, path?}` (or `pistead-docs pull` in the sandbox, going through the proxy at
  `http://127.0.0.1:41080/docs/<source>/…`, the way `/git/…` works) downloads a bound source's files into the
  worktree. Google Docs and Notion pages are converted to Markdown; Sheets to CSV/XLSX. Each file's provider
  revision is recorded in a manifest (`.pistead-docs.json`).
- The agent works on them with ordinary tools.
- `docs_push {directory}` (approval) uploads the changed files. It is **compare-and-swap** on the recorded revision,
  like fast-forward-only pushes: a file someone changed meanwhile is refused ("pull and merge first"). Candidate
  revision fields are Drive `headRevisionId` / `version`, Dropbox `rev` (upload with `mode: update`), OneDrive `eTag`
  (`If-Match`) and Notion `last_edited_time` **(verify)**. The approval card shows the diff per file.

The relay route sits beside the Git relay: `POST /api/connectors/self/docs/relay/:sourceId/:op?sessionId=…`. It has
the same checks (session authority, connector scope, source in the session's workspace, owner's own account, bounded
bodies) and the same credential-free refusals.

- Pros: agents are good at files; backups, moves and the Files tab work unchanged; one approval per push, not per
  call; the scoping (bound source) is the same idea as bound repositories.
- Cons: format round-trips are lossy. Notion blocks ↔ Markdown, and Docs → Markdown → Docs, drop comments,
  mentions, layout and rich blocks. A safe first version should push Markdown back **only for sources whose native
  format is files** (Drive or Dropbox `.md`/`.txt`/`.csv`, Obsidian vaults in a drive), and use option A writes for
  Notion pages and Google Docs (append blocks, replace one block, comment) rather than whole-document rewrites.

### C. Credential-injecting HTTP relay (generic API passthrough)

The proxy forwards `http://127.0.0.1:41080/api/<provider>/<path>` to the control plane, which adds the owner's
token and calls the provider, so the agent can use `curl` or SDKs against a proxy base URL.

- Pros: one mechanism for many APIs; full API surface.
- Cons: scoping and approvals become a per-provider HTTP allowlist (method plus path patterns, request bodies that
  name IDs), which is easy to get wrong. Mutating calls would bypass approval cards unless each is classified.
  **Not recommended** except as a read-only mode (GET plus known read-only POSTs like Notion search) for providers
  whose own permission model already limits the token (Notion integrations see only pages shared with them).

### D. Remote MCP servers brokered by the control plane

Many vendors now host MCP servers with OAuth (Notion has one; community ones exist for Google Workspace, Dropbox,
Feishu and others) **(verify each)**. The control plane would be the MCP client, with the owner's OAuth token. The
runner would expose the server's tools to the agent as brokered tools. Read-only tools (`readOnlyHint`) run within
write admissions; others become approval cards with their exact arguments.

- Pros: broad coverage with one generic integration, and vendors maintain the tool surface.
- Cons: tool lists and annotations are under the vendor's control. Prompt-injection surface: tool descriptions come
  from a third party. Results are unbounded unless we cap them. Pi has no built-in MCP client, so this needs a Pi
  extension or a runner-side bridge. A good **second** step after one or two first-class adapters prove the
  account, binding and approval plumbing.

## Recommendation

1. **Shared plumbing first** (needed by A, B and D):
   - `source_accounts` (per user, encrypted like `git_credentials`): `provider`, `host`/`tenant`, OAuth refresh
     token or API token, scopes, and the verified account name. UI: **Settings → Profile → Connected accounts**.
   - `workspace_sources` (per workspace, owners and admins): `provider`, the provider-stable root ID (folder, page,
     database), its display path, and `writable` (default off, like **Allow agent pushes to the default branch**).
     The session grant (`/api/connectors/self/network`) lists them next to repositories, and the instructions name
     them.
   - Let a workspace with a bound source but no repository start sessions.
   - OAuth apps are configured **by the server operator**, as the GitHub OAuth app is (`GOOGLE_CLIENT_ID`, …).
     Pistead is self-hosted, so each operator registers their own apps. Providers without OAuth configured offer
     token entry only, where the provider supports tokens.
2. **First adapters, by value per effort:**
   - **Notion**: an internal integration token works like a personal access token (no OAuth app needed), and Notion
     itself scopes it to the pages shared with the integration. Read: search, page or database → Markdown. Write
     (option A, approval): append blocks, update properties, create a page under a bound parent. Watch the rate
     limit (about 3 requests/s per integration) **(verify)**.
   - **Google Drive / Docs**: option B for files, plus Docs export to Markdown (Drive `files.export` with
     `text/markdown`) **(verify)**. Scope: `drive.file` doesn't let us browse folders the user didn't pick, and
     `drive.readonly` / `drive` are restricted scopes that need Google verification for public apps. For a
     self-hosted, internal-use OAuth client (Workspace "Internal" app) that verification isn't needed **(verify)**.
   - **Dropbox** and **OneDrive / SharePoint** (Microsoft Graph): option B. They are file stores with good revision
     preconditions. They also cover **Obsidian vaults synced through a drive**.
3. **Then the China-region suites**, which need developer registration and have narrower APIs:
   - **Tencent Docs (腾讯文档) open platform**: OAuth app registration and approval. File listing and metadata,
     asynchronous export (docx/xlsx/pdf), and limited content APIs, strongest for sheets **(verify scope and whether
     accounts outside mainland China can register)**. Start read-only: list plus export → convert (docx → Markdown via
     pandoc in the runner or the control plane).
   - **Feishu/Lark Docs**: the richest API of this group (docx blocks, Markdown-like import, wiki spaces, bitable).
     Likely a better first China-region adapter than Tencent Docs if the team uses it.
   - **Baidu Netdisk (xpan)** and **Alibaba Cloud Drive (阿里云盘) open platform**: option B file stores.
     Registration and rate limits are strict **(verify)**.
   - Network: the control plane makes these calls, so a server hosted outside mainland China may see high latency
     to these APIs. Timeouts and the 64 MiB-style body bounds should be per provider.
4. **Obsidian specifically:**
   - Vault in Git: works now (document it in the README).
   - Vault in Dropbox, Drive or OneDrive: covered by step 2.
   - **Obsidian Sync**: no public API (it is end-to-end encrypted). Not integrable from the control plane. Only
     reachable from a host running Obsidian, via "On this host" sessions.
   - The Local REST API community plugin listens on the user's own machine (loopback). The egress proxy never reaches
     loopback, by design. Only `host_bash` on that machine could use it. Not recommended for shared hosts.
5. **Later:** option D (brokered remote MCP) as the generic long tail. Skip option C, or allow it only read-only.

## Security notes

- Document contents are **untrusted input** (prompt injection). That matters more than for code, because shared
  docs are often edited by people outside the team. Reads run only within write admissions, as `github_read` does.
  The approval card for every write shows the exact target and content.
- OAuth refresh tokens are long-lived and broad. Ask for the narrowest scope the binding needs: read-only unless a
  bound source is `writable`. Re-check on every call that the source is still bound and the account unchanged (the
  `recheckCredential` pattern).
- Workspace exports should include `workspace_sources` but never accounts. Audit `docs.read`, `docs.write` and
  `docs.pull` with the source and revision.
- Restores and moves keep materialized files (they are worktree files). The manifest's revisions make a stale push
  after a restore fail safely.

## Decision: workspaces have sources, and a Git repository is one kind of source

Instead of a second system beside repositories, a workspace binds **sources**. A Git repository is one kind; Notion,
Google Drive, Dropbox, OneDrive, Tencent Docs and the rest are others.

- **Visibility: no restriction per session or member.** Every source of a workspace is in the grant of every session
  in it, as repositories are today. Each read still uses the session owner's own account, so what a session can
  actually see is still limited by that owner's access at the provider.
- **A general layer** that owns what is the same for every kind: `workspace_sources` (`id`, `workspace_id`, `kind`,
  display name, `writable`, created by and when). Used by the settings UI (**Settings → Workspaces → Sources → Add
  source**), the setup checklist, the start-session check ("at least one source" replaces "at least one
  repository"), the session grant and instructions, workspace exports and audit.
- **Per-kind detail tables.** `workspace_repositories` becomes the detail of `kind = git` and keeps everything that
  only Git has: push policies and identities, session branches, LFS, the host repository cache, `git_push` and tags,
  and pull request states. New kinds get their own tables (`notion_sources` with the root page or database id,
  `drive_sources` with the folder and drive ids, …). Branch, LFS or cache concepts are not pushed into the general
  layer.
- **Accounts:** one **Connected accounts** page in the profile; storage stays per kind (`git_credentials` and a new
  `source_accounts`).
- **Tools stay per kind.** Git keeps `git clone` and `git_push`. Document kinds get their own tools (`notion_read`,
  `docs_pull`, `docs_push`, …), because their approval cards and failure modes differ. No single `source_read`.

### Migration

1. Add `workspace_sources` and backfill one `git` row per existing repository, keeping the repository ids so existing
   references (pushes, ledgers, mirrors, exports) still resolve.
2. Move the workspace-level reads to sources: the settings UI, setup checklist, start-session check, grant and
   exports. The repository-specific server code (`push/broker.ts`, `push/identities.ts`, LFS, the relay and the
   runner's proxy and cache) keeps reading `workspace_repositories`.
3. Rename **Repositories** to **Sources** in the UI and the README.
4. Add the first non-Git kind (Notion) on top of the general layer.

Steps 1 and 2 are a refactor with no visible behaviour change, and can land before any integration.

## Open questions

- Is the main demand reading context (specs, notes) or writing documents back? Reading-only cuts the work roughly
  in half and avoids lossy round-trips.
- Which providers do actual users have? Notion and Google likely; Tencent Docs or Feishu for China-based teams.
