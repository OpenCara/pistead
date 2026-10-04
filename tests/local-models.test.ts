import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import test from 'node:test';
import { createModels } from '@earendil-works/pi-ai/models';
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { LocalModelSummary } from '../packages/shared/src/connector.js';
import type { ModelDefinition } from '../packages/shared/src/types.js';
import type { LocalPiOptions, LocalPiRuntime } from '../apps/runner/src/local-pi.js';
import { connectorLimits } from '../packages/shared/src/connector.js';
import { connectorManifest } from '../apps/runner/src/connector.js';
import { createFauxLocalModels, loadLocalPiModels, modelSummary } from '../apps/runner/src/local-pi.js';
import { runnerModels } from '../apps/runner/src/provider.js';

const secret = 'fixture-only-provider-credential-never-publish';
const nativeModel = {
  provider: 'native.fixture', id: 'regional/model-v2', name: 'Native fixture model',
  apiKey: secret, accessToken: secret, refreshToken: secret,
  headers: { authorization: `Bearer ${secret}` }, baseUrl: `https://model.invalid/${secret}`,
};

type CatalogEntry = { provider: string; id: string; name: string };

function definition(provider = nativeModel.provider, modelId = nativeModel.id): ModelDefinition {
  return { id: 'model', workspaceId: 'workspace', name: 'Workspace label', provider, modelId, connectorId: 'connector' };
}

function runtimeFixture(entries: readonly CatalogEntry[] = [nativeModel]) {
  const state = { entries, configured: new Set(entries.map(entry => entry.provider)), missingLookup: false };
  const lookups: [string, string][] = [];
  const forbidden: PropertyKey[] = [];
  const template = fauxProvider({ provider: nativeModel.provider, models: [{ id: nativeModel.id, name: nativeModel.name }] }).models[0];
  const api = Object.assign(createModels(), {
    getModels: (provider?: string) => state.entries
      .filter(entry => provider === undefined || entry.provider === provider)
      .map(entry => ({ ...template, ...entry })),
    hasConfiguredAuth: (provider: string) => state.configured.has(provider),
    getAvailable: async (provider?: string) => state.entries
      .filter(entry => state.configured.has(entry.provider) && (provider === undefined || entry.provider === provider))
      .map(entry => ({ ...template, ...entry })),
    getModel: (provider: string, modelId: string) => {
      lookups.push([provider, modelId]);
      const entry = state.entries.find(entry => entry.provider === provider && entry.id === modelId);
      return state.missingLookup || !entry ? undefined : { ...template, ...entry };
    },
  });
  // Preserve the full Models shape and exact identity, but fail if this boundary
  // reads auth, refreshes, streams, serializes, or enumerates non-chat models.
  const runtime: LocalPiRuntime = new Proxy(api, {
    get(target, property, receiver): unknown {
      if (property === 'then') return undefined;
      if (property === 'getModels' || property === 'getModel' || property === 'getAvailable') {
        return Reflect.get(target, property, receiver);
      }
      forbidden.push(property);
      throw new Error(`Unexpected fixture runtime access: ${String(property)}`);
    },
    ownKeys() {
      forbidden.push('ownKeys');
      throw new Error('The native runtime must not be copied or serialized');
    },
  });
  const configurations: Parameters<NonNullable<LocalPiOptions['runtimeFactory']>>[0][] = [];
  const runtimeFactory: NonNullable<LocalPiOptions['runtimeFactory']> = config => {
    configurations.push(config);
    return Promise.resolve(runtime);
  };
  return { runtime, runtimeFactory, configurations, state, lookups, forbidden };
}

test('native Pi chat resolution preserves the exact injected Models runtime without extracting credentials', async () => {
  const fixture = runtimeFixture();
  const local = await loadLocalPiModels({ runtimeFactory: fixture.runtimeFactory });
  assert.deepEqual(fixture.configurations, [{ refreshOnCreate: false, allowModelNetwork: false }]);
  const manifest = await local.manifest();
  assert.deepEqual(manifest, [{ provider: nativeModel.provider, modelId: nativeModel.id, name: nativeModel.name, thinkingLevels: ['off'] }]);
  assert.equal(JSON.stringify(manifest).includes(secret), false);
  assert.deepEqual(await connectorManifest(local), manifest);

  const resolved = await local.resolve(definition());
  assert.strictEqual(resolved.models, fixture.runtime);
  assert.equal(resolved.provider, nativeModel.provider);
  assert.equal(resolved.modelId, nativeModel.id);
  assert.deepEqual(Object.keys(resolved).sort(), ['modelId', 'models', 'provider']);
  assert.deepEqual(fixture.lookups, [[nativeModel.provider, nativeModel.id]]);
  assert.deepEqual(fixture.forbidden, []);
  assert.equal(fixture.configurations.length, 1);
});

test('an explicit agent directory is passed as config paths without reading fixture auth files', async () => {
  const fixture = runtimeFixture();
  const agentDir = resolve('fixture-only-nonexistent-pi-agent');
  await loadLocalPiModels({ agentDir, runtimeFactory: fixture.runtimeFactory });
  assert.deepEqual(fixture.configurations, [{
    authPath: join(agentDir, 'auth.json'), modelsPath: join(agentDir, 'models.json'),
    refreshOnCreate: false, allowModelNetwork: false,
  }]);
  assert.deepEqual(fixture.forbidden, []);
});

