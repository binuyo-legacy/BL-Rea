import { z } from "zod";
import type { AnalysisError } from "../analysisErrorBase.js";
import { AnalysisResourceConstraintError } from "../analysisErrorCore.js";
import { jsonValueByteLength } from "../jsonValueByteLength.js";
import type { JsonValue } from "../jsonValue.js";
import { err, ok, type Result } from "../result.js";
import {
  webBundleAnalysisSchema,
  type WebBundleAnalysis,
} from "../webBundleAnalysis.js";
import { recordedBrowserOriginSchema } from "../browserObservation.js";
import type {
  AnalysisViewParent,
  AnalysisViewRequest,
  UnsignedAnalysisView,
} from "./analysisView.js";
import {
  boundedViewMessages,
  completeWithinViewCoverage,
  pageViewCoverage,
} from "./analysisViewCoverage.js";
import { analysisViewInputError } from "./analysisViewErrors.js";
import { createAnalysisViewResultReader } from "./analysisViewParent.js";

const PAGE_BYTES = 1024 * 1024;
const DIGEST_BYTES = jsonValueByteLength({ view_digest: "0".repeat(64) }) - 1;
const PROJECTION_BYTES = PAGE_BYTES - DIGEST_BYTES;

const endpointSchema =
  webBundleAnalysisSchema.shape.observations.shape.endpoints.element;
const inferenceSchema = webBundleAnalysisSchema.shape.inferences.element;
const sourceLocationSchema = endpointSchema.shape.location;
const basisSchema = inferenceSchema.shape.basis.element;

const pageShape = {
  kind: z.literal("web-bundle"),
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().positive().default(64),
};

export const webBundleViewRequestSchema = z.discriminatedUnion("collection", [
  z.strictObject({
    ...pageShape,
    collection: z.literal("endpoints"),
    indices: z.array(z.number().int().nonnegative()).optional(),
    values: z.array(z.string()).optional(),
    script_keys: z.array(z.string()).optional(),
    mechanisms: z.array(z.string()).optional(),
    fields: z.array(endpointSchema.keyof()).optional(),
  }),
  z.strictObject({
    ...pageShape,
    collection: z.literal("inferences"),
    indices: z.array(z.number().int().nonnegative()).optional(),
    kinds: z.array(inferenceSchema.shape.kind).optional(),
    values: z.array(z.string()).optional(),
    script_keys: z.array(z.string()).optional(),
    fields: z.array(inferenceSchema.keyof()).optional(),
  }),
  z.strictObject({
    kind: z.literal("web-bundle"),
    collection: z.literal("summary"),
  }),
]);

export type WebBundleViewRequest = z.output<typeof webBundleViewRequestSchema>;

export const webBundleSummarySchema = z.strictObject({
  target_url: z.string(),
  target_origin: recordedBrowserOriginSchema.nullable().optional(),
  scripts_observed: z.number().int().nonnegative(),
  scripts_analyzed: z.number().int().nonnegative(),
  counts: z.strictObject({
    endpoints: z.number().int().nonnegative(),
    inferences: z.number().int().nonnegative(),
    endpoint_candidates: z.number().int().nonnegative(),
    chunks: z.number().int().nonnegative(),
    routes: z.number().int().nonnegative(),
  }),
  completeness: webBundleAnalysisSchema.shape.completeness,
  limitation_count: z.number().int().nonnegative(),
});

export const webBundleEndpointRowSchema = z.strictObject({
  source_index: z.number().int().nonnegative(),
  value: endpointSchema.shape.value.optional(),
  mechanism: endpointSchema.shape.mechanism.optional(),
  location: sourceLocationSchema.optional(),
});

export const webBundleInferenceRowSchema = z.strictObject({
  source_index: z.number().int().nonnegative(),
  kind: inferenceSchema.shape.kind.optional(),
  value: inferenceSchema.shape.value.optional(),
  confidence: inferenceSchema.shape.confidence.optional(),
  basis: z.array(basisSchema).optional(),
});

export const webBundleViewItemsSchema = z.union([
  z.array(webBundleEndpointRowSchema),
  z.array(webBundleInferenceRowSchema),
]);

const readReport = createAnalysisViewResultReader(webBundleAnalysisSchema);

