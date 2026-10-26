import {
  spawn as spawnChild,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { constants as osConstants } from "node:os";
import type { IDisposable, IPty } from "@lydell/node-pty";

import { processCaptureCancelled } from "./ProcessCaptureError.js";

/**
 * How a captured command gets its standard streams.
 *
 * The packaged `@lydell/node-pty` prebuild for Linux is linked against glibc.
 * On musl (Alpine) a gcompat shim lets the addon load but makes `forkpty`
 * segfault the calling process — and because that process is the MCP server
 * itself, one capture took the whole server down with it.
 *
 * So the backend is chosen before the native module is imported:
 *
 *   * **node-pty** where the prebuild is native (glibc Linux, macOS, Windows);
 *   * **pipe** on musl Linux, where the command runs under ordinary pipes.
 *
 * Pipe capture still observes output, exit, process samples and filesystem
 * effects; what it cannot observe is a TTY. A command that tests `isatty()` or
 * draws by terminal size behaves differently, so the capture reports that as a
 * limitation rather than pretending the terminal was real.
 */
export type ProcessTerminalBackend = "node-pty" | "pipe";

export interface ProcessTerminalSpawnOptions {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cols: number;
  readonly rows: number;
  readonly name: string;
}

/**
 * Is the native prebuild usable here?
 *
 * Node reports the glibc it runs against; musl builds have no such version.
 * Windows and macOS have no glibc either, so the check is Linux-only. This is a
 * property of the runtime, not a probe: probing by spawning is exactly the call
 * that faults, and a probe that kills its own server answers nothing.
 */
export const nativePtyUsable = (): boolean => {
  if (process.platform !== "linux") return true;
  const report = process.report?.getReport() as
    | { readonly header?: { readonly glibcVersionRuntime?: string } }
    | undefined;
  return report?.header?.glibcVersionRuntime !== undefined;
};

export const processTerminalBackend = (): ProcessTerminalBackend =>
  nativePtyUsable() ? "node-pty" : "pipe";

/** The smallest shape the capture harness needs from a terminal. */
class PipeTerminal {
  readonly pid: number;
  readonly process: string;
  readonly cols: number;
  readonly rows: number;
  handleFlowControl = false;

  readonly #child: ChildProcessWithoutNullStreams;
  readonly #data = new Set<(data: string) => void>();
  readonly #exit = new Set<
    (event: { readonly exitCode: number; readonly signal?: number }) => void
  >();
  #exited = false;
  #pendingExit: { readonly exitCode: number; readonly signal?: number } = {
    exitCode: 0,
  };
  #drainTimer: NodeJS.Timeout | undefined;

  constructor(
    executable: string,
    args: readonly string[],
    options: ProcessTerminalSpawnOptions,
  ) {
    this.process = executable;
    this.cols = options.cols;
    this.rows = options.rows;
    this.#child = spawnChild(executable, [...args], {
      cwd: options.cwd,
      env: options.env as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
      // Capture cleanup signals the process group it sampled from
      // `terminal.pid`, and a PTY child is a session leader. A pipe child has
      // to be one too, or that group is REA's own and cleanup would signal the
      // server. Not on Windows, where `detached` means a new console instead.
      detached: process.platform !== "win32",
    }) as ChildProcessWithoutNullStreams;
    this.pid = this.#child.pid ?? -1;
    if (this.pid < 1) {
      // `spawn` reports ENOENT asynchronously; consume it so the throw below is
      // the only error the caller sees.
      this.#child.on("error", () => undefined);
      throw new Error(`could not start ${executable}`);
    }
    this.#child.stdout.setEncoding("utf8");
    this.#child.stderr.setEncoding("utf8");
    // A command can close its stdin and stay alive (`exec 0<&-; sleep 10`). The
    // next scripted write then fails with EPIPE asynchronously, outside the
    // `try` in `write()`; an unhandled stream error would take down the server
    // this backend exists to keep up. Input after the command stopped reading is
    // not a capture error.
    this.#child.stdin.on("error", () => undefined);
    this.#child.stdout.on("data", (chunk: string) => this.#emit(chunk));
    this.#child.stderr.on("data", (chunk: string) => this.#emit(chunk));
    this.#child.on("error", () => undefined);
    this.#child.on("exit", (code, signal) => {
      const signalNumber =
        signal === null ? undefined : osConstants.signals[signal];
      this.#pendingExit = {
        exitCode: code ?? 0,
        ...(signalNumber === undefined ? {} : { signal: signalNumber }),
      };
      // `close` waits for the stdio pipes to close, and a grandchild that
      // inherited them holds those pipes open long after the command is gone
      // (`sh -c 'sleep 30'`, a shell that leaves a daemon behind). Exit is
      // therefore reported from the process itself, once the output already in
      // flight has drained or the drain wait is over.
      this.#drainTimer = setTimeout(() => this.#emitExit(), 200);
    });
    this.#child.on("close", () => this.#emitExit());
  }

  #emitExit(): void {
    if (this.#exited) return;
    this.#exited = true;
    if (this.#drainTimer !== undefined) clearTimeout(this.#drainTimer);
    for (const listener of Array.from(this.#exit)) listener(this.#pendingExit);
  }

  #emit(data: string): void {
    if (this.#exited) return;
    for (const listener of Array.from(this.#data)) listener(data);
  }

  onData(listener: (data: string) => void): IDisposable {
    this.#data.add(listener);
    return { dispose: () => this.#data.delete(listener) };
  }

  onExit(
    listener: (event: {
      readonly exitCode: number;
      readonly signal?: number;
    }) => void,
  ): IDisposable {
    // A listener attached after the command is gone still has to hear about it.
    if (this.#exited) {
      listener(this.#pendingExit);
      return { dispose: () => undefined };
    }
    this.#exit.add(listener);
    return { dispose: () => this.#exit.delete(listener) };
  }

  write(data: string): void {
    if (this.#child.stdin.destroyed || this.#child.stdin.writableEnded) return;
    try {
      this.#child.stdin.write(data);
    } catch {
      // The command closed its stdin; input after that is not an analysis error.
    }
  }

  resize(columns: number, rows: number): void {
    // No PTY, no window to resize. The records still say what was requested.
    void columns;
    void rows;
  }

  clear(): void {
    // ConPTY-only concern.
  }

  kill(signal?: string): void {
    try {
      this.#child.kill((signal ?? "SIGHUP") as NodeJS.Signals);
    } catch {
      // Already gone.
    }
  }

  pause(): void {
    this.#child.stdout.pause();
    this.#child.stderr.pause();
  }

  resume(): void {
    this.#child.stdout.resume();
    this.#child.stderr.resume();
  }
}

export interface SpawnedProcessTerminal {
  readonly terminal: IPty;
  readonly backend: ProcessTerminalBackend;
}

/** How the caller wants the spawn done, when it needs a say. */
export interface ProcessTerminalSpawnChoice {
  /** Defaults to what this host can run; a test names one to reach the other path. */
  readonly backend?: ProcessTerminalBackend;
  /** Checked once more after the native module loads, before the command starts. */
  readonly signal?: AbortSignal;
}

/**
 * Start one captured command on the best backend this host can actually run.
 *
 * The backend is a parameter so a test can exercise the pipe path on a glibc
 * machine, where the native module would otherwise be chosen.
 */
export const spawnProcessTerminal = async (
  executable: string,
  args: readonly string[],
  options: ProcessTerminalSpawnOptions,
  choice: ProcessTerminalSpawnChoice = {},
): Promise<SpawnedProcessTerminal> => {
  const backend = choice.backend ?? processTerminalBackend();
  if (backend === "pipe") {
    return {
      terminal: new PipeTerminal(executable, args, options) as unknown as IPty,
      backend,
    };
  }
  const { spawn } = await import("@lydell/node-pty");
  // The caller checked cancellation before this call, but loading the native
  // module is itself asynchronous. A command that starts after the capture was
  // cancelled still writes files, and a later kill cannot undo those.
  if (choice.signal?.aborted === true) {
    throw processCaptureCancelled(choice.signal.reason);
  }
  return { terminal: spawn(executable, [...args], options), backend };
};
