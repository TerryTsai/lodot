# lodot

A grab bag of TypeScript utilities for simplifying and standardizing evals
across projects.

## Install

```sh
npm install @terrytsai/lodot
```

`CodexJudge` has optional peer dependencies so projects that only use the
Microsandbox utilities do not install DeepEval and the Codex SDK:

```sh
npm install @openai/codex-sdk@^0.163.0 deepeval@^0.9.22 zod@^4.3.6
```

## CodexJudge

`CodexJudge` implements the TypeScript `DeepEvalBaseLLM` contract. Every call
starts a fresh thread. Model settings are the Codex SDK's native
`ThreadOptions`; lower-level settings are native `CodexOptions`.

```ts
import { CodexJudge } from "@terrytsai/lodot/codex-judge";
import { z } from "zod";

const judge = new CodexJudge({
  threadOptions: {
    model: "your-codex-model",
    modelReasoningEffort: "high",
    webSearchMode: "disabled",
  },
  codexOptions: {
    config: {
      model_verbosity: "low",
    },
  },
});

const text = await judge.generate("Assess this answer: ...");

const verdict = await judge.generate(
  "Assess this answer and return a verdict.",
  z.object({
    score: z.number().min(0).max(10),
    reason: z.string(),
  }),
);
```

Use the same instance directly as a G-Eval model:

```ts
import { GEval } from "deepeval/metrics";
import { SingleTurnParams } from "deepeval/test-case";

const metric = new GEval({
  name: "Correctness",
  criteria: "The answer is factually correct.",
  evaluationSteps: ["Check every factual claim."],
  evaluationParams: [SingleTurnParams.ACTUAL_OUTPUT],
  model: judge,
});
```

Omit `model` or `modelReasoningEffort` to inherit the Codex CLI's configured
defaults. Judging defaults to the read-only sandbox, no interactive approvals,
and no Git-repository requirement. `generate()` returns DeepEval's
`{ output, cost }` shape; `cost` is `null` because the Codex SDK does not expose
a monetary cost for subscription-backed turns.

Authenticate once with `codex login` and confirm `codex login status` reports
`Logged in using ChatGPT`. The adapter forces the ChatGPT login method, removes
`OPENAI_API_KEY` and `CODEX_API_KEY` from the child environment, and rejects
`codexOptions.apiKey`. A mismatched login therefore fails instead of falling
back to API billing.

DeepEval 0.9.22's published `deepeval/metrics` entry imports `@sentry/node`
without declaring it. If importing `GEval` reports that missing module, install
`@sentry/node` in the evaluation project. This does not affect the
`DeepEvalBaseLLM` adapter itself. That release also ships both
`dist/telemetry.js` and `dist/telemetry/index.js`; CommonJS metric execution can
resolve the legacy file and fail with `inComponentScope is not a function`.
This is an upstream 0.9.22 packaging issue that also affects DeepEval's own
models, not a `CodexJudge` contract mismatch.

## Codex sandbox

Pass the factory result directly to the existing runner:

```ts
import {
  codexSandbox,
  runSandbox,
} from "@terrytsai/lodot";

await using run = await runSandbox(
  codexSandbox("Review this workspace and summarize risks."),
);
```

The prompt-only configuration copies the current workspace and the file-backed
Codex `auth.json` into an ephemeral VM, copies `config.toml` when present, and
runs Codex with read-only access and no approvals. It uses
`node:22-bookworm`: the slimmer image lacks the system CA bundle required by
the Codex binary. The VM needs public networking for Codex inference and for
the pinned CLI package that `npx` installs. For repeated runs, override the
native `image` and `command` attributes with a prebuilt image containing Codex.

All overrides use `SandboxOptions`; there is no second configuration
schema:

```ts
const config = codexSandbox("Evaluate the fixture.", {
  workspace: "./fixtures/case-1",
  cpus: 4,
  memory: "2G",
});
```

The automatic authentication transfer requires `~/.codex/auth.json` (or
`$CODEX_HOME/auth.json`). Credentials held only in an OS keyring cannot be
copied into the VM; run `codex login` with file-backed credential storage or
supply an explicitly prepared native `copy`/`env` configuration. The runner
copies rather than mounts credentials, so token refreshes made inside the VM
are intentionally not written back to the host; long-lived automation should
refresh the host login or use a managed Codex access-token workflow.

Set `LODOT_LIVE_CODEX_TESTS=1` when running `npm test` to include the real
subscription-backed judge and Microsandbox smoke tests.

## Sandbox runner

The lower-level `runSandbox` utility uses Microsandbox to run one command in a
fresh sandbox and returns paths you can assert against. It requires Node.js 22
or newer.

```ts
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { runSandbox } from "@terrytsai/lodot";

await using run = await runSandbox({
  image: "node:22-slim",
  command: ["npm", "test"],
  workspace: process.cwd(),
  copy: [
    {
      source: path.join(homedir(), ".npmrc"),
      target: "/root/.npmrc",
    },
  ],
});

assert.equal(run.exitCode, 0);
assert.match(await readFile(run.stdoutPath, "utf8"), /passed/);
assert.ok(run.workspacePath);
assert.equal(
  await readFile(path.join(run.workspacePath, "result.json"), "utf8"),
  '{"ok":true}',
);
```

The host workspace is copied into the VM; it is never mounted, so the command
cannot modify the working copy. Its final state is exported to
`workspacePath`. Stdout and stderr are raw temp files. `await using` removes all
three when the scope exits; call `dispose()` when explicit cleanup is clearer.

`copy` stages extra files, directories, or symlinks such as credentials. They
are destroyed with the VM and are not exported unless their target is inside
the workspace. Guest code can still read them, and network access is disabled
by default.

## License

MIT
