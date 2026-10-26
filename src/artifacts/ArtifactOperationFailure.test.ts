import { expect, it } from "vitest";

import { ArtifactReaderFailure } from "./ArtifactReader.js";
import { translateArtifactFailure } from "./ArtifactOperationFailure.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";

it.each(["capacity", "file-size", "memory"] as const)(
  "retains the producing %s limit through public error projection",
  (boundary) => {
    const failure = new ArtifactReaderFailure(
      "limit",
      "The specific reader allowance was exceeded",
      { boundary },
    );
    const result = projectAnalysisError(
      translateArtifactFailure("inventory_artifact", failure),
    );
    expect(result).toMatchObject({
      code: "truncated",
      retryable: false,
      message: failure.message,
      details: { boundary, detail: failure.message },
    });
  },
);

it("keeps producer-owned recovery through cleanup wrapping and public projection", () => {
  const failure = new ArtifactReaderFailure(
    "unavailable",
    "Exact command diagnostic",
    {
      userMessage:
        "Release the existing attachment through its owner when safe, then retry.",
    },
  );
  const wrapped = ArtifactReaderFailure.withCleanup(failure, {
    reason: "Owned staging cleanup needs retry",
    resources: ["owned staging"],
  });
  const projected = projectAnalysisError(
    translateArtifactFailure("inspect_artifact", wrapped),
  );
  expect(projected.message).toContain("Release the existing attachment");
  expect(projected.remediation.action).toContain("owner when safe");
  expect(projected.details?.detail).toBe("Exact command diagnostic");
  expect(projected.details?.cleanup).toBeDefined();
});
