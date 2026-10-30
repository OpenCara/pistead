import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { HTTPException } from 'hono/http-exception';
import { googleDriveAdapter } from '../apps/server/src/google-drive.js';
import { feishuAdapter } from '../apps/server/src/feishu.js';
import { fit } from '../apps/server/src/document-http.js';
import { feishuItem, googleDriveId, sourceReadLimits } from '../packages/shared/src/sources.js';

async function code(promise: Promise<unknown>): Promise<{ status: number; code: string }> {
  try { await promise; } catch (error) {
    assert.ok(error instanceof HTTPException, String(error));
    const body = await error.getResponse().json() as { code: string };
    return { status: error.status, code: body.code };
  }
  return assert.fail('expected a refusal');
}

test('Google Drive and Feishu items are named by their links or ids, and nothing else', () => {
  const id = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345';
  for (const value of [id, `https://drive.google.com/drive/folders/${id}`, `https://drive.google.com/drive/u/1/folders/${id}?usp=sharing`,
    `https://drive.google.com/file/d/${id}/view`, `https://docs.google.com/document/d/${id}/edit#heading=h.1`, `https://docs.google.com/spreadsheets/d/${id}/edit`,
    `https://docs.google.com/presentation/d/${id}/edit`, `https://drive.google.com/open?id=${id}`]) {
    assert.equal(googleDriveId(value), id, value);
  }
  for (const value of ['short', `https://evil.example/drive/folders/${id}`, `http://drive.google.com/drive/folders/${id}`, 'has space in it 0123456789', 42]) {
    assert.equal(googleDriveId(value), null, String(value));
  }
  const token = 'doxcnAbCdEfGhIjKlMn0123';
  assert.deepEqual(feishuItem(`https://acme.feishu.cn/docx/${token}`), { type: 'document', token });
  assert.deepEqual(feishuItem(`https://acme.larksuite.com/drive/folder/${token}?from=space`), { type: 'folder', token });
  assert.deepEqual(feishuItem(`https://acme.feishu.cn/wiki/${token}`), { type: 'wiki', token });
  assert.deepEqual(feishuItem(`docx:${token}`), { type: 'document', token });
  assert.deepEqual(feishuItem(`folder:${token}`), { type: 'folder', token });
  for (const value of [token, `https://feishu.cn.evil.example/docx/${token}`, `https://acme.feishu.cn/sheets/${token}`, `file:${token}`, 'docx:short']) {
    assert.equal(feishuItem(value), null, value);
  }
});

test('a view is cut to fit: entries first, then content', () => {
  const view = fit({ id: 'x', type: 'folder' as const, title: 't', url: 'u', lastEdited: '', truncated: false,
    entries: Array.from({ length: 300 }, (_, index) => ({ id: `id-${index}`, type: 'file' as const, title: 'é'.repeat(400) })), content: 'c'.repeat(200 * 1024) });
  assert.ok(Buffer.byteLength(JSON.stringify(view)) <= sourceReadLimits.bytes);
  assert.equal(view.entries?.length, 0);
  assert.ok(view.truncated && view.content!.length > 50 * 1024);
});

