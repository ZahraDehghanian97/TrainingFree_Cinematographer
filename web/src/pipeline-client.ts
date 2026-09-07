import type { CameraDirectionDraft, ResolvedCameraDirectionDSL } from "../../src/types/dsl";
import type { ResolvedSubjectBinding } from "../../src/types/subject-binding";
import type { FlattenedTimeline, TimelineSolverOutput } from "../../src/types/solver";
import type { CompiledLossPlan, OptimizerDiagnostics } from "../../src/optimizer/types";
import type { PipelineErrorDetails, PromptPipelineResult } from "../../src/pipeline/types";

export type { PipelineErrorDetails };

export const PIPELINE_STAGES = [
  "draft",
  "grounding",
  "timeline",
  "optimization",
] as const;

export type PipelineStage = typeof PIPELINE_STAGES[number];
export type PipelineStageStatus = "running" | "completed";

export interface PipelineRunRequest {
  environmentId: string;
  prompt: string;
}

export interface PipelineRunAccepted {
  runId: string;
}

export interface GroundingArtifact {
  resolvedCsl: ResolvedCameraDirectionDSL;
  bindings: ResolvedSubjectBinding[];
}

export interface TimelineArtifact {
  timeline: TimelineSolverOutput;
  flattenedTimeline: FlattenedTimeline;
}

export interface OptimizationArtifact {
  diagnostics: OptimizerDiagnostics;
  compiledPlan: CompiledLossPlan;
}

export interface PipelineIssue {
  path?: string;
  message: string;
}

export interface PipelineArtifacts {
  draft?: CameraDirectionDraft;
  resolvedCsl?: ResolvedCameraDirectionDSL;
  bindings?: ResolvedSubjectBinding[];
  timeline?: TimelineSolverOutput;
  flattenedTimeline?: FlattenedTimeline;
  diagnostics?: OptimizerDiagnostics;
  compiledPlan?: CompiledLossPlan;
  models?: PromptPipelineResult["models"];
  timings?: PromptPipelineResult["timings"];
}

export type PipelineCompleteResult = PromptPipelineResult & {
  /** Accepted for servers that also group the same final artifacts. */
  artifacts?: PipelineArtifacts;
};

export interface PipelineStageEvent {
  type: "stage";
  runId: string;
  sequence: number;
  timestamp: string;
  stage: PipelineStage;
  status: PipelineStageStatus;
  elapsedMilliseconds?: number;
  artifact?: unknown;
}

export interface PipelineCompleteEvent {
  type: "complete";
  runId: string;
  sequence: number;
  timestamp: string;
  result: PipelineCompleteResult;
}

export interface PipelineErrorEvent {
  type: "error";
  runId: string;
  sequence: number;
  timestamp: string;
  stage: PipelineStage;
  errorId: string;
  code: string;
  message: string;
  retryable: boolean;
  issues?: PipelineIssue[];
  details?: PipelineErrorDetails;
}

export type PipelineEvent = PipelineStageEvent | PipelineCompleteEvent | PipelineErrorEvent;

export class PipelineClientError extends Error {
  readonly status?: number;
  readonly code?: string;
  readonly errorId?: string;
  readonly issues?: PipelineIssue[];
  readonly details?: PipelineErrorDetails;

  constructor(message: string, options: {
    status?: number;
    code?: string;
    errorId?: string;
    issues?: PipelineIssue[];
    details?: PipelineErrorDetails;
  } = {}) {
    super(message);
    this.name = "PipelineClientError";
    this.status = options.status;
    this.code = options.code;
    this.errorId = options.errorId;
    this.issues = options.issues;
    this.details = options.details;
  }
}

interface PipelineEventCallbacks {
  onEvent(event: PipelineEvent): void;
  onProtocolError(error: PipelineClientError): void;
  onConnectionError?(): void;
  onOpen?(): void;
}

export interface PipelineEventStream {
  close(): void;
}

const API_ROOT = "/api/pipeline/runs";
const STAGE_SET = new Set<string>(PIPELINE_STAGES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new PipelineClientError(`${path} must be a non-empty string.`, { code: "invalid-response" });
  }
  return value;
}

function requiredSequence(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new PipelineClientError("event.sequence must be a positive safe integer.", { code: "invalid-event" });
  }
  return value as number;
}

