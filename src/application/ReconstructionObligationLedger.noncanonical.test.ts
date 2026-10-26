import { describe, expect, it } from "vitest";

import { AnalysisInputError } from "../domain/analysisErrorCore.js";
import { createEvidenceBundle } from "../domain/evidenceBundle.js";
import {
  buildReconstructionObligationLedgerEvidenceValidated,
  resolveReconstructionObligationLedgerRequest,
} from "./ReconstructionObligationLedgerService.js";
import { proofEvidence } from "./ReconstructionObligationLedger.fixture.js";

/**
 * Build a non-canonical bundle by constructing a canonical one and then
 * swapping the order of its `records` array. The resolver accepts the
 * input shape because the schema allows any EvidenceBundle shape, but
 * `parseEvidenceBundle` inside the ledger pipeline performs a whole-bundle
 * canonical comparison that fails when `records` is out of order. This throws
 * `TypeError("Evidence bundle manifests are not canonical")` which, before the
 * fix for #3219, leaked through as `AnalysisProtocolError` → `unreadable_output`.
 */
const nonCanonicalBundle = () => {
  // Two records whose IDs sort in one direction; reverse them so the bundle
  // `records` array is out of canonical (ascending evidence_id) order.
  const a = proofEvidence("aaa");
  const b = proofEvidence("bbb");
  const canonical = createEvidenceBundle([a, b]);
  // Reverse records to produce a non-canonical ordering. While createEvidenceBundle
  // sorts records before deriving manifest arrays, the out-of-order `records`
  // array causes the later whole-bundle canonical comparison in
  // parseEvidenceBundle() to fail.
  return { ...canonical, records: [...canonical.records].reverse() };
};

describe("build_reconstruction_obligation_ledger non-canonical bundle handling", () => {
  it("returns AnalysisInputError for a non-canonical evidence bundle (issue #3219)", () => {
    // The resolver accepts the shape of the input (the schema allows any
    // EvidenceBundle shape). The canonicality check fires downstream in
    // deriveReconstructionObligationCandidates when parseEvidenceBundle()
    // performs whole-bundle canonical comparison, throwing a TypeError that
    // the ledger service maps to AnalysisInputError.
    const parsed = resolveReconstructionObligationLedgerRequest({
      evidence_bundle: nonCanonicalBundle(),
      reviewed_obligations: [],
      manifest: { bindings: [], contradictions: [] },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("Expected request parsing to succeed");

    const result = buildReconstructionObligationLedgerEvidenceValidated(
      parsed.value,
    );

    // The TypeError thrown by parseEvidenceBundle must be routed to
    // AnalysisInputError (→ invalid_request), NOT AnalysisProtocolError
    // (→ unreadable_output).
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected err result");
    expect(result.error).toBeInstanceOf(AnalysisInputError);
    if (!(result.error instanceof AnalysisInputError)) return;
    expect(result.error.operation).toBe(
      "build_reconstruction_obligation_ledger",
    );
  });

  it("returns AnalysisInputError with the canonicality message as an issue", () => {
    const parsed = resolveReconstructionObligationLedgerRequest({
      evidence_bundle: nonCanonicalBundle(),
      reviewed_obligations: [],
      manifest: { bindings: [], contradictions: [] },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("Expected request parsing to succeed");

    const result = buildReconstructionObligationLedgerEvidenceValidated(
      parsed.value,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("Expected err result");

    const error = result.error;
    expect(error).toBeInstanceOf(AnalysisInputError);
    if (!(error instanceof AnalysisInputError)) return;

    // workflowInputError converts TypeError.message into an invalid_value issue.
    expect(error.issues).toHaveLength(1);
    expect(error.issues[0]).toMatchObject({
      path: [],
      reason: "invalid_value",
      message: expect.stringContaining("canonical"),
    });
  });
});