test('model summaries copy only public fields and never evaluate credential getters', () => {
  const extra = {
    provider: nativeModel.provider, modelId: nativeModel.id, name: nativeModel.name,
    get auth(): never { return assert.fail('auth metadata was read'); },
    get apiKey(): never { return assert.fail('API key metadata was read'); },
    get headers(): never { return assert.fail('provider headers were read'); },
    get toJSON(): never { return assert.fail('untrusted serialization hook was read'); },
  };
  const summary = modelSummary(extra);
  assert.deepEqual(summary, { provider: nativeModel.provider, modelId: nativeModel.id, name: nativeModel.name });
  assert.notStrictEqual(summary, extra);
  assert.doesNotThrow(() => JSON.stringify(summary));
});

test('model metadata rejects malformed provider, model ID and display name', () => {
  const valid: LocalModelSummary = { provider: 'native.fixture', modelId: 'region/model', name: 'Fixture' };
  const invalid: LocalModelSummary[] = [
    { ...valid, provider: '../provider' }, { ...valid, provider: 'bad provider' },
    { ...valid, provider: 'p'.repeat(129) }, { ...valid, modelId: '' },
    { ...valid, modelId: 'model\nsecret' }, { ...valid, modelId: 'two models' },
    { ...valid, modelId: 'm'.repeat(257) }, { ...valid, name: '   ' },
    { ...valid, name: 'name\u0000secret' }, { ...valid, name: 'n'.repeat(201) },
  ];
  for (const value of invalid) assert.throws(() => modelSummary(value), /Invalid local model metadata/);
});

test('catalog filters unauthenticated providers, deduplicates and sorts without mutating runtime metadata', async () => {
  const entries = [
    { provider: 'z-native', id: 'second', name: 'Z' },
    { provider: 'a-native', id: 'second', name: 'A second' },
    { provider: 'a-native', id: 'first', name: 'A first' },
    { provider: 'a-native', id: 'first', name: 'Duplicate ignored' },
    { provider: 'no-auth', id: 'hidden', name: 'Unavailable' },
  ];
  const before = structuredClone(entries);
  const fixture = runtimeFixture(entries);
  fixture.state.configured.delete('no-auth');
  const local = await loadLocalPiModels({ runtimeFactory: fixture.runtimeFactory });
  assert.deepEqual(await local.manifest(), [
    { provider: 'a-native', modelId: 'first', name: 'A first', thinkingLevels: ['off'] },
    { provider: 'a-native', modelId: 'second', name: 'A second', thinkingLevels: ['off'] },
    { provider: 'z-native', modelId: 'second', name: 'Z', thinkingLevels: ['off'] },
  ]);
  assert.deepEqual(entries, before);
  await assert.rejects(local.resolve(definition('no-auth', 'hidden')), /unavailable/);
  assert.deepEqual(fixture.lookups, []);
  assert.deepEqual(fixture.forbidden, []);
});

test('resolution rejects unknown IDs, provider mismatches, vanished models and revoked auth', async () => {
  const fixture = runtimeFixture();
  const local = await loadLocalPiModels({ runtimeFactory: fixture.runtimeFactory });
  await assert.rejects(local.resolve(definition(nativeModel.provider, 'missing')), /unavailable/);
  await assert.rejects(local.resolve(definition('another-native', nativeModel.id)), /unavailable/);
  await assert.rejects(local.resolve(definition('faux', 'fixture')), /unavailable/);
  assert.deepEqual(fixture.lookups, []);

  fixture.state.missingLookup = true;
  await assert.rejects(local.resolve(definition()), /unavailable/);
  fixture.state.missingLookup = false;
  fixture.state.configured.clear();
  assert.deepEqual(await local.manifest(), []);
  await assert.rejects(local.resolve(definition()), /unavailable/);
  assert.equal(fixture.lookups.length, 1);
  fixture.state.configured.add(nativeModel.provider);
  fixture.state.entries = [];
  await assert.rejects(local.resolve(definition()), /unavailable/);
  assert.deepEqual(fixture.forbidden, []);
});

test('explicit selections reject unavailable or unauthenticated IDs and are revalidated', async () => {
  const fixture = runtimeFixture();
  const selection = { provider: nativeModel.provider, modelId: nativeModel.id };
  await assert.rejects(loadLocalPiModels({ runtimeFactory: fixture.runtimeFactory, models: [{ ...selection, modelId: 'missing' }] }), /unavailable or lacks configured authentication/);
  fixture.state.configured.clear();
  await assert.rejects(loadLocalPiModels({ runtimeFactory: fixture.runtimeFactory, models: [selection] }), /unavailable or lacks configured authentication/);
  fixture.state.configured.add(nativeModel.provider);
  const local = await loadLocalPiModels({ runtimeFactory: fixture.runtimeFactory, models: [selection] });
  fixture.state.configured.clear();
  await assert.rejects(local.manifest(), /unavailable or lacks configured authentication/);
  await assert.rejects(local.resolve(definition()), /unavailable or lacks configured authentication/);
  assert.deepEqual(fixture.forbidden, []);
});