const choose = <T extends Record<string, JsonValue>>(
  row: T,
  fields: readonly string[] | undefined,
): Record<string, JsonValue> => {
  if (fields === undefined) return { ...row };
  const allowed = new Set(fields);
  const out: Record<string, JsonValue> = {};
  for (const [k, v] of Object.entries(row)) {
    if (allowed.has(k)) {
      out[k] = v;
    }
  }
  return out;
};

/** Historical projection of completed analyze_web_bundle Evidence. */
export const projectWebBundleView = (
  parent: AnalysisViewParent,
  selected: AnalysisViewRequest,
): Result<UnsignedAnalysisView, AnalysisError> => {
  if (selected.kind !== "web-bundle" && selected.kind !== "summary")
    return err(
      analysisViewInputError([
        {
          path: ["view", "kind"],
          reason: "invalid_value",
          message: "Select a web-bundle or summary view.",
        },
      ]),
    );

  if (parent.operation !== "analyze_web_bundle")
    return err(
      analysisViewInputError([
        {
          path: ["source", "operation"],
          reason: "invalid_value",
          message: "Web-bundle views require analyze_web_bundle Evidence.",
        },
      ]),
    );

  const parsed = readReport(parent);
  if (!parsed.ok) return parsed;
  const report: WebBundleAnalysis = parsed.value;

  const shared = {
    parent_evidence_id: parent.evidenceId,
    parent_operation: "analyze_web_bundle" as const,
    parent_digest: parent.evidenceId.slice(3),
    artifact: parent.artifact ?? null,
    target_url: report.capture.target_url,
    target_origin: report.capture.target_origin ?? null,
    limitations: boundedViewMessages(
      [...parent.limitations, ...report.limitations],
      parent.evidenceId,
      "limitations",
    ),
    unknowns: boundedViewMessages(
      [
        "Static bundle findings are observations or bounded inferences; REA does not execute captured JavaScript.",
        "String-built routes and endpoints, encrypted configuration, and server-side behavior may remain unknown.",
        ...report.unknowns.map((u) => `${u.dimension}: ${u.reason}`),
      ],
      parent.evidenceId,
      "unknowns",
    ),
  };

  const tooLarge = (collection: string): Result<never, AnalysisError> =>
    err(
      new AnalysisResourceConstraintError(
        "inspect_analysis_view",
        "transport",
        "The requested web-bundle page cannot fit the analysis-view byte budget; select fewer fields or a smaller selection. The complete parent is retained.",
        {
          parent_evidence_id: parent.evidenceId,
          limit_bytes: PAGE_BYTES,
          collection,
        },
      ),
    );

  const buildSummary = (): z.output<typeof webBundleSummarySchema> => ({
    target_url: report.capture.target_url,
    target_origin: report.capture.target_origin ?? null,
    scripts_observed: report.capture.scripts_observed,
    scripts_analyzed: report.capture.scripts_analyzed,
    counts: {
      endpoints: report.observations.endpoints.length,
      inferences: report.inferences.length,
      endpoint_candidates: report.inferences.filter(
        (i) => i.kind === "endpoint_candidate",
      ).length,
      chunks: report.observations.chunks.nodes.length,
      routes: report.observations.routes.length,
    },
    completeness: report.completeness,
    limitation_count: report.limitations.length,
  });

  if (selected.kind === "summary") {
    const summary = buildSummary();
    const result: UnsignedAnalysisView = {
      kind: "summary",
      view: selected,
      ...shared,
      summary,
      coverage: completeWithinViewCoverage(1, 1),
    };
    return jsonValueByteLength(
      result as unknown as JsonValue,
      PROJECTION_BYTES,
    ) > PROJECTION_BYTES
      ? tooLarge("summary")
      : ok(result);
  }

  const view = selected;
  if (view.collection === "summary") {
    const summary = buildSummary();
    const result: UnsignedAnalysisView = {
      kind: "web-bundle",
      view,
      ...shared,
      completeness: report.completeness,
      items: [],
      summary,
      byte_limited: false,
      coverage: completeWithinViewCoverage(1, 1),
    };
    return jsonValueByteLength(
      result as unknown as JsonValue,
      PROJECTION_BYTES,
    ) > PROJECTION_BYTES
      ? tooLarge("summary")
      : ok(result);
  }

  const deliverRows = <T extends Record<string, JsonValue>>(
    rows: readonly { readonly row: T; readonly source_index: number }[],
    project: (row: T, source_index: number) => Record<string, JsonValue>,
  ): Result<UnsignedAnalysisView, AnalysisError> => {
    const baseEnvelope = {
      ...shared,
      kind: "web-bundle" as const,
      view,
      completeness: report.completeness,
      items: [],
      summary: null,
      byte_limited: false,
      coverage: {
        status: "complete-within-view" as const,
        examined: Number.MAX_SAFE_INTEGER,
        total: Number.MAX_SAFE_INTEGER,
        next_offset: Number.MAX_SAFE_INTEGER,
        exhausted: false,
      },
    };

    let bytes =
      DIGEST_BYTES +
      jsonValueByteLength(
        baseEnvelope as unknown as JsonValue,
        PROJECTION_BYTES,
      );

    if (bytes > PAGE_BYTES) return tooLarge(view.collection);

    const items: Record<string, JsonValue>[] = [];
    let byte_limited = false;

    for (
      let index = view.offset;
      index < rows.length && items.length < view.limit;
      index++
    ) {
      const { row, source_index } = rows[index]!;
      const item = project(row, source_index);
      const addedBytes =
        jsonValueByteLength(item, PAGE_BYTES - bytes) +
        (items.length > 0 ? 1 : 0);
      if (bytes + addedBytes > PAGE_BYTES) {
        if (items.length === 0) return tooLarge(view.collection);
        byte_limited = true;
        break;
      }
      bytes += addedBytes;
      items.push(item);
    }

    const coverage = pageViewCoverage(view.offset, items.length, rows.length);
    const result: UnsignedAnalysisView = {
      ...shared,
      kind: "web-bundle" as const,
      view,
      completeness: report.completeness,
      items: webBundleViewItemsSchema.parse(items),
      summary: null,
      byte_limited,
      coverage,
    };

    return jsonValueByteLength(
      result as unknown as JsonValue,
      PROJECTION_BYTES,
    ) > PROJECTION_BYTES
      ? tooLarge(view.collection)
      : ok(result);
  };

  if (view.collection === "endpoints") {
    const indices =
      view.indices !== undefined ? new Set(view.indices) : undefined;
    const values = view.values !== undefined ? new Set(view.values) : undefined;
    const scriptKeys =
      view.script_keys !== undefined ? new Set(view.script_keys) : undefined;
    const mechanisms =
      view.mechanisms !== undefined ? new Set(view.mechanisms) : undefined;

    const matched: {
      readonly row: (typeof report.observations.endpoints)[number];
      readonly source_index: number;
    }[] = [];
    for (const [index, row] of report.observations.endpoints.entries()) {
      if (indices !== undefined && !indices.has(index)) continue;
      if (values !== undefined && !values.has(row.value)) continue;
      if (scriptKeys !== undefined && !scriptKeys.has(row.location.script_key))
        continue;
      if (mechanisms !== undefined && !mechanisms.has(row.mechanism)) continue;
      matched.push({ row, source_index: index });
    }

    return deliverRows(
      matched as unknown as readonly {
        readonly row: Record<string, JsonValue>;
        readonly source_index: number;
      }[],
      (row, source_index) => ({
        source_index,
        ...choose(row, view.fields),
      }),
    );
  }

  const indices =
    view.indices !== undefined ? new Set(view.indices) : undefined;
  const kinds = view.kinds !== undefined ? new Set(view.kinds) : undefined;
  const values = view.values !== undefined ? new Set(view.values) : undefined;
  const scriptKeys =
    view.script_keys !== undefined ? new Set(view.script_keys) : undefined;

  const matched: {
    readonly row: (typeof report.inferences)[number];
    readonly source_index: number;
  }[] = [];
  for (const [index, row] of report.inferences.entries()) {
    if (indices !== undefined && !indices.has(index)) continue;
    if (kinds !== undefined && !kinds.has(row.kind)) continue;
    if (values !== undefined && !values.has(row.value)) continue;
    if (
      scriptKeys !== undefined &&
      !row.basis.some((b) => scriptKeys.has(b.script_key))
    )
      continue;
    matched.push({ row, source_index: index });
  }

  return deliverRows(
    matched as unknown as readonly {
      readonly row: Record<string, JsonValue>;
      readonly source_index: number;
    }[],
    (row, source_index) => ({
      source_index,
      ...choose(row, view.fields),
    }),
  );
};
