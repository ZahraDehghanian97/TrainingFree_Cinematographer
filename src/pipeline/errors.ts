import {
  APICallError,
  RetryError,
} from "ai";
import { ZodError } from "zod";
import { DirectorGenerationError } from "./director";
import { GroundingGenerationError } from "./grounding-resolver";
import { PipelineModelTimeoutError } from "./model-provider";
import { PipelineAbortError } from "./orchestrator";
import type {
  PipelineErrorDetails,
  PipelineStage,
} from "./types";

const GATEWAY_ERROR_MARKER = Symbol.for("vercel.ai.gateway.error");
const MAX_CAUSE_DEPTH = 8;
const MAX_LOG_MESSAGE_LENGTH = 1_000;
const MAX_STACK_FRAMES = 20;

const TRANSPORT_ERROR_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

interface ErrorLikeRecord {
  cause?: unknown;
  code?: unknown;
  message?: unknown;
  name?: unknown;
  stack?: unknown;
  statusCode?: unknown;
}

export interface ClassifyPipelineErrorOptions {
  stage: PipelineStage;
  externalSignalAborted: boolean;
  model?: string;
  timeoutMs?: number;
}

export interface ClassifiedPipelineError {
  code: string;
  message: string;
  retryable: boolean;
  issues?: Array<{ path?: string; message: string }>;
  details: PipelineErrorDetails;
}

export interface PipelineFailureCauseLog {
  errorType: string;
  message: string;
  statusCode?: number;
  stack?: string;
}

export interface PipelineFailureLogEntry {
  level: "error";
  event: "pipeline.run.failed";
  timestamp: string;
  errorId: string;
  runId: string;
  environmentId: string;
  stage: PipelineStage;
  code: string;
  retryable: boolean;
  details: PipelineErrorDetails;
  error: PipelineFailureCauseLog;
  causeChain: PipelineFailureCauseLog[];
}

export interface PipelineRunLogger {
  error(entry: PipelineFailureLogEntry): void;
}

export interface CreatePipelineFailureLogOptions {
  errorId: string;
  runId: string;
  environmentId: string;
  stage: PipelineStage;
  timestamp: string;
  classification: ClassifiedPipelineError;
  /** Values which must not appear even if an unexpected error echoes them. */
  redact?: readonly string[];
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return value !== null && typeof value === "object";
}

function asErrorLike(value: unknown): ErrorLikeRecord | undefined {
  return isRecord(value) ? value as ErrorLikeRecord : undefined;
}

function isGatewayError(error: unknown): boolean {
  return isRecord(error) && error[GATEWAY_ERROR_MARKER] === true;
}

function errorName(error: unknown): string {
  const candidate = asErrorLike(error)?.name;
  if (
    typeof candidate === "string"
    && candidate.length > 0
    && candidate.length <= 80
    && /^[A-Za-z0-9_.:-]+$/.test(candidate)
  ) {
    return candidate;
  }
  const constructorName = error instanceof Error ? error.constructor.name : undefined;
  return typeof constructorName === "string"
    && constructorName.length > 0
    && constructorName.length <= 80
    && /^[A-Za-z0-9_.:-]+$/.test(constructorName)
    ? constructorName
    : "UnknownError";
}

function statusCodeOf(error: unknown): number | undefined {
  const statusCode = asErrorLike(error)?.statusCode;
  return Number.isInteger(statusCode) && (statusCode as number) >= 100 && (statusCode as number) <= 599
    ? statusCode as number
    : undefined;
}

function childErrors(error: unknown): unknown[] {
  const children: unknown[] = [];
  const cause = asErrorLike(error)?.cause;
  if (cause !== undefined) children.push(cause);
  if (RetryError.isInstance(error)) children.push(...error.errors);
  return children;
}

/** Root-first, bounded traversal that understands both Error.cause and AI retry attempts. */
function relatedErrors(root: unknown): unknown[] {
  const result: unknown[] = [];
  const pending: unknown[] = [root];
  const seen = new Set<unknown>();
  while (pending.length > 0 && result.length < MAX_CAUSE_DEPTH + 1) {
    const current = pending.shift();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    result.push(current);
    pending.push(...childErrors(current));
  }
  return result;
}

function issuesFor(error: unknown): Array<{ path?: string; message: string }> | undefined {
  if (error instanceof DirectorGenerationError) return error.issues;
  if (error instanceof ZodError) {
    return error.issues.slice(0, 20).map((issue) => ({
      path: issue.path.join(".") || "$",
      message: issue.message,
    }));
  }
  return undefined;
}

function retryAttempts(errors: readonly unknown[]): number | undefined {
  const counts = errors
    .filter((error) => RetryError.isInstance(error))
    .map((error) => (error as RetryError).errors.length);
  return counts.length === 0 ? undefined : Math.max(...counts);
}

function isTransportError(error: unknown): boolean {
  const record = asErrorLike(error);
  const code = typeof record?.code === "string" ? record.code.toUpperCase() : undefined;
  if (code !== undefined && TRANSPORT_ERROR_CODES.has(code)) return true;
  return error instanceof TypeError
    && typeof error.message === "string"
    && /\bfetch failed\b|\bnetwork(?: request)? failed\b/i.test(error.message);
}

