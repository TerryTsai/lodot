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
import { pathToFileURL } from "node:url";

import { Golden } from "deepeval/dataset";

import { loadGoldens } from "../dist/index.js";

test("loadGoldens loads a flat YAML directory as native goldens", async (t) => {
  const directory = await temporaryDirectory(t);

  await writeFile(path.join(directory, "second.yaml"), `
name: custom-name
input: A second request
expectations:
  mustNot:
    - Invent facts.
`);
  await writeFile(path.join(directory, "first.yaml"), `
input: |-
  Write release notes from these facts:

  - Search supports quoted phrases.
expectations:
  must:
    - Mention quoted-phrase search.
additionalMetadata:
  suite: core
`);
  await writeFile(path.join(directory, "ignored.yml"), "input: ignored\n");
  await mkdir(path.join(directory, "nested"));
  await writeFile(
    path.join(directory, "nested", "ignored.yaml"),
    "input: ignored\n",
  );

  const goldens = await loadGoldens(pathToFileURL(directory));

  assert.deepEqual(goldens.map((golden) => golden.name), [
    "first",
    "custom-name",
  ]);
  assert.equal(goldens.every((golden) => golden instanceof Golden), true);
  assert.equal(
    goldens[0].input,
    "Write release notes from these facts:\n\n- Search supports quoted phrases.",
  );
  assert.deepEqual(goldens[0].expectations?.must, [
    "Mention quoted-phrase search.",
  ]);
  assert.deepEqual(goldens[0].additionalMetadata, { suite: "core" });
  assert.deepEqual(goldens[1].expectations?.mustNot, ["Invent facts."]);
});

test("identifies malformed golden files", async (t) => {
  const directory = await temporaryDirectory(t);
  await writeFile(path.join(directory, "broken.yaml"), "input: [\n");

  await assert.rejects(
    loadGoldens(directory),
    /Failed to load golden broken\.yaml:/,
  );
});

test("requires a nonempty input", async (t) => {
  const directory = await temporaryDirectory(t);
  await writeFile(path.join(directory, "empty.yaml"), "input: '  '\n");

  await assert.rejects(
    loadGoldens(directory),
    /Failed to load golden empty\.yaml: input must be a nonempty string/,
  );
});

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "lodot-goldens-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
