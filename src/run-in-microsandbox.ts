import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  readlink,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  ExecHandle,
  FsEntry,
  Sandbox,
  SandboxBuilder,
  SandboxFsOps,
  SftpClient,
  SshClient,
} from "microsandbox";

/** An executable followed by its literal arguments. No shell is involved. */
export type SandboxCommand = readonly [
  executable: string,
  ...args: string[],
];

/** A host file, directory, or symbolic link to copy into the sandbox. */
export interface SandboxCopy {
  /** Host path. Relative paths are resolved from the current directory. */
  readonly source: string;

  /** Absolute POSIX path inside the sandbox. */
  readonly target: string;
}

/** Options for one isolated Microsandbox process. */
export interface RunInMicrosandboxOptions {
  /** OCI image reference used to create the sandbox. */
  readonly image: string;

  /** Command to run. Omit it to use the image's default command. */
  readonly command?: SandboxCommand;

  /** Host directory copied into the sandbox as an immutable input. */
  readonly workspace?: string;

  /** Guest destination for `workspace`. Defaults to `/workspace`. */
  readonly workspaceTarget?: string;

  /** Additional host files or directories to copy into the sandbox. */
  readonly copy?: readonly SandboxCopy[];

  /** Guest working directory. Defaults to `workspaceTarget` when present. */
  readonly cwd?: string;

  /** Environment variables for the process. */
  readonly env?: Readonly<Record<string, string>>;

  /** Bytes supplied to stdin before it is closed. */
  readonly stdin?: string | Uint8Array;

  /** Number of virtual CPUs. */
  readonly cpus?: number;

  /** Memory in MiB, or an integer size such as `512M` or `2G`. */
  readonly memory?: number | `${number}M` | `${number}G`;

  /** Guest network access. Defaults to `none`. */
  readonly network?: "none" | "public";

  /** Total run timeout. Defaults to ten minutes; `null` disables it. */
  readonly timeoutMs?: number | null;

  /** Cancels sandbox creation or execution. */
  readonly signal?: AbortSignal;
}

/** Files and status produced by one completed sandbox run. */
export interface RunInMicrosandboxResult extends AsyncDisposable {
  /** Process exit code. Nonzero exits are returned, not thrown. */
  readonly exitCode: number;

  /** Whether `exitCode` is zero. */
  readonly success: boolean;

  /** Temp file containing the process's exact stdout bytes. */
  readonly stdoutPath: string;

  /** Temp file containing the process's exact stderr bytes. */
  readonly stderrPath: string;

  /**
   * Exported final workspace. Present when `workspace` was supplied.
   * The path does not exist if the process deleted the workspace.
   */
  readonly workspacePath?: string;

  /** Removes stdout, stderr, and the exported workspace. */
  dispose(): Promise<void>;

  /** Removes stdout, stderr, and the exported workspace. */
  [Symbol.asyncDispose](): Promise<void>;
}

type MicrosandboxSdk = Pick<typeof import("microsandbox"), "Sandbox">;
type LoadSdk = () => Promise<MicrosandboxSdk>;

type PreparedCopy =
  | {
      readonly source: string;
      readonly target: string;
      readonly kind: "directory";
    }
  | {
      readonly source: string;
      readonly target: string;
      readonly kind: "file";
      readonly mode: number;
    }
  | {
      readonly source: string;
      readonly target: string;
      readonly kind: "symlink";
      readonly linkTarget: string;
    };

interface PreparedRun {
  readonly image: string;
  readonly command: SandboxCommand | undefined;
  readonly workspace: PreparedCopy | undefined;
  readonly copy: readonly PreparedCopy[];
  readonly cwd: string | undefined;
  readonly env: Readonly<Record<string, string>> | undefined;
  readonly stdin: string | Uint8Array | undefined;
  readonly cpus: number | undefined;
  readonly memory: number | undefined;
  readonly network: "none" | "public";
  readonly timeoutMs: number | null;
}

interface RunControl {
  readonly signal: AbortSignal;
  dispose(): void;
}

/**
 * Runs one process in a fresh Microsandbox and returns disposable temp files.
 *
 * The host workspace is copied, never mounted, so guest writes cannot change
 * the working copy. The final guest workspace is exported to a separate temp
 * path. Call `dispose()` (or use `await using`) when assertions are complete.
 */
