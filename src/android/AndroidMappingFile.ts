import {
  artifactFileCancellationCause,
  artifactFilePrimaryFacts,
  bindArtifactFileCleanup,
} from "../artifacts/ArtifactFileOperation.js";
import { ArtifactReaderFailure } from "../artifacts/ArtifactReader.js";
import type { ArtifactResourceScope } from "../artifacts/ArtifactResourceScope.js";
import { readStableArtifact } from "../artifacts/readStableArtifact.js";
import {
  ANDROID_MAPPING_LIMITS,
  type AndroidMappingSource,
} from "../domain/android/androidMapping.js";
import { parseProguardMapping } from "../domain/android/proguardMapping.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import { analysisErrorWithCleanupFailure } from "../domain/analysisErrorCleanup.js";
import {
  AnalysisAccessDeniedError,
  AnalysisArtifactChangedError,
  AnalysisCancelledError,
  AnalysisInputError,
  AnalysisResourceConstraintError,
} from "../domain/analysisErrorCore.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { err, ok, type Result } from "../domain/result.js";
import { isSelectedRegularFileError } from "../filesystem/RegularFile.js";

interface MappingRead {
  readonly path: string;
  readonly operation: string;
  readonly signal: AbortSignal;
}

const invalidMapping = (
  read: MappingRead,
  reason: "invalid_value" | "invalid_format",
  message: string,
  options?: ConstructorParameters<typeof AnalysisInputError>[1],
) =>
  new AnalysisInputError(read.operation, options, [
    { path: ["mapping_path"], reason, message },
  ]);

/** Classify the read's primary failure as the caller's selection where it is one. */
const readFailurePrimary = (
  cause: unknown,
  read: MappingRead,
): AnalysisError => {
  const facts = artifactFilePrimaryFacts(cause);
  const primary = facts.cause;
  const owned =
    facts.origin === "owned-or-classified" &&
    primary instanceof ArtifactReaderFailure
      ? primary
      : undefined;
  if (owned?.reason === "cancelled")
    return new AnalysisCancelledError(read.operation, {
      cause: artifactFileCancellationCause(owned),
    });
  if (owned?.reason === "limit")
    return new AnalysisResourceConstraintError(
      read.operation,
      "file-size",
      owned.message,
      { maximum_bytes: ANDROID_MAPPING_LIMITS.fileBytes },
      {
        cause: owned,
        retryable: false,
        remediationAction:
          "Select a mapping file within the fixed mapping byte limit.",
      },
    );
  if (owned?.reason === "integrity")
    return new AnalysisArtifactChangedError(
      read.operation,
      read.path,
      owned.message,
      { cause: owned },
    );
  if (owned?.reason === "path")
    return invalidMapping(read, "invalid_value", owned.message, {
      cause: owned,
    });
  if (primary instanceof Error && "code" in primary) {
    if (primary.code === "EACCES" || primary.code === "EPERM")
      return new AnalysisAccessDeniedError(
        read.operation,
        read.path,
        primary.code,
        { cause: primary },
      );
    if (isSelectedRegularFileError(primary))
      return invalidMapping(
        read,
        "invalid_value",
        `Selected mapping file could not be read (${primary.code}): ${read.path}`,
        { cause: primary },
      );
  }
  // A closed resource scope during shutdown is cancellation, not a file fault.
  if (read.signal.aborted)
    return new AnalysisCancelledError(read.operation, {
      cause: read.signal.reason,
    });
  return new ProviderAdapterError("jadx", read.operation, {
    cause: primary,
    diagnostics: {
      mapping_path: read.path,
      reason: primary instanceof Error ? primary.message : String(primary),
    },
  });
};

/** Compose the read failure with any descriptor cleanup the scope retained. */
const readFailure = (cause: unknown, read: MappingRead): AnalysisError => {
  const primary = readFailurePrimary(cause, read);
  const error =
    cause instanceof ArtifactReaderFailure && cause.cleanup !== undefined
      ? analysisErrorWithCleanupFailure(
          primary,
          new ProviderCleanupError(
            "jadx",
            cause.cleanup.resources,
            { reason: cause.cleanup.reason },
            { operation: read.operation, cause },
          ),
          read.operation,
        )
      : primary;
  bindArtifactFileCleanup(cause, error);
  return error;
};

/**
 * Read and parse one caller-selected R8/ProGuard mapping as a bounded,
 * identity-checked regular file. Failed descriptor cleanup stays owned by the
 * caller's resource scope.
 */
export const readAndroidMapping = async (
  path: string,
  operation: string,
  resources: ArtifactResourceScope,
  signal: AbortSignal,
): Promise<Result<AndroidMappingSource, AnalysisError>> => {
  const read = { path, operation, signal };
  let snapshot: Awaited<ReturnType<typeof readStableArtifact>>;
  try {
    snapshot = await resources.run(() =>
      readStableArtifact(
        path,
        ANDROID_MAPPING_LIMITS.fileBytes,
        signal,
        undefined,
        resources,
      ),
    );
  } catch (cause: unknown) {
    return err(readFailure(cause, read));
  }
  const malformed = (message: string) =>
    err(
      invalidMapping(read, "invalid_format", message, {
        diagnostics: { mapping_sha256: snapshot.sha256 },
      }),
    );
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(snapshot.bytes);
  } catch {
    return malformed(`Mapping file is not valid UTF-8: ${path}`);
  }
  const mapping = parseProguardMapping(text, ANDROID_MAPPING_LIMITS);
  if (!mapping.ok)
    return malformed(
      `Mapping file has no R8/ProGuard class records (${mapping.error}): ${path}`,
    );
  return ok({
    file: { path, sha256: snapshot.sha256, bytes: snapshot.bytes.length },
    mapping: mapping.value,
  });
};
