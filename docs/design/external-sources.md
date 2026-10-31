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
  `source_accounts`). **Done:** the profile's **Connected accounts** section lists every supported Git provider, one row each
  like the document providers (GitHub's sign-in, then the token providers with **Connect** and their connected accounts
  under them), then one row per document provider.
- **Tools by what they do.** Git keeps `git clone` and `git_push`. Every document kind is read with one tool,
  `source_read`, so a new kind needs no connector update; writes, when they come, get tools per kind, because their
  approval cards and failure modes differ.

### Migration

1. Add `workspace_sources` and backfill one `git` row per existing repository, keeping the repository ids so existing
   references (pushes, ledgers, mirrors, exports) still resolve.
2. Move the workspace-level reads to sources: the settings UI, setup checklist, start-session check, grant and
   exports. The repository-specific server code (`push/broker.ts`, `push/identities.ts`, LFS, the relay and the
   runner's proxy and cache) keeps reading `workspace_repositories`.
3. Rename **Repositories** to **Sources** in the UI and the README.
4. Add the first non-Git kind (Notion) on top of the general layer.

Steps 1 and 2 are a refactor with no visible behaviour change, and can land before any integration.

**Done: steps 1 and 2.** Migration `0040_workspace_sources.sql` (Postgres `0033_workspace_sources.sql`) adds
`workspace_sources` and backfills one `git` row per repository, with the repository's id. A `git` source references its
repository (`repository_binding_id`, `ON DELETE CASCADE`), and an insert trigger on `workspace_repositories` adds it,
so every path that binds or removes a repository (the API, imports, tests) keeps the two in step. Sources are
immutable, and a `git` source is refused without its own repository in its own workspace. Sharing a host with a
workspace and starting a session now require a source (`workspaceHasSourceSQL`, `workspaceSourceIds` in
`repositories.ts`), and the session insert requires the workspace's sources, not its repositories, to be unchanged.
The error code stays `workspace_repositories_required` for API callers.

**Done: steps 3 and 4, and two more kinds.** The web app's workspace section is **Sources**, holding **Git
repositories** and **Documents**; the setup step is **Add a source**; new-session and host-sharing gates (web and
mobile) count every source (`WorkspaceRepositoryList.sources`). Three document kinds, all read-only, share one path:

- `source_accounts` (per user and provider, vault-encrypted with the user id as AAD) under **Settings → Profile →
  Connected accounts**; `PUT/DELETE /api/source-accounts/:provider`. Each kind connects with a secret its owner pastes
  and scopes by sharing, so no OAuth app is needed: a Notion internal integration secret (verified with
  `GET /v1/users/me`), a Google service account's JSON key (only `client_email`, `private_key` and `private_key_id` are
  kept; signed into a `drive.readonly` token at `oauth2.googleapis.com` only), a Feishu/Lark custom app's id and
  secret (a tenant token from `open.feishu.cn` or `open.larksuite.com`).
- `document_sources` (the detail of every non-Git workspace source: kind, the provider's item id and type, title,
  URL), at most 20 per workspace; `GET/POST /api/workspaces/:id/sources` and `DELETE …/sources/:sourceId`, owners and
  admins, audited (`workspace.source.added` / `.removed`). The adding admin's own connection checks and names the item.
- The session grant lists them (`EgressGrant.sources`, with kind and type), and the runner names them in the
  instructions with a warning that their content is other people's.
- `source_read {source, item?}`: **one** read tool for every document kind, behind the connector capability `sources`,
  so a new kind needs only the control plane. It is brokered like `github_read` (`/api/connectors/self/sources/read`,
  `/api/internal/sources/read`): a write admission of the requester, the tool or the owner's permission for that exact
  target, the **session owner's** connection of the source's kind, and an item that is the bound one or under it.
  Results stay within 96 KiB of JSON, the account is rechecked before the result leaves, and every read is audited
  (`source.read`). (Writes, when they come, are per kind: their approval cards differ.)