export function runInMicrosandbox(
  options: RunInMicrosandboxOptions,
): Promise<RunInMicrosandboxResult> {
  return runInMicrosandboxWith(options, () => import("microsandbox"));
}

/** @internal Dependency-injected entry point used by the test suite. */
export async function runInMicrosandboxWith(
  options: RunInMicrosandboxOptions,
  loadSdk: LoadSdk,
): Promise<RunInMicrosandboxResult> {
  const run = await prepareRun(options);
  const control = createRunControl(run.timeoutMs, options.signal);
  let sandbox: Sandbox | undefined;
  let tempPath: string | undefined;

  try {
    control.signal.throwIfAborted();
    const sdk = await loadSdk();
    control.signal.throwIfAborted();

    const builder = buildSandbox(sdk, run);
    sandbox = await createSandbox(builder, control.signal);
    control.signal.throwIfAborted();

    const resultPath = await mkdtemp(
      path.join(tmpdir(), "lodot-microsandbox-"),
    );
    tempPath = resultPath;
    const stdoutPath = path.join(resultPath, "stdout");
    const stderrPath = path.join(resultPath, "stderr");
    const workspacePath = run.workspace
      ? path.join(resultPath, "workspace")
      : undefined;

    const exitCode = await runCommand(
      sandbox,
      run,
      stdoutPath,
      stderrPath,
      control.signal,
    );

    if (run.workspace && workspacePath) {
      await exportWorkspace(
        sandbox,
        run.workspace.target,
        workspacePath,
        control.signal,
      );
    }

    control.signal.throwIfAborted();
    control.dispose();
    await destroySandbox(sandbox);
    sandbox = undefined;

    return new SandboxRunResult({
      exitCode,
      stdoutPath,
      stderrPath,
      workspacePath,
      tempPath: resultPath,
    });
  } catch (error) {
    control.dispose();
    return await cleanupFailedRun(error, sandbox, tempPath);
  } finally {
    control.dispose();
  }
}

class SandboxRunResult implements RunInMicrosandboxResult {
  readonly exitCode: number;
  readonly success: boolean;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  declare readonly workspacePath?: string;
  private disposePromise: Promise<void> | undefined;
  private readonly tempPath: string;

  constructor(value: {
    exitCode: number;
    stdoutPath: string;
    stderrPath: string;
    workspacePath: string | undefined;
    tempPath: string;
  }) {
    this.exitCode = value.exitCode;
    this.success = value.exitCode === 0;
    this.stdoutPath = value.stdoutPath;
    this.stderrPath = value.stderrPath;
    this.tempPath = value.tempPath;

    if (value.workspacePath !== undefined) {
      this.workspacePath = value.workspacePath;
    }
  }

  dispose(): Promise<void> {
    return this.disposePromise ??= rm(this.tempPath, {
      force: true,
      maxRetries: 3,
      recursive: true,
    });
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.dispose();
  }
}

async function prepareRun(
  options: RunInMicrosandboxOptions,
): Promise<PreparedRun> {
  if (!isRecord(options)) {
    throw new TypeError("runInMicrosandbox() requires an options object");
  }

  const image = nonemptyString(options.image, "image");
  const command = prepareCommand(options.command);
  const workspace = await prepareWorkspace(
    options.workspace,
    options.workspaceTarget,
  );
  const copy = await prepareCopies(options.copy);

  return {
    image,
    command,
    workspace,
    copy,
    cwd: optionalString(options.cwd, "cwd") ?? workspace?.target,
    env: prepareEnvironment(options.env),
    stdin: prepareStdin(options.stdin),
    cpus: optionalPositiveInteger(options.cpus, "cpus"),
    memory: prepareMemory(options.memory),
    network: prepareNetwork(options.network),
    timeoutMs: prepareTimeout(options.timeoutMs),
  };
}

async function prepareWorkspace(
  source: string | undefined,
  target: string | undefined,
): Promise<PreparedCopy | undefined> {
  if (source === undefined) {
    if (target !== undefined) {
      throw new TypeError("workspaceTarget requires workspace");
    }
    return undefined;
  }

  const hostPath = await realpath(
    path.resolve(nonemptyString(source, "workspace")),
  );
  const metadata = await lstat(hostPath);
  if (!metadata.isDirectory()) {
    throw new TypeError(`workspace is not a directory: ${hostPath}`);
  }

  return {
    source: hostPath,
    target: guestPath(target ?? "/workspace", "workspaceTarget"),
    kind: "directory",
  };
}

