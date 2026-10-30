import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadConfig } from "../apps/server/src/config.js";
import { app } from "../apps/server/src/index.js";

const repository = new URL("../", import.meta.url);

/** What the image's final stage sets with ENV: NAME=value pairs, on lines a backslash continues. */
function imageEnvironment(): Record<string, string> {
  const instructions = readFileSync(new URL("Dockerfile", repository), "utf8").replace(/\\\r?\n/g, " ").split(/\r?\n/)
    .map(line => line.trim()).filter(line => line && !line.startsWith("#"));
  const environment: Record<string, string> = {};
  for (const instruction of instructions.slice(instructions.findLastIndex(line => /^FROM\s/i.test(line)))) {
    const settings = /^ENV\s+(.+)$/i.exec(instruction)?.[1];
    for (const pair of settings?.split(/\s+/) ?? []) {
      const setting = /^([A-Za-z_][A-Za-z0-9_]*)=(\S*)$/.exec(pair);
      assert.ok(setting, `the Dockerfile's ENV sets NAME=value pairs, not ${pair}`);
      environment[setting[1]!] = setting[2]!;
    }
  }
  return environment;
}

/** What docker compose's env_file passes from a copy of .env.example: each NAME=value line, an empty value too. */
function envFileEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const line of readFileSync(new URL("apps/server/.env.example", repository), "utf8").split(/\r?\n/)) {
    const setting = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (setting) environment[setting[1]!] = setting[2]!;
  }
  return environment;
}

test("an .env copied from .env.example keeps each setting the Docker image makes, since compose's env_file overrides it", () => {
  const image = imageEnvironment();
  const envFile = envFileEnvironment();
  // The settings the image changes from the server's own defaults.
  for (const name of ["WORKSPACE_DATABASES", "PASSWORD_AUTH", "SIGNUP"]) assert.ok(name in image, `the image sets ${name}`);
  for (const [name, value] of Object.entries(image)) {
    // Even an empty value replaces the image's: the server then reads the setting as unset.
    if (name in envFile) assert.equal(envFile[name], value, `.env.example sets ${name}, replacing the image's ${name}=${value}`);
  }
});

test("the Docker image signs people in with a password, and takes new accounts, GitHub's too, only through invite links", async () => {
  // The image's environment under a filled-in copy of .env.example, as docker compose starts the server.
  const config = await loadConfig({ ...imageEnvironment(), ...envFileEnvironment(), SESSION_SECRET: "s".repeat(32),
    VAULT_KEY: Buffer.alloc(32, 7).toString("base64url"), DATABASE_URL: "sqlite::memory:" });
  try {
    const health = await (await app.request("/api/health", {}, config.env)).json() as Record<string, unknown>;
    assert.equal(health.passwordAuth, true);
    assert.equal(health.githubSignup, "invite");
    assert.equal(health.passwordSignup, "invite");
    assert.equal(health.workspaceDatabasesConfigured, true);
  } finally {
    await config.env.CONNECTOR_HUB?.close();
    await config.env.DB.close();
  }
});
