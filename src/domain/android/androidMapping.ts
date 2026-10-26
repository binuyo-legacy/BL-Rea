import { z } from "zod";
import { digestSchema } from "../digests.js";
import { dexDescriptorSchema, dexTypeSchema } from "./dexTypes.js";
import {
  type ProguardMapping,
  type ProguardResolution,
  resolveProguardClass,
  resolveProguardField,
  resolveProguardMethod,
} from "./proguardMapping.js";

/**
 * Memory bounds for one caller-selected mapping, parsed once per call. These
 * are not runtime settings: the whole file is decoded and indexed in memory.
 */
export const ANDROID_MAPPING_LIMITS = Object.freeze({
  fileBytes: 64 * 1024 * 1024,
  malformedSamples: 16,
  candidates: 8,
});

/** Caller-selected mapping provenance, added to Evidence when a mapping is applied. */
const ANDROID_MAPPING_LIMITATIONS = [
  "Mapped names come from the caller-selected mapping file, not from the APK.",
  "REA does not verify that the mapping belongs to this APK build; pg_map_id is reported, not checked.",
  "Mapping lookups use raw DEX names and types from the bridge, not JADX display aliases.",
  "unmapped means no valid mapping record matched the observed raw identity; it does not establish that the symbol was not obfuscated.",
  "No original source files or line numbers are recovered from the mapping.",
] as const;

/** Added when the mapping had malformed records that were skipped. */
const ANDROID_MAPPING_MALFORMED_LIMITATION =
  "The mapping contains malformed records; an unmapped symbol might be described by one of them.";

const mappedClass = z.strictObject({ name: z.string() });
const mappedField = z.strictObject({
  class: z.string(),
  name: z.string(),
  type: z.string(),
});
const mappedMethod = z.strictObject({
  class: z.string(),
  name: z.string(),
  return_type: z.string(),
  parameter_types: z.array(z.string()),
});

const resolution = <
  Mapped extends z.ZodType,
  const Verifier extends readonly [string, ...string[]],
>(
  mapped: Mapped,
  verifiedBy: Verifier,
) =>
  z.discriminatedUnion("status", [
    z.strictObject({
      status: z.literal("mapped"),
      mapped,
      verified_by: z.enum(verifiedBy),
    }),
    z.strictObject({
      status: z.literal("ambiguous"),
      reason: z.enum([
        "multiple-records",
        "descriptor-mismatch",
        "type-mismatch",
        "ambiguous-class",
      ]),
      candidate_count: z.int().positive(),
      /** The first ANDROID_MAPPING_LIMITS.candidates candidates. */
      candidates: z.array(mapped),
    }),
    z.strictObject({ status: z.literal("unmapped") }),
  ]);

const classSymbol = {
  kind: z.literal("class"),
  name: z.string(),
  raw_name: z.string(),
};
const fieldSymbol = {
  kind: z.literal("field"),
  class_raw_name: z.string(),
  name: z.string(),
  raw_name: z.string(),
  dex_type: dexTypeSchema,
};
const methodSymbol = {
  kind: z.literal("method"),
  class_raw_name: z.string(),
  name: z.string(),
  overload_index: z.int().nonnegative(),
  raw_name: z.string(),
  dex_descriptor: dexDescriptorSchema,
};
const count = z.int().nonnegative();

/** Mapping-derived names for observed symbols; observed facts stay primary. */
export const androidMappingReportSchema = z.strictObject({
  association: z.literal("caller-selected"),
  file: z.strictObject({
    path: z.string().min(1),
    sha256: digestSchema,
    bytes: count,
  }),
  reported: z.strictObject({
    compiler: z.string().nullable(),
    compiler_version: z.string().nullable(),
    min_api: z.string().nullable(),
    map_version: z.string().nullable(),
    pg_map_id: z.string().nullable(),
    pg_map_hash: z.string().nullable(),
  }),
  records: z.strictObject({
    classes: count,
    fields: count,
    methods: count,
    malformed: count,
  }),
  malformed: z.array(
    z.strictObject({
      line: z.int().positive(),
      reason: z.enum([
        "class-line",
        "member-line",
        "member-without-class",
        "metadata",
      ]),
    }),
  ),
  symbols: z.array(
    z.discriminatedUnion("kind", [
      z.strictObject({
        ...classSymbol,
        resolution: resolution(mappedClass, ["class"]),
      }),
      z.strictObject({
        ...fieldSymbol,
        resolution: resolution(mappedField, ["type"]),
      }),
      z.strictObject({
        ...methodSymbol,
        resolution: resolution(mappedMethod, ["descriptor"]),
      }),
    ]),
  ),
  coverage: z.strictObject({
    symbols: count,
    mapped: count,
    ambiguous: count,
    unmapped: count,
  }),
});

/** One observed symbol, identified by raw DEX facts rather than display names. */
export type AndroidMappingQuery =
  | z.infer<z.ZodObject<typeof classSymbol>>
  | z.infer<z.ZodObject<typeof fieldSymbol>>
  | z.infer<z.ZodObject<typeof methodSymbol>>;

/** A parsed mapping and the exact file bytes it came from. */
export interface AndroidMappingSource {
  readonly file: {
    readonly path: string;
    readonly sha256: string;
    readonly bytes: number;
  };
  readonly mapping: ProguardMapping;
}

const bounded = <Mapped, Verifier extends string>(
  resolved: ProguardResolution<Mapped, Verifier>,
) =>
  resolved.status === "ambiguous"
    ? {
        ...resolved,
        candidate_count: resolved.candidates.length,
        candidates: resolved.candidates.slice(
          0,
          ANDROID_MAPPING_LIMITS.candidates,
        ),
      }
    : resolved;

const resolve = (mapping: ProguardMapping, query: AndroidMappingQuery) => {
  switch (query.kind) {
    case "class":
      return bounded(resolveProguardClass(mapping, query.raw_name));
    case "field":
      return bounded(
        resolveProguardField(mapping, {
          className: query.class_raw_name,
          name: query.raw_name,
          type: query.dex_type,
        }),
      );
    case "method":
      return bounded(
        resolveProguardMethod(mapping, {
          className: query.class_raw_name,
          name: query.raw_name,
          descriptor: query.dex_descriptor,
        }),
      );
  }
};

/** Annotate observed symbols with mapping-derived names and coverage. */
export const projectAndroidMapping = (
  source: AndroidMappingSource,
  queries: readonly AndroidMappingQuery[],
): z.infer<typeof androidMappingReportSchema> => {
  const symbols = queries.map((query) => ({
    ...query,
    resolution: resolve(source.mapping, query),
  }));
  const counted = (status: string) =>
    symbols.filter((symbol) => symbol.resolution.status === status).length;
  return androidMappingReportSchema.parse({
    association: "caller-selected",
    file: source.file,
    reported: source.mapping.reported,
    records: source.mapping.records,
    malformed: source.mapping.malformed,
    symbols,
    coverage: {
      symbols: symbols.length,
      mapped: counted("mapped"),
      ambiguous: counted("ambiguous"),
      unmapped: counted("unmapped"),
    },
  });
};

/** Evidence limitations for an applied mapping; none without one. */
export const androidMappingLimitations = (
  source: AndroidMappingSource | undefined,
): readonly string[] => {
  if (source === undefined) return [];
  return source.mapping.records.malformed === 0
    ? ANDROID_MAPPING_LIMITATIONS
    : [...ANDROID_MAPPING_LIMITATIONS, ANDROID_MAPPING_MALFORMED_LIMITATION];
};
