import type { Hono } from 'hono';
import type { ConnectorCapabilities, HostModelSettings, LocalModelSummary } from '../../../packages/shared/src/connector.js';
import type { ChatOptions } from '../../../packages/shared/src/types.js';
import type { AppContext, Env, SessionRow, WorkerEnv } from './types.js';
import { auditAfterChange } from './db.js';
import { fail, jsonObject, now, text } from './http.js';
import { managedConnector, managedConnectorFor, managesConnectorSQL } from './host-access.js';

/*
 * Which of its models a host offers. A host advertises the models Pi on it is configured to offer; its owner and its
 * admins can disable some of them, for everyone who uses the host, the owner included, in every workspace. A disabled
 * model is listed only to them, as disabled: no picker offers it, no session starts from one or moves onto one, and no
 * message switches to one. Sessions already on it keep their history and go on with another model: while its host has a
 * disabled model, each message names the model it runs on (requireEnabledModel).
 */

/** Disabled models are kept apart from the advertised list, so their number is bounded on its own. */
const maxDisabledModels = 1000;

const modelKey = (provider: string, modelId: string) => JSON.stringify([provider, modelId]);

/**
 * SQL true while the models row `model` (an alias) isn't disabled on the connector `connector` (an SQL expression for its
 * id). Binds nothing.
 */
export function modelEnabledSQL(connector: string, model: string): string {
  return `NOT EXISTS (SELECT 1 FROM connector_disabled_models off
    WHERE off.connector_id = ${connector} AND off.provider = ${model}.provider AND off.model_id = ${model}.model_id)`;
}

/** The connector's disabled models, by `provider` and `modelId`, whether or not it still advertises them. */
export async function disabledModelKeys(env: Env, connectorId: string): Promise<Set<string>> {
  const rows = await env.DB.query<{ provider: string; model_id: string }>('SELECT provider, model_id FROM connector_disabled_models WHERE connector_id = ?')
    .bind(connectorId).all();
  return new Set(rows.map(row => modelKey(row.provider, row.model_id)));
}

/** The advertised `models` the host offers, and those its owner or an admin disabled, each in advertised order. */
export function hostModelSettings(models: readonly LocalModelSummary[], disabled: ReadonlySet<string>): HostModelSettings {
  const off = (model: LocalModelSummary) => disabled.has(modelKey(model.provider, model.modelId));
  return { models: models.filter(model => !off(model)), disabledModels: models.filter(off) };
}

/** Whether `model` is one of `disabled`. */
export function isModelDisabled(disabled: ReadonlySet<string>, model: { provider: string; modelId: string }): boolean {
  return disabled.has(modelKey(model.provider, model.modelId));
}

/**
 * A message runs on one of its host's enabled models. chatOptions refuses a disabled model that a message names. One that
 * names none runs on the conversation's current model, which only the host knows, so while the host advertises a model
 * its owner or an admin disabled, a message must name its model (the apps always do when the host can switch models).
 * A host that can't switch models runs every message on the session's own model, which must then be enabled.
 */
export async function requireEnabledModel(c: AppContext, row: SessionRow, options: ChatOptions | undefined): Promise<void> {
  if (!row.connector_id || options?.model) return;
  const host = await c.env.DB.query<{ models_json: string; capabilities_json: string }>('SELECT models_json, capabilities_json FROM connectors WHERE id = ?')
    .bind(row.connector_id).first();
  // A host that is gone serves no message; the request to it says so.
  if (!host) return;
  const disabled = hostModelSettings(JSON.parse(host.models_json) as LocalModelSummary[], await disabledModelKeys(c.env, row.connector_id)).disabledModels;
  if (!disabled.length) return;
  if ((JSON.parse(host.capabilities_json) as ConnectorCapabilities).chatOptions === true) {
    fail(409, 'model_required', 'Some of this host\'s models are disabled, so each message names the model it runs on. Choose a model and send it again.');
  }
  const own = await c.env.DB.query<{ provider: string; model_id: string }>(`SELECT m.provider, m.model_id FROM agent_versions a
    JOIN models m ON m.id = a.model_id WHERE a.id = ?`).bind(row.agent_version_id).first();
  if (own && disabled.some(model => model.provider === own.provider && model.modelId === own.model_id)) {
    fail(409, 'model_disabled', 'This session\'s model is disabled on its host. Ask the host\'s owner or an admin to enable it.');
  }
}

