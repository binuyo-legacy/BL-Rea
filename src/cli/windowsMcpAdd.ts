// Windows delegation for `rea mcp add` (issue #5811).
//
// Incur's `mcp add` registers REA by spawning a bare `npx add-mcp` through
// execFile. On Windows `npx` is a `.cmd` shim that Node cannot execute without a
// shell, so the spawn fails with ENOENT before any client configuration is
// touched. REA's own `setup --client <id>` resolves the launcher through the
// installed package path and works on Windows, so the dispatcher delegates to
// it there. Options setup cannot honor are refused, never silently dropped.

import {
  VALUED_OUTPUT_FLAGS,
  splitIncurBuiltinArguments,
} from "../cliBuiltinArguments.js";

export type WindowsMcpAddDelegation =
  | { readonly refusal: string }
  | { readonly args: readonly string[]; readonly note: string };

/** Incur agent names use hyphens; REA client IDs use underscores. */
export const setupClientId = (agent: string): string =>
  agent.trim().toLowerCase().replaceAll("-", "_");

const MCP_ADD_OPTIONS_WITH_VALUE = new Set(["--agent", "--command", "-c"]);

/** Incur builtins that describe `mcp add` instead of running it; none spawns npx. */
const INCUR_INTROSPECTION_FLAGS = new Set([
  "--help",
  "-h",
  "--schema",
  "--llms",
  "--llms-full",
]);

/**
 * Decide how `rea mcp add` runs on this platform, from arguments already
 * normalized by `normalizeCliArguments`. Command selection uses Incur's
 * builtin split, so output flags may appear anywhere and are kept.
 * Returns undefined when nothing changes (not Windows, not `mcp add`, or an
 * introspection request such as `--help`).
 * Returns { refusal } when the request cannot be honored through setup.
 * Returns { args, note } with the setup arguments to run instead.
 */
export const windowsMcpAddDelegation = (
  normalized: readonly string[],
  platform: string,
): WindowsMcpAddDelegation | undefined => {
  if (platform !== "win32") return undefined;
  const split = splitIncurBuiltinArguments(normalized);
  if (split.command[0] !== "mcp" || split.command[1] !== "add")
    return undefined;
  const values = new Set(split.outputValues.map(({ index }) => index));
  if (
    normalized.some(
      (token, index) =>
        !values.has(index) && INCUR_INTROSPECTION_FLAGS.has(token),
    )
  )
    return undefined;
  const mcp = normalized.findIndex(
    (token, index) => token === "mcp" && !values.has(index),
  );
  const add = normalized.findIndex(
    (token, index) => index > mcp && token === "add" && !values.has(index),
  );
  const agents: string[] = [];
  const passthrough: string[] = [];
  let projectScope = false;
  let commandOverride = false;
  let dryRun = false;
  for (let index = 0; index < normalized.length; index += 1) {
    if (index === mcp || index === add) continue;
    const argument = normalized[index]!;
    if (VALUED_OUTPUT_FLAGS.has(argument) && values.has(index + 1)) {
      passthrough.push(argument, normalized[index + 1]!);
      index += 1;
      continue;
    }
    if (argument === "--agent") {
      const value = normalized[index + 1];
      if (value !== undefined && !value.startsWith("-")) {
        agents.push(value);
        index += 1;
      }
      continue;
    }
    if (argument.startsWith("--agent=")) {
      agents.push(argument.slice("--agent=".length));
      continue;
    }
    if (argument === "--no-global") {
      projectScope = true;
      continue;
    }
    if (
      argument === "--command" ||
      argument === "-c" ||
      argument.startsWith("--command=")
    ) {
      commandOverride = true;
      if (MCP_ADD_OPTIONS_WITH_VALUE.has(argument)) index += 1;
      continue;
    }
    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }
    passthrough.push(argument);
  }
  if (projectScope)
    return {
      refusal:
        "rea mcp add --no-global is not available on Windows: Incur's registration spawns a bare `npx`, which Windows cannot execute (#5811), and REA's setup registers agents globally only. Run `rea setup --client <id>` for a global registration, or add the project entry by hand with the command `rea setup --dry-run` prints.",
    };
  if (commandOverride)
    return {
      refusal:
        "rea mcp add --command is not available on Windows: Incur's registration spawns a bare `npx`, which Windows cannot execute (#5811), and REA's setup registers its own verified launcher command. Run `rea setup --client <id>` to register that launcher, or edit the client configuration by hand.",
    };
  if (agents.length === 0)
    return {
      refusal:
        "rea mcp add needs --agent <id> on Windows: Incur's agent auto-detection spawns a bare `npx`, which Windows cannot execute (#5811). Use `rea setup --all-detected` to configure every detected agent, or `rea mcp add --agent <id>`.",
    };
  const clients = agents.flatMap((agent) => ["--client", setupClientId(agent)]);
  return {
    args: [
      "setup",
      ...clients,
      "--yes",
      ...(dryRun ? ["--dry-run"] : []),
      ...passthrough,
    ],
    note: `Windows: rea mcp add delegates to rea setup ${clients.join(" ")}${dryRun ? " --dry-run" : ""} because Incur's registration cannot spawn npx here (#5811).`,
  };
};
