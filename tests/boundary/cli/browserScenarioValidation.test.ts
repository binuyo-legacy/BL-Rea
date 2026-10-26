import { Cli } from "incur";
import pino from "pino";
import { expect, it } from "vitest";

import { registerBrowserScenarioCommands } from "../../../src/cliBrowserScenarioCommands.js";
import { BROWSER_SCENARIO_START_STEP_ID } from "../../../src/domain/browserScenarioValues.js";
import type { BrowserScenarioCapturePort } from "../../../src/application/BrowserScenarioCapturePort.js";
import { AnalysisCapabilityUnavailableError } from "../../../src/domain/analysisErrorCore.js";
import { err } from "../../../src/domain/result.js";

const providerIdentity = {
  id: "test.scenario-validation",
  name: "Scenario validation test provider",
  version: null,
} as const;

const serveJson = async (
  cli: ReturnType<typeof Cli.create>,
  command: string,
  input: unknown,
): Promise<unknown> => {
  let stdout = "";
  await cli.serve([command, JSON.stringify(input), "--json"], {
    env: {},
    stdout: (text) => {
      stdout += text;
    },
    exit: () => undefined,
  });
  return JSON.parse(stdout) as unknown;
};

/** Register only the scenario commands, with a provider that must never run. */
const registerValidatingCli = (): ReturnType<typeof Cli.create> => {
  const cli = Cli.create("rea-scenario-validation-test", { sync: false });
  const provider: BrowserScenarioCapturePort = {
    identity: () => providerIdentity,
    captureScenario: async () =>
      err(
        new AnalysisCapabilityUnavailableError(
          providerIdentity.id,
          "capture_browser_scenario",
          "validation must not reach a provider",
        ),
      ),
    close: async () => undefined,
  };
  registerBrowserScenarioCommands(
    cli,
    pino({ level: "silent" }),
    {},
    {
      createProvider: () => {
        throw new Error("validation must not construct a browser provider");
      },
    },
  );
  // The inert provider is never handed to the CLI; keeping it referenced makes
  // the intended-but-unused execution path explicit for reviewers.
  void provider;
  return cli;
};

const launchScenario = {
  browser: { mode: "launch", executable_path: "browser" },
  start_url: { url: "http://127.0.0.1:3000" },
  actions: [{ step_id: "settle", action: "wait_for_timeout", duration_ms: 1 }],
} as const;

it("accepts a valid scenario without launching or attaching to a browser", async () => {
  const output = await serveJson(
    registerValidatingCli(),
    "validate-browser-scenario",
    launchScenario,
  );
  expect(output).toEqual({ valid: true, actions: 1, secrets: 0 });
});

it("counts declared secrets without resolving their environment values", async () => {
  const cli = registerValidatingCli();
  const output = await serveJson(cli, "validate-browser-scenario", {
    ...launchScenario,
    actions: [
      {
        step_id: "sign-in",
        action: "fill",
        locator: { kind: "css", selector: "#token" },
        value: { source: "secret", secret_id: "session_token" },
      },
    ],
    secrets: [
      { secret_id: "session_token", environment_variable: "SESSION_TOKEN" },
      { secret_id: "api_key", environment_variable: "API_KEY" },
    ],
  });
  expect(output).toEqual({ valid: true, actions: 1, secrets: 2 });
});

it("rejects a duplicate action step identity with the offending field path", async () => {
  const output = await serveJson(
    registerValidatingCli(),
    "validate-browser-scenario",
    {
      ...launchScenario,
      actions: [
        { step_id: "settle", action: "wait_for_timeout", duration_ms: 1 },
        { step_id: "settle", action: "wait_for_timeout", duration_ms: 2 },
      ],
    },
  );
  expect(output).toMatchObject({
    error: "Browser scenario validation failed",
    code: "invalid_request",
    category: "invalid_input",
    details: {
      issues: [
        expect.objectContaining({
          path: ["actions"],
          reason: "invalid_value",
          message: "Action step IDs must be unique",
        }),
      ],
    },
  });
});

it("rejects an action that reuses the reserved initial step identity", async () => {
  const output = await serveJson(
    registerValidatingCli(),
    "validate-browser-scenario",
    {
      ...launchScenario,
      actions: [
        {
          step_id: BROWSER_SCENARIO_START_STEP_ID,
          action: "wait_for_timeout",
          duration_ms: 1,
        },
      ],
    },
  );
  expect(output).toMatchObject({
    error: "Browser scenario validation failed",
    code: "invalid_request",
    category: "invalid_input",
    details: {
      issues: [
        expect.objectContaining({
          path: ["actions", 0, "step_id"],
          reason: "invalid_value",
        }),
      ],
    },
  });
});

it("rejects an undeclared secret reference without exposing any secret value", async () => {
  const cli = registerValidatingCli();
  const output = await serveJson(cli, "validate-browser-scenario", {
    ...launchScenario,
    actions: [
      {
        step_id: "sign-in",
        action: "fill",
        locator: { kind: "css", selector: "#token" },
        value: { source: "secret", secret_id: "session_token" },
      },
    ],
  });
  const serialized = JSON.stringify(output);
  expect(output).toMatchObject({
    error: "Browser scenario validation failed",
    code: "invalid_request",
    category: "invalid_input",
    details: {
      issues: [
        expect.objectContaining({
          path: ["secrets"],
          reason: "invalid_value",
          message: expect.stringContaining("session_token"),
        }),
      ],
    },
  });
  // The declaration is reported by identity only; no environment variable name
  // or resolved value belongs in a validation reply.
  expect(serialized).not.toContain("SESSION_TOKEN");
  expect(serialized).not.toContain("environment_variable");
});

it("rejects an unknown field instead of ignoring it", async () => {
  const output = await serveJson(
    registerValidatingCli(),
    "validate-browser-scenario",
    {
      ...launchScenario,
      navigation: { timeout_ms: 5 },
    },
  );
  expect(output).toMatchObject({
    error: "Browser scenario validation failed",
    code: "invalid_request",
    category: "invalid_input",
    details: {
      issues: [
        expect.objectContaining({
          path: ["navigation"],
          reason: "unknown_argument",
        }),
      ],
    },
  });
});

it("rejects a scenario whose input file cannot be read", async () => {
  const cli = registerValidatingCli();
  let stdout = "";
  await cli.serve(
    ["validate-browser-scenario", "missing-scenario.json", "--json"],
    {
      env: {},
      stdout: (text) => {
        stdout += text;
      },
      exit: () => undefined,
    },
  );
  expect(JSON.parse(stdout) as unknown).toMatchObject({
    input_path: "missing-scenario.json",
    input_reason: "read-failed",
  });
});
