import { createRequire } from "node:module";

import { expect, it, vi } from "vitest";

import {
  nativePtyUsable,
  processTerminalBackend,
  spawnProcessTerminal,
} from "./ProcessTerminalBackend.js";

// The native prebuild is the one thing a musl runtime cannot import: through a
// gcompat shim the module resolves, and then `forkpty` faults the process that
// loaded it. Importing it there is the bug this suite guards, so the import
// itself fails rather than only the call made after it.
vi.mock("@lydell/node-pty", () => {
  throw new Error(
    "@lydell/node-pty was imported on a runtime that cannot run it",
  );
});

/** Run one shell script through the pipe backend and collect what it produced. */
const run = async (
  script: string,
  options: { readonly write?: string } = {},
): Promise<{
  readonly output: string;
  readonly exit: { readonly exitCode: number; readonly signal?: number };
  readonly backend: string;
}> => {
  const { terminal, backend } = await spawnProcessTerminal(
    "/bin/sh",
    ["-c", script],
    {
      cwd: process.cwd(),
      env: process.env,
      cols: 80,
      rows: 24,
      name: "xterm-256color",
    },
    { backend: "pipe" },
  );
  let output = "";
  terminal.onData((data) => {
    output += data;
  });
  const exited = new Promise<{
    readonly exitCode: number;
    readonly signal?: number;
  }>((resolve) => terminal.onExit(resolve));
  // A resize with no PTY is a recorded no-op, not an error.
  terminal.resize(120, 40);
  if (options.write !== undefined) terminal.write(options.write);
  const exit = await exited;
  return { output, exit, backend };
};

it("runs the command under pipes and reports its output and exit code", async () => {
  const { output, exit, backend } = await run(
    "printf hello; printf oops >&2; exit 3",
  );
  expect(backend).toBe("pipe");
  expect(output).toContain("hello");
  expect(output).toContain("oops");
  expect(exit.exitCode).toBe(3);
});

it("carries scripted input to the command's standard input", async () => {
  const { output, exit } = await run("read line; printf 'got:%s' \"$line\"", {
    write: "typed\n",
  });
  expect(output).toContain("got:typed");
  expect(exit.exitCode).toBe(0);
});

it.skipIf(process.platform !== "linux")(
  "chooses the pipe backend on a runtime with no glibc",
  () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "report");
    try {
      // A musl runtime reports no glibc, which is the only signal available
      // before the native module would be loaded and fault.
      Object.defineProperty(process, "report", {
        value: { getReport: () => ({ header: {} }) },
        configurable: true,
      });
      expect(nativePtyUsable()).toBe(false);
      expect(processTerminalBackend()).toBe("pipe");
    } finally {
      if (descriptor !== undefined)
        Object.defineProperty(process, "report", descriptor);
    }
  },
);

it.skipIf(process.platform !== "linux")(
  "runs on pipes where the runtime reports no glibc, without importing node-pty",
  async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "report");
    const loadedBefore = new Set(
      Object.keys(createRequire(import.meta.url).cache),
    );
    try {
      // The same signal the musl runtime gives: no glibcVersionRuntime. If the
      // default backend still chose node-pty, its import would throw above.
      Object.defineProperty(process, "report", {
        value: { getReport: () => ({ header: {} }) },
        configurable: true,
      });
      expect(processTerminalBackend()).toBe("pipe");
      const { terminal, backend } = await spawnProcessTerminal("/bin/sh", [
        "-c",
        "printf piped; exit 0",
      ], {
        cwd: process.cwd(),
        env: process.env,
        cols: 80,
        rows: 24,
        name: "xterm-256color",
      });
      const output: string[] = [];
      terminal.onData((data) => output.push(data));
      const exited = new Promise<{
        readonly exitCode: number;
        readonly signal?: number;
      }>((resolve) => terminal.onExit(resolve));
      const exit = await exited;
      expect(backend).toBe("pipe");
      expect(output.join("")).toContain("piped");
      expect(exit.exitCode).toBe(0);
      const newlyLoaded = Object.keys(createRequire(import.meta.url).cache).filter(
        (path) => path.includes("node-pty") && !loadedBefore.has(path),
      );
      expect(newlyLoaded).toEqual([]);
    } finally {
      if (descriptor !== undefined)
        Object.defineProperty(process, "report", descriptor);
    }
  },
);

it("survives scripted input after the command closed its stdin", async () => {
  const { terminal } = await spawnProcessTerminal(
    "/bin/sh",
    ["-c", "exec 0<&-; sleep 0.3"],
    {
      cwd: process.cwd(),
      env: process.env,
      cols: 80,
      rows: 24,
      name: "xterm-256color",
    },
    { backend: "pipe" },
  );
  const exited = new Promise<{
    readonly exitCode: number;
    readonly signal?: number;
  }>((resolve) => terminal.onExit(resolve));
  // Let the command close its end of the pipe, then write anyway. The failure
  // arrives as an asynchronous EPIPE on the stream, not from `write()` itself.
  await new Promise((resolve) => setTimeout(resolve, 100));
  terminal.write("ignored\n");
  terminal.write("ignored again\n");
  const exit = await exited;
  expect(exit.exitCode).toBe(0);
});

it.skipIf(process.platform !== "linux")(
  "runs the pipe child in its own process group",
  async () => {
    const { terminal } = await spawnProcessTerminal(
      "/bin/sh",
      ["-c", "sleep 30"],
      {
        cwd: process.cwd(),
        env: process.env,
        cols: 80,
        rows: 24,
        name: "xterm-256color",
      },
      { backend: "pipe" },
    );
    const exited = new Promise<{
      readonly exitCode: number;
      readonly signal?: number;
    }>((resolve) => terminal.onExit(resolve));
    try {
      // Capture cleanup signals the group sampled from `terminal.pid`; a PTY
      // child leads its own group, so the pipe child has to as well. Otherwise
      // that group is REA's and cleanup would signal the server.
      const stat = await import("node:fs/promises").then((fs) =>
        fs.readFile(`/proc/${String(terminal.pid)}/stat`, "utf8"),
      );
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      expect(Number(fields[2])).toBe(terminal.pid);
    } finally {
      terminal.kill("SIGKILL");
      await exited;
    }
  },
);

it("reports a signal when the command is killed", async () => {
  const { terminal } = await spawnProcessTerminal(
    "/bin/sh",
    ["-c", "sleep 30"],
    {
      cwd: process.cwd(),
      env: process.env,
      cols: 80,
      rows: 24,
      name: "xterm-256color",
    },
    { backend: "pipe" },
  );
  const exited = new Promise<{
    readonly exitCode: number;
    readonly signal?: number;
  }>((resolve) => terminal.onExit(resolve));
  terminal.kill("SIGTERM");
  const exit = await exited;
  expect(exit.signal).toBe(15);
});