async function prepareCopies(
  copies: readonly SandboxCopy[] | undefined,
): Promise<PreparedCopy[]> {
  if (copies === undefined) return [];
  if (!Array.isArray(copies)) {
    throw new TypeError("copy must be an array");
  }

  return await Promise.all(copies.map(prepareCopy));
}

async function prepareCopy(
  copy: SandboxCopy,
  index: number,
): Promise<PreparedCopy> {
  if (!isRecord(copy)) {
    throw new TypeError(`copy[${index}] must be an object`);
  }

  const source = path.resolve(
    nonemptyString(copy.source, `copy[${index}].source`),
  );
  const target = guestPath(copy.target, `copy[${index}].target`);
  const metadata = await lstat(source);

  if (metadata.isDirectory()) return { source, target, kind: "directory" };
  if (metadata.isFile()) {
    return { source, target, kind: "file", mode: metadata.mode & 0o777 };
  }
  if (metadata.isSymbolicLink()) {
    return {
      source,
      target,
      kind: "symlink",
      linkTarget: await readlink(source),
    };
  }

  throw new TypeError(`Unsupported copy source: ${source}`);
}

function buildSandbox(
  sdk: MicrosandboxSdk,
  run: PreparedRun,
): SandboxBuilder {
  let builder = sdk.Sandbox
    .builder(`lodot-${process.pid}-${randomUUID()}`)
    .image(run.image)
    .ephemeral(true)
    .detached(false);

  if (run.cpus !== undefined) builder = builder.cpus(run.cpus);
  if (run.memory !== undefined) builder = builder.memory(run.memory);
  if (run.network === "none") builder = builder.disableNetwork();

  if (run.workspace) builder = addCopy(builder, run.workspace);
  for (const copy of run.copy) builder = addCopy(builder, copy);

  return builder;
}

function addCopy(
  builder: SandboxBuilder,
  copy: PreparedCopy,
): SandboxBuilder {
  return builder.patch((patch) => {
    if (copy.kind === "directory") {
      return patch.copyDir(copy.source, copy.target, { replace: true });
    }
    if (copy.kind === "file") {
      return patch.copyFile(copy.source, copy.target, {
        mode: copy.mode,
        replace: true,
      });
    }
    return patch.symlink(copy.linkTarget, copy.target, { replace: true });
  });
}

