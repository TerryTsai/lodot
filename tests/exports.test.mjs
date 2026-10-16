import assert from "node:assert/strict";
import test from "node:test";

import * as lodot from "../dist/index.js";

test("exports the public API from one flat entrypoint", async () => {
  assert.equal(typeof lodot.CodexJudge, "function");
  assert.equal(typeof lodot.runSandbox, "function");
  assert.equal(typeof lodot.codexSandbox, "function");
  assert.equal(typeof lodot.loadGoldens, "function");
  assert.equal("runInMicrosandbox" in lodot, false);
  assert.equal("createCodexMicrosandboxConfig" in lodot, false);

  for (const subpath of ["codex-judge", "codex-sandbox", "sandbox"]) {
    await assert.rejects(
      import(`@terrytsai/lodot/${subpath}`),
      (error) => error?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED",
    );
  }
});
