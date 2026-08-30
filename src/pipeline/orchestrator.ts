import type { EnvironmentV1 } from "../types/environment";
import type { CameraDirectionDraft } from "../types/dsl";
import type { SubjectResolver } from "../types/subject-binding";
import { bindCameraDirectionDraft } from "../grounding";
import { solveTimeline } from "../timeline/solver";
import { flattenTimeline } from "../timeline/flattener";
import {
  optimizeCameraTrajectory,
  type CameraOptimizerInput,
  type CameraOptimizerResult,
  type OptimizerOptions,
} from "../optimizer";
import {
  generateCameraDirectionDraft,
  type DirectorGenerationOptions,
  type DirectorGenerationResult,
} from "./director";
import {
  createPipelineGroundingResolver,
  type PipelineGroundingOptions,
  type PipelineGroundingResolver,
} from "./grounding-resolver";
import type {
  PipelineStage,
  PipelineStageArtifact,
  PipelineStageStatus,
  PipelineStageTimings,
  PromptPipelineResult,
} from "./types";

export class PipelineAbortError extends Error {
  constructor() {
    super("The pipeline run was cancelled.");
    this.name = "PipelineAbortError";
  }
}

export interface PipelineProgressUpdate {
  stage: PipelineStage;
  status: PipelineStageStatus;
  elapsedMilliseconds?: number;
  artifact?: PipelineStageArtifact;
}

export type PipelineProgressHandler = (
  update: PipelineProgressUpdate,
) => void | Promise<void>;

export type DraftGenerator = (
  prompt: string,
  durationSeconds: number,
  options: DirectorGenerationOptions,
) => Promise<DirectorGenerationResult>;

export type GroundingResolverFactory = (
  environment: EnvironmentV1,
  options: PipelineGroundingOptions,
) => PipelineGroundingResolver;

export interface TrajectoryOptimizerContext {
  abortSignal?: AbortSignal;
}

/**
 * Injectable optimization boundary. The library default remains the synchronous
 * TypeScript optimizer; interactive servers can provide a worker-backed runner.
 */
export type TrajectoryOptimizer = (
  input: CameraOptimizerInput,
  context: TrajectoryOptimizerContext,
) => CameraOptimizerResult | Promise<CameraOptimizerResult>;

export interface RunPromptPipelineOptions {
  director?: DirectorGenerationOptions;
  grounding?: PipelineGroundingOptions;
  optimizer?: OptimizerOptions;
  abortSignal?: AbortSignal;
  onProgress?: PipelineProgressHandler;
  /** Test/custom-provider injection. Production uses the AI SDK implementation. */
  draftGenerator?: DraftGenerator;
  /** Test/production-4D-module injection. Skips the built-in grounding LLM. */
  subjectResolver?: SubjectResolver;
  groundingResolverFactory?: GroundingResolverFactory;
  injectedGroundingModelId?: string;
  trajectoryOptimizer?: TrajectoryOptimizer;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new PipelineAbortError();
}

async function report(
  handler: PipelineProgressHandler | undefined,
  update: PipelineProgressUpdate,
): Promise<void> {
  await handler?.(update);
}

