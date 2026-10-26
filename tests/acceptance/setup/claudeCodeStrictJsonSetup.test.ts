import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest, type TestCli } from "../../support/cli/cliFixture.js";

const peer = '"peer": { "command": "/usr/bin/true", "args": [] }';

const runIn = (cli: TestCli, home: string) => (arguments_: readonly string[]) =>
  cli.run({
    arguments: arguments_,
    cwd: home,
    environment: {
      HOME: home,
      USERPROFILE: home,
      CLAUDE_CONFIG_DIR: home,
      XDG_CONFIG_HOME: join(home, ".config"),
    },
  });

// Both clients read their configuration with strict JSON.parse after a BOM.
const clients = [
  { client: "claude_code", name: "Claude Code", path: [".claude.json"] },
  {
    client: "claude_desktop",
    name: "Claude Desktop",
    path:
      process.platform === "darwin"
        ? [
            "Library",
            "Application Support",
            "Claude",
            "claude_desktop_config.json",
          ]
        : process.platform === "win32"
          ? ["AppData", "Roaming", "Claude", "claude_desktop_config.json"]
          : [".config", "Claude", "claude_desktop_config.json"],
  },
] as const;

const setupArguments = (client: string) =>
  ["setup", "--client", client, "--skill=false", "--json"] as const;
const doctorArguments = (client: string) =>
  ["doctor", "--client", client, "--skill=false", "--json"] as const;

const writeConfig = async (config: string, text: string) => {
  await mkdir(dirname(config), { recursive: true });
  await writeFile(config, text);
};

// Both native clients reject these documents with their strict JSON reader.
for (const { client, name, path, syntax, original } of clients.flatMap((c) =>
  (
    [
      [
        "a comment",
        `{\n  // preserve this unrelated setting\n  "mcpServers": {\n    ${peer}\n  }\n}\n`,
      ],
      ["a trailing comma", `{\n  "mcpServers": {\n    ${peer},\n  }\n}\n`],
    ] as const
  ).map(([syntax, original]) => ({ ...c, syntax, original })),
))
  cliTest(
    `${name} setup, doctor, and uninstall refuse JSON with ${syntax}`,
    async ({ cli }) => {
      const home = await createTestTempDirectory("rea-claude-strict-json-");
      const config = join(home, ...path);
      await writeConfig(config, original);
      const run = runIn(cli, home);

      for (const mode of ["--dry-run", "--yes"]) {
        const setup = await run([...setupArguments(client), mode]);
        expect(setup.exitCode, setup.stdout).toBe(1);
        expect(setup.json).toMatchObject({
          status: "needs_human",
          plannedActions: [],
          appliedActions: [],
          remediation: expect.stringContaining("malformed"),
        });
      }
      const doctor = await run(doctorArguments(client));
      expect(doctor.exitCode).toBe(1);
      expect(doctor.json).toMatchObject({
        healthy: false,
        identity: {
          registrations: expect.arrayContaining([
            expect.objectContaining({
              client,
              state: "invalid",
            }),
          ]),
        },
      });
      const removed = await run(["uninstall", "--json"]);
      expect(removed.exitCode).toBe(1);
      expect(removed.json).toMatchObject({
        status: "failed",
        items: expect.arrayContaining([
          expect.objectContaining({ name: client, status: "failed" }),
        ]),
      });
      expect(await readFile(config, "utf8")).toBe(original);
      await expect(readFile(`${config}.rea.backup`)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

for (const { client, name, path, prefix } of clients.flatMap((c) =>
  ["", "\uFEFF"].map((prefix) => ({ ...c, prefix })),
))
  cliTest(
    `${name} setup configures strict JSON with prefix ${JSON.stringify(prefix)}`,
    async ({ cli }) => {
      const home = await createTestTempDirectory("rea-claude-strict-json-");
      const config = join(home, ...path);
      const original = `${prefix}{\n  "mcpServers": {\n    ${peer}\n  }\n}\n`;
      await writeConfig(config, original);
      const run = runIn(cli, home);

      const setup = await run([...setupArguments(client), "--yes"]);
      expect(setup.exitCode, setup.stdout).toBe(0);
      expect(setup.json).toMatchObject({
        status: "ready",
        clients: { [client]: { status: "configured" } },
      });
      expect(await readFile(`${config}.rea.backup`, "utf8")).toBe(original);
      const configured = await readFile(config, "utf8");
      expect(configured.startsWith(`${prefix}{`)).toBe(true);
      expect(JSON.parse(configured.slice(prefix.length))).toMatchObject({
        mcpServers: {
          peer: { command: "/usr/bin/true", args: [] },
          rea: { command: expect.any(String) },
        },
      });
      const doctor = await run(doctorArguments(client));
      expect(doctor.json).toMatchObject({
        identity: {
          registrations: expect.arrayContaining([
            expect.objectContaining({
              client,
              state: "aligned",
            }),
          ]),
        },
      });
    },
  );