async function createSandbox(
  builder: SandboxBuilder,
  signal: AbortSignal,
): Promise<Sandbox> {
  signal.throwIfAborted();
  const creation = await builder.createWithProgress();
  const cancel = (): void => creation.cancel();

  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();

  try {
    const sandbox = await creation.awaitSandbox();
    if (signal.aborted) {
      try {
        await destroySandbox(sandbox);
      } catch (cleanupError) {
        throw new AggregateError(
          [signal.reason, cleanupError],
          "Microsandbox creation was cancelled and cleanup failed",
        );
      }
      signal.throwIfAborted();
    }
    return sandbox;
  } catch (error) {
    creation.cancel();
    if (signal.aborted) signal.throwIfAborted();
    throw error;
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

async function runCommand(
  sandbox: Sandbox,
  run: PreparedRun,
  stdoutPath: string,
  stderrPath: string,
  signal: AbortSignal,
): Promise<number> {
  const stdout = await open(stdoutPath, "wx");
  try {
    const stderr = await open(stderrPath, "wx");
    try {
      const configure = (
        options: InstanceType<
          typeof import("microsandbox").ExecOptionsBuilder
        >,
      ) => {
        let configured = options.tty(false);
        if (run.command) configured = configured.args(run.command.slice(1));
        if (run.cwd) configured = configured.cwd(run.cwd);
        if (run.env) configured = configured.envs({ ...run.env });
        if (run.stdin === undefined) return configured.stdinNull();
        return configured.stdinBytes(Buffer.from(run.stdin));
      };

      const handle = run.command
        ? await sandbox.execStreamWith(run.command[0], configure)
        : await sandbox.execDefaultStreamWith(configure);

      return await drainProcess(handle, stdout, stderr, signal);
    } finally {
      await stderr.close();
    }
  } finally {
    await stdout.close();
  }
}

async function drainProcess(
  handle: ExecHandle,
  stdout: Awaited<ReturnType<typeof open>>,
  stderr: Awaited<ReturnType<typeof open>>,
  signal: AbortSignal,
): Promise<number> {
  let exitCode: number | undefined;
  let killPromise: Promise<void> | undefined;
  const kill = (): void => {
    killPromise ??= handle.kill();
    void killPromise.catch(() => undefined);
  };

  signal.addEventListener("abort", kill, { once: true });
  if (signal.aborted) kill();

  try {
    for (;;) {
      const event = await handle.recv();
      if (event === null) break;

      if (event.kind === "stdout") await stdout.writeFile(event.data);
      if (event.kind === "stderr") await stderr.writeFile(event.data);
      if (event.kind === "exited") {
        if (exitCode !== undefined) {
          throw new Error("Microsandbox reported process exit twice");
        }
        exitCode = event.code;
      }
    }

    signal.throwIfAborted();
    if (exitCode === undefined) {
      throw new Error("Microsandbox process stream ended without an exit code");
    }
    return exitCode;
  } catch (error) {
    kill();
    await Promise.allSettled(killPromise ? [killPromise] : []);
    if (signal.aborted) signal.throwIfAborted();
    throw error;
  } finally {
    signal.removeEventListener("abort", kill);
  }
}

async function exportWorkspace(
  sandbox: Sandbox,
  guestPath: string,
  hostPath: string,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const fs = sandbox.fs();
  if (!(await fs.exists(guestPath))) return;

  let ssh: SshClient | undefined;
  let sftp: SftpClient | undefined;
  const getSftp = async (): Promise<SftpClient> => {
    if (!sftp) {
      ssh = await sandbox.ssh().openClient({ sftp: true });
      sftp = await ssh.sftp();
    }
    return sftp;
  };

  try {
    const metadata = await fs.stat(guestPath);
    await copyGuestNode(
      fs,
      getSftp,
      guestPath,
      hostPath,
      metadata,
      signal,
    );
  } finally {
    await closeSftp(sftp, ssh);
  }
}

async function copyGuestNode(
  fs: SandboxFsOps,
  getSftp: () => Promise<SftpClient>,
  guestPath: string,
  hostPath: string,
  entry: Pick<FsEntry, "kind" | "mode">,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();

  if (entry.kind === "file") {
    await fs.copyToHost(guestPath, hostPath);
    await preserveExecutableBits(hostPath, entry.mode);
    return;
  }

  if (entry.kind === "symlink") {
    const target = await (await getSftp()).readLink(guestPath);
    await symlink(target, hostPath);
    return;
  }

  if (entry.kind !== "directory") {
    throw new Error(`Unsupported sandbox workspace entry: ${guestPath}`);
  }

  await mkdir(hostPath);
  const children = await fs.list(guestPath);
  children.sort((left, right) => left.path.localeCompare(right.path, "en"));

  for (const child of children) {
    const name = entryName(guestPath, child.path);
    await copyGuestNode(
      fs,
      getSftp,
      path.posix.join(guestPath, name),
      path.join(hostPath, name),
      child,
      signal,
    );
  }

}

async function preserveExecutableBits(
  hostPath: string,
  guestMode: number,
): Promise<void> {
  const hostMode = (await lstat(hostPath)).mode;
  await chmod(hostPath, (hostMode & ~0o111) | (guestMode & 0o111));
}

function entryName(parent: string, reportedPath: string): string {
  const name = path.posix.basename(reportedPath);
  if (
    name === "." ||
    name === ".." ||
    name.length === 0 ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0")
  ) {
    throw new Error(`Invalid Microsandbox directory entry: ${reportedPath}`);
  }

  if (reportedPath.includes("/")) {
    const expected = path.posix.join(parent, name);
    if (path.posix.normalize(reportedPath) !== expected) {
      throw new Error(`Escaping Microsandbox directory entry: ${reportedPath}`);
    }
  }

  return name;
}

async function closeSftp(
  sftp: SftpClient | undefined,
  ssh: SshClient | undefined,
): Promise<void> {
  const errors: unknown[] = [];

  try {
    await sftp?.close();
  } catch (error) {
    errors.push(error);
  }
  try {
    await ssh?.close();
  } catch (error) {
    errors.push(error);
  }

  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, "Closing SFTP failed");
  }
}

