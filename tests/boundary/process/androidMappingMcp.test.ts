import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { Ajv2020 } from "ajv/dist/2020.js";
import { createHash } from "node:crypto";
import { readFile, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it as test, onTestFinished } from "vitest";
import { z } from "zod";
import { ANDROID_TOOL_CONTRACTS } from "../../../src/contracts/android/androidToolContracts.js";
import { ANDROID_MAPPING_LIMITS } from "../../../src/domain/android/androidMapping.js";
import { androidResultSchemas } from "../../../src/domain/android/androidAnalysis.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createJadxProtocolFixture } from "../../fixtures/android/jadx.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const it = test.skipIf(process.platform === "win32");

/** One MCP client over the production server and a real owned fake JADX child. */
const connect = async () => {
  const fixture = await createJadxProtocolFixture();
  const session = createTestBinarySession(() => {
    throw new Error("APK analysis must not acquire a deep binary provider");
  });
  const server = createServer(
    { kind: "session", session },
    { androidAnalysis: fixture.provider },
  );
  const client = new Client({
    name: "android-mapping-regression",
    version: "1",
  });
  onTestFinished(async () => {
    await client.close();
    await server.close();
    await session.close();
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const inspect = (mapping_path: string) =>
    client.callTool({
      name: "inspect_android_class",
      arguments: {
        path: fixture.apk,
        class_name: "fixture.Target",
        mapping_path,
      },
    });
  return { ...fixture, client, inspect };
};

const mappingText = (original: string) =>
  [
    "# compiler: R8",
    "# pg_map_id: 7f00",
    `${original} -> fixture.Target:`,
    "    void onCreate(android.os.Bundle) -> onCreate",
    "    void pick(java.lang.String) -> choose",
    "    void pick(int) -> choose",
  ].join("\n");

it("annotates class inspection with a caller-selected mapping and reuses one engine", async () => {
  const { apk, client, inspect, launches } = await connect();
  const root = await createTestTempDirectory("rea-android-mapping-");
  const first = join(root, "first.txt");
  const second = join(root, "second.txt");
  await writeFile(first, mappingText("com.example.Original"));
  await writeFile(second, mappingText("com.example.Renamed"));
  const wire = (await client.listTools()).tools.find(
    (tool) => tool.name === "inspect_android_class",
  );
  const contract = ANDROID_TOOL_CONTRACTS.find(
    (candidate) => candidate.name === "inspect_android_class",
  );
  if (wire?.outputSchema === undefined || contract === undefined)
    throw new Error("Missing inspect_android_class contract");
  const validateOutput = new Ajv2020({
    strict: false,
    validateFormats: false,
  }).compile(z.record(z.string(), z.unknown()).parse(wire.outputSchema));
  const apkSha256 = createHash("sha256")
    .update(await readFile(apk))
    .digest("hex");
  for (const [path, original] of [
    [first, "com.example.Original"],
    [second, "com.example.Renamed"],
  ] as const) {
    const response = await inspect(path);
    expect(response.isError, JSON.stringify(response)).not.toBe(true);
    expect(validateOutput(response.structuredContent)).toBe(true);
    const evidence = parseEvidence(
      contract.outputSchema.parse(response.structuredContent),
    );
    expect(evidence.parameters.mapping_path).toBe(path);
    expect(evidence.subject?.digest.sha256).toBe(apkSha256);
    expect(evidence.limitations.join(" ")).toContain("pg_map_id");
    const result = androidResultSchemas.inspect_android_class.parse(
      evidence.normalized_result,
    );
    expect(result.methods.map(({ name }) => name)).toEqual([
      "onCreate",
      "choose",
      "choose",
    ]);
    expect(result.mapping).toMatchObject({
      file: {
        path,
        sha256: createHash("sha256")
          .update(await readFile(path))
          .digest("hex"),
      },
      reported: { compiler: "R8", pg_map_id: "7f00" },
      coverage: { symbols: 4, mapped: 4, ambiguous: 0, unmapped: 0 },
    });
    expect(result.mapping?.symbols[0]?.resolution).toEqual({
      status: "mapped",
      mapped: { name: original },
      verified_by: "class",
    });
    expect(result.mapping?.symbols[3]?.resolution).toMatchObject({
      mapped: { name: "pick", parameter_types: ["int"] },
    });
  }
  expect(launches).toHaveLength(1);
});

it.each([
  ["missing", "invalid_request", "invalid_value"],
  ["relative", "invalid_request", undefined],
  ["not UTF-8", "invalid_request", "invalid_format"],
  ["no class records", "invalid_request", "invalid_format"],
  ["over budget", "resource_constraint", undefined],
] as const)(
  "refuses a %s mapping before launching JADX",
  async (scenario, code, reason) => {
    const { inspect, launches } = await connect();
    const root = await createTestTempDirectory("rea-android-mapping-");
    const path = join(root, "mapping.txt");
    if (scenario === "not UTF-8")
      await writeFile(
        path,
        Buffer.concat([Buffer.from("a.B -> a.b:\n# "), Buffer.from([0xff])]),
      );
    if (scenario === "no class records")
      await writeFile(path, "com.example.Unused\n    void unused()\n");
    if (scenario === "over budget") {
      await writeFile(path, "");
      await truncate(path, ANDROID_MAPPING_LIMITS.fileBytes + 1);
    }
    const error = parseMcpToolError(
      await inspect(scenario === "relative" ? "mapping.txt" : path),
    ).error;
    expect(error.code).toBe(code);
    if (reason !== undefined)
      expect(error.details).toMatchObject({
        issues: [{ path: ["mapping_path"], reason }],
      });
    // The advertised schema refuses a relative path before Android admission.
    if (scenario === "relative")
      expect(JSON.stringify(error.details)).toContain(
        "mapping_path: must be an absolute local filesystem path",
      );
    if (scenario === "not UTF-8" || scenario === "no class records")
      expect(JSON.stringify(error)).toContain(
        createHash("sha256")
          .update(await readFile(path))
          .digest("hex"),
      );
    expect(launches).toHaveLength(0);
  },
);
