import { Cli } from "incur";
import { z } from "zod";

import { captureBrowserScenario } from "./application/BrowserScenarioCaptureService.js";
import { finishAnalysisCommand } from "./cli/finishAnalysisCommand.js";
import { withCommandCancellation } from "./cli/commandCancellation.js";
import {
  analysisEvidenceDeliveryOptions,
  cliEvidenceDeliveryInputError,
  publishCliAnalysisEvidence,
} from "./cli/analysisEvidenceDelivery.js";
import { CLI_COMMANDS } from "./cliCommandNames.js";
import { parseCliJsonInput, resolveCliJsonPaths } from "./cliJsonInput.js";
import { logCliCommand } from "./cliLogging.js";
import { projectAnalysisError } from "./domain/analysisErrorProjection.js";
import { analysisInputErrorFromIssues } from "./domain/inputIssueProjection.js";
import { browserScenarioSchema } from "./domain/browserScenario.js";
import type { BrowserScenarioCapturePort } from "./application/BrowserScenarioCapturePort.js";
import type { JsonValue } from "./domain/jsonValue.js";
import type { Logger } from "pino";

const OPERATION = "capture_browser_scenario";

/** Register the one-shot controlled browser scenario command. */
export const registerBrowserScenarioCommands = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
  environment: Readonly<Record<string, string | undefined>>,
  options: {
    readonly createProvider?: (
      environment: Readonly<Record<string, string | undefined>>,
    ) => BrowserScenarioCapturePort;
  } = {},
): void => {
  cli.command(CLI_COMMANDS.captureBrowserScenario, {
    description:
      "Run one bounded Playwright browser scenario and return Evidence",
    args: z.object({
      inputJson: z
        .string()
        .describe("Inline browser scenario JSON or JSON file path"),
    }),
    options: z.object(analysisEvidenceDeliveryOptions),
    run: ({ args, options: delivery }) =>
      withCommandCancellation((signal) =>
        logCliCommand(logger, CLI_COMMANDS.captureBrowserScenario, async () => {
          const deliveryError = cliEvidenceDeliveryInputError({
            detail: delivery.detail,
            evidenceOutput: delivery.evidence_output,
            operation: OPERATION,
          });
          if (deliveryError !== undefined) return cliError(deliveryError);
          const input = await parseCliJsonInput(
            args.inputJson,
            OPERATION,
            signal,
          );
          if (!input.ok) return input.error;
          const scenario = browserScenarioSchema.safeParse(
            resolveCliJsonPaths(input.value, [["browser", "executable_path"]]),
          );
          if (!scenario.success)
            return cliError(
              analysisInputErrorFromIssues(
                OPERATION,
                scenario.error.issues,
                input.value,
                { cause: scenario.error },
              ),
            );
          // Load Playwright only for this command, not during CLI startup.
          const provider =
            options.createProvider === undefined
              ? await import("./composition/browserScenario.js").then(
                  ({ createBrowserScenarioProvider }) =>
                    createBrowserScenarioProvider(environment),
                )
              : options.createProvider(environment);
          const result = await finishAnalysisCommand(
            () => captureBrowserScenario(provider, scenario.data, { signal }),
            {
              close: async () => {
                await provider?.close?.();
              },
            },
            "rea-playwright-browser-scenario",
            OPERATION,
            signal,
            undefined,
            { failureProjection: "initial" },
          );
          if (!("evidence_id" in result))
            return { error: "Browser scenario capture failed", ...result };
          return publishCliAnalysisEvidence(result, {
            providerId: "rea-playwright-browser-scenario",
            operation: OPERATION,
            signal,
            detail: delivery.detail,
            evidenceOutput: delivery.evidence_output,
          });
        }),
      ),
  });
  registerBrowserScenarioValidationCommand(cli, logger);
};

/**
 * Register the validation-only scenario command. It shares the execution
 * contract but stops before browser discovery, launch, attachment, or
 * navigation, so it needs no environment and constructs no provider.
 */
const registerBrowserScenarioValidationCommand = (
  cli: ReturnType<typeof Cli.create>,
  logger: Logger,
): void => {
  cli.command(CLI_COMMANDS.validateBrowserScenario, {
    description:
      "Validate one browser scenario without launching or attaching to a browser",
    args: z.object({
      inputJson: z
        .string()
        .describe("Inline browser scenario JSON or JSON file path"),
    }),
    run: ({ args }) =>
      withCommandCancellation((signal) =>
        logCliCommand(
          logger,
          CLI_COMMANDS.validateBrowserScenario,
          async () => {
            const input = await parseCliJsonInput(
              args.inputJson,
              OPERATION,
              signal,
            );
            if (!input.ok) return input.error;
            // Share the execution contract exactly: the same refinement rejects
            // duplicate or reserved step IDs, duplicate secret identities,
            // undeclared secret references, and request-step violations, so a
            // scenario that validates here is the scenario execution admits.
            const scenario = browserScenarioSchema.safeParse(
              resolveCliJsonPaths(input.value, [
                ["browser", "executable_path"],
              ]),
            );
            if (!scenario.success)
              return cliError(
                analysisInputErrorFromIssues(
                  OPERATION,
                  scenario.error.issues,
                  input.value,
                  { cause: scenario.error },
                ),
                "Browser scenario validation failed",
              );
            // Report the smallest sufficient answer: the accepted request shape.
            // Secret values are never read here, so nothing about them can leak.
            return {
              valid: true,
              actions: scenario.data.actions.length,
              secrets: scenario.data.secrets.length,
            };
          },
        ),
      ),
  });
};

const cliError = (
  error: Parameters<typeof projectAnalysisError>[0],
  headline = "Browser scenario capture failed",
): JsonValue => ({
  error: headline,
  ...projectAnalysisError(error),
});
