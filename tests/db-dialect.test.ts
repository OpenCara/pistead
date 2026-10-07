import assert from 'node:assert/strict';
import test from 'node:test';
import { statementShape, translateToPostgres } from '../apps/server/src/db/sql.js';

// Statements below are copied from the application so the translation is exercised on real shapes.

test('placeholders become $n and skip question marks inside string literals and comments', () => {
  const statement = translateToPostgres(`SELECT 'what?' AS q, "Odd?Name", id -- trailing ? comment
    FROM audit /* block ? */ WHERE action = ? AND detail_json <> 'it''s ?' AND id = ?`);
  assert.equal(statement.placeholders, 2);
  assert.match(statement.text, /action = \$1 AND detail_json <> 'it''s \?' AND id = \$2/);
  assert.match(statement.text, /'what\?' AS q, "Odd\?Name", id -- trailing \? comment/);
  assert.equal(statement.changes, false);
});

test('json_each and json_extract (connectors.ts model sync) use jsonb set-returning functions', () => {
  const sql = `INSERT INTO models
      (id, workspace_id, name, provider, model_id, created_at, connector_id, connector_owner_id, available)
      SELECT lower(hex(randomblob(16))), cw.workspace_id, json_extract(local.value, '$.name'),
        json_extract(local.value, '$.provider'), json_extract(local.value, '$.modelId'), ?, c.id, c.owner_id, 1
      FROM connectors c JOIN connector_workspaces cw ON cw.connector_id = c.id
      JOIN workspace_members m ON m.workspace_id = cw.workspace_id AND m.user_id = c.owner_id
      JOIN json_each(c.models_json) local
      WHERE c.id = ? AND c.revoked_at IS NULL AND c.models_json = ? AND (? IS NULL OR cw.workspace_id = ?)
      ON CONFLICT (workspace_id, connector_id, provider, model_id) DO UPDATE SET name = excluded.name, available = 1`;
  const { text, placeholders } = translateToPostgres(sql);
  assert.equal(placeholders, 5);
  assert.match(text, /SELECT replace\(gen_random_uuid\(\)::text, '-', ''\), cw\.workspace_id, \(\(local\.value\)::jsonb ->> 'name'\)/);
  assert.match(text, /\(\(local\.value\)::jsonb ->> 'modelId'\), \$1, c\.id/);
  // A bare JOIN without ON is a cross join in SQLite; Postgres needs it spelled out.
  assert.match(text, /CROSS JOIN jsonb_array_elements_text\(\(c\.models_json\)::jsonb\) local\n/);
  assert.match(text, /\(\$4::text IS NULL OR cw\.workspace_id = \$5\)/);
  assert.match(text, /ON CONFLICT \(workspace_id, connector_id, provider, model_id\) DO UPDATE SET name = excluded\.name/);
});

test('json_each with a bound array (approval-reviews.ts) and nested paths', () => {
  const { text } = translateToPostgres(`SELECT * FROM approval_reviews WHERE session_id = ?
    AND approval_id IN (SELECT value FROM json_each(?))`);
  assert.match(text, /IN \(SELECT value FROM jsonb_array_elements_text\(\(\$2\)::jsonb\)\)/);
  assert.equal(translateToPostgres("SELECT json_extract(binding_json, '$.a.b') FROM restore_jobs").text,
    "SELECT ((binding_json)::jsonb #>> '{a,b}') FROM restore_jobs");
  assert.throws(() => translateToPostgres("SELECT json_extract(x, '$[0]')"), /literal JSON paths/);
});

test('IS with a bound value or column (connector-hub.ts, run-admissions.ts) becomes IS NOT DISTINCT FROM', () => {
  const update = translateToPostgres(`UPDATE connectors SET connection_hash = ?, last_seen_at = ?
      WHERE id = ? AND credential_hash = ? AND revoked_at IS NULL AND connection_hash IS ?`);
  assert.match(update.text, /revoked_at IS NULL AND connection_hash IS NOT DISTINCT FROM \$5$/);
  const guard = translateToPostgres(`SELECT 1 FROM sessions s JOIN models m ON m.id = ?
    WHERE s.connector_id IS ? AND m.connector_id IS s.connector_id AND m.owner IS NOT s.owner AND s.x IS NOT NULL AND s.y IS NOT DISTINCT FROM ?`);
  assert.equal(guard.text, `SELECT 1 FROM sessions s JOIN models m ON m.id = $1
    WHERE s.connector_id IS NOT DISTINCT FROM $2 AND m.connector_id IS NOT DISTINCT FROM s.connector_id AND m.owner IS DISTINCT FROM s.owner AND s.x IS NOT NULL AND s.y IS NOT DISTINCT FROM $3`);
});

test('ON CONFLICT … RETURNING (git/accounts.ts) passes through with renumbered placeholders', () => {
  const { text, placeholders } = translateToPostgres(`INSERT INTO git_credentials (id, user_id, provider, host, organization, username, login, ciphertext, created_at, updated_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM users WHERE id = ? AND (? = 1 OR auth_kind <> 'test'))
      ON CONFLICT (user_id, provider, host, organization) DO UPDATE SET username = excluded.username, login = excluded.login,
        ciphertext = excluded.ciphertext, updated_at = excluded.updated_at
      RETURNING id, provider, host, organization, login, created_at`);
  assert.equal(placeholders, 12);
  assert.match(text, /SELECT \$1, \$2, \$3, \$4, \$5, \$6, \$7, \$8, \$9, \$10\n/);
  assert.match(text, /WHERE id = \$11 AND \(\$12 = 1 OR auth_kind <> 'test'\)/);
  assert.match(text, /ON CONFLICT \(user_id, provider, host, organization\) DO UPDATE SET username = excluded\.username/);
  assert.match(text, /RETURNING id, provider, host, organization, login, created_at$/);
});

