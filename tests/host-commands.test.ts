import assert from "node:assert/strict";
import test from "node:test";
import { decidesHostCommand, decidesHostCommands, isHostCommand } from "../packages/client/src/host-commands.js";

test("a host command is host_bash, or any command of a session that runs on its host", () => {
  const sandboxed = {};
  const onHost = { hostEnvironment: true as const };
  assert.equal(isHostCommand({ kind: "host.bash" }, sandboxed), true);
  assert.equal(isHostCommand({ kind: "host.bash" }, onHost), true);
  assert.equal(isHostCommand({ kind: "bash" }, onHost), true);
  assert.equal(isHostCommand({ kind: "bash" }, sandboxed), false);
  // Only commands: a session on its host still pushes, comments and asks for permissions as any other does.
  for (const kind of ["git.push", "github.comment", "permission"] as const) assert.equal(isHostCommand({ kind }, onHost), false, kind);
});

test("the host's owner and members granted host commands decide them, as the control plane checks; approve access alone doesn't", () => {
  const session = { connectorOwnerId: "github:1" };
  assert.equal(decidesHostCommands(session, { hostCommandAccess: "owner" }, "github:1"), true);
  // The owner is known before the host listing loads; a grant only from it.
  assert.equal(decidesHostCommands(session, undefined, "github:1"), true);
  assert.equal(decidesHostCommands(session, undefined, "github:2"), false);
  for (const level of ["approve", "auto"] as const) assert.equal(decidesHostCommands(session, { hostCommandAccess: level }, "github:2"), true, level);
  assert.equal(decidesHostCommands(session, {}, "github:2"), false);
  // A session with no host recorded has no owner to match.
  assert.equal(decidesHostCommands({}, {}, "github:2"), false);
});

test("the host's owner decides its host commands without approve permission once the host lets them; anyone else still needs it", () => {
  const session = { connectorOwnerId: "github:1" };
  const current = { hostCommandAccess: "owner" as const, capabilities: { hostOwnerDecides: true } };
  const older = { hostCommandAccess: "owner" as const, capabilities: {} };
  assert.equal(decidesHostCommand(session, current, "github:1", false), true);
  // An older connector checks approve permission on every decision, its owner's too; before the listing loads, so does the app.
  assert.equal(decidesHostCommand(session, older, "github:1", false), false);
  assert.equal(decidesHostCommand(session, undefined, "github:1", false), false);
  assert.equal(decidesHostCommand(session, older, "github:1", true), true);
  // A member granted host commands decides them only with approve permission on the session, wherever the host stands.
  for (const level of ["approve", "auto"] as const) {
    const host = { hostCommandAccess: level, capabilities: { hostOwnerDecides: true } };
    assert.equal(decidesHostCommand(session, host, "github:2", false), false, level);
    assert.equal(decidesHostCommand(session, host, "github:2", true), true, level);
  }
  assert.equal(decidesHostCommand(session, { capabilities: { hostOwnerDecides: true } }, "github:2", true), false);
});
