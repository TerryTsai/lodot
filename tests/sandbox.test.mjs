import assert from "node:assert/strict";
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { runSandboxWith } from "../dist/sandbox.js";

test("runs once and returns disposable side effects", async (t) => {
  const host = await mkdtemp(path.join(tmpdir(), "lodot-run-input-"));
  const workspace = path.join(host, "workspace");
  const credential = path.join(host, "token");
  await mkdir(workspace);
  await writeFile(path.join(workspace, "input.txt"), "original");
  await symlink("input.txt", path.join(workspace, "input-link"));
  await writeFile(credential, "secret");
  t.after(() => rm(host, { recursive: true, force: true }));

  const fake = fakeSdk(async ({ resolve, command, options }) => {
    assert.equal(command, "/bin/tool");
    assert.deepEqual(options.argsValue, ["--flag"]);
    assert.equal(options.cwdValue, "/work");
    assert.deepEqual(options.envValue, { MODE: "test" });
    assert.deepEqual(options.stdinValue, Buffer.from("hello"));
    assert.equal(await readFile(resolve("/run/token"), "utf8"), "secret");

    await writeFile(resolve("/work/input.txt"), "changed");
    await writeFile(resolve("/work/output.txt"), "created");

    return {
      events: [
        { kind: "stdout", data: Uint8Array.from([0, 255]) },
        { kind: "stdout", data: Uint8Array.from([10]) },
        { kind: "stderr", data: Buffer.from("warning") },
        { kind: "exited", code: 7 },
      ],
    };
  });

  const result = await runSandboxWith(
    {
      image: "example.test/runner:latest",
      command: ["/bin/tool", "--flag"],
      workspace,
      workspaceTarget: "/work",
      copy: [{ source: credential, target: "/run/token" }],
      env: { MODE: "test" },
      stdin: "hello",
      cpus: 2,
      memory: "1G",
      timeoutMs: null,
    },
    async () => fake.sdk,
  );

  assert.equal(result.exitCode, 7);
  assert.equal(result.success, false);
  assert.notEqual(result.workspacePath, workspace);
  assert.deepEqual(await readFile(result.stdoutPath), Buffer.from([0, 255, 10]));
  assert.equal(await readFile(result.stderrPath, "utf8"), "warning");
  assert.equal(
    await readFile(path.join(result.workspacePath, "input.txt"), "utf8"),
    "changed",
  );
  assert.equal(
    await readFile(path.join(result.workspacePath, "output.txt"), "utf8"),
    "created",
  );
  assert.equal(
    await readlink(path.join(result.workspacePath, "input-link")),
    "input.txt",
  );

  assert.equal(await readFile(path.join(workspace, "input.txt"), "utf8"), "original");
  assert.equal(await readFile(credential, "utf8"), "secret");
  assert.deepEqual(fake.builder.config, {
    cpus: 2,
    detached: false,
    ephemeral: true,
    image: "example.test/runner:latest",
    memory: 1024,
    network: "none",
  });
  assert.equal(fake.builder.sandbox.destroyCalls, 1);

  const resultDirectory = path.dirname(result.stdoutPath);
  await result.dispose();
  await result.dispose();
  await assert.rejects(lstat(resultDirectory), { code: "ENOENT" });
});

test("uses the image command and can leave no workspace", async () => {
  const fake = fakeSdk(async ({ command, options }) => {
    assert.equal(command, undefined);
    assert.equal(options.stdinWasClosed, true);
    return { events: [{ kind: "exited", code: 0 }] };
  });

  const result = await runSandboxWith(
    {
      image: "example.test/default:latest",
      network: "public",
      timeoutMs: null,
    },
    async () => fake.sdk,
  );

  assert.equal(result.success, true);
  assert.equal(result.workspacePath, undefined);
  assert.equal(fake.builder.config.network, "public");
  await result[Symbol.asyncDispose]();
});

test("a timeout kills the process and destroys the sandbox", async () => {
  const fake = fakeSdk(async () => ({ events: [], block: true }));

  await assert.rejects(
    runSandboxWith(
      {
        image: "example.test/slow:latest",
        command: ["/bin/wait"],
        timeoutMs: 20,
      },
      async () => fake.sdk,
    ),
    (error) => error?.name === "TimeoutError",
  );

  assert.equal(fake.builder.sandbox.handles[0].killed, true);
  assert.equal(fake.builder.sandbox.destroyCalls, 1);
});

function fakeSdk(onExec) {
  const fake = {
    builder: undefined,
    sdk: {
      Sandbox: {
        builder(name) {
          fake.builder = new FakeBuilder(name, onExec);
          return fake.builder;
        },
      },
    },
  };
  return fake;
}

class FakeBuilder {
  config = {};
  patches = [];
  sandbox = undefined;

  constructor(name, onExec) {
    this.name = name;
    this.onExec = onExec;
  }

  image(value) {
    this.config.image = value;
    return this;
  }

  ephemeral(value) {
    this.config.ephemeral = value;
    return this;
  }

  detached(value) {
    this.config.detached = value;
    return this;
  }

  cpus(value) {
    this.config.cpus = value;
    return this;
  }

  memory(value) {
    this.config.memory = value;
    return this;
  }