function providerFacts(root: unknown): {
  detected: boolean;
  statusCode?: number;
  attempts?: number;
  transport: boolean;
} {
  const related = relatedErrors(root);
  const providerErrors = related.filter((error) =>
    APICallError.isInstance(error)
    || RetryError.isInstance(error)
    || isGatewayError(error)
    || errorName(error) === "GatewayAuthenticationError"
    || errorName(error) === "GatewayError",
  );
  const statuses = providerErrors
    .map(statusCodeOf)
    .filter((status): status is number => status !== undefined);
  const attempts = retryAttempts(related);
  return {
    detected: providerErrors.length > 0,
    ...(statuses.length === 0 ? {} : { statusCode: statuses[statuses.length - 1] }),
    ...(attempts === undefined ? {} : { attempts }),
    transport: related.some(isTransportError)
      || providerErrors.some((error) => APICallError.isInstance(error) && error.statusCode === undefined),
  };
}

function safeModelId(value: string | undefined): string | undefined {
  const candidate = value?.trim();
  return candidate !== undefined
    && candidate.length > 0
    && candidate.length <= 200
    && /^[A-Za-z0-9._:/-]+$/.test(candidate)
    ? candidate
    : undefined;
}

function isLlmStage(stage: PipelineStage): boolean {
  return stage === "draft" || stage === "grounding";
}

function isInternalLlmTimeout(error: unknown, options: ClassifyPipelineErrorOptions): boolean {
  if (options.externalSignalAborted || !isLlmStage(options.stage)) return false;
  if (error instanceof PipelineModelTimeoutError) return true;
  const name = errorName(error);
  if (name === "TimeoutError") return true;
  if (name === "AbortError") return true;
  return RetryError.isInstance(error) && error.reason === "abort";
}

function defaultPublicMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.slice(0, 1_000);
  return "The pipeline run failed unexpectedly.";
}

function buildDetails(
  error: unknown,
  options: ClassifyPipelineErrorOptions,
  facts: ReturnType<typeof providerFacts>,
): PipelineErrorDetails {
  const name = errorName(error);
  const hasModelContext = isLlmStage(options.stage) && (
    error instanceof PipelineModelTimeoutError
    || error instanceof DirectorGenerationError
    || error instanceof GroundingGenerationError
    || facts.detected
    || name === "AbortError"
    || name === "TimeoutError"
  );
  const timeout = error instanceof PipelineModelTimeoutError
    ? error.timeoutMs
    : options.timeoutMs;
  const model = safeModelId(error instanceof PipelineModelTimeoutError
    ? error.modelId
    : options.model);
  const attempts = error instanceof PipelineModelTimeoutError
    ? error.attempts
    : facts.attempts;
  return {
    errorType: errorName(error),
    ...(facts.statusCode === undefined ? {} : { statusCode: facts.statusCode }),
    ...(attempts === undefined ? {} : { attempts }),
    ...(timeout === undefined || !hasModelContext ? {} : { timeoutMs: timeout }),
    ...(model === undefined || !hasModelContext ? {} : { model }),
  };
}

/** Converts arbitrary provider/domain errors into the stable, safe public API contract. */
export function classifyPipelineError(
  error: unknown,
  options: ClassifyPipelineErrorOptions,
): ClassifiedPipelineError {
  const facts = providerFacts(error);
  const details = buildDetails(error, options, facts);
  const issues = issuesFor(error);

  if (options.externalSignalAborted || error instanceof PipelineAbortError) {
    return {
      code: "run_cancelled",
      message: "The pipeline run was cancelled.",
      retryable: true,
      details,
    };
  }
  if (error instanceof DirectorGenerationError) {
    return {
      code: "invalid_director_output",
      message: error.message,
      retryable: true,
      ...(issues === undefined ? {} : { issues }),
      details,
    };
  }
  if (error instanceof GroundingGenerationError) {
    return {
      code: "invalid_grounding_output",
      message: error.message,
      retryable: true,
      details,
    };
  }
  if (error instanceof ZodError) {
    return {
      code: "schema_validation_failed",
      message: "Pipeline data failed schema validation.",
      retryable: isLlmStage(options.stage),
      ...(issues === undefined ? {} : { issues }),
      details,
    };
  }
  if (isInternalLlmTimeout(error, options)) {
    const timeoutMs = details.timeoutMs;
    return {
      code: "llm_timeout",
      message: timeoutMs === undefined
        ? `The ${options.stage} model request timed out. Retry, or increase LLM_TIMEOUT_MS if the provider is responding slowly.`
        : `The ${options.stage} model request timed out after ${timeoutMs} ms. Retry, or increase LLM_TIMEOUT_MS if the provider is responding slowly.`,
      retryable: true,
      details,
    };
  }

  const names = relatedErrors(error).map(errorName);
  const statusCode = facts.statusCode;
  if (
    facts.detected
    && (
      statusCode === 401
      || statusCode === 403
      || names.includes("GatewayAuthenticationError")
      || names.includes("GatewayError")
    )
  ) {
    return {
      code: "provider_auth_failed",
      message: "The language-model provider rejected the server credentials or model access. Check AI_GATEWAY_API_KEY and the configured model.",
      retryable: false,
      details,
    };
  }
  if (facts.detected && statusCode === 429) {
    return {
      code: "provider_rate_limited",
      message: "The language-model provider rate limit was reached. Wait briefly, then retry.",
      retryable: true,
      details,
    };
  }
  if (
    facts.detected
    && (
      statusCode === 408
      || statusCode === 409
      || (statusCode !== undefined && statusCode >= 500)
      || facts.transport
      || (RetryError.isInstance(error) && statusCode === undefined)
    )
  ) {
    return {
      code: "provider_unavailable",
      message: "The language-model provider is temporarily unavailable or could not be reached. Retry the run.",
      retryable: true,
      details,
    };
  }
  if (facts.detected) {
    return {
      code: "provider_request_failed",
      message: "The language-model provider rejected the request. Check the configured model and provider settings.",
      retryable: false,
      details,
    };
  }

  if (options.stage === "timeline") {
    return {
      code: "timeline_solver_failed",
      message: defaultPublicMessage(error),
      retryable: false,
      details,
    };
  }
  if (options.stage === "optimization") {
    return {
      code: "trajectory_optimization_failed",
      message: defaultPublicMessage(error),
      retryable: false,
      details,
    };
  }
  return {
    code: "pipeline_stage_failed",
    message: defaultPublicMessage(error),
    retryable: true,
    details,
  };
}

