import assert from "node:assert/strict";
import test from "node:test";

import * as lodot from "../dist/index.js";

test("exports the concise sandbox API without legacy aliases", () => {
  assert.equal(typeof lodot.runSandbox, "function");
  assert.equal(typeof lodot.codexSandbox, "function");
  assert.equal("runInMicrosandbox" in lodot, false);
  assert.equal("createCodexMicrosandboxConfig" in lodot, false);
});
