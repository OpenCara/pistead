import test from "node:test";
import assert from "node:assert/strict";
import { memberPerson, peopleDirectory, userIdFromInput, username, usernameWithId, withUsernames } from "../apps/web/src/usernames.js";

const alice = { id: "github:1", githubLogin: "alice" };
const bob = { id: "github:2", githubLogin: "Bob" };
const carol = { id: "test:carol", githubLogin: null };

test("people are named by username, or username(id) where the exact person matters", () => {
  assert.equal(username(alice), "alice");
  assert.equal(usernameWithId(alice), "alice(github:1)");
  // Without a username, the user ID is all there is to show.
  assert.equal(username(carol), "test:carol");
  assert.equal(usernameWithId(carol), "test:carol");
  assert.deepEqual(memberPerson({ userId: "github:2", role: "member", displayName: "Bob B", githubLogin: "Bob" }), bob);
  const person = peopleDirectory([alice, bob]);
  assert.deepEqual(person("github:2"), bob);
  // Someone the directory lacks, such as a former member, keeps their ID.
  assert.equal(usernameWithId(person("github:3")), "github:3");
});

test("a typed or pasted member names a user ID by username(id), username or the ID itself", () => {
  const people = [alice, bob, carol];
  assert.equal(userIdFromInput(" alice(github:1) ", people), "github:1");
  assert.equal(userIdFromInput("alice (github:1)"), "github:1");
  assert.equal(userIdFromInput("bob", people), "github:2");
  assert.equal(userIdFromInput("@BOB", people), "github:2");
  assert.equal(userIdFromInput("github:7", people), "github:7");
  assert.equal(userIdFromInput("test:carol", people), "test:carol");
  // GitHub logins aren't unique here after a rename; an ambiguous or unknown one is left for the server to refuse.
  assert.equal(userIdFromInput("alice", [...people, { id: "github:9", githubLogin: "Alice" }]), "alice");
  assert.equal(userIdFromInput("dave", people), "dave");
  assert.equal(userIdFromInput("alice(github:1", people), "alice(github:1");
  assert.equal(userIdFromInput("   ", people), "");
});

test("details show the user IDs of known people as username(id)", () => {
  const person = peopleDirectory([alice]);
  assert.deepEqual(
    withUsernames({ userId: "github:1", permissions: ["read"], nested: [{ by: "github:1" }], other: "github:5", count: 2, none: null }, person),
    { userId: "alice(github:1)", permissions: ["read"], nested: [{ by: "alice(github:1)" }], other: "github:5", count: 2, none: null },
  );
  assert.equal(withUsernames("github:1", person), "alice(github:1)");
});