/** A fake Google: a token endpoint that checks the service account's signed assertion, and a Drive with a small tree. */
function googleFake(t: TestContext) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = { type: 'service_account', project_id: 'acme', private_key_id: 'abc123', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    client_email: 'reader@acme.iam.gserviceaccount.com', client_id: '1', token_uri: 'https://oauth2.googleapis.com/token' };
  const folder = 'application/vnd.google-apps.folder';
  const files: Record<string, { name: string; mimeType: string; parents: string[]; body?: string }> = {
    rootFolder0001: { name: 'Specs', mimeType: folder, parents: ['myDrive00001'] },
    subFolder00001: { name: 'Design', mimeType: folder, parents: ['rootFolder0001'] },
    designDoc00001: { name: 'Architecture', mimeType: 'application/vnd.google-apps.document', parents: ['subFolder00001'], body: '# Architecture\n\nThe plan.' },
    budgetSheet001: { name: 'Budget', mimeType: 'application/vnd.google-apps.spreadsheet', parents: ['rootFolder0001'], body: 'item,cost\nhosts,10' },
    notesFile00001: { name: 'notes.md', mimeType: 'text/markdown', parents: ['rootFolder0001'], body: 'plain notes' },
    photoFile00001: { name: 'photo.png', mimeType: 'image/png', parents: ['rootFolder0001'] },
    payrollDoc0001: { name: 'Payroll', mimeType: 'application/vnd.google-apps.document', parents: ['hrFolder00001'], body: 'secret' },
    hrFolder00001: { name: 'HR', mimeType: folder, parents: [] },
  };
  let issued = 0;
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? 'GET'} ${url.origin}${url.pathname}`);
    assert.equal(init?.redirect, 'manual');
    if (url.href === 'https://oauth2.googleapis.com/token') {
      const form = new URLSearchParams(String(init?.body));
      assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
      const [header, claims, signature] = form.get('assertion')!.split('.');
      const valid = verify('RSA-SHA256', Buffer.from(`${header}.${claims}`), publicKey, Buffer.from(signature!, 'base64url'));
      const body = JSON.parse(Buffer.from(claims!, 'base64url').toString());
      if (!valid || body.iss !== key.client_email) return Response.json({ error: 'invalid_grant' }, { status: 400 });
      assert.equal(body.scope, 'https://www.googleapis.com/auth/drive.readonly');
      assert.equal(body.aud, 'https://oauth2.googleapis.com/token');
      issued++;
      return Response.json({ access_token: 'ya29.fake-token', expires_in: 3600 });
    }
    assert.equal(url.origin, 'https://www.googleapis.com', 'The key and token go only to Google');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer ya29.fake-token');
    const path = url.pathname.replace('/drive/v3', '');
    if (path === '/about') return Response.json({ user: { emailAddress: key.client_email } });
    if (path === '/files') {
      const parent = url.searchParams.get('q')!.match(/^'([^']+)' in parents/)![1]!;
      return Response.json({ files: Object.entries(files).filter(([, file]) => file.parents.includes(parent))
        .map(([id, file]) => ({ id, name: file.name, mimeType: file.mimeType, webViewLink: `https://drive.google.com/open?id=${id}`, modifiedTime: '2026-10-01T00:00:00Z' })) });
    }
    const match = path.match(/^\/files\/([^/]+)(\/export)?$/);
    const file = match && files[match[1]!];
    if (!file) return Response.json({ error: { code: 404 } }, { status: 404 });
    if (match![2]) {
      const mimeType = url.searchParams.get('mimeType');
      if (file.mimeType.endsWith('document') && mimeType !== 'text/markdown') return new Response('wrong format', { status: 400 });
      return new Response(file.body ?? '', { headers: { 'Content-Type': mimeType ?? 'text/plain' } });
    }
    if (url.searchParams.get('alt') === 'media') return new Response(file.body ?? '');
    return Response.json({ id: match![1], name: file.name, mimeType: file.mimeType, parents: file.parents, webViewLink: `https://drive.google.com/open?id=${match![1]}`, modifiedTime: '2026-10-01T00:00:00Z' });
  });
  return { key, calls, issued: () => issued };
}

test('a Google Drive service account reads the folders, Docs, Sheets and text files under the bound folder, and nothing else', async t => {
  const google = googleFake(t);
  assert.deepEqual(await code(googleDriveAdapter.connect({ key: '{"type":"authorized_user"}' })), { status: 400, code: 'invalid_source_account' });
  assert.deepEqual(await code(googleDriveAdapter.connect({ key: JSON.stringify({ ...google.key, token_uri: 'https://evil.example/token' }) })), { status: 400, code: 'invalid_source_account' });
  const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  assert.deepEqual(await code(googleDriveAdapter.connect({ key: JSON.stringify({ ...google.key, private_key: other }) })), { status: 403, code: 'source_account_rejected' });
  const { secret, name } = await googleDriveAdapter.connect({ key: JSON.stringify(google.key) });
  assert.equal(name, 'reader@acme.iam.gserviceaccount.com');
  assert.deepEqual(Object.keys(JSON.parse(secret)).sort(), ['client_email', 'private_key', 'private_key_id'], 'Only what signing needs is kept');

  const root = await googleDriveAdapter.resolve(secret, 'https://drive.google.com/drive/folders/rootFolder0001?usp=sharing');
  assert.deepEqual([root.id, root.type, root.title], ['rootFolder0001', 'folder', 'Specs']);
  const listing = await googleDriveAdapter.read(secret, root, null);
  assert.deepEqual(listing.entries?.map(entry => [entry.id, entry.type]), [['subFolder00001', 'folder'], ['budgetSheet001', 'spreadsheet'], ['notesFile00001', 'file'], ['photoFile00001', 'file']]);
  const doc = await googleDriveAdapter.read(secret, root, 'https://docs.google.com/document/d/designDoc00001/edit');
  assert.deepEqual([doc.type, doc.title, doc.content], ['document', 'Architecture', '# Architecture\n\nThe plan.']);
  const sheet = await googleDriveAdapter.read(secret, root, 'budgetSheet001');
  assert.equal(sheet.content, 'item,cost\nhosts,10');
  assert.equal((await googleDriveAdapter.read(secret, root, 'notesFile00001')).content, 'plain notes');
  const photo = await googleDriveAdapter.read(secret, root, 'photoFile00001');
  assert.equal(photo.content, undefined);
  assert.match(photo.note!, /binary file \(image\/png\)/);
  // The service account can read it, but it isn't under the bound folder.
  assert.deepEqual(await code(googleDriveAdapter.read(secret, root, 'payrollDoc0001')), { status: 403, code: 'source_outside' });
  assert.deepEqual(await code(googleDriveAdapter.read(secret, root, 'missingFile001')), { status: 404, code: 'source_item_not_found' });
  assert.deepEqual(await code(googleDriveAdapter.read(secret, root, 'not an id')), { status: 400, code: 'invalid_input' });
  // One token served every read: it is kept until shortly before it expires.
  assert.equal(google.issued(), 1);
});

