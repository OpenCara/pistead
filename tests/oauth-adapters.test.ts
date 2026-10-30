import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import test, { type TestContext } from 'node:test';
import { HTTPException } from 'hono/http-exception';
import { docxText } from '../apps/server/src/office.js';
import { onedriveAdapter } from '../apps/server/src/onedrive.js';
import { tencentDocsAdapter } from '../apps/server/src/tencent-docs.js';
import { oauthSecret } from '../apps/server/src/source-oauth.js';
import { dropboxItem, onedriveItem, tencentDocsItem } from '../packages/shared/src/sources.js';

async function code(promise: Promise<unknown>): Promise<{ status: number; code: string }> {
  try { await promise; } catch (error) {
    assert.ok(error instanceof HTTPException, String(error));
    return { status: error.status, code: (await error.getResponse().json() as { code: string }).code };
  }
  return assert.fail('expected a refusal');
}

/** A minimal .docx: a ZIP with word/document.xml (deflated) and one stored part before it. */
function docx(xml: string): Uint8Array<ArrayBuffer> {
  const parts = [{ name: '[Content_Types].xml', data: Buffer.from('<Types/>'), method: 0 }, { name: 'word/document.xml', data: Buffer.from(xml), method: 8 }];
  const locals: Buffer[] = []; const centrals: Buffer[] = [];
  let offset = 0;
  for (const part of parts) {
    const name = Buffer.from(part.name);
    const body = part.method === 8 ? deflateRawSync(part.data) : part.data;
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(part.method, 8);
    local.writeUInt32LE(body.length, 18); local.writeUInt32LE(part.data.length, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 6); central.writeUInt16LE(part.method, 10);
    central.writeUInt32LE(body.length, 20); central.writeUInt32LE(part.data.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, name, body); centrals.push(central, name);
    offset += 30 + name.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(parts.length, 8); end.writeUInt16LE(parts.length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Uint8Array.from(Buffer.concat([...locals, directory, end]));
}

const wordXml = '<?xml version="1.0"?><w:document xmlns:w="w"><w:body><w:p><w:r><w:t>Goals</w:t></w:r></w:p>'
  + '<w:p><w:r><w:t xml:space="preserve">Ship </w:t></w:r><w:r><w:t>it &amp; tell &lt;everyone&gt;</w:t><w:tab/><w:t>&#8364;5</w:t></w:r></w:p></w:body></w:document>';

test('a Word document reads as its paragraphs; anything else is no document', () => {
  assert.equal(docxText(docx(wordXml)), 'Goals\nShip it & tell <everyone>\t€5');
  assert.equal(docxText(new TextEncoder().encode('not a zip')), null);
  assert.equal(docxText(new Uint8Array(0)), null);
});

test('Dropbox, OneDrive and Tencent Docs items are named by their links, paths or ids', () => {
  assert.deepEqual(dropboxItem('/Specs/Design/'), { path: '/Specs/Design' });
  assert.deepEqual(dropboxItem('id:a4ayc_80_OEAAAAAAAAAXw'), { path: 'id:a4ayc_80_OEAAAAAAAAAXw' });
  assert.deepEqual(dropboxItem('https://www.dropbox.com/home/Specs/Design'), { path: '/Specs/Design' });
  assert.deepEqual(dropboxItem('https://www.dropbox.com/scl/fo/abc123/xyz?rlkey=k&dl=0'), { url: 'https://www.dropbox.com/scl/fo/abc123/xyz?rlkey=k&dl=0' });
  for (const value of ['Specs', '/a/../b', 'https://evil.example/home/x', 'id:short']) assert.equal(dropboxItem(value), null, value);
  assert.deepEqual(onedriveItem('b!AbC-12_x~01BYE5RZ6QN3ZWBTUFOFD3GSPGOHDJD36K'), { driveId: 'b!AbC-12_x', itemId: '01BYE5RZ6QN3ZWBTUFOFD3GSPGOHDJD36K' });
  assert.deepEqual(onedriveItem('https://contoso.sharepoint.com/:f:/s/team/EabC'), { url: 'https://contoso.sharepoint.com/:f:/s/team/EabC' });
  assert.deepEqual(onedriveItem('https://1drv.ms/f/s!Abc'), { url: 'https://1drv.ms/f/s!Abc' });
  for (const value of ['https://sharepoint.com.evil.example/x', 'no-tilde', 'a~b~c']) assert.equal(onedriveItem(value), null, value);
  assert.deepEqual(tencentDocsItem('https://docs.qq.com/doc/DQ2xhbGVuZGFy?u=1'), { type: 'file', id: 'DQ2xhbGVuZGFy' });
  assert.deepEqual(tencentDocsItem('https://docs.qq.com/desktop/mydoc/folder/AbCdEf_12'), { type: 'folder', id: 'AbCdEf_12' });
  assert.deepEqual(tencentDocsItem('folder:AbCdEf_12'), { type: 'folder', id: 'AbCdEf_12' });
  for (const value of ['https://docs.qq.com.evil.example/doc/DQ2xhbGVuZGFy', 'https://docs.qq.com/unknown/DQ2xhbGVuZGFy', 'file:x']) assert.equal(tencentDocsItem(value), null, value);
});

test('a token response becomes what Pistead stores: expiry from now, and refreshes keep the refresh token', () => {
  const first = oauthSecret({ access_token: 'a1', refresh_token: 'r1', expires_in: 3600, user_id: 'open-1' });
  assert.equal(first.accessToken, 'a1'); assert.equal(first.refreshToken, 'r1'); assert.equal(first.openId, 'open-1');
  assert.ok(Math.abs(first.expiresAt! - (Date.now() + 3600_000)) < 5000);
  const refreshed = oauthSecret({ access_token: 'a2', expires_in: '7200' }, first);
  assert.deepEqual([refreshed.accessToken, refreshed.refreshToken, refreshed.openId], ['a2', 'r1', 'open-1']);
  const forever = oauthSecret({ access_token: 'notion', workspace_name: 'Acme' });
  assert.equal(forever.expiresAt, undefined);
});

const graph = 'https://graph.microsoft.com/v1.0';

/** A fake Graph: drive d1 with root → Specs → Design → spec.docx and notes.txt; payroll.txt elsewhere in d1. */
function graphFake(t: TestContext) {
  const items: Record<string, { name: string; parent: string | null; folder?: boolean; mimeType?: string; body?: Uint8Array<ArrayBuffer> | string }> = {
    root: { name: 'root', parent: null, folder: true },
    specs: { name: 'Specs', parent: 'root', folder: true },
    design: { name: 'Design', parent: 'specs', folder: true },
    spec: { name: 'spec.docx', parent: 'design', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', body: docx(wordXml) },
    notes: { name: 'notes.txt', parent: 'specs', mimeType: 'text/plain', body: 'plain notes' },
    payroll: { name: 'payroll.txt', parent: 'root', mimeType: 'text/plain', body: 'secret' },
    photo: { name: 'photo.png', parent: 'specs', mimeType: 'image/png' },
  };
  const view = (id: string) => {
    const item = items[id]!;
    return { id, name: item.name, webUrl: `https://contoso-my.sharepoint.com/personal/me/${item.name}`, lastModifiedDateTime: '2026-10-01T00:00:00Z',
      parentReference: { driveId: 'd1', ...(item.parent ? { id: item.parent } : {}) }, ...(item.folder ? { folder: { childCount: 1 } } : { file: { mimeType: item.mimeType } }) };
  };
  const downloads: { url: string; authorization: string | null }[] = [];
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(init?.redirect, 'manual');
    const authorization = new Headers(init?.headers).get('authorization');
    if (url.hostname === 'contoso-my.sharepoint.com' && url.pathname.startsWith('/download/')) {
      downloads.push({ url: url.href, authorization });
      return new Response(items[url.pathname.slice('/download/'.length)]!.body!);
    }
    assert.equal(url.origin, 'https://graph.microsoft.com');
    if (authorization !== 'Bearer graph-token') return Response.json({ error: { code: 'InvalidAuthenticationToken' } }, { status: 401 });
    const path = url.pathname.replace('/v1.0', '');
    const share = path.match(/^\/shares\/u!([^/]+)\/driveItem$/);
    if (share) {
      const link = Buffer.from(share[1]!, 'base64url').toString();
      return link === 'https://contoso-my.sharepoint.com/:f:/g/personal/me/Specs' ? Response.json(view('specs')) : Response.json({ error: {} }, { status: 404 });
    }
    const match = path.match(/^\/drives\/d1\/items\/([^/]+)(\/children|\/content)?$/);
    if (!match || !items[match[1]!]) return Response.json({ error: { code: 'itemNotFound' } }, { status: 404 });
    const id = match[1]!;
    if (match[2] === '/children') return Response.json({ value: Object.keys(items).filter(key => items[key]!.parent === id).map(view) });
    if (match[2] === '/content') return new Response(null, { status: 302, headers: { Location: `https://contoso-my.sharepoint.com/download/${id}?tempauth=x` } });
    return Response.json(view(id));
  });
  return { downloads };
}

test('OneDrive and SharePoint read folders, Word documents and text files under the bound folder, downloading without the token', async t => {
  const fake = graphFake(t);
  const secret = JSON.stringify({ mode: 'oauth', accessToken: 'graph-token' });
  const root = await onedriveAdapter.resolve(secret, 'https://contoso-my.sharepoint.com/:f:/g/personal/me/Specs');
  assert.deepEqual([root.id, root.type, root.title], ['d1~specs', 'folder', 'Specs']);
  const listing = await onedriveAdapter.read(secret, root, null);
  assert.deepEqual(listing.entries?.map(entry => [entry.id, entry.type]), [['d1~design', 'folder'], ['d1~notes', 'file'], ['d1~photo', 'file']]);
  const spec = await onedriveAdapter.read(secret, root, 'd1~spec');
  assert.deepEqual([spec.type, spec.content], ['document', 'Goals\nShip it & tell <everyone>\t€5']);
  assert.equal((await onedriveAdapter.read(secret, root, 'd1~notes')).content, 'plain notes');
  assert.match((await onedriveAdapter.read(secret, root, 'd1~photo')).note!, /binary file/);
  assert.deepEqual(await code(onedriveAdapter.read(secret, root, 'd1~payroll')), { status: 403, code: 'source_outside' });
  assert.deepEqual(await code(onedriveAdapter.read(secret, root, 'd2~spec')), { status: 404, code: 'source_item_not_found' });
  assert.deepEqual(await code(onedriveAdapter.read(JSON.stringify({ mode: 'oauth', accessToken: 'stale' }), root, null)), { status: 403, code: 'source_account_rejected' });
  // The pre-authenticated download URL never gets the member's token.
  assert.ok(fake.downloads.length === 2 && fake.downloads.every(download => download.authorization === null));
});

test('Tencent Docs lists folders and reads documents through an export, searching down from the bound folder (unverified API)', async t => {
  const headers: Headers[] = [];
  let polls = 0;
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === 'export.docs.qq.com') return new Response(docx(wordXml));
    headers.push(new Headers(init?.headers));
    assert.equal(url.origin, 'https://docs.qq.com');
    const ok = (data: unknown) => Response.json({ ret: 0, msg: 'Succeed', data });
    const path = url.pathname.replace('/openapi', '');
    if (path === '/drive/v2/folders/FolderSpecs/metadata') return ok({ ID: 'FolderSpecs', title: 'Specs' });
    if (path === '/drive/v2/folders/FolderSpecs') return ok({ list: [{ ID: 'FolderSub', title: 'Design', type: 'folder' }, { ID: 'DSheet0001', title: 'Budget', type: 'sheet' }], next: 0 });
    if (path === '/drive/v2/folders/FolderSub') return ok({ list: [{ ID: 'DSpec00001', title: 'Spec', type: 'doc', url: 'https://docs.qq.com/doc/DSpec00001' }], next: 0 });
    if (path === '/drive/v2/files/DSpec00001/metadata') return ok({ ID: 'DSpec00001', title: 'Spec', type: 'doc', url: 'https://docs.qq.com/doc/DSpec00001' });
    if (path === '/drive/v2/files/DSheet0001/metadata') return ok({ ID: 'DSheet0001', title: 'Budget', type: 'sheet' });
    if (path === '/drive/v2/files/DSpec00001/async-export') { assert.equal(init?.method, 'POST'); return ok({ operationID: 'op-1' }); }
    if (path === '/drive/v2/files/DSpec00001/export-progress') return ok(++polls < 2 ? { progress: 50 } : { progress: 100, url: 'https://export.docs.qq.com/file.docx' });
    return Response.json({ ret: 10003, msg: 'no permission' });
  });
  const secret = JSON.stringify({ mode: 'oauth', accessToken: 'tencent-token', openId: 'open-1', clientId: 'client-1' });
  const root = await tencentDocsAdapter.resolve(secret, 'https://docs.qq.com/desktop/mydoc/folder/FolderSpecs');
  assert.deepEqual([root.id, root.type, root.title], ['folder:FolderSpecs', 'folder', 'Specs']);
  assert.deepEqual((await tencentDocsAdapter.read(secret, root, null)).entries?.map(entry => entry.id), ['folder:FolderSub', 'file:DSheet0001']);
  const spec = await tencentDocsAdapter.read(secret, root, 'https://docs.qq.com/doc/DSpec00001');
  assert.equal(spec.content, 'Goals\nShip it & tell <everyone>\t€5');
  assert.match((await tencentDocsAdapter.read(secret, root, 'file:DSheet0001')).note!, /can't be read as text yet/);
  assert.deepEqual(await code(tencentDocsAdapter.read(secret, root, 'file:DOther0001')), { status: 403, code: 'source_outside' });
  assert.ok(headers.every(header => header.get('access-token') === 'tencent-token' && header.get('client-id') === 'client-1' && header.get('open-id') === 'open-1'));
});
