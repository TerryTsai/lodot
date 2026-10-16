import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

type GoldenOptions = ConstructorParameters<
  typeof import("deepeval/dataset").Golden
>[0];

/**
 * Loads a flat directory of YAML files as native DeepEval goldens.
 *
 * Files are loaded in lexical order. A golden without a `name` uses its
 * filename without the `.yaml` extension.
 */
export async function loadGoldens(
  directory: string | URL,
): Promise<import("deepeval/dataset").Golden[]> {
  const directoryPath = directory instanceof URL
    ? fileURLToPath(directory)
    : path.resolve(directory);
  const files = (await readdir(directoryPath, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".yaml"))
    .map((entry) => entry.name)
    .sort();

  const [{ Golden }, { parse }] = await Promise.all([
    import("deepeval/dataset"),
    import("yaml"),
  ]);

  const goldens: Array<import("deepeval/dataset").Golden> = [];

  for (const filename of files) {
    const filePath = path.join(directoryPath, filename);

    try {
      const definition = parseGoldenDefinition(
        parse(await readFile(filePath, "utf8")),
      );

      goldens.push(new Golden({
        ...definition,
        name: definition.name ?? path.basename(filename, ".yaml"),
      }));
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      throw new Error(`Failed to load golden ${filename}: ${detail}`, {
        cause,
      });
    }
  }

  return goldens;
}

function parseGoldenDefinition(value: unknown): GoldenOptions {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("expected a YAML mapping");
  }

  const definition = value as Record<string, unknown>;

  if (
    typeof definition.input !== "string" ||
    definition.input.trim().length === 0
  ) {
    throw new TypeError("input must be a nonempty string");
  }

  if (
    definition.name !== undefined &&
    (typeof definition.name !== "string" ||
      definition.name.trim().length === 0)
  ) {
    throw new TypeError("name must be a nonempty string when supplied");
  }

  return definition as unknown as GoldenOptions;
}