test('CTE insert (run-admissions.ts) keeps WITH and aliases the unaliased FROM subqueries', () => {
  const sql = `WITH eligible AS (SELECT s.id FROM sessions s
    JOIN session_grants g, json_each(g.permissions_json) permission ON g.session_id = s.id
    WHERE s.id = ? AND permission.value = 'write')
    INSERT INTO run_admissions (id, session_id, actor_id, mode, request_id, content_hash, expires_at, created_at, access)
    SELECT ?, eligible.id, ?, 'write', ?, ?, ?, ?, ? FROM eligible
    WHERE (SELECT COUNT(*) FROM (
      SELECT 1 FROM run_admissions WHERE session_id = ? AND actor_id = ? AND expires_at > ? LIMIT ?
    )) < ?
    ON CONFLICT(session_id, actor_id, request_id) DO NOTHING`;
  const { text, placeholders } = translateToPostgres(sql);
  assert.equal(placeholders, 13);
  assert.match(text, /^WITH eligible AS \(SELECT s\.id FROM sessions s\n/);
  assert.match(text, /jsonb_array_elements_text\(\(g\.permissions_json\)::jsonb\) permission ON g\.session_id = s\.id/);
  assert.match(text, /SELECT \$2, eligible\.id, \$3, 'write', \$4, \$5, \$6, \$7, \$8 FROM eligible/);
  assert.match(text, /LIMIT \$12\n\s+\) AS sq1\) < \$13/);
  assert.equal(statementShape(sql).write, true);
  assert.equal(statementShape(sql).returning, false);
});

test('changes() (catalog.ts audit guard) binds one extra parameter after the placeholders', () => {
  const statement = translateToPostgres(`INSERT INTO audit (id, workspace_id, session_id, actor_id, action, detail_json, created_at)
    SELECT ?, ?, NULL, ?, ?, ?, ? WHERE changes() = 1`);
  assert.equal(statement.changes, true);
  assert.equal(statement.placeholders, 6);
  assert.match(statement.text, /SELECT \$1, \$2, NULL, \$3, \$4, \$5, \$6 WHERE \$7 = 1$/);
});

test('json aggregate, canonical json() comparison, json_type and json_set (sessions.ts, connectors.ts, push/identities.ts)', () => {
  const same = translateToPostgres(`SELECT 1 WHERE (SELECT json_group_array(id ORDER BY id) FROM workspace_repositories WHERE workspace_id = ?) = json(?)`);
  assert.equal(same.text, `SELECT 1 WHERE (SELECT COALESCE(jsonb_agg(id ORDER BY id), '[]'::jsonb)::text FROM workspace_repositories WHERE workspace_id = $1) = (($2)::jsonb::text)`);
  const arrays = translateToPostgres(`SELECT CASE WHEN c.owner_id = ? THEN json_array(cw.workspace_id) ELSE json_array() END AS workspace_ids`);
  assert.equal(arrays.text, `SELECT CASE WHEN c.owner_id = $1 THEN jsonb_build_array(cw.workspace_id)::text ELSE jsonb_build_array()::text END AS workspace_ids`);
  const type = translateToPostgres(`SELECT 1 WHERE (? = 0 OR json_type(host.capabilities_json, '$.gitPush') = 'true')`);
  assert.match(type.text, /CASE jsonb_typeof\(\(\(host\.capabilities_json\)::jsonb #> '\{gitPush\}'\)\) WHEN 'boolean' THEN/);
  assert.match(type.text, /END\) = 'true'\)$/);
  const set = translateToPostgres(`UPDATE push_identities SET secret_ciphertext = ?, config_json = json_set(config_json, '$.login', ?), status = 'ready' WHERE id = ?`);
  assert.equal(set.text, `UPDATE push_identities SET secret_ciphertext = $1, config_json = jsonb_set((config_json)::jsonb, '{login}', to_jsonb($2::text))::text, status = 'ready' WHERE id = $3`);
});

test('COLLATE NOCASE is dropped and mixed-case aliases are quoted (repositories.ts, catalog.ts)', () => {
  const insert = translateToPostgres(`SELECT 1 FROM workspace_repositories WHERE workspace_id = ? AND (repository_id = ? OR full_name = ? COLLATE NOCASE)`);
  assert.equal(insert.text, `SELECT 1 FROM workspace_repositories WHERE workspace_id = $1 AND (repository_id = $2 OR full_name = $3 )`);
  const members = translateToPostgres(`SELECT member.user_id AS userId, u.display_name AS displayName, member.role FROM workspace_members member ORDER BY userId`);
  assert.equal(members.text, `SELECT member.user_id AS "userId", u.display_name AS "displayName", member.role FROM workspace_members member ORDER BY "userId"`);
});

test('translation is memoized per statement text', () => {
  const sql = 'SELECT ? AS a';
  assert.equal(translateToPostgres(sql), translateToPostgres(sql));
});

test('statementShape classifies reads, writes and RETURNING', () => {
  assert.deepEqual(statementShape('SELECT * FROM users WHERE id = ?'), { write: false, returning: false });
  assert.deepEqual(statementShape('DELETE FROM oauth_states WHERE state_hash = ? RETURNING verifier, expires_at'), { write: true, returning: true });
  assert.deepEqual(statementShape('INSERT INTO audit (id) SELECT id FROM users WHERE 1 = 1'), { write: true, returning: false });
  assert.deepEqual(statementShape('WITH eligible AS (SELECT 1) SELECT * FROM eligible'), { write: false, returning: false });
  assert.deepEqual(statementShape("SELECT 'RETURNING' FROM users"), { write: false, returning: false });
});
