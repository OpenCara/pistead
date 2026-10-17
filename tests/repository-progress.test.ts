import test from "node:test";
import assert from "node:assert/strict";
import { formatBytes, preparingRepositories, repositoryPhaseLabel, repositoryProgressText, repositoryProgressValue } from "../apps/web/src/repository-progress.ts";
import { repositoryPreparationPhases, type RepositoryPreparationItem } from "../packages/shared/src/types.ts";

const item = (change: Partial<RepositoryPreparationItem>): RepositoryPreparationItem =>
  ({ path: "acme/app", phase: "receiving", percent: null, done: null, total: null, bytes: 0, ...change });

test("every preparation phase has its own words, and anything else reads as preparing", () => {
  const labels = repositoryPreparationPhases.map(repositoryPhaseLabel);
  assert.equal(new Set(labels).size, labels.length);
  assert.ok(!labels.includes("Preparing"));
  assert.equal(repositoryPhaseLabel("done"), "Ready");
  for (const unknown of ["", "toString", "__proto__", "Receiving objects: 45% <script>"]) assert.equal(repositoryPhaseLabel(unknown), "Preparing");
});

test("progress text shows Git's percentage, counts and received bytes", () => {
  assert.equal(repositoryProgressText(item({ percent: 45, done: 4500, total: 10000, bytes: 5_400_000 })), "Receiving objects · 45% · 4,500 of 10,000 · 5.1 MiB");
  assert.equal(repositoryProgressText(item({ percent: 99, done: 9900, total: 10000, bytes: 12_900_000 })), "Receiving objects · 99% · 9,900 of 10,000 · 12 MiB");
  assert.equal(repositoryProgressText(item({ phase: "enumerating", done: 1234 })), "Enumerating objects · 1,234");
  assert.equal(repositoryProgressText(item({ phase: "authorizing" })), "Checking access");
  assert.equal(repositoryProgressText(item({ phase: "done", percent: 100, bytes: 2048 })), "Ready · 2.0 KiB");
  // Values that are not plain counts are left out rather than shown.
  assert.equal(repositoryProgressText(item({ done: -1, total: Number.NaN, bytes: 1.5 })), "Receiving objects");
});

test("bars are determinate only with a percentage, clamped, and full when ready", () => {
  assert.equal(repositoryProgressValue(item({})), undefined);
  assert.equal(repositoryProgressValue(item({ percent: 44.6 })), 45);
  assert.equal(repositoryProgressValue(item({ percent: 140 })), 100);
  assert.equal(repositoryProgressValue(item({ percent: -3 })), 0);
  assert.equal(repositoryProgressValue(item({ percent: Number.POSITIVE_INFINITY })), undefined);
  assert.equal(repositoryProgressValue(item({ phase: "done" })), 100);
});

test("bytes use Git's binary units", () => {
  assert.deepEqual([0, 1023, 1024, 10 * 1024, 5 * 1024 ** 3, 3 * 1024 ** 5].map(formatBytes), ["0 B", "1023 B", "1.0 KiB", "10 KiB", "5.0 GiB", "3072 TiB"]);
  assert.equal(formatBytes(-1), "");
});

test("only a preparing view counts as preparing", () => {
  assert.equal(preparingRepositories(undefined), false);
  assert.equal(preparingRepositories({}), false);
  assert.equal(preparingRepositories({ repositories: { status: "failed", items: [], error: "No Git credentials" } }), false);
  assert.equal(preparingRepositories({ repositories: { status: "preparing", items: [] } }), true);
});
