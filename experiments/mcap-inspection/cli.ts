import {
  constants,
  openSync,
  closeSync,
  lstatSync,
  fstatSync,
  readSync,
} from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import type { JsonValue } from "../../src/domain/jsonValue.js";
import { sameRegularFileState } from "../../src/filesystem/RegularFile.js";
import { inspectSummary } from "./summary.ts";
import { boundedJson, diagnostic, InspectionFailure } from "./limits.ts";
import type { BoundedReadable } from "./limits.ts";

function readRange(fd: number, offset: bigint, size: bigint): Buffer {
  const buffer = Buffer.alloc(Number(size));
  let received = 0;
  while (received < buffer.length) {
    let bytes: number;
    try {
      bytes = readSync(
        fd,
        buffer,
        received,
        buffer.length - received,
        Number(offset) + received,
      );
    } catch (cause) {
      throw new InspectionFailure(
        "io",
        cause instanceof Error ? cause.message : String(cause),
      );
    }
    if (bytes === 0)
      throw new InspectionFailure(
        "changed",
        "File became shorter during inspection",
      );
    received += bytes;
  }
  return buffer;
}

async function main(): Promise<void> {
  let descriptor: number | undefined;
  let source: JsonValue = { input: null };
  let report: Record<string, JsonValue> = {};
  let readRanges: BoundedReadable["reads"] = [];
  let error: ReturnType<typeof diagnostic> | null = null;
  let fileError: ReturnType<typeof diagnostic> | null = null;
  let cleanupError: ReturnType<typeof diagnostic> | null = null;
  let input: string | undefined;
  try {
    const { positionals, values } = parseArgs({
      allowPositionals: true,
      options: { schema: { type: "string" } },
    });
    input = positionals[0];
    source = { input: input ?? null };
    if (input === undefined || positionals.length !== 1)
      throw new InspectionFailure(
        "input",
        "Usage: npm run inspect -- FILE [--schema ID]",
      );
    if (
      values.schema !== undefined &&
      (!/^[1-9][0-9]{0,4}$/.test(values.schema) ||
        Number(values.schema) > 65535)
    )
      throw new InspectionFailure(
        "input",
        "Schema ID must be an integer from 1 to 65535",
      );
    const path = resolve(input);
    const named = lstatSync(path, { bigint: true });
    if (!named.isFile())
      throw new InspectionFailure(
        "input",
        "Select a regular file, not a directory, device or symlink",
      );
    descriptor = openSync(
      path,
      constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0),
    );
    const fd = descriptor;
    const initial = fstatSync(fd, { bigint: true });
    if (!sameRegularFileState(named, initial))
      throw new InspectionFailure("changed", "File changed during admission");
    source = {
      input,
      path,
      size_bytes: String(initial.size),
      device: String(initial.dev),
      inode: String(initial.ino),
      modified_ns: String(initial.mtimeNs),
      changed_ns: String(initial.ctimeNs),
      hash_scope: "individual_read_ranges_not_whole_file",
    };
    const result = await inspectSummary(
      {
        size: async () => initial.size,
        read: async (offset, size) => readRange(fd, offset, size),
      },
      values.schema === undefined ? undefined : Number(values.schema),
    );
    if (!result.ok) {
      const { read_ranges, ...problem } = result.error;
      readRanges = read_ranges;
      error = problem;
      process.exitCode = 1;
    } else {
      const { read_ranges, ...summary } = result.value;
      readRanges = read_ranges;
      report = summary;
    }
    if (
      !sameRegularFileState(initial, fstatSync(fd, { bigint: true })) ||
      !sameRegularFileState(initial, lstatSync(path, { bigint: true }))
    )
      throw new InspectionFailure(
        "changed",
        "File identity or metadata changed during inspection",
      );
  } catch (cause) {
    const problem = diagnostic(cause, "io_or_usage");
    if (error === null) error = problem;
    else fileError = problem;
    process.exitCode = 1;
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch (cause) {
        cleanupError = diagnostic(cause, "io");
        process.exitCode = 1;
      }
    }
  }
  const receipt = {
    source,
    read_ranges: readRanges,
    error,
    file_error: fileError,
    cleanup_error: cleanupError,
  };
  let output: string;
  try {
    output = boundedJson({
      ok: error === null && cleanupError === null,
      ...receipt,
      ...report,
    });
  } catch (cause) {
    output = boundedJson({
      ok: false,
      ...receipt,
      output_error: diagnostic(cause),
      report_omitted: "json_limit",
    });
    process.exitCode = 1;
  }
  process.stdout.write(`${output}\n`);
}

await main();
