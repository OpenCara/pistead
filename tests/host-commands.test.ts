import assert from "node:assert/strict";
import test from "node:test";
import { decidedAsHostCommand, decidesHostCommand, decidesHostCommands, hostCommandWaiting, isHostCommand } from "../packages/client/src/host-commands.js";

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

test("a command without the host's missing limits in a member's session is decided as a host command, though it runs in the sandbox", () => {
  type Session = { ownerId: string; connectorOwnerId?: string; hostEnvironment?: true };
  const member: Session = { ownerId: "github:2", connectorOwnerId: "github:1" };
  const own: Session = { ownerId: "github:1", connectorOwnerId: "github:1" };
  const bash = { kind: "bash" } as const;
  assert.equal(decidedAsHostCommand(bash, member, true), true);
  assert.equal(isHostCommand(bash, member), false, "it still runs in the sandbox, as the session's owner");
  // Within the host's limits, or in the host owner's own session, approve permission decides it as before.
  assert.equal(decidedAsHostCommand(bash, member, false), false);
  assert.equal(decidedAsHostCommand(bash, member), false);
  assert.equal(decidedAsHostCommand(bash, own, true), false);
  // A session with no host recorded has no owner to compare.
  assert.equal(decidedAsHostCommand(bash, { ownerId: "github:2" }, true), false);
  // Every host command is decided as one.
  assert.equal(decidedAsHostCommand({ kind: "host.bash" }, own), true);
  assert.equal(decidedAsHostCommand(bash, { ...own, hostEnvironment: true }), true);
  for (const kind of ["git.push", "github.comment", "permission"] as const) assert.equal(decidedAsHostCommand({ kind }, member, true), false, kind);
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

test("the host's owner decides host_bash without approve permission once the host lets them; anything else, and anyone else, still needs it", () => {
  const session = { connectorOwnerId: "github:1" };
  const hostBash = { kind: "host.bash" } as const;
  // A command of a session that runs on its host is a host command too, but the host's owner decides it with the approve
  // permission they hold on their own session, as the control plane and the host check it.
  const hostSessionBash = { kind: "bash" } as const;
  const current = { hostCommandAccess: "owner" as const, capabilities: { hostOwnerDecides: true } };
  const older = { hostCommandAccess: "owner" as const, capabilities: {} };
  assert.equal(decidesHostCommand(hostBash, session, current, "github:1", false), true);
  assert.equal(decidesHostCommand(hostSessionBash, session, current, "github:1", false), false);
  assert.equal(decidesHostCommand(hostSessionBash, session, current, "github:1", true), true);
  // An older connector checks approve permission on every decision, its owner's too; before the listing loads, so does the app.
  assert.equal(decidesHostCommand(hostBash, session, older, "github:1", false), false);
  assert.equal(decidesHostCommand(hostBash, session, undefined, "github:1", false), false);
  assert.equal(decidesHostCommand(hostBash, session, older, "github:1", true), true);
  // A member granted host commands decides them only with approve permission on the session, wherever the host stands.
  for (const level of ["approve", "auto"] as const) {
    const host = { hostCommandAccess: level, capabilities: { hostOwnerDecides: true } };
    assert.equal(decidesHostCommand(hostBash, session, host, "github:2", false), false, level);
    assert.equal(decidesHostCommand(hostBash, session, host, "github:2", true), true, level);
  }
  assert.equal(decidesHostCommand(hostBash, session, { capabilities: { hostOwnerDecides: true } }, "github:2", true), false);
});

test("a host command's card says whether approve access is needed of the host's owner too", () => {
  const current = { capabilities: { hostOwnerDecides: true } };
  assert.equal(hostCommandWaiting({ kind: "host.bash" }, current), "Waiting for the host's owner, or a member granted host commands with approve access to this session");
  for (const [operation, host] of [[{ kind: "host.bash" }, { capabilities: {} }], [{ kind: "host.bash" }, undefined], [{ kind: "bash" }, current]] as const) {
    assert.equal(hostCommandWaiting(operation, host), "Waiting for the host's owner or a member granted host commands, either with approve access to this session");
  }
});