function parseIssues(value: unknown): PipelineIssue[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new PipelineClientError("event.issues must be an array.", { code: "invalid-event" });
  }
  return value.map((issue, index) => {
    if (!isRecord(issue)) {
      throw new PipelineClientError(`event.issues[${index}] must be an object.`, { code: "invalid-event" });
    }
    const message = requiredString(issue.message, `event.issues[${index}].message`);
    return typeof issue.path === "string" && issue.path.trim()
      ? { path: issue.path, message }
      : { message };
  });
}

function parseErrorDetails(value: unknown): PipelineErrorDetails | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new PipelineClientError("event.details must be an object.", { code: "invalid-event" });
  }

  const errorType = requiredString(value.errorType, "event.details.errorType");
  const optionalNonNegativeInteger = (candidate: unknown, path: string): number | undefined => {
    if (candidate === undefined) return undefined;
    if (!Number.isSafeInteger(candidate) || (candidate as number) < 0) {
      throw new PipelineClientError(`${path} must be a non-negative safe integer.`, { code: "invalid-event" });
    }
    return candidate as number;
  };
  const optionalPositiveNumber = (candidate: unknown, path: string): number | undefined => {
    if (candidate === undefined) return undefined;
    if (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate <= 0) {
      throw new PipelineClientError(`${path} must be a positive finite number.`, { code: "invalid-event" });
    }
    return candidate;
  };
  const statusCode = optionalNonNegativeInteger(value.statusCode, "event.details.statusCode");
  const attempts = optionalNonNegativeInteger(value.attempts, "event.details.attempts");
  const timeoutMs = optionalPositiveNumber(value.timeoutMs, "event.details.timeoutMs");
  const model = value.model === undefined
    ? undefined
    : requiredString(value.model, "event.details.model");

  return {
    errorType,
    ...(statusCode === undefined ? {} : { statusCode }),
    ...(attempts === undefined ? {} : { attempts }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(model === undefined ? {} : { model }),
  };
}

function parsePipelineEvent(value: unknown): PipelineEvent {
  if (!isRecord(value)) {
    throw new PipelineClientError("Pipeline event must be a JSON object.", { code: "invalid-event" });
  }
  const type = requiredString(value.type, "event.type");
  const runId = requiredString(value.runId, "event.runId");
  const sequence = requiredSequence(value.sequence);
  const timestamp = requiredString(value.timestamp, "event.timestamp");

  if (type === "stage") {
    const stage = requiredString(value.stage, "event.stage");
    if (!STAGE_SET.has(stage)) {
      throw new PipelineClientError(`Unknown pipeline stage ${JSON.stringify(stage)}.`, { code: "invalid-event" });
    }
    if (value.status !== "running" && value.status !== "completed") {
      throw new PipelineClientError("event.status must be running or completed.", { code: "invalid-event" });
    }
    if (
      value.elapsedMilliseconds !== undefined
      && (typeof value.elapsedMilliseconds !== "number" || !Number.isFinite(value.elapsedMilliseconds))
    ) {
      throw new PipelineClientError("event.elapsedMilliseconds must be finite.", { code: "invalid-event" });
    }
    return {
      type,
      runId,
      sequence,
      timestamp,
      stage: stage as PipelineStage,
      status: value.status,
      ...(value.elapsedMilliseconds === undefined
        ? {}
        : { elapsedMilliseconds: value.elapsedMilliseconds }),
      ...(value.artifact === undefined ? {} : { artifact: value.artifact }),
    };
  }

  if (type === "complete") {
    if (!isRecord(value.result) || !isRecord(value.result.trajectory)) {
      throw new PipelineClientError("Complete event is missing result.trajectory.", { code: "invalid-event" });
    }
    return { type, runId, sequence, timestamp, result: value.result as unknown as PipelineCompleteResult };
  }

  if (type === "error") {
    const stage = requiredString(value.stage, "event.stage");
    if (!STAGE_SET.has(stage)) {
      throw new PipelineClientError(`Unknown pipeline stage ${JSON.stringify(stage)}.`, { code: "invalid-event" });
    }
    const issues = parseIssues(value.issues);
    const details = parseErrorDetails(value.details);
    return {
      type,
      runId,
      sequence,
      timestamp,
      stage: stage as PipelineStage,
      errorId: requiredString(value.errorId, "event.errorId"),
      code: requiredString(value.code, "event.code"),
      message: requiredString(value.message, "event.message"),
      retryable: value.retryable === true,
      ...(issues === undefined ? {} : { issues }),
      ...(details === undefined ? {} : { details }),
    };
  }

  throw new PipelineClientError(`Unknown pipeline event type ${JSON.stringify(type)}.`, { code: "invalid-event" });
}

