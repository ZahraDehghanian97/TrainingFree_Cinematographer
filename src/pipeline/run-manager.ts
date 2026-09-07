import { randomUUID } from "node:crypto";
import { EnvironmentRepository } from "./environment-repository";
import {
  classifyPipelineError,
  createPipelineFailureLog,
  type PipelineRunLogger,
} from "./errors";
import {
  getDirectorModelId,
  getGroundingModelId,
  getPipelineLlmTimeoutMs,
  loadProjectEnvOnce,
} from "./model-provider";
import {
  PipelineAbortError,
  runPromptPipeline,
  type RunPromptPipelineOptions,
} from "./orchestrator";
import type {
  CreatePipelineRunRequest,
  PipelineCompleteEvent,
  PipelineErrorEvent,
  PipelineRunEvent,
  PipelineRunSnapshot,
  PipelineRunStatus,
  PipelineStage,
  PipelineStageEvent,
  PromptPipelineResult,
} from "./types";

type PipelineRunner = typeof runPromptPipeline;
type RunListener = (event: PipelineRunEvent) => void;

interface RunRecord {
  request: CreatePipelineRunRequest;
  status: PipelineRunStatus;
  createdAt: string;
  updatedAt: string;
  activeStage?: PipelineStage;
  result?: PromptPipelineResult;
  error?: PipelineErrorEvent;
  events: PipelineRunEvent[];
  listeners: Set<RunListener>;
  controller: AbortController;
  nextSequence: number;
}

export interface PipelineRunManagerOptions {
  repository: EnvironmentRepository;
  runner?: PipelineRunner;
  /** Receives redacted, structured failures. Defaults to one-line JSON on stderr. */
  logger?: PipelineRunLogger;
  optimizerIterations?: number;
  maxRetainedRuns?: number;
  maxConcurrentRuns?: number;
  pipelineOptions?: Omit<RunPromptPipelineOptions, "abortSignal" | "onProgress" | "optimizer">;
}

const defaultPipelineLogger: PipelineRunLogger = {
  error(entry): void {
    console.error(JSON.stringify(entry));
  },
};

function configuredOptimizerIterations(explicit?: number): number {
  loadProjectEnvOnce();
  if (explicit !== undefined) return Math.max(0, Math.min(10_000, Math.floor(explicit)));
  const fromEnvironment = Number(process.env.PIPELINE_OPTIMIZER_ITERATIONS);
  return Number.isInteger(fromEnvironment) && fromEnvironment >= 0
    ? Math.min(10_000, fromEnvironment)
    : 500;
}

function configuredMaxConcurrentRuns(explicit?: number): number {
  loadProjectEnvOnce();
  if (explicit !== undefined) return Math.max(1, Math.min(8, Math.floor(explicit)));
  const fromEnvironment = Number(process.env.PIPELINE_MAX_CONCURRENT_RUNS);
  return Number.isInteger(fromEnvironment) && fromEnvironment > 0
    ? Math.min(8, fromEnvironment)
    : 2;
}

export class PipelineCapacityError extends Error {
  constructor(readonly capacity: number) {
    super(`The pipeline run queue is full (${capacity} retained runs).`);
    this.name = "PipelineCapacityError";
  }
}

export class PipelineRunManager {
  private readonly runs = new Map<string, RunRecord>();
  private readonly runner: PipelineRunner;
  private readonly optimizerIterations: number;
  private readonly maxRetainedRuns: number;
  private readonly maxConcurrentRuns: number;
  private readonly logger: PipelineRunLogger;
  private activeRuns = 0;

  constructor(private readonly options: PipelineRunManagerOptions) {
    this.runner = options.runner ?? runPromptPipeline;
    this.optimizerIterations = configuredOptimizerIterations(options.optimizerIterations);
    this.maxRetainedRuns = Math.max(1, options.maxRetainedRuns ?? 25);
    this.maxConcurrentRuns = configuredMaxConcurrentRuns(options.maxConcurrentRuns);
    this.logger = options.logger ?? defaultPipelineLogger;
  }

  create(request: CreatePipelineRunRequest): PipelineRunSnapshot {
    this.prune();
    if (this.runs.size >= this.maxRetainedRuns) {
      throw new PipelineCapacityError(this.maxRetainedRuns);
    }
    const runId = randomUUID();
    const now = new Date().toISOString();
    this.runs.set(runId, {
      request,
      status: "queued",
      createdAt: now,
      updatedAt: now,
      events: [],
      listeners: new Set(),
      controller: new AbortController(),
      nextSequence: 1,
    });
    setImmediate(() => this.drain());
    return this.snapshot(runId)!;
  }

  snapshot(runId: string): PipelineRunSnapshot | undefined {
    const record = this.runs.get(runId);
    if (!record) return undefined;
    return {
      runId,
      status: record.status,
      environmentId: record.request.environmentId,
      prompt: record.request.prompt,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      ...(record.activeStage === undefined ? {} : { activeStage: record.activeStage }),
      ...(record.result === undefined ? {} : { result: record.result }),
      ...(record.error === undefined ? {} : { error: record.error }),
    };
  }

  events(runId: string): PipelineRunEvent[] | undefined {
    const record = this.runs.get(runId);
    return record ? [...record.events] : undefined;
  }

  subscribe(runId: string, listener: RunListener): (() => void) | undefined {
    const record = this.runs.get(runId);
    if (!record) return undefined;
    record.listeners.add(listener);
    return () => record.listeners.delete(listener);
  }