test('oversized native catalogs require a subset rather than silently truncating', async () => {
  const fixture = runtimeFixture(Array.from({ length: connectorLimits.models + 1 }, (_, index) => ({
    provider: 'native.fixture', id: `model-${index}`, name: `Model ${index}`,
  })));
  await assert.rejects(loadLocalPiModels({ runtimeFactory: fixture.runtimeFactory }), /exceeds 200 models/);
  const local = await loadLocalPiModels({
    runtimeFactory: fixture.runtimeFactory, models: [{ provider: 'native.fixture', modelId: 'model-200' }],
  });
  assert.deepEqual(await local.manifest(), [{ provider: 'native.fixture', modelId: 'model-200', name: 'Model 200', thinkingLevels: ['off'] }]);
  await assert.rejects(local.resolve(definition('native.fixture', 'model-0')), /unavailable/);
  assert.strictEqual((await local.resolve(definition('native.fixture', 'model-200'))).models, fixture.runtime);
});

test('faux is explicit fixture-only opt-in and never an unsupported-provider fallback', async () => {
  const local = createFauxLocalModels('chosen-fixture');
  assert.deepEqual(await local.manifest(), [{
    provider: 'faux', modelId: 'chosen-fixture', name: 'Deterministic test provider (not an LLM)', thinkingLevels: ['off'],
  }]);
  await assert.rejects(connectorManifest(local), /Invalid or disabled local model/);
  assert.deepEqual(await connectorManifest(local, true), await local.manifest());
  const resolved = await local.resolve(definition('faux', 'chosen-fixture'));
  assert.equal(resolved.provider, 'faux');
  assert.equal(resolved.modelId, 'chosen-fixture');
  assert.ok(resolved.models.getModel('faux', 'chosen-fixture'));
  await assert.rejects(local.resolve(definition('faux', 'other-fixture')), /fixture model is unavailable/);
  await assert.rejects(local.resolve(definition()), /fixture model is unavailable/);
  assert.throws(() => runnerModels(definition('faux', 'chosen-fixture'), false), /faux test provider is disabled/);
  for (const provider of ['native.fixture', 'unsupported', 'openai-compatible']) {
    for (const allowFaux of [false, true]) {
      assert.throws(() => runnerModels(definition(provider), allowFaux), /Unsupported legacy model provider/);
    }
  }
});

test('pinned ModelRuntime discovers selected configured models without catalog network refresh', async t => {
  const agentDir = await mkdtemp(join(tmpdir(), 'local-pi-config-fixture-'));
  t.after(() => rm(agentDir, { recursive: true, force: true }));
  const network = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('Fixture model discovery must not perform network requests');
  });
  const provider = 'fixture-configured';
  const keyless = 'fixture-keyless';
  const missing = 'fixture-unconfigured';
  const modelId = 'fixture-chat';
  const storedCredential = 'synthetic-fixture-key-not-a-real-provider-credential';
  const providerConfig = {
    api: 'openai-completions', baseUrl: 'http://127.0.0.1:9/v1',
    models: [{ id: modelId, name: 'Fixture configured chat' }],
  };
  const auth = JSON.stringify({ [provider]: { type: 'api_key', key: storedCredential } });
  await writeFile(join(agentDir, 'auth.json'), auth, { mode: 0o600 });
  await writeFile(join(agentDir, 'models.json'), JSON.stringify({
    providers: {
      [provider]: providerConfig,
      // Pi's custom-provider auth contract requires explicit configuration even
      // for a keyless compatible server: a non-secret local placeholder suffices.
      [keyless]: { ...providerConfig, apiKey: 'local-keyless-placeholder', authHeader: false },
      [missing]: { ...providerConfig, authHeader: false },
    },
  }), { mode: 0o600 });

  const local = await loadLocalPiModels({
    agentDir, models: [{ provider, modelId }, { provider: keyless, modelId }],
  });
  assert.deepEqual(await local.manifest(), [
    { provider, modelId, name: 'Fixture configured chat', thinkingLevels: ['off'] },
    { provider: keyless, modelId, name: 'Fixture configured chat', thinkingLevels: ['off'] },
  ]);
  const resolved = await local.resolve(definition(provider, modelId));
  assert.ok(resolved.models instanceof ModelRuntime);
  assert.equal(resolved.models.getModel(provider, modelId)?.id, modelId);
  assert.strictEqual((await local.resolve(definition(keyless, modelId))).models, resolved.models);
  assert.equal(JSON.stringify(await local.manifest()).includes(storedCredential), false);
  assert.equal(JSON.stringify(await local.manifest()).includes('local-keyless-placeholder'), false);
  assert.equal(await readFile(join(agentDir, 'auth.json'), 'utf8'), auth);
  await assert.rejects(loadLocalPiModels({
    agentDir, models: [{ provider: missing, modelId }],
  }), /unavailable or lacks configured authentication/);
  assert.equal(network.mock.callCount(), 0);
});
