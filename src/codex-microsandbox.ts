import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type {
  RunInMicrosandboxOptions,
  SandboxCopy,
} from "./run-in-microsandbox.js";

const CODEX_CLI_PACKAGE = "@openai/codex@0.163.0";
const GUEST_CODEX_HOME = "/root/.codex";

/**
 * Creates native runInMicrosandbox options for one noninteractive Codex run.
 *
 * The caller's current workspace and file-backed Codex login are copied into
 * the ephemeral VM. Any supplied options override these defaults directly.
 */
export function createCodexMicrosandboxConfig(
  prompt: string,
  overrides: Partial<RunInMicrosandboxOptions> = {},
): RunInMicrosandboxOptions {
  if (typeof prompt !== "string" || prompt.trim().length === 0) {
    throw new TypeError(
      "createCodexMicrosandboxConfig() requires a nonempty prompt",
    );
  }

  const defaults: RunInMicrosandboxOptions = {
    // The slim Node image omits the OS CA bundle used by the Rust Codex binary.
    image: "node:22-bookworm",
    command: [
      "npx",
      "--yes",
      CODEX_CLI_PACKAGE,
      "exec",
      "--ephemeral",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "--color",
      "never",
      "--config",
      'approval_policy="never"',
      "--config",
      'forced_login_method="chatgpt"',
      "--config",
      'cli_auth_credentials_store="file"',
      "-",
    ],
    workspace: process.cwd(),
    copy: codexConfigurationCopies(),
    env: { CODEX_HOME: GUEST_CODEX_HOME },
    stdin: prompt,
    network: "public",
  };

  return { ...defaults, ...overrides };
}

function codexConfigurationCopies(): SandboxCopy[] {
  const hostCodexHome = path.resolve(
    process.env.CODEX_HOME ?? path.join(homedir(), ".codex"),
  );
  const copies: SandboxCopy[] = [
    {
      source: path.join(hostCodexHome, "auth.json"),
      target: path.posix.join(GUEST_CODEX_HOME, "auth.json"),
    },
  ];
  const configPath = path.join(hostCodexHome, "config.toml");

  if (existsSync(configPath)) {
    copies.push({
      source: configPath,
      target: path.posix.join(GUEST_CODEX_HOME, "config.toml"),
    });
  }

  return copies;
}
