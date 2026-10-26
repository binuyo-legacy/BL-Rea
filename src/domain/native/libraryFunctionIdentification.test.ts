import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  identifyLibraryFunctions,
  MAX_LIBRARY_SIGNATURE_PATTERN_TOKENS,
} from "./libraryFunctionIdentification.js";

const signature = (
  id: string,
  pattern: string,
  overrides: Record<string, unknown> = {},
) => ({
  id,
  name: id,
  library: "libc",
  pattern,
  ...overrides,
});

describe("identifyLibraryFunctions", () => {
  it("matches exact signatures at the function start", () => {
    expect(
      identifyLibraryFunctions(
        [{ function_id: "f1", bytes: [0x55, 0x48, 0x89, 0xe5] }],
        [signature("memcpy", "55 48 89 E5")],
      ),
    ).toEqual({
      identified: [
        {
          function_id: "f1",
          matches: [
            {
              signature_id: "memcpy",
              name: "memcpy",
              library: "libc",
              library_version: null,
              pattern_length: 4,
              wildcard_count: 0,
              score: 1,
              confidence: "exact",
            },
          ],
        },
      ],
      unknowns: [],
    });
  });

  it("matches wildcards and reports pattern confidence", () => {
    const result = identifyLibraryFunctions(
      [{ function_id: "f1", bytes: [0x55, 0x48, 0x8b, 0xe5] }],
      [signature("memcpy", "55 48 ?? E5")],
    );
    expect(result.identified[0]?.matches[0]).toMatchObject({
      wildcard_count: 1,
      score: 0.75,
      confidence: "pattern",
    });
  });

  it("anchors patterns at offset zero", () => {
    const result = identifyLibraryFunctions(
      [{ function_id: "f1", bytes: [0x90, 0x55, 0x48, 0x89, 0xe5] }],
      [signature("memcpy", "55 48 89 E5")],
    );
    expect(result.identified[0]?.matches).toEqual([]);
  });

  it("keeps all equally valid signatures with deterministic ranking", () => {
    const result = identifyLibraryFunctions(
      [{ function_id: "f1", bytes: [0x55, 0x48, 0x89, 0xe5] }],
      [
        signature("short", "55 48 ??"),
        signature("exact-z", "55 48 89 E5"),
        signature("exact-a", "55 48 89 E5"),
      ],
    );
    expect(
      result.identified[0]?.matches.map((match) => match.signature_id),
    ).toEqual(["exact-a", "exact-z", "short"]);
  });

  it("preserves optional library versions", () => {
    const result = identifyLibraryFunctions(
      [{ function_id: "f1", bytes: [0x90] }],
      [signature("nop", "90", { library_version: "2.39" })],
    );
    expect(result.identified[0]?.matches[0]?.library_version).toBe("2.39");
  });

  it("reports functions beyond the function budget as unknown", () => {
    const result = identifyLibraryFunctions(
      [
        { function_id: "f1", bytes: [0x90] },
        { function_id: "f2", bytes: [0x90] },
      ],
      [signature("nop", "90")],
      { max_functions: 1 },
    );
    expect(result.unknowns).toEqual([
      { function_id: "f2", reason: "function_budget_exceeded" },
    ]);
  });

  it("reports oversized function bytes as unknown", () => {
    const result = identifyLibraryFunctions(
      [{ function_id: "f1", bytes: [0x90, 0x90] }],
      [signature("nop", "90")],
      { max_function_bytes: 1 },
    );
    expect(result.unknowns).toEqual([
      { function_id: "f1", reason: "function_bytes_budget_exceeded" },
    ]);
  });

  it("rejects duplicate signature ids", () => {
    expect(() =>
      identifyLibraryFunctions(
        [],
        [signature("duplicate", "90"), signature("duplicate", "91")],
      ),
    ).toThrow(z.ZodError);
  });

  it("rejects all-wildcard signatures", () => {
    expect(() =>
      identifyLibraryFunctions([], [signature("wild", "?? ??")]),
    ).toThrow(z.ZodError);
  });

  it("rejects patterns over the token cap", () => {
    expect(() =>
      identifyLibraryFunctions(
        [],
        [
          signature(
            "long",
            "90 ".repeat(MAX_LIBRARY_SIGNATURE_PATTERN_TOKENS + 1),
          ),
        ],
      ),
    ).toThrow(z.ZodError);
  });
});
