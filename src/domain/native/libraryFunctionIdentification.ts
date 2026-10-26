import { z } from "zod";
import { compareUnicodeCodePoints } from "../unicodeCodePointOrder.js";

export const MAX_LIBRARY_SIGNATURE_PATTERN_TOKENS = 1024;
export const DEFAULT_LIBRARY_FUNCTION_BUDGET = 10_000;
export const DEFAULT_LIBRARY_FUNCTION_BYTES_BUDGET = 4_096;
export const DEFAULT_LIBRARY_SIGNATURE_SET_BUDGET = 10_000;

const signatureToken = /^(?:[0-9A-Fa-f]{2}|\?\?)$/u;

export const libraryFunctionSignatureSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  library: z.string().min(1),
  library_version: z.string().min(1).nullable().default(null),
  pattern: z.string().trim().min(1),
});

export const libraryFunctionBytesSchema = z.array(
  z.number().int().min(0).max(255),
);

export const libraryFunctionInputSchema = z.strictObject({
  function_id: z.string().min(1),
  bytes: libraryFunctionBytesSchema,
});

export const libraryFunctionBudgetsSchema = z.strictObject({
  max_functions: z
    .number()
    .int()
    .positive()
    .default(DEFAULT_LIBRARY_FUNCTION_BUDGET),
  max_function_bytes: z
    .number()
    .int()
    .positive()
    .default(DEFAULT_LIBRARY_FUNCTION_BYTES_BUDGET),
  max_signatures: z
    .number()
    .int()
    .positive()
    .default(DEFAULT_LIBRARY_SIGNATURE_SET_BUDGET),
});

export const libraryFunctionMatchSchema = z.strictObject({
  signature_id: z.string().min(1),
  name: z.string().min(1),
  library: z.string().min(1),
  library_version: z.string().min(1).nullable(),
  pattern_length: z.number().int().positive(),
  wildcard_count: z.number().int().nonnegative(),
  score: z.number().min(0).max(1),
  confidence: z.enum(["exact", "pattern"]),
});

export const libraryFunctionIdentificationSchema = z.strictObject({
  identified: z.array(
    z.strictObject({
      function_id: z.string().min(1),
      matches: z.array(libraryFunctionMatchSchema),
    }),
  ),
  unknowns: z.array(
    z.strictObject({
      function_id: z.string().min(1),
      reason: z.enum([
        "function_budget_exceeded",
        "function_bytes_budget_exceeded",
      ]),
    }),
  ),
});

export type LibraryFunctionSignature = z.output<
  typeof libraryFunctionSignatureSchema
>;
export type LibraryFunctionInput = z.output<typeof libraryFunctionInputSchema>;
export type LibraryFunctionBudgets = z.output<
  typeof libraryFunctionBudgetsSchema
>;
export type LibraryFunctionMatch = z.output<typeof libraryFunctionMatchSchema>;
export type LibraryFunctionIdentification = z.output<
  typeof libraryFunctionIdentificationSchema
>;

type CompiledSignature = LibraryFunctionSignature & {
  readonly bytes: readonly (number | null)[];
  readonly wildcard_count: number;
  readonly concrete_count: number;
};

const parseSignature = (raw: LibraryFunctionSignature): CompiledSignature => {
  const tokens = raw.pattern.split(/\s+/u);
  if (
    tokens.length > MAX_LIBRARY_SIGNATURE_PATTERN_TOKENS ||
    tokens.some((token) => !signatureToken.test(token))
  )
    throw new z.ZodError([
      {
        code: "custom",
        path: ["pattern"],
        message: `Pattern must contain at most ${MAX_LIBRARY_SIGNATURE_PATTERN_TOKENS} hexadecimal or ?? tokens`,
      },
    ]);
  const bytes = tokens.map((token) =>
    token === "??" ? null : Number.parseInt(token, 16),
  );
  const wildcard_count = bytes.filter((byte) => byte === null).length;
  const concrete_count = bytes.length - wildcard_count;
  if (concrete_count === 0)
    throw new z.ZodError([
      {
        code: "custom",
        path: ["pattern"],
        message: "Pattern must contain at least one concrete byte",
      },
    ]);
  return { ...raw, bytes, wildcard_count, concrete_count };
};

const compileSignatures = (
  raw: readonly LibraryFunctionSignature[],
  maxSignatures: number,
): readonly CompiledSignature[] => {
  if (raw.length > maxSignatures)
    throw new z.ZodError([
      {
        code: "custom",
        path: [],
        message: `Signature set exceeds the maximum of ${maxSignatures} signatures`,
      },
    ]);
  const seen = new Set<string>();
  return raw.map((signature) => {
    if (seen.has(signature.id))
      throw new z.ZodError([
        {
          code: "custom",
          path: ["id"],
          message: `Duplicate signature id: ${signature.id}`,
        },
      ]);
    seen.add(signature.id);
    return parseSignature(signature);
  });
};

const matches = (
  bytes: readonly number[],
  signature: CompiledSignature,
): boolean =>
  signature.bytes.every(
    (expected, index) => expected === null || expected === bytes[index],
  );

const rankMatches = (
  signatures: readonly CompiledSignature[],
): LibraryFunctionMatch[] =>
  signatures
    .map((signature) => ({
      signature_id: signature.id,
      name: signature.name,
      library: signature.library,
      library_version: signature.library_version,
      pattern_length: signature.bytes.length,
      wildcard_count: signature.wildcard_count,
      score: signature.concrete_count / signature.bytes.length,
      confidence:
        signature.wildcard_count === 0
          ? ("exact" as const)
          : ("pattern" as const),
    }))
    .sort(
      (left, right) =>
        right.score - left.score ||
        right.pattern_length - left.pattern_length ||
        compareUnicodeCodePoints(left.signature_id, right.signature_id),
    );

export const identifyLibraryFunctions = (
  rawFunctions: readonly unknown[],
  rawSignatures: readonly unknown[],
  rawBudgets: unknown = {},
): LibraryFunctionIdentification => {
  const budgets = libraryFunctionBudgetsSchema.parse(rawBudgets);
  const functions = rawFunctions.map((input) =>
    libraryFunctionInputSchema.parse(input),
  );
  const signatures = compileSignatures(
    rawSignatures.map((signature) =>
      libraryFunctionSignatureSchema.parse(signature),
    ),
    budgets.max_signatures,
  );
  const identified: LibraryFunctionIdentification["identified"] = [];
  const unknowns: LibraryFunctionIdentification["unknowns"] = [];
  functions.forEach((input, index) => {
    if (index >= budgets.max_functions) {
      unknowns.push({
        function_id: input.function_id,
        reason: "function_budget_exceeded",
      });
      return;
    }
    if (input.bytes.length > budgets.max_function_bytes) {
      unknowns.push({
        function_id: input.function_id,
        reason: "function_bytes_budget_exceeded",
      });
      return;
    }
    identified.push({
      function_id: input.function_id,
      matches: rankMatches(
        signatures.filter((signature) => matches(input.bytes, signature)),
      ),
    });
  });
  return libraryFunctionIdentificationSchema.parse({ identified, unknowns });
};
