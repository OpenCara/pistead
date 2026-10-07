import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { FilesystemStorage } from "../apps/server/src/storage/filesystem.js";
import { openStorage } from "../apps/server/src/storage/index.js";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pistead-storage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, storage: new FilesystemStorage(root) };
}

test("put, get and delete round trip bodies with metadata", async t => {
  const { root, storage } = await fixture(t);
  const body = new TextEncoder().encode('{"snapshot":true}');
  const metadata = { contentType: "application/json", custom: { owner: "owner", sha256: "abc", format: "v1" } };
  await storage.put("sessions/owner/session/backup-1.json", body, metadata);
  const stored = await storage.get("sessions/owner/session/backup-1.json");
  assert.ok(stored);
  assert.deepEqual(Buffer.from(stored.body), Buffer.from(body));
  assert.equal(stored.size, body.byteLength);
  assert.deepEqual(stored.metadata, metadata);
  assert.deepEqual((await readdir(join(root, "sessions/owner/session"))).sort(), ["backup-1.json", "backup-1.json.meta.json"]);
  await storage.put("sessions/owner/session/backup-1.json", new TextEncoder().encode("v2"), { contentType: "text/plain", custom: {} });
  const replaced = await storage.get("sessions/owner/session/backup-1.json");
  assert.equal(new TextDecoder().decode(replaced!.body), "v2");
  assert.equal(replaced!.metadata.contentType, "text/plain");
  await storage.delete("sessions/owner/session/backup-1.json");
  assert.equal(await storage.get("sessions/owner/session/backup-1.json"), null);
  assert.deepEqual(await readdir(join(root, "sessions/owner/session")), [], "sidecar is removed with the body");
  await storage.delete("sessions/owner/session/backup-1.json");
});

test("missing objects read as null and never leave temporary files behind", async t => {
  const { root, storage } = await fixture(t);
  assert.equal(await storage.get("sessions/none.json"), null);
  await storage.put("a/b", new Uint8Array([1, 2, 3]), { contentType: "application/octet-stream", custom: {} });
  assert.deepEqual((await readdir(join(root, "a"))).sort(), ["b", "b.meta.json"]);
  await writeFile(join(root, "a", "orphan"), "no sidecar");
  const orphan = await storage.get("a/orphan");
  assert.equal(new TextDecoder().decode(orphan!.body), "no sidecar");
  assert.deepEqual(orphan!.metadata, { contentType: "application/octet-stream", custom: {} });
});

test("path traversal and malformed keys are rejected before touching the filesystem", async t => {
  const { root, storage } = await fixture(t);
  const outside = join(root, "..", `pistead-escape-${process.pid}`);
  for (const key of ["../escape", "a/../../escape", "/etc/passwd", "a//b", "", "a/", "a b", "a\\b", "a/./b", "x.meta.json", "a/b.meta.json"]) {
    await assert.rejects(storage.put(key, new Uint8Array(1), { contentType: "text/plain", custom: {} }), /Invalid object key/, key);
    await assert.rejects(storage.get(key), /Invalid object key/, key);
    await assert.rejects(storage.delete(key), /Invalid object key/, key);
  }
  await assert.rejects(readFile(outside), { code: "ENOENT" });
});

test("openStorage builds a filesystem store from a file:// URL", async t => {
  const root = await mkdtemp(join(tmpdir(), "pistead-storage-url-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const storage = openStorage(`file://${root}`, {});
  assert.equal(storage.provider, "filesystem");
  await storage.put("k", new Uint8Array([7]), { contentType: "application/octet-stream", custom: { a: "b" } });
  assert.deepEqual(JSON.parse(await readFile(join(root, "k.meta.json"), "utf8")), { contentType: "application/octet-stream", custom: { a: "b" } });
  assert.throws(() => openStorage("ftp://x", {}), /not supported/);
  assert.throws(() => openStorage("file://host/path", {}), /must not name a host/);
  const s3 = openStorage("s3://bucket/prefix/?endpoint=http://127.0.0.1:9000&region=eu-west-1", { S3_ACCESS_KEY_ID: "k", S3_SECRET_ACCESS_KEY: "s" });
  assert.equal(s3.provider, "s3");
});