/** A fake Feishu: a tenant token for one app, a folder tree with a docx, and a wiki node with a child page. */
function feishuFake(t: TestContext, origin = 'https://open.feishu.cn') {
  const app = { appId: 'cli_a1b2c3d4e5f6g7h8', appSecret: 'S3cr3tS3cr3tS3cr3tS3cr3tS3cr3t00' };
  const ok = (data: unknown) => Response.json({ code: 0, msg: 'success', data });
  const folders: Record<string, { name: string; files: { token: string; type: string; name: string }[] }> = {
    fldRoot0000001: { name: 'Specs', files: [{ token: 'fldSub00000001', type: 'folder', name: 'Design' }, { token: 'shtBudget00001', type: 'sheet', name: 'Budget' }] },
    fldSub00000001: { name: 'Design', files: [{ token: 'doxArch0000001', type: 'docx', name: 'Architecture' }] },
  };
  const docs: Record<string, { title: string; content: string }> = {
    doxArch0000001: { title: 'Architecture', content: 'The plan.\n' },
    doxWiki0000001: { title: 'Runbook', content: 'Restart it.\n' },
    doxSecret00001: { title: 'Payroll', content: 'secret' },
  };
  const calls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    assert.equal(url.origin, origin, 'The app secret and tokens go only to the chosen platform');
    assert.equal(init?.redirect, 'manual');
    const path = url.pathname.replace('/open-apis', '');
    if (path === '/auth/v3/tenant_access_token/internal') {
      const body = JSON.parse(String(init?.body));
      return body.app_id === app.appId && body.app_secret === app.appSecret ? Response.json({ code: 0, tenant_access_token: 't-fake', expire: 7200 }) : Response.json({ code: 10014, msg: 'app secret invalid' });
    }
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer t-fake');
    if (path === '/drive/v1/files') {
      const folder = folders[url.searchParams.get('folder_token')!];
      return folder ? ok({ files: folder.files.map(file => ({ ...file, url: `https://acme.feishu.cn/${file.type}/${file.token}` })), has_more: false }) : Response.json({ code: 1061004, msg: 'forbidden' });
    }
    const meta = path.match(/^\/drive\/explorer\/v2\/folder\/([^/]+)\/meta$/);
    if (meta) return folders[meta[1]!] ? ok({ name: folders[meta[1]!]!.name, token: meta[1] }) : Response.json({ code: 1061004, msg: 'forbidden' });
    const doc = path.match(/^\/docx\/v1\/documents\/([^/]+)(\/raw_content)?$/);
    if (doc) {
      const found = docs[doc[1]!];
      if (!found) return Response.json({ code: 1770032, msg: 'forbidden' });
      return ok(doc[2] ? { content: found.content } : { document: { document_id: doc[1], title: found.title } });
    }
    if (path === '/wiki/v2/spaces/get_node') {
      const token = url.searchParams.get('token');
      if (token === 'wikRoot0000001') return ok({ node: { space_id: '7000', node_token: token, obj_token: 'doxWiki0000001', obj_type: 'docx', title: 'Ops', has_child: true } });
      if (token === 'wikChild000001') return ok({ node: { space_id: '7000', node_token: token, obj_token: 'doxWiki0000001', obj_type: 'docx', title: 'Runbook', has_child: false } });
      return Response.json({ code: 131005, msg: 'not found' });
    }
    if (path === '/wiki/v2/spaces/7000/nodes') {
      return ok({ items: url.searchParams.get('parent_node_token') === 'wikRoot0000001'
        ? [{ space_id: '7000', node_token: 'wikChild000001', obj_token: 'doxWiki0000001', obj_type: 'docx', title: 'Runbook', has_child: false }] : [], has_more: false });
    }
    return assert.fail(`unexpected Feishu call ${path}`);
  });
  return { app, calls };
}

