import assert from "node:assert/strict";
import test from "node:test";
import { decidesHostCommands, isHostCommand } from "../packages/client/src/host-commands.js";

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
