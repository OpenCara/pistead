import assert from "node:assert/strict";
import test from "node:test";
import { constantTimeEqual, sha256, signToken, verifyToken } from "../packages/shared/src/crypto.js";
import { hasPermission, isSafeRelativePath, normalizePermissions, validateUserEnv } from "../packages/shared/src/policy.js";
import type { RunnerTicket } from "../packages/shared/src/types.js";

const secret = "test-only-0123456789abcdef0123456789abcdef";

test("signed tickets retain identity and reject signature tampering", async () => {
  const ticket: RunnerTicket = { aud: "runner", sessionId: "session-a", actorId: "bob", ownerId: "alice", action: "submit", policyVersion: 2, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 30, jti: "request-1", bodyHash: await sha256("payload") };
  const token = await signToken(ticket, secret);
  assert.deepEqual(await verifyToken<RunnerTicket>(token, secret), ticket);
  const parts = token.split(".");
  parts[1] = Buffer.from(JSON.stringify({ ...ticket, ownerId: "bob" })).toString("base64url");
  assert.equal(await verifyToken(parts.join("."), secret), null);
  assert.equal(await verifyToken(token, "different-secret-0123456789abcdef0123456789"), null);
});

test("expiry is mandatory and malformed signed envelopes are rejected", async () => {
  for (const payload of [{ exp: 1 }, { exp: "99999999999" }, { exp: NaN }, { noExpiry: true }, { exp: Date.now(), iat: Date.now() }]) {
    assert.equal(await verifyToken(await signToken(payload, secret), secret), null);
  }
  for (const token of ["", "a.b.c", "..", "a.b.c.d", "x".repeat(24_001)]) assert.equal(await verifyToken(token, secret), null);
  await assert.rejects(signToken({ exp: 9999999999 }, "short"));
});

test("ticket body digests bind exact payload bytes", async () => {
  assert.notEqual(await sha256('{"owner":"alice"}'), await sha256('{"owner":"bob"}'));
  assert.notEqual(await sha256("{}"), await sha256("{ }"));
  assert.equal(constantTimeEqual("token", "token"), true);
  assert.equal(constantTimeEqual("token", "token\0"), false);
  assert.equal(constantTimeEqual("", "token"), false);
});

test("sharing capabilities do not implicitly escalate", () => {
  assert.equal(hasPermission(["ask"], "read"), true);
  assert.equal(hasPermission(["write"], "read"), true);
  assert.equal(hasPermission(["manage"], "approve"), false);
  assert.equal(hasPermission(["write"], "approve"), false);
  assert.equal(hasPermission(["approve"], "write"), false);
  assert.equal(hasPermission(["read"], "ask"), false);
  assert.equal(hasPermission([], "read"), false);
  assert.deepEqual(normalizePermissions(["write", "write"]), ["read", "write"]);
  assert.throws(() => normalizePermissions(["owner"]));
  assert.throws(() => normalizePermissions([]));
});

test("personal environment cannot replace runtime, git, or secret bindings", () => {
  assert.deepEqual({ ...validateUserEnv({ APP_TEAM: "engineering", APP_THEME: "forest" }) }, { APP_TEAM: "engineering", APP_THEME: "forest" });
  for (const key of ["HOME", "PATH", "GIT_AUTHOR_NAME", "GH_TOKEN", "SSH_AUTH_SOCK", "NODE_OPTIONS", "BASH_ENV", "LD_PRELOAD", "APP_API_KEY", "APP_SECRET"]) assert.throws(() => validateUserEnv({ [key]: "value" }));
  assert.throws(() => validateUserEnv({ APP_VALUE: "a\0b" }));
  assert.throws(() => validateUserEnv({ APP_VALUE: 5 }));
  assert.throws(() => validateUserEnv(null));
});

test("tool paths cannot access home, git configuration, or parent directories", () => {
  for (const path of ["src/index.ts", "notes.txt", "nested/a b.txt"]) assert.equal(isSafeRelativePath(path), true);
  for (const path of ["", "/etc/passwd", "../alice", "x/../../alice", "x/./y", "a//b", "C:\\secret", "a\\..\\b", ".git/config", "foo/.GIT/hooks/run", "a\0b"]) assert.equal(isSafeRelativePath(path), false, path);
});