function createRunControl(
  timeoutMs: number | null,
  external: AbortSignal | undefined,
): RunControl {
  const controller = new AbortController();
  const abort = (): void => controller.abort(external?.reason);

  if (external?.aborted) abort();
  else external?.addEventListener("abort", abort, { once: true });

  const timer = timeoutMs === null
    ? undefined
    : setTimeout(() => {
        const error = new Error(
          `Microsandbox run timed out after ${timeoutMs}ms`,
        );
        error.name = "TimeoutError";
        controller.abort(error);
      }, timeoutMs);

  return {
    signal: controller.signal,
    dispose() {
      if (timer) clearTimeout(timer);
      external?.removeEventListener("abort", abort);
    },
  };
}

async function destroySandbox(sandbox: Sandbox): Promise<void> {
  await sandbox.destroy({ force: true, timeoutMs: 5_000 });
}

async function cleanupFailedRun(
  error: unknown,
  sandbox: Sandbox | undefined,
  tempPath: string | undefined,
): Promise<never> {
  const errors = [error];

  if (sandbox) {
    try {
      await destroySandbox(sandbox);
    } catch (cleanupError) {
      errors.push(cleanupError);
    }
  }

  if (tempPath) {
    try {
      await rm(tempPath, { force: true, recursive: true });
    } catch (cleanupError) {
      errors.push(cleanupError);
    }
  }

  if (errors.length === 1) throw error;
  throw new AggregateError(errors, "Microsandbox run and cleanup failed");
}

function prepareCommand(
  command: SandboxCommand | undefined,
): SandboxCommand | undefined {
  if (command === undefined) return undefined;
  if (!Array.isArray(command) || command.length === 0) {
    throw new TypeError("command must contain an executable");
  }
  nonemptyString(command[0], "command[0]");
  for (let index = 1; index < command.length; index += 1) {
    if (typeof command[index] !== "string") {
      throw new TypeError(`command[${index}] must be a string`);
    }
  }
  return [...command] as unknown as SandboxCommand;
}

function prepareEnvironment(
  env: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> | undefined {
  if (env === undefined) return undefined;
  if (!isRecord(env)) throw new TypeError("env must be an object");

  const entries = Object.entries(env);
  for (const [key, value] of entries) {
    nonemptyString(key, "env key");
    if (typeof value !== "string") {
      throw new TypeError(`env.${key} must be a string`);
    }
  }
  return Object.fromEntries(entries);
}

function prepareStdin(
  stdin: string | Uint8Array | undefined,
): string | Uint8Array | undefined {
  if (
    stdin !== undefined &&
    typeof stdin !== "string" &&
    !(stdin instanceof Uint8Array)
  ) {
    throw new TypeError("stdin must be a string or Uint8Array");
  }
  return stdin;
}

function prepareMemory(
  memory: RunInMicrosandboxOptions["memory"],
): number | undefined {
  if (memory === undefined) return undefined;
  if (typeof memory === "number") {
    return positiveInteger(memory, "memory");
  }

  const match = /^([1-9][0-9]*)(M|G)$/u.exec(memory);
  if (!match) {
    throw new TypeError("memory must be MiB or an integer M/G size");
  }

  const amount = Number(match[1]);
  const mebibytes = match[2] === "G" ? amount * 1024 : amount;
  return positiveInteger(mebibytes, "memory");
}

function prepareNetwork(
  network: RunInMicrosandboxOptions["network"],
): "none" | "public" {
  if (network === undefined) return "none";
  if (network !== "none" && network !== "public") {
    throw new TypeError('network must be "none" or "public"');
  }
  return network;
}

function prepareTimeout(timeoutMs: number | null | undefined): number | null {
  if (timeoutMs === undefined) return 600_000;
  if (timeoutMs === null) return null;
  return positiveInteger(timeoutMs, "timeoutMs");
}

function optionalPositiveInteger(
  value: number | undefined,
  name: string,
): number | undefined {
  return value === undefined ? undefined : positiveInteger(value, name);
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return value;
}

function guestPath(value: string, name: string): string {
  nonemptyString(value, name);
  if (
    value === "/" ||
    !path.posix.isAbsolute(value) ||
    path.posix.normalize(value) !== value ||
    value.includes("\0")
  ) {
    throw new TypeError(
      `${name} must be an absolute normalized POSIX path other than /`,
    );
  }
  return value;
}

function optionalString(
  value: string | undefined,
  name: string,
): string | undefined {
  return value === undefined ? undefined : nonemptyString(value, name);
}

function nonemptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a nonempty string`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