/** Pure in-memory composition of both LLM stages, timeline solving, and optimization. */
export async function runPromptPipeline(
  environment: EnvironmentV1,
  directorPrompt: string,
  options: RunPromptPipelineOptions = {},
): Promise<PromptPipelineResult> {
  const totalStartedAt = Date.now();
  const timings: PipelineStageTimings = {
    draft: 0,
    grounding: 0,
    timeline: 0,
    optimization: 0,
    total: 0,
  };
  const abortSignal = options.abortSignal;
  const directorOptions: DirectorGenerationOptions = {
    ...options.director,
    abortSignal,
  };
  const groundingOptions: PipelineGroundingOptions = {
    ...options.grounding,
    abortSignal,
  };

  throwIfAborted(abortSignal);
  await report(options.onProgress, { stage: "draft", status: "running" });
  const draftStartedAt = Date.now();
  const directorResult = await (options.draftGenerator ?? generateCameraDirectionDraft)(
    directorPrompt,
    environment.clock.durationSeconds,
    directorOptions,
  );
  timings.draft = Date.now() - draftStartedAt;
  throwIfAborted(abortSignal);
  await report(options.onProgress, {
    stage: "draft",
    status: "completed",
    elapsedMilliseconds: timings.draft,
    artifact: directorResult.draft,
  });

  await report(options.onProgress, { stage: "grounding", status: "running" });
  const groundingStartedAt = Date.now();
  const groundingResolver = options.subjectResolver
    ?? (options.groundingResolverFactory ?? createPipelineGroundingResolver)(
      environment,
      groundingOptions,
    );
  const grounded = await bindCameraDirectionDraft(
    directorResult.draft,
    {
      directorPrompt,
      scene: { id: environment.id },
    },
    groundingResolver,
  );
  timings.grounding = Date.now() - groundingStartedAt;
  throwIfAborted(abortSignal);
  await report(options.onProgress, {
    stage: "grounding",
    status: "completed",
    elapsedMilliseconds: timings.grounding,
    artifact: {
      resolvedCsl: grounded.csl,
      bindings: grounded.bindings,
    },
  });

  await report(options.onProgress, { stage: "timeline", status: "running" });
  const timelineStartedAt = Date.now();
  // EnvironmentV1 is intentionally always passed: event triggers are resolved
  // against tracked 4D motion rather than placeholder offsets.
  const timeline = solveTimeline(grounded.csl, environment);
  const flattenedTimeline = flattenTimeline(timeline);
  timings.timeline = Date.now() - timelineStartedAt;
  throwIfAborted(abortSignal);
  await report(options.onProgress, {
    stage: "timeline",
    status: "completed",
    elapsedMilliseconds: timings.timeline,
    artifact: { timeline, flattenedTimeline },
  });

  await report(options.onProgress, { stage: "optimization", status: "running" });
  const optimizationStartedAt = Date.now();
  const optimized = await (options.trajectoryOptimizer ?? optimizeCameraTrajectory)(
    {
      environment,
      timeline: flattenedTimeline,
      ...(options.optimizer === undefined ? {} : { options: options.optimizer }),
    },
    { abortSignal },
  );
  timings.optimization = Date.now() - optimizationStartedAt;
  throwIfAborted(abortSignal);
  await report(options.onProgress, {
    stage: "optimization",
    status: "completed",
    elapsedMilliseconds: timings.optimization,
    artifact: {
      diagnostics: optimized.diagnostics,
      compiledPlan: optimized.compiledPlan,
    },
  });

  timings.total = Date.now() - totalStartedAt;
  const groundingModelId = "modelId" in groundingResolver
    && typeof groundingResolver.modelId === "string"
    ? groundingResolver.modelId
    : options.injectedGroundingModelId ?? "injected-subject-resolver";
  const groundingRepairModelId = "repairModelId" in groundingResolver
    && typeof groundingResolver.repairModelId === "string"
    ? groundingResolver.repairModelId
    : undefined;

  return {
    schemaVersion: "1.0",
    kind: "cameraPromptPipelineResult",
    environmentId: environment.id,
    prompt: directorPrompt,
    models: {
      director: directorResult.modelId,
      grounding: groundingModelId,
      ...(directorResult.repairModelId === undefined
        ? {}
        : { repair: directorResult.repairModelId }),
      ...(groundingRepairModelId === undefined
        ? {}
        : { groundingRepair: groundingRepairModelId }),
    },
    draftCsl: directorResult.draft,
    bindings: grounded.bindings,
    resolvedCsl: grounded.csl,
    timeline,
    flattenedTimeline,
    diagnostics: optimized.diagnostics,
    compiledPlan: optimized.compiledPlan,
    trajectory: optimized.trajectory,
    timings,
  };
}

/** Convenience helper for tests and integrations that already own draft creation. */
export function fixedDraftGenerator(
  draft: CameraDirectionDraft,
  modelId = "injected-draft-generator",
): DraftGenerator {
  return async () => ({
    draft,
    modelId,
    repairAttempts: 0,
    finishReason: "stop",
  });
}