  cancel(runId: string): PipelineRunSnapshot | undefined {
    const record = this.runs.get(runId);
    if (!record) return undefined;
    if (record.status === "queued") {
      record.controller.abort();
      record.status = "cancelled";
      const event = this.createErrorEvent(runId, record, "draft", new PipelineAbortError());
      record.error = event;
      this.emit(runId, event);
    } else if (record.status === "running") {
      record.controller.abort();
    }
    return this.snapshot(runId);
  }

  private emit(runId: string, event: PipelineRunEvent): void {
    const record = this.runs.get(runId);
    if (!record) return;
    record.updatedAt = event.timestamp;
    record.events.push(event);
    for (const listener of [...record.listeners]) {
      try {
        listener(event);
      } catch {
        // A disconnected SSE response or observer must never change the run's
        // computational outcome. Drop only the faulty listener.
        record.listeners.delete(listener);
      }
    }
    if (event.type === "complete" || event.type === "error") record.listeners.clear();
  }

  private nextEventBase(runId: string): {
    runId: string;
    sequence: number;
    timestamp: string;
  } {
    const record = this.runs.get(runId);
    if (!record) throw new Error(`Unknown pipeline run ${runId}`);
    return {
      runId,
      sequence: record.nextSequence++,
      timestamp: new Date().toISOString(),
    };
  }

  private modelErrorContext(stage: PipelineStage): {
    model?: string;
    timeoutMs?: number;
  } {
    if (stage === "draft") {
      return {
        model: this.options.pipelineOptions?.director?.model?.trim() || getDirectorModelId(),
        timeoutMs: this.options.pipelineOptions?.director?.timeoutMs ?? getPipelineLlmTimeoutMs(),
      };
    }
    if (stage === "grounding") {
      return {
        model: this.options.pipelineOptions?.grounding?.model?.trim() || getGroundingModelId(),
        timeoutMs: this.options.pipelineOptions?.grounding?.timeoutMs ?? getPipelineLlmTimeoutMs(),
      };
    }
    return {};
  }

  private createErrorEvent(
    runId: string,
    record: RunRecord,
    stage: PipelineStage,
    error: unknown,
  ): PipelineErrorEvent {
    const classification = classifyPipelineError(error, {
      stage,
      externalSignalAborted: record.controller.signal.aborted,
      ...this.modelErrorContext(stage),
    });
    const base = this.nextEventBase(runId);
    const errorId = randomUUID();
    const event: PipelineErrorEvent = {
      ...base,
      type: "error",
      errorId,
      stage,
      code: classification.code,
      message: classification.message,
      retryable: classification.retryable,
      ...(classification.issues === undefined ? {} : { issues: classification.issues }),
      details: classification.details,
    };

    if (classification.code !== "run_cancelled") {
      try {
        this.logger.error(createPipelineFailureLog(error, {
          errorId,
          runId,
          environmentId: record.request.environmentId,
          stage,
          timestamp: base.timestamp,
          classification,
          redact: [record.request.prompt],
        }));
      } catch {
        // Observability must never replace the pipeline's original outcome.
      }
    }
    return event;
  }

  private async execute(runId: string): Promise<void> {
    const record = this.runs.get(runId);
    if (!record) return;
    record.status = "running";
    record.activeStage = "draft";
    record.updatedAt = new Date().toISOString();

    try {
      if (record.controller.signal.aborted) throw new PipelineAbortError();
      const environment = await this.options.repository.load(record.request.environmentId);
      const result = await this.runner(environment, record.request.prompt, {
        ...this.options.pipelineOptions,
        abortSignal: record.controller.signal,
        optimizer: { iterations: this.optimizerIterations },
        onProgress: (update) => {
          if (record.controller.signal.aborted) throw new PipelineAbortError();
          record.activeStage = update.stage;
          const event: PipelineStageEvent = {
            ...this.nextEventBase(runId),
            type: "stage",
            stage: update.stage,
            status: update.status,
            ...(update.elapsedMilliseconds === undefined
              ? {}
              : { elapsedMilliseconds: update.elapsedMilliseconds }),
            ...(update.artifact === undefined ? {} : { artifact: update.artifact }),
          };
          this.emit(runId, event);
        },
      });
      record.status = "complete";
      record.result = result;
      record.activeStage = undefined;
      const event: PipelineCompleteEvent = {
        ...this.nextEventBase(runId),
        type: "complete",
        result,
      };
      this.emit(runId, event);
    } catch (error) {
      const cancelled = record.controller.signal.aborted || error instanceof PipelineAbortError;
      record.status = cancelled ? "cancelled" : "error";
      const stage = record.activeStage ?? "draft";
      const event = this.createErrorEvent(runId, record, stage, error);
      record.error = event;
      this.emit(runId, event);
    }
  }

  private drain(): void {
    while (this.activeRuns < this.maxConcurrentRuns) {
      const next = [...this.runs.entries()].find(([, record]) =>
        record.status === "queued",
      );
      if (!next) return;
      const [runId] = next;
      this.activeRuns += 1;
      void this.execute(runId).finally(() => {
        this.activeRuns -= 1;
        setImmediate(() => this.drain());
      });
    }
  }

  private prune(): void {
    if (this.runs.size < this.maxRetainedRuns) return;
    for (const [runId, record] of this.runs) {
      if (record.status === "complete" || record.status === "error" || record.status === "cancelled") {
        this.runs.delete(runId);
        if (this.runs.size < this.maxRetainedRuns) return;
      }
    }
  }
}