export function registerHostModels(app: Hono<WorkerEnv>): void {
  // The host's owner or an admin enables or disables one of its models, for everyone who uses the host.
  app.patch('/api/connectors/:id/models', async c => {
    const actorId = c.get('auth').userId;
    const row = await managedConnector(c);
    if (row.revoked_at) fail(409, 'connector_revoked', 'Connector is revoked.');
    const input = await jsonObject(c, 4096);
    if (Object.keys(input).some(field => !['provider', 'modelId', 'enabled'].includes(field)) || typeof input.enabled !== 'boolean') {
      fail(400, 'invalid_model_setting', 'Name the model by provider and modelId, and set enabled to true or false.');
    }
    const provider = text(input.provider, 'provider', 80);
    const modelId = text(input.modelId, 'modelId', 200);
    const enabled = input.enabled;
    const detail = { connectorId: row.id, provider, modelId };
    // Each write checks again that the host is live and the actor still manages it; only a change is audited.
    const live = `c.id = ? AND c.revoked_at IS NULL AND c.removed_at IS NULL AND ${managesConnectorSQL}`;
    await c.env.DB.batch(enabled ? [
      // Enabling lifts the setting, whether or not the host still advertises the model.
      c.env.DB.query(`DELETE FROM connector_disabled_models WHERE connector_id = ? AND provider = ? AND model_id = ?
        AND EXISTS (SELECT 1 FROM connectors c WHERE ${live})`)
        .bind(row.id, provider, modelId, row.id, actorId, actorId),
      auditAfterChange(c.env, actorId, 'connector.model.enabled', null, detail),
    ] : [
      // Only a model the host advertises now can be disabled.
      c.env.DB.query(`INSERT INTO connector_disabled_models (connector_id, provider, model_id, disabled_by, disabled_at)
        SELECT c.id, ?, ?, ?, ? FROM connectors c WHERE ${live}
          AND EXISTS (SELECT 1 FROM json_each(c.models_json) local
            WHERE json_extract(local.value, '$.provider') = ? AND json_extract(local.value, '$.modelId') = ?)
          AND (SELECT COUNT(*) FROM connector_disabled_models WHERE connector_id = c.id) < ?
        ON CONFLICT (connector_id, provider, model_id) DO NOTHING`)
        .bind(provider, modelId, actorId, now(), row.id, actorId, actorId, provider, modelId, maxDisabledModels),
      auditAfterChange(c.env, actorId, 'connector.model.disabled', null, detail),
    ]);
    // Answer with the host as it is now, which also tells an unchanged request from a refused one.
    const current = await managedConnectorFor(c.env, row.id, actorId);
    if (!current) fail(404, 'not_found', 'Connector not found.');
    if (current.revoked_at) fail(409, 'connector_revoked', 'Connector is revoked.');
    const advertised = JSON.parse(current.models_json) as LocalModelSummary[];
    const disabled = await disabledModelKeys(c.env, current.id);
    if (!enabled && !isModelDisabled(disabled, { provider, modelId })) {
      if (!advertised.some(model => model.provider === provider && model.modelId === modelId)) fail(404, 'model_not_on_host', 'This host doesn\'t offer that model.');
      fail(409, 'model_limit', `A host keeps at most ${maxDisabledModels} disabled models.`);
    }
    return c.json(hostModelSettings(advertised, disabled));
  });
}