async function errorFromResponse(response: Response, fallback: string): Promise<PipelineClientError> {
  let message = fallback;
  let code: string | undefined;
  let errorId: string | undefined;
  let issues: PipelineIssue[] | undefined;
  let details: PipelineErrorDetails | undefined;
  try {
    const body: unknown = await response.json();
    if (isRecord(body)) {
      const errorBody = isRecord(body.error) ? body.error : body;
      if (typeof errorBody.message === "string" && errorBody.message.trim()) message = errorBody.message;
      if (typeof errorBody.code === "string" && errorBody.code.trim()) code = errorBody.code;
      if (typeof errorBody.errorId === "string" && errorBody.errorId.trim()) errorId = errorBody.errorId;
      try {
        issues = parseIssues(errorBody.issues);
      } catch {
        // A malformed optional diagnostic must not hide the useful HTTP error.
      }
      try {
        details = parseErrorDetails(errorBody.details);
      } catch {
        // A malformed optional diagnostic must not hide the useful HTTP error.
      }
    }
  } catch {
    // Some server/proxy errors intentionally have no JSON response body.
  }
  return new PipelineClientError(message, {
    status: response.status,
    ...(code === undefined ? {} : { code }),
    ...(errorId === undefined ? {} : { errorId }),
    ...(issues === undefined ? {} : { issues }),
    ...(details === undefined ? {} : { details }),
  });
}

export async function startPipelineRun(
  request: PipelineRunRequest,
  signal?: AbortSignal,
): Promise<PipelineRunAccepted> {
  const response = await fetch(API_ROOT, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(request),
    signal,
  });
  if (!response.ok) {
    throw await errorFromResponse(response, `Could not start the pipeline (HTTP ${response.status}).`);
  }
  const body: unknown = await response.json();
  if (!isRecord(body)) {
    throw new PipelineClientError("Pipeline start response must be a JSON object.", { code: "invalid-response" });
  }
  return { runId: requiredString(body.runId, "response.runId") };
}

export function openPipelineEvents(
  runId: string,
  callbacks: PipelineEventCallbacks,
): PipelineEventStream {
  const source = new EventSource(`${API_ROOT}/${encodeURIComponent(runId)}/events`);
  let closed = false;
  let highestSequence = 0;
  let reconnectTimeout: ReturnType<typeof setTimeout> | undefined;

  const clearReconnectTimeout = (): void => {
    if (reconnectTimeout !== undefined) clearTimeout(reconnectTimeout);
    reconnectTimeout = undefined;
  };

  source.onopen = () => {
    clearReconnectTimeout();
    callbacks.onOpen?.();
  };
  source.onmessage = (message) => {
    if (closed) return;
    try {
      const event = parsePipelineEvent(JSON.parse(message.data) as unknown);
      if (event.sequence <= highestSequence) return;
      highestSequence = event.sequence;
      clearReconnectTimeout();
      callbacks.onEvent(event);
    } catch (error) {
      callbacks.onProtocolError(error instanceof PipelineClientError
        ? error
        : new PipelineClientError(
            error instanceof Error ? error.message : String(error),
            { code: "invalid-event" },
          ));
    }
  };
  source.onerror = () => {
    if (closed) return;
    callbacks.onConnectionError?.();
    if (reconnectTimeout === undefined) {
      reconnectTimeout = setTimeout(() => {
        if (closed || source.readyState === EventSource.OPEN) return;
        callbacks.onProtocolError(new PipelineClientError(
          "The live pipeline connection could not be restored.",
          { code: "event-stream-unavailable" },
        ));
      }, 15_000);
    }
  };

  return {
    close(): void {
      if (closed) return;
      closed = true;
      clearReconnectTimeout();
      source.close();
    },
  };
}

export async function cancelPipelineRun(runId: string): Promise<void> {
  const response = await fetch(`${API_ROOT}/${encodeURIComponent(runId)}`, {
    method: "DELETE",
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw await errorFromResponse(response, `Could not cancel the pipeline (HTTP ${response.status}).`);
  }
}
