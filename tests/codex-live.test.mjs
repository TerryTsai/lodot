import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { CodexJudge } from "../dist/codex-judge.js";
import { codexSandbox } from "../dist/codex-sandbox.js";
import { runSandbox } from "../dist/sandbox.js";

const live = process.env.LODOT_LIVE_CODEX_TESTS === "1";

test("uses the signed-in Codex subscription", { skip: !live }, async () => {
  const judge = new CodexJudge({
    threadOptions: {
      modelReasoningEffort: "low",
      webSearchMode: "disabled",
    },
  });

  const result = await judge.generate(
    "Reply with exactly LODOT_CODEX_JUDGE_OK and nothing else.",
  );

  assert.equal(result.output.trim(), "LODOT_CODEX_JUDGE_OK");
});

test("runs Codex in a sandbox", { skip: !live }, async (t) => {
  const workspace = await mkdtemp(path.join(tmpdir(), "lodot-codex-live-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const run = await runSandbox(
    codexSandbox(
      "Reply with exactly LODOT_MICROSANDBOX_OK and nothing else.",
      { workspace, timeoutMs: 300_000 },
    ),
  );

  try {
    const stdout = await readFile(run.stdoutPath, "utf8");
    const stderr = await readFile(run.stderrPath, "utf8");
    assert.equal(
      run.success,
      true,
      `Codex exited with ${run.exitCode}:\n${stderr}`,
    );
    assert.match(stdout, /LODOT_MICROSANDBOX_OK/);
  } finally {
    await run.dispose();
  }
});