- Adapters (`DocumentAdapter` in `document-http.ts`: `connect`, `resolve`, `read`):
  - `notion.ts`: "under" follows Notion parents (pages, databases, blocks) up, at most 16 steps. A page is Markdown
    (at most 1,000 blocks, 3 nesting levels) plus its child pages and databases; a database, its 200 newest rows.
  - `google-drive.ts`: "under" follows Drive parents up. Docs export as `text/markdown` (falling back to
    `text/plain`), Sheets as CSV (first sheet), Slides as text; text files download as they are (512 KiB); folders list.
  - `feishu.ts`: Feishu names no parent of a file, so "under" searches down from the bound folder or wiki node (at
    most 40 listings). Docx documents read as `raw_content` plain text; folders and wiki nodes list; a wiki node holding
    a docx reads its text too. Older docs, sheets, bases and files are listed, not read.

The Google Drive and Feishu/Lark adapters were written from memory of their APIs (this sandbox reaches neither the
APIs nor their documentation) and are tested against fakes: verify endpoint shapes, error codes and permission scopes
against the real services before relying on them.

**Done: sign-in (OAuth) and three more kinds.** Members can connect a document source by signing in to the provider
(`apps/server/src/source-oauth.ts`), which Dropbox, OneDrive/SharePoint and Tencent Docs need (they have no app-scoped
secret to paste), and which spares Notion and Google members the integration and service-account setup.

- **Apps.** The operator registers one OAuth app per provider and sets its client id and secret
  (`GOOGLE_`, `NOTION_`, `DROPBOX_`, `MICROSOFT_` (+ `MICROSOFT_TENANT`), `TENCENT_DOCS_CLIENT_ID`/`_SECRET`). The
  redirect URI is `APP_ORIGIN/api/source-accounts/<provider>/oauth/callback`. `GET /api/source-accounts` lists which
  kinds offer sign-in (`oauth`); a kind without an app offers none, and sign-in-only kinds then don't show.
- **Flow.** `GET …/oauth/start` (the signed-in member, from the web app) stores a state and a PKCE verifier in
  `source_oauth_states` for that member and provider (10 minutes, one per member), sets the state in a `SameSite=Lax`
  cookie, and redirects to the provider (PKCE S256 for Google, Dropbox and Microsoft; offline access everywhere). The
  callback requires the cookie to equal the state, the state's row to be this member's for this provider and
  unexpired, deletes it (one use), exchanges the code, names the account, and stores the tokens encrypted with
  `source_accounts.method = 'oauth'`. It then redirects to the profile with `source_account`, `result` and `reason`,
  which the page shows once and removes from the address. A callback for another member, without the cookie, reused or
  forged links nothing.
- **Tokens.** The stored secret is `{ mode: 'oauth', accessToken, refreshToken?, expiresAt?, openId? }`. Before every
  resolve and read, `adapterSecret` refreshes an access token within a minute of expiry with the refresh token (keeping
  it where the provider doesn't send a new one), stores the result with a compare-and-swap on the old ciphertext (a
  concurrent refresh's result wins and is used), and gives the adapter only the access token (and, for Tencent Docs,
  the open id and app id its API wants). The refresh token goes only to the provider's token endpoint.
- **Adapters.** `dropbox.ts` (paths compared, the bound item re-read by id; Paper docs export as Markdown),
  `onedrive.ts` (Microsoft Graph; links via `/shares`; "under" follows `parentReference` within the drive; downloads
  follow Graph's redirect only to Microsoft download hosts, without the token), `tencent-docs.ts` (**unverified**:
  written from memory of the open platform; folders list, documents export to .docx and read as text, "under" searches
  down at most 40 listings). Word files read as their paragraphs through `office.ts` (a bounded ZIP reader for
  `word/document.xml`), in Dropbox, OneDrive, Google Drive and Tencent Docs exports. Notion and Google Drive adapters
  take a signed-in access token as well as their pasted secrets.

Like the Drive and Feishu adapters, these were written without access to the providers (the sandbox reaches none of
them) and are tested against fakes, the Tencent Docs one most tentatively: check endpoints, scopes and codes with real
accounts before relying on them.

Not yet: writes; document sources in workspace data exports; sign-in from the iPhone, iPad and Mac apps (the flow
needs the web app's cookie); revoking a provider's tokens when a member disconnects (the stored tokens are deleted).

## Open questions

- Is the main demand reading context (specs, notes) or writing documents back? Reading-only cuts the work roughly
  in half and avoids lossy round-trips.
- Which providers do actual users have? Notion and Google likely; Tencent Docs or Feishu for China-based teams.