  disableNetwork() {
    this.config.network = "none";
    return this;
  }

  patch(configure) {
    configure(new FakePatch(this.patches));
    return this;
  }

  async createWithProgress() {
    this.config.network ??= "public";
    this.sandbox = await FakeSandbox.create(this.onExec);
    let cancelled = false;

    return {
      cancel() {
        cancelled = true;
      },
      awaitSandbox: async () => {
        if (cancelled) throw new Error("creation cancelled");
        await applyPatches(this.sandbox.resolve, this.patches);
        return this.sandbox;
      },
    };
  }
}

class FakePatch {
  constructor(patches) {
    this.patches = patches;
  }

  copyDir(source, target) {
    this.patches.push({ kind: "directory", source, target });
    return this;
  }

  copyFile(source, target, options) {
    this.patches.push({
      kind: "file",
      mode: options?.mode,
      source,
      target,
    });
    return this;
  }

  symlink(linkTarget, target) {
    this.patches.push({ kind: "symlink", linkTarget, target });
    return this;
  }
}

async function applyPatches(resolve, patches) {
  for (const patch of patches) {
    const target = resolve(patch.target);
    await rm(target, { recursive: true, force: true });
    await mkdir(path.dirname(target), { recursive: true });

    if (patch.kind === "directory") {
      await cp(patch.source, target, { recursive: true, verbatimSymlinks: true });
    } else if (patch.kind === "file") {
      await copyFile(patch.source, target);
      await chmod(target, patch.mode);
    } else {
      await symlink(patch.linkTarget, target);
    }
  }
}

class FakeExecOptions {
  argsValue = [];
  cwdValue = undefined;
  envValue = undefined;
  stdinValue = undefined;
  stdinWasClosed = false;

  args(value) {
    this.argsValue = value;
    return this;
  }

  cwd(value) {
    this.cwdValue = value;
    return this;
  }

  envs(value) {
    this.envValue = value;
    return this;
  }

  stdinBytes(value) {
    this.stdinValue = Buffer.from(value);
    return this;
  }

  stdinNull() {
    this.stdinWasClosed = true;
    return this;
  }

  tty() {
    return this;
  }
}

class FakeHandle {
  killed = false;
  pending = undefined;

  constructor(events, block) {
    this.events = events;
    this.block = block;
  }

  async recv() {
    if (this.events.length > 0) return this.events.shift();
    if (!this.block || this.killed) return null;
    return await new Promise((resolve) => {
      this.pending = resolve;
    });
  }

  async kill() {
    this.killed = true;
    this.pending?.({ kind: "exited", code: -1 });
    this.pending = undefined;
  }
}

class FakeSandbox {
  handles = [];
  destroyCalls = 0;

  constructor(root, onExec) {
    this.root = root;
    this.onExec = onExec;
    this.resolve = (guestPath) => resolveGuest(root, guestPath);
    this.fsValue = new FakeFs(this.resolve);
  }

  static async create(onExec) {
    const root = await mkdtemp(path.join(tmpdir(), "lodot-run-guest-"));
    return new FakeSandbox(root, onExec);
  }

  fs() {
    return this.fsValue;
  }

  ssh() {
    return {
      openClient: async () => ({
        sftp: async () => ({
          readLink: async (guestPath) => readlink(this.resolve(guestPath)),
          close: async () => undefined,
        }),
        close: async () => undefined,
      }),
    };
  }

  async execStreamWith(command, configure) {
    return await this.start(command, configure);
  }

  async execDefaultStreamWith(configure) {
    return await this.start(undefined, configure);
  }

  async start(command, configure) {
    const options = configure(new FakeExecOptions());
    const { events, block = false } = await this.onExec({
      command,
      options,
      resolve: this.resolve,
    });
    const handle = new FakeHandle([...events], block);
    this.handles.push(handle);
    return handle;
  }

  async destroy() {
    this.destroyCalls += 1;
    await rm(this.root, { recursive: true, force: true });
  }
}

class FakeFs {
  constructor(resolve) {
    this.resolve = resolve;
  }

  async exists(guestPath) {
    try {
      await lstat(this.resolve(guestPath));
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  }

  async stat(guestPath) {
    return metadata(await lstat(this.resolve(guestPath)));
  }

  async list(guestPath) {
    const names = await readdir(this.resolve(guestPath));
    return await Promise.all(names.map(async (name) => ({
      path: path.posix.join(guestPath, name),
      ...metadata(await lstat(this.resolve(path.posix.join(guestPath, name)))),
    })));
  }

  async copyToHost(guestPath, hostPath) {
    await copyFile(this.resolve(guestPath), hostPath);
  }
}

function metadata(value) {
  let kind = "other";
  if (value.isFile()) kind = "file";
  if (value.isDirectory()) kind = "directory";
  if (value.isSymbolicLink()) kind = "symlink";
  return { kind, mode: value.mode };
}

function resolveGuest(root, guestPath) {
  assert.equal(path.posix.isAbsolute(guestPath), true);
  const normalized = path.posix.normalize(guestPath);
  assert.equal(normalized, guestPath);
  return path.join(root, ...guestPath.slice(1).split("/").filter(Boolean));
}
