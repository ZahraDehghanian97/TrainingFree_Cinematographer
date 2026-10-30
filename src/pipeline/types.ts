import type { CameraDirectionDraft, ResolvedCameraDirectionDSL } from "../types/dsl";
import type { TimelineSolverOutput, FlattenedTimeline } from "../types/solver";
import type { CameraTrajectoryV1 } from "../types/trajectory";
import type { ResolvedSubjectBinding } from "../types/subject-binding";
import type {
  CompiledLossPlan,
  OptimizerDiagnostics,
} from "../optimizer/types";

export const PIPELINE_STAGES = [
  "draft",
  "grounding",
  "timeline",
  "optimization",
] as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[number];
export type PipelineStageStatus = "running" | "completed";

export interface PipelineModelProvenance {
  director: string;
  grounding: string;
  /** Director-stage repair model, when a repair generation was actually used. */
  repair?: string;
  /** Grounding-stage repair model, when a repair generation was actually used. */
  groundingRepair?: string;
}

export interface PipelineStageTimings {
  draft: number;
  grounding: number;
  timeline: number;
  optimization: number;
  total: number;
}

/** Complete, in-memory artifact returned by the interactive prompt pipeline. */
export interface PromptPipelineResult {
  schemaVersion: "1.0";
  kind: "cameraPromptPipelineResult";
  environmentId: string;
  prompt: string;
  models: PipelineModelProvenance;
  draftCsl: CameraDirectionDraft;
  bindings: ResolvedSubjectBinding[];
  resolvedCsl: ResolvedCameraDirectionDSL;
  timeline: TimelineSolverOutput;
  flattenedTimeline: FlattenedTimeline;
  diagnostics: OptimizerDiagnostics;
  compiledPlan: CompiledLossPlan;
  trajectory: CameraTrajectoryV1;
  timings: PipelineStageTimings;
}

export type PipelineStageArtifact =
  | CameraDirectionDraft
  | {
      resolvedCsl: ResolvedCameraDirectionDSL;
      bindings: ResolvedSubjectBinding[];
    }
  | {
      timeline: TimelineSolverOutput;
      flattenedTimeline: FlattenedTimeline;
    }
  | {
      diagnostics: OptimizerDiagnostics;
      compiledPlan: CompiledLossPlan;
    };

export interface PipelineStageEvent {
  type: "stage";
  runId: string;
  sequence: number;
  stage: PipelineStage;
  status: PipelineStageStatus;
  timestamp: string;
  elapsedMilliseconds?: number;
  artifact?: PipelineStageArtifact;
}

export interface PipelineCompleteEvent {
  type: "complete";
  runId: string;
  sequence: number;
  timestamp: string;
  result: PromptPipelineResult;
}

/** Safe, browser-visible diagnostics for a failed pipeline stage. */
export interface PipelineErrorDetails {
  errorType: string;
  statusCode?: number;
  attempts?: number;
  timeoutMs?: number;
  model?: string;
}

export interface PipelineErrorEvent {
  type: "error";
  runId: string;
  sequence: number;
  timestamp: string;
  /** Correlates the public event with the redacted server-side diagnostic. */
  errorId: string;
  stage: PipelineStage;
  code: string;
  message: string;
  retryable: boolean;
  issues?: Array<{ path?: string; message: string }>;
  details?: PipelineErrorDetails;
}

export type PipelineRunEvent =
  | PipelineStageEvent
  | PipelineCompleteEvent
  | PipelineErrorEvent;

export interface CreatePipelineRunRequest {
  environmentId: string;
  prompt: string;
}

export type PipelineRunStatus =
  | "queued"
  | "running"
  | "complete"
  | "error"
  | "cancelled";

export interface PipelineRunSnapshot {
  runId: string;
  status: PipelineRunStatus;
  environmentId: string;
  prompt: string;
  createdAt: string;
  updatedAt: string;
  activeStage?: PipelineStage;
  result?: PromptPipelineResult;
  error?: PipelineErrorEvent;
}
