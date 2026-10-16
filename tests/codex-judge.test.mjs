import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { GEval } from "deepeval/metrics";
import { SingleTurnParams } from "deepeval/test-case";
import { z } from "zod";

import { CodexJudge } from "../dist/codex-judge.js";

test("generates text in fresh threads and forwards native Codex options", async (t) => {
  const fake = await fakeCodex(t);
  const judge = new CodexJudge({
    threadOptions: {
      model: "chosen-model",
      modelReasoningEffort: "high",
      webSearchMode: "disabled",
    },
    codexOptions: {
      codexPathOverride: fake.executable,
      config: { model_verbosity: "low" },
      env: fake.environment,
    },
  });

  assert.deepEqual(await judge.generate("first judgment"), {
    output: "plain response",
    cost: null,
  });
  assert.deepEqual(await judge.generate("second judgment"), {
    output: "plain response",
    cost: null,
  });
  assert.equal(judge.getModelName(), "chosen-model");

  const calls = await fake.calls();
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.prompt), [
    "first judgment",
    "second judgment",
  ]);

  for (const call of calls) {
    assert.equal(hasPair(call.args, "--model", "chosen-model"), true);
    assert.equal(hasPair(call.args, "--sandbox", "read-only"), true);
    assert.equal(
      hasPair(call.args, "--config", 'approval_policy="never"'),
      true,
    );
    assert.equal(
      hasPair(
        call.args,
        "--config",
        'model_reasoning_effort="high"',
      ),
      true,
    );
    assert.equal(
      hasPair(call.args, "--config", 'web_search="disabled"'),
      true,
    );
    assert.equal(
      hasPair(call.args, "--config", 'model_verbosity="low"'),
      true,
    );
    assert.equal(call.args.includes("resume"), false);
  }
});

test("validates Codex structured output with the supplied Zod schema", async (t) => {
  const fake = await fakeCodex(t, {
    structuredResponse: JSON.stringify({
      verdict: "pass",
      confidence: 0.9,
    }),
  });
  const judge = new CodexJudge({
    codexOptions: {
      codexPathOverride: fake.executable,
      env: fake.environment,
    },
  });
  const schema = z.object({
    verdict: z.enum(["pass", "fail"]),
    confidence: z.number().min(0).max(1),
  });

  const result = await judge.generate("Return a verdict", schema);

  assert.deepEqual(result, {
    output: { verdict: "pass", confidence: 0.9 },
    cost: null,
  });
  const [call] = await fake.calls();
  assert.equal(call.schema.type, "object");
  assert.deepEqual(call.schema.required, ["verdict", "confidence"]);
  assert.equal(call.schema.additionalProperties, false);
});

test("inherits model defaults and cannot silently use an API key", async (t) => {
  const fake = await fakeCodex(t, {
    environment: {
      CODEX_API_KEY: "must-not-be-forwarded",
      OPENAI_API_KEY: "must-not-be-forwarded",
    },
  });
  const judge = new CodexJudge({
    codexOptions: {
      codexPathOverride: fake.executable,
      configOverrides: ['forced_login_method="api"'],
      env: fake.environment,
    },
  });

  await judge.generate("use configured defaults");

  assert.equal(judge.getModelName(), "codex");
  const [call] = await fake.calls();
  assert.equal(call.args.includes("--model"), false);
  assert.equal(
    call.args.some((argument) =>
      argument.startsWith("model_reasoning_effort=")),
    false,
  );
  assert.equal(call.hasCodexApiKey, false);
  assert.equal(call.hasOpenAiApiKey, false);

  const apiOverrideIndex = call.args.indexOf('forced_login_method="api"');
  const subscriptionOverrideIndex = call.args.lastIndexOf(
    'forced_login_method="chatgpt"',
  );
  assert.ok(apiOverrideIndex >= 0);
  assert.ok(subscriptionOverrideIndex > apiOverrideIndex);

  assert.throws(
    () => new CodexJudge({ codexOptions: { apiKey: "sk-billed" } }),
    /does not accept codexOptions\.apiKey/,
  );
});

test("is accepted by DeepEval G-Eval", async (t) => {
  const fake = await fakeCodex(t);
  const judge = new CodexJudge({
    codexOptions: {
      codexPathOverride: fake.executable,
      env: fake.environment,
    },
  });
  const metric = new GEval({
    name: "Correctness",
    criteria: "The output is correct.",
    evaluationSteps: ["Compare the answer with the expected facts."],
    evaluationParams: [SingleTurnParams.ACTUAL_OUTPUT],
    model: judge,
    showIndicator: false,
  });

  assert.equal(metric.model, judge);
  assert.equal(metric.evaluationModel, "codex");
});

function hasPair(values, first, second) {
  return values.some(
    (value, index) => value === first && values[index + 1] === second,
  );
}

async function fakeCodex(t, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "lodot-codex-fake-"));
  const executable = path.join(directory, "codex");
  const logPath = path.join(directory, "calls.jsonl");
  t.after(() => rm(directory, { recursive: true, force: true }));

  await writeFile(executable, `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require("node:fs");

const args = process.argv.slice(2);
const prompt = readFileSync(0, "utf8");
const schemaFlag = args.indexOf("--output-schema");
const schema = schemaFlag < 0
  ? null
  : JSON.parse(readFileSync(args[schemaFlag + 1], "utf8"));

let response = process.env.FAKE_CODEX_TEXT ?? "plain response";
if (schema?.properties?.score) {
  response = JSON.stringify({
    score: 8,
    reason: "The answer satisfies the criterion.",
  });
} else if (schema) {
  response = process.env.FAKE_CODEX_STRUCTURED ?? "{}";
}

const threadId = \`fake-\${process.pid}\`;
appendFileSync(process.env.FAKE_CODEX_LOG, JSON.stringify({
  args,
  prompt,
  schema,
  threadId,
  hasCodexApiKey: Object.hasOwn(process.env, "CODEX_API_KEY"),
  hasOpenAiApiKey: Object.hasOwn(process.env, "OPENAI_API_KEY"),
}) + "\\n");

console.log(JSON.stringify({ type: "thread.started", thread_id: threadId }));
console.log(JSON.stringify({
  type: "item.completed",
  item: {
    id: "message",
    type: "agent_message",
    text: response,
  },
}));
console.log(JSON.stringify({
  type: "turn.completed",
  usage: {
    input_tokens: 1,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    output_tokens: 1,
    reasoning_output_tokens: 0,
  },
}));
`);
  await chmod(executable, 0o755);

  return {
    executable,
    environment: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      FAKE_CODEX_LOG: logPath,
      FAKE_CODEX_STRUCTURED: options.structuredResponse ?? "{}",
      ...(options.environment ?? {}),
    },
    async calls() {
      const text = await readFile(logPath, "utf8");
      return text.trim().split("\n").filter(Boolean).map(JSON.parse);
    },
  };
}