test('a Feishu/Lark app reads the docx documents, folders and wiki pages under the bound item, and nothing else', async t => {
  const feishu = feishuFake(t);
  assert.deepEqual(await code(feishuAdapter.connect({ appId: 'not-an-app', appSecret: 'x' })), { status: 400, code: 'invalid_source_account' });
  assert.deepEqual(await code(feishuAdapter.connect({ appId: feishu.app.appId, appSecret: 'WrongWrongWrongWrongWrong000000', domain: 'feishu' })), { status: 403, code: 'source_account_rejected' });
  const { secret, name } = await feishuAdapter.connect({ ...feishu.app, domain: 'feishu' });
  assert.equal(name, `Feishu app ${feishu.app.appId}`);

  const folder = await feishuAdapter.resolve(secret, 'https://acme.feishu.cn/drive/folder/fldRoot0000001');
  assert.deepEqual([folder.id, folder.type, folder.title, folder.url], ['folder:fldRoot0000001', 'folder', 'Specs', 'https://acme.feishu.cn/drive/folder/fldRoot0000001']);
  const listing = await feishuAdapter.read(secret, folder, null);
  assert.deepEqual(listing.entries?.map(entry => [entry.id, entry.type]), [['folder:fldSub00000001', 'folder'], ['sheet:shtBudget00001', 'spreadsheet']]);
  // A document two folders down is found by searching down from the bound folder.
  const doc = await feishuAdapter.read(secret, folder, 'docx:doxArch0000001');
  assert.deepEqual([doc.type, doc.title, doc.content], ['document', 'Architecture', 'The plan.\n']);
  assert.deepEqual(await code(feishuAdapter.read(secret, folder, 'https://acme.feishu.cn/docx/doxSecret00001')), { status: 403, code: 'source_outside' });
  assert.deepEqual(await code(feishuAdapter.read(secret, folder, 'wiki:wikRoot0000001')), { status: 403, code: 'source_outside' });
  assert.deepEqual(await code(feishuAdapter.read(secret, folder, 'sheet:shtBudget00001')), { status: 400, code: 'invalid_input' });

  const wiki = await feishuAdapter.resolve(secret, 'https://acme.feishu.cn/wiki/wikRoot0000001');
  const ops = await feishuAdapter.read(secret, wiki, null);
  assert.deepEqual([ops.type, ops.title, ops.content, ops.entries], ['wiki', 'Ops', 'Restart it.\n', [{ id: 'wiki:wikChild000001', type: 'wiki', title: 'Runbook' }]]);
  assert.equal((await feishuAdapter.read(secret, wiki, 'wiki:wikChild000001')).title, 'Runbook');

  // A single bound document reads only itself.
  const single = await feishuAdapter.resolve(secret, 'docx:doxArch0000001');
  assert.equal((await feishuAdapter.read(secret, single, null)).content, 'The plan.\n');
  assert.deepEqual(await code(feishuAdapter.read(secret, single, 'docx:doxWiki0000001')), { status: 403, code: 'source_outside' });
  assert.deepEqual(await code(feishuAdapter.resolve(secret, 'https://acme.feishu.cn/docx/doxMissing0001')), { status: 404, code: 'source_item_not_found' });
});

test('a Lark app talks only to open.larksuite.com', async t => {
  const lark = feishuFake(t, 'https://open.larksuite.com');
  const { secret, name } = await feishuAdapter.connect({ ...lark.app, domain: 'lark' });
  assert.equal(name, `Lark app ${lark.app.appId}`);
  const doc = await feishuAdapter.resolve(secret, 'docx:doxArch0000001');
  assert.equal(doc.url, 'https://www.larksuite.com/docx/doxArch0000001');
});

