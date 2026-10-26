import { createHash } from "node:crypto";
import type { IReadable } from "@mcap/core";
import { jsonValueByteLength } from "../../src/domain/jsonValueByteLength.js";
import type { JsonValue } from "../../src/domain/jsonValue.js";

export const READ_BYTES = 4 * 1024 * 1024;
export const OUTPUT_BYTES = 1024 * 1024;

export class InspectionFailure extends Error {
  readonly _tag = "McapPrototypeFailure";
  readonly kind:
    | "reader_rejected"
    | "selection"
    | "limit"
    | "io"
    | "io_or_usage"
    | "input"
    | "changed";
  constructor(kind: InspectionFailure["kind"], message: string) {
    super(message);
    this.kind = kind;
  }
}

export function diagnostic(
  cause: unknown,
  fallback: InspectionFailure["kind"] = "reader_rejected",
) {
  const message = cause instanceof Error ? cause.message : String(cause);
  return {
    kind: cause instanceof InspectionFailure ? cause.kind : fallback,
    message: message.slice(0, 1024),
    ...(message.length > 1024
      ? {
          message_truncated: true,
          message_utf8_bytes: Buffer.byteLength(message),
          message_sha256: createHash("sha256").update(message).digest("hex"),
        }
      : {}),
  };
}

export function boundedJson(value: JsonValue): string {
  if (jsonValueByteLength(value, OUTPUT_BYTES) > OUTPUT_BYTES)
    throw new InspectionFailure(
      "limit",
      `JSON output exceeds ${OUTPUT_BYTES} bytes`,
    );
  return JSON.stringify(value);
}

/** Borrows the source; the CLI owns the descriptor and its final close. */
export class BoundedReadable implements IReadable {
  readonly source: IReadable;
  readonly reads: { offset: string; byte_length: string; sha256: string }[] =
    [];
  #charged = 0n;
  constructor(source: IReadable) {
    this.source = source;
  }
  size(): Promise<bigint> {
    return this.source.size();
  }
  async read(offset: bigint, size: bigint): Promise<Uint8Array> {
    const end = offset + size;
    if (offset < 0n || size < 0n || end > (await this.size()))
      throw new InspectionFailure(
        "reader_rejected",
        "Reader requested a range outside the file",
      );
    if (end > BigInt(Number.MAX_SAFE_INTEGER))
      throw new InspectionFailure(
        "limit",
        "File offsets exceed this prototype's safe integer range",
      );
    if (size > BigInt(READ_BYTES) - this.#charged)
      throw new InspectionFailure(
        "limit",
        `Cumulative reads exceed ${READ_BYTES} bytes`,
      );
    this.#charged += size;
    const data = await this.source.read(offset, size);
    if (BigInt(data.byteLength) !== size)
      throw new InspectionFailure(
        "changed",
        "File ended before the requested range was read",
      );
    this.reads.push({
      offset: String(offset),
      byte_length: String(size),
      sha256: createHash("sha256").update(data).digest("hex"),
    });
    return data;
  }
}
