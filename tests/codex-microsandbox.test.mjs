import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createCodexMicrosandboxConfig } from "../dist/codex-microsandbox.js";

test("creates prompt-only native runner configuration", async (t) => {
  const codexHome = await temporaryCodexHome(t);
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  t.after(() => restoreEnvironment("CODEX_HOME", previousCodexHome));

  const config = createCodexMicrosandboxConfig("Inspect the fixture");

  assert.equal(config.image, "node:22-bookworm");
  assert.equal(config.workspace, process.cwd());
  assert.equal(config.network, "public");
  assert.equal(config.stdin, "Inspect the fixture");
  assert.deepEqual(config.env, { CODEX_HOME: "/root/.codex" });
  assert.deepEqual(config.copy, [
    {
      source: path.join(codexHome, "auth.json"),
      target: "/root/.codex/auth.json",
    },
    {
      source: path.join(codexHome, "config.toml"),
      target: "/root/.codex/config.toml",
    },
  ]);

  assert.deepEqual(config.command?.slice(0, 4), [
    "npx",
    "--yes",
    "@openai/codex@0.163.0",
    "exec",
  ]);
  assert.equal(config.command?.at(-1), "-");
  assert.equal(hasPair(config.command, "--sandbox", "read-only"), true);
  assert.equal(config.command?.includes("--ephemeral"), true);
  assert.equal(
    hasPair(config.command, "--config", 'approval_policy="never"'),
    true,
  );
  assert.equal(
    hasPair(config.command, "--config", 'forced_login_method="chatgpt"'),
    true,
  );

  for (const redundant of [
    "inputDir",
    "skillsDir",
    "outputDir",
    "resources",
    "volumes",
  ]) {
    assert.equal(Object.hasOwn(config, redundant), false);
  }
});

test("uses existing runner attributes for overrides", async (t) => {
  const codexHome = await temporaryCodexHome(t);
  const workspace = await mkdtemp(
    path.join(tmpdir(), "lodot-codex-workspace-"),
  );
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  t.after(() => restoreEnvironment("CODEX_HOME", previousCodexHome));

  const command = ["codex", "exec", "custom"];
  const config = createCodexMicrosandboxConfig("overridden", {
    image: "example.test/codex:current",
    command,
    workspace,
    copy: [],
    cwd: "/job",
    env: { CUSTOM: "yes" },
    cpus: 4,
    memory: "2G",
    network: "none",
    timeoutMs: null,
  });

  assert.equal(config.image, "example.test/codex:current");
  assert.equal(config.command, command);
  assert.equal(config.workspace, workspace);
  assert.deepEqual(config.copy, []);
  assert.equal(config.cwd, "/job");
  assert.deepEqual(config.env, { CUSTOM: "yes" });
  assert.equal(config.cpus, 4);
  assert.equal(config.memory, "2G");
  assert.equal(config.network, "none");
  assert.equal(config.timeoutMs, null);
  assert.equal(config.stdin, "overridden");
});

test("rejects an empty prompt", () => {
  assert.throws(
    () => createCodexMicrosandboxConfig("  "),
    /requires a nonempty prompt/,
  );
});

function hasPair(values, first, second) {
  return values?.some(
    (value, index) => value === first && values[index + 1] === second,
  ) ?? false;
}

async function temporaryCodexHome(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "lodot-codex-home-"));
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "auth.json"), "{}");
  await writeFile(path.join(directory, "config.toml"), 'model = "configured"\n');
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function restoreEnvironment(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