function redactText(value: string, redactions: readonly string[]): string {
  let result = value;
  for (const secret of redactions) {
    if (secret.length > 0) result = result.split(secret).join("[REDACTED]");
  }
  return result
    .replace(/\bBearer\s+[^\s"']+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:api[_-]?key|authorization)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/\b(?:sk|vck)[-_][A-Za-z0-9_-]{12,}\b/g, "[REDACTED_TOKEN]")
    .slice(0, MAX_LOG_MESSAGE_LENGTH);
}

function safeDiagnosticMessage(
  error: unknown,
  classification: ClassifiedPipelineError,
  redactions: readonly string[],
): string {
  if (APICallError.isInstance(error)) {
    return error.statusCode === undefined
      ? "Provider API transport failed."
      : `Provider API call failed with HTTP ${error.statusCode}.`;
  }
  if (RetryError.isInstance(error)) {
    return `Provider request failed after ${error.errors.length} attempt(s).`;
  }
  if (isGatewayError(error)) {
    const statusCode = statusCodeOf(error);
    return statusCode === undefined
      ? "AI Gateway request failed."
      : `AI Gateway request failed with HTTP ${statusCode}.`;
  }
  const name = errorName(error);
  if (name === "AbortError" || name === "TimeoutError") return classification.message;
  if (name.startsWith("AI_")) return `${name} occurred.`;
  if (
    isRecord(error)
    && (
      "requestBodyValues" in error
      || "responseBody" in error
      || "requestHeaders" in error
      || "responseHeaders" in error
    )
  ) {
    return `${name} occurred.`;
  }
  if (error instanceof Error && error.message.trim()) {
    return redactText(error.message, redactions);
  }
  return `Thrown ${typeof error} value.`;
}

function safeStack(error: unknown, redactions: readonly string[]): string | undefined {
  const stack = asErrorLike(error)?.stack;
  if (typeof stack !== "string") return undefined;
  const frames = stack.split("\n")
    .slice(1)
    .filter((line) => /^\s*at\s/.test(line))
    .slice(0, MAX_STACK_FRAMES)
    .map((line) => redactText(line, redactions));
  return frames.length === 0 ? undefined : `${errorName(error)}\n${frames.join("\n")}`;
}

function causeLog(
  error: unknown,
  classification: ClassifiedPipelineError,
  redactions: readonly string[],
): PipelineFailureCauseLog {
  const statusCode = statusCodeOf(error);
  const stack = safeStack(error, redactions);
  return {
    errorType: errorName(error),
    message: safeDiagnosticMessage(error, classification, redactions),
    ...(statusCode === undefined ? {} : { statusCode }),
    ...(stack === undefined ? {} : { stack }),
  };
}

/** Builds a manually whitelisted log object; provider request/response data is never traversed. */
export function createPipelineFailureLog(
  error: unknown,
  options: CreatePipelineFailureLogOptions,
): PipelineFailureLogEntry {
  const redactions = options.redact ?? [];
  const related = relatedErrors(error);
  return {
    level: "error",
    event: "pipeline.run.failed",
    timestamp: options.timestamp,
    errorId: options.errorId,
    runId: options.runId,
    environmentId: options.environmentId,
    stage: options.stage,
    code: options.classification.code,
    retryable: options.classification.retryable,
    details: options.classification.details,
    error: causeLog(error, options.classification, redactions),
    causeChain: related.slice(1).map((cause) =>
      causeLog(cause, options.classification, redactions)),
  };
}
