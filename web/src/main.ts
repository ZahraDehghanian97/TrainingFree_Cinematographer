import "../styles.css";

import type { EnvironmentV1 } from "../../src/types/environment";
import type { CameraPath4dV1, CameraTrajectoryV1 } from "../../src/types/trajectory";
import { fetchEnvironment } from "./environment-loader";
import { SceneRenderer, type ViewMode } from "./scene-renderer";
import {
  environmentTimeAtPlayback,
  parseCameraTrajectory,
  playbackRateAt,
  sampleCameraTrajectory,
} from "./trajectory-loader";
import {
  automaticTrajectorySources,
  isAbsoluteTrajectoryUrl,
  type AutomaticTrajectorySource,
} from "./trajectory-source";
import {
  PIPELINE_STAGES,
  PipelineClientError,
  cancelPipelineRun,
  openPipelineEvents,
  startPipelineRun,
  type GroundingArtifact,
  type OptimizationArtifact,
  type PipelineArtifacts,
  type PipelineCompleteResult,
  type PipelineErrorDetails,
  type PipelineErrorEvent,
  type PipelineEvent,
  type PipelineEventStream,
  type PipelineIssue,
  type PipelineRunRequest,
  type PipelineStage,
  type PipelineStageEvent,
  type TimelineArtifact,
} from "./pipeline-client";

interface EnvironmentManifestEntry {
  id: string;
  promptExampleId: string;
  title?: string;
  prompt: string;
  durationSeconds: number;
  url: string;
  optimizedTrajectoryUrl?: string;
  sampleTrajectoryUrl?: string;
}

interface EnvironmentManifest {
  schemaVersion: "1.0";
  kind: "environmentManifest";
  environments: EnvironmentManifestEntry[];
}

const byId = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing UI element #${id}`);
  return element as T;
};

const canvas = byId<HTMLCanvasElement>("scene");
const environmentSelect = byId<HTMLSelectElement>("environmentSelect");
const sceneStatus = byId<HTMLSpanElement>("sceneStatus");
const sceneTitle = byId<HTMLHeadingElement>("sceneTitle");
const promptText = byId<HTMLParagraphElement>("promptText");
const durationValue = byId<HTMLElement>("durationValue");
const entityValue = byId<HTMLElement>("entityValue");
const sampleValue = byId<HTMLElement>("sampleValue");
const orientationValue = byId<HTMLElement>("orientationValue");
const actionValue = byId<HTMLElement>("actionValue");
const sceneRateValue = byId<HTMLElement>("sceneRateValue");
const sceneTimeValue = byId<HTMLElement>("sceneTimeValue");
const coordinateValue = byId<HTMLOutputElement>("coordinateValue");
const uploadStatus = byId<HTMLDivElement>("uploadStatus");
const trajectoryInput = byId<HTMLInputElement>("trajectoryInput");
const dropzone = byId<HTMLLabelElement>("dropzone");
const playButton = byId<HTMLButtonElement>("playButton");
const timeline = byId<HTMLInputElement>("timeline");
const rateBand = byId<HTMLDivElement>("rateBand");
const endTime = byId<HTMLElement>("endTime");
const clockValue = byId<HTMLOutputElement>("clockValue");
const speedButton = byId<HTMLButtonElement>("speedButton");
const viewMode = byId<HTMLDivElement>("viewMode");
const pathToggle = byId<HTMLInputElement>("pathToggle");
const boundsToggle = byId<HTMLInputElement>("boundsToggle");
const labelsToggle = byId<HTMLInputElement>("labelsToggle");
const dataDrawer = byId<HTMLElement>("dataDrawer");
const scrim = byId<HTMLElement>("scrim");
const drawerTabs = byId<HTMLDivElement>("drawerTabs");
const drawerNote = byId<HTMLParagraphElement>("drawerNote");
const jsonPreview = byId<HTMLElement>("jsonPreview");
const pasteDialog = byId<HTMLDialogElement>("pasteDialog");
const pasteValue = byId<HTMLTextAreaElement>("pasteValue");
const toast = byId<HTMLDivElement>("toast");
const fatalError = byId<HTMLDivElement>("fatalError");
const composerTabs = byId<HTMLDivElement>("composerTabs");
const exampleComposer = byId<HTMLElement>("exampleComposer");
const customComposer = byId<HTMLElement>("customComposer");
const examplePrompt = byId<HTMLParagraphElement>("examplePrompt");
const customPrompt = byId<HTMLTextAreaElement>("customPrompt");
const promptCount = byId<HTMLOutputElement>("promptCount");
const replayExampleButton = byId<HTMLButtonElement>("replayExampleButton");
const runExampleButton = byId<HTMLButtonElement>("runExampleButton");
const runCustomButton = byId<HTMLButtonElement>("runCustomButton");
const pipelineRunBadge = byId<HTMLElement>("pipelineRunBadge");
const pipelineProgressTitle = byId<HTMLElement>("pipelineProgressTitle");
const pipelineConnection = byId<HTMLElement>("pipelineConnection");
const stageList = byId<HTMLOListElement>("stageList");
const pipelineError = byId<HTMLDivElement>("pipelineError");
const pipelineErrorTitle = byId<HTMLElement>("pipelineErrorTitle");
const pipelineErrorMessage = byId<HTMLParagraphElement>("pipelineErrorMessage");
const pipelineErrorCode = byId<HTMLElement>("pipelineErrorCode");
const pipelineErrorDetailsButton = byId<HTMLButtonElement>("pipelineErrorDetailsButton");
const cancelRunButton = byId<HTMLButtonElement>("cancelRunButton");
const retryRunButton = byId<HTMLButtonElement>("retryRunButton");
const inspectRunButton = byId<HTMLButtonElement>("inspectRunButton");
const pasteButton = byId<HTMLButtonElement>("pasteButton");
const templateButton = byId<HTMLButtonElement>("templateButton");
const loadPastedButton = byId<HTMLButtonElement>("loadPastedButton");

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const SPEEDS = [0.1, 0.25, 0.5, 1, 2, 4];

type ComposerMode = "example" | "custom";
type DrawerTab = "environment" | "run" | "draft" | "grounding" | "timeline" | "diagnostics" | "trajectory";
type PipelineUiStatus = "idle" | "starting" | "running" | "completed" | "failed" | "cancelled";
type StageUiStatus = "idle" | "running" | "completed" | "failed";

interface StageUiState {
  status: StageUiStatus;
  elapsedMilliseconds?: number;
}

interface PipelineUiError {
  stage?: PipelineStage;
  runId?: string;
  sequence?: number;
  timestamp?: string;
  errorId?: string;
  code: string;
  message: string;
  retryable: boolean;
  httpStatus?: number;
  issues?: PipelineIssue[];
  details?: PipelineErrorDetails;
}

function emptyStageState(): Record<PipelineStage, StageUiState> {
  return Object.fromEntries(
    PIPELINE_STAGES.map((stage) => [stage, { status: "idle" as const }]),
  ) as Record<PipelineStage, StageUiState>;
}

let renderer: SceneRenderer;
let manifest: EnvironmentManifest;
let environment: EnvironmentV1 | null = null;
let trajectory: CameraTrajectoryV1 | null = null;
let currentTime = 0;
let playbackSpeed = 1;
let playing = false;
let activeView: ViewMode = "god";
let activeDrawerTab: DrawerTab = "environment";
let lastFrameAt = performance.now();
let environmentRequest = 0;
let environmentLoading = false;
let toastTimer: number | undefined;
let composerMode: ComposerMode = "example";
let pipelineStatus: PipelineUiStatus = "idle";
let pipelineStages = emptyStageState();
let pipelineArtifacts: PipelineArtifacts = {};
let pipelineUiError: PipelineUiError | null = null;
let activePipelineRunId: string | null = null;
let pipelineRunId: string | null = null;
let pipelineEvents: PipelineEvent[] = [];
let activePipelineStream: PipelineEventStream | null = null;
let pipelineStartController: AbortController | null = null;
let pipelineGeneration = 0;
let lastPipelineRequest: PipelineRunRequest | null = null;
let drawerReturnFocus: HTMLElement | null = null;

function publicUrl(path: string): string {
  const cleanPath = path.replace(/^\/+/, "");
  const base = import.meta.env.BASE_URL.endsWith("/") ? import.meta.env.BASE_URL : `${import.meta.env.BASE_URL}/`;
  return `${base}${cleanPath}`;
}

function trajectoryUrl(path: string): string {
  return isAbsoluteTrajectoryUrl(path) ? path : publicUrl(path);
}

function isManifest(value: unknown): value is EnvironmentManifest {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<EnvironmentManifest>;
  return candidate.schemaVersion === "1.0"
    && candidate.kind === "environmentManifest"
    && Array.isArray(candidate.environments)
    && candidate.environments.length > 0;
}

async function fetchManifest(): Promise<EnvironmentManifest> {
  const response = await fetch(publicUrl("environments/manifest.json"));
  if (!response.ok) throw new Error(`Could not load the environment manifest (${response.status}).`);
  const value: unknown = await response.json();
  if (!isManifest(value)) throw new Error("The environment manifest has an unsupported shape.");
  return value;
}

function labelFor(entry: EnvironmentManifestEntry): string {
  const number = entry.promptExampleId.replace("example-", "");
  return `Example ${number} · ${entry.title ?? entry.prompt}`;
}

function shortEnvironmentName(env: EnvironmentV1): string {
  const number = env.promptExampleId.replace("example-", "");
  const words = env.id.split("-").slice(2).join(" ");
  return `Example ${number} · ${words || "scene"}`;
}

function populateEnvironmentPicker(): void {
  environmentSelect.replaceChildren();
  for (const entry of manifest.environments) {
    const option = document.createElement("option");
    option.value = entry.id;
    option.textContent = labelFor(entry);
    environmentSelect.append(option);
  }
}

function setPlaying(value: boolean): void {
  playing = value;
  playButton.classList.toggle("is-playing", value);
  playButton.setAttribute("aria-label", value ? "Pause" : "Play");
}

function setView(next: ViewMode): void {
  if (next === "director" && !trajectory) {
    showToast("Load a camera trajectory before opening Director POV.", "warning");
    return;
  }
  activeView = next;
  renderer.setViewMode(next);
  for (const button of viewMode.querySelectorAll<HTMLButtonElement>("button[data-view]")) {
    button.classList.toggle("is-active", button.dataset.view === next);
  }
}

function setUploadMessage(message: string, state: "info" | "success" | "warning" | "error" = "info"): void {
  uploadStatus.className = `upload-status${state === "info" ? "" : ` is-${state}`}`;
  uploadStatus.querySelector("p")!.textContent = message;
  uploadStatus.querySelector(".status-icon")!.textContent = state === "success" ? "✓" : state === "error" ? "!" : state === "warning" ? "△" : "i";
}

function showToast(message: string, state: "info" | "warning" | "error" = "info"): void {
  if (toastTimer !== undefined) window.clearTimeout(toastTimer);
  toast.textContent = message;
  toast.className = `toast${state === "info" ? "" : ` is-${state}`}`;
  toast.hidden = false;
  toastTimer = window.setTimeout(() => { toast.hidden = true; }, 5200);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function formatElapsed(milliseconds: number | undefined): string {
  if (milliseconds === undefined) return "View result";
  if (milliseconds < 1000) return `View · ${Math.round(milliseconds)} ms`;
  return `View · ${(milliseconds / 1000).toFixed(milliseconds < 10_000 ? 1 : 0)} s`;
}

function hasRunLogData(): boolean {
  return pipelineRunId !== null
    || lastPipelineRequest !== null
    || pipelineEvents.length > 0
    || pipelineUiError !== null;
}

function hasArtifactForTab(tab: DrawerTab): boolean {
  switch (tab) {
    case "environment": return environment !== null;
    case "run": return hasRunLogData();
    case "draft": return pipelineArtifacts.draft !== undefined;
    case "grounding": return pipelineArtifacts.resolvedCsl !== undefined || pipelineArtifacts.bindings !== undefined;
    case "timeline": return pipelineArtifacts.timeline !== undefined || pipelineArtifacts.flattenedTimeline !== undefined;
    case "diagnostics": return pipelineArtifacts.diagnostics !== undefined
      || pipelineArtifacts.compiledPlan !== undefined
      || pipelineArtifacts.models !== undefined
      || pipelineArtifacts.timings !== undefined;
    case "trajectory": return trajectory !== null;
  }
}

function setComposerMode(mode: ComposerMode, focusTab = false): void {
  composerMode = mode;
  exampleComposer.hidden = mode !== "example";
  customComposer.hidden = mode !== "custom";
  for (const button of composerTabs.querySelectorAll<HTMLButtonElement>("button[data-mode]")) {
    const active = button.dataset.mode === mode;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
    if (active && focusTab) button.focus();
  }
}

function renderPipelineUi(): void {
  const active = pipelineStatus === "starting" || pipelineStatus === "running";
  const title: Record<PipelineUiStatus, string> = {
    idle: "Ready to run",
    starting: "Starting pipeline",
    running: "Pipeline running",
    completed: "Trajectory ready",
    failed: "Pipeline stopped",
    cancelled: "Run cancelled",
  };
  const badge: Record<PipelineUiStatus, string> = {
    idle: "Ready",
    starting: "Starting",
    running: "Live",
    completed: "Done",
    failed: "Failed",
    cancelled: "Cancelled",
  };
  pipelineProgressTitle.textContent = title[pipelineStatus];
  pipelineRunBadge.textContent = badge[pipelineStatus];
  pipelineRunBadge.className = `format-pill run-badge is-${pipelineStatus}`;
  stageList.setAttribute("aria-busy", String(active));

  for (const stage of PIPELINE_STAGES) {
    const item = stageList.querySelector<HTMLLIElement>(`li[data-stage="${stage}"]`);
    if (!item) continue;
    const state = pipelineStages[stage];
    item.dataset.status = state.status;
    if (state.status === "running") item.setAttribute("aria-current", "step");
    else item.removeAttribute("aria-current");
    const stateLabel = item.querySelector<HTMLElement>(".stage-state");
    if (stateLabel) {
      stateLabel.textContent = state.status === "running"
        ? "Running"
        : state.status === "completed"
          ? formatElapsed(state.elapsedMilliseconds)
          : state.status === "failed"
            ? "Failed"
            : "Waiting";
    }
    const button = item.querySelector<HTMLButtonElement>("button[data-open-tab]");
    if (button) {
      const canInspectFailure = state.status === "failed" && hasRunLogData();
      button.disabled = !canInspectFailure && !hasArtifactForTab(button.dataset.openTab as DrawerTab);
    }
  }

  pipelineError.hidden = pipelineUiError === null;
  if (pipelineUiError) {
    pipelineErrorTitle.textContent = pipelineUiError.stage
      ? `${pipelineUiError.stage[0].toUpperCase()}${pipelineUiError.stage.slice(1)} failed`
      : "Pipeline failed";
    const issueDetails = pipelineUiError.issues?.slice(0, 6).map((issue) =>
      `${issue.path ? `${issue.path}: ` : ""}${issue.message}`,
    ) ?? [];
    pipelineErrorMessage.textContent = [pipelineUiError.message, ...issueDetails].join("\n");
    pipelineErrorCode.textContent = pipelineUiError.code;
  }

  cancelRunButton.hidden = !active;
  retryRunButton.hidden = !(
    pipelineStatus === "failed"
    && pipelineUiError?.retryable
    && lastPipelineRequest?.environmentId === environment?.id
  );
  replayExampleButton.disabled = active || environmentLoading || environment === null;
  runExampleButton.disabled = active || environmentLoading || environment === null;
  runCustomButton.disabled = active || environmentLoading || environment === null || customPrompt.value.trim().length === 0;
  trajectoryInput.disabled = active || environmentLoading;
  pasteButton.disabled = active || environmentLoading;
  templateButton.disabled = active || environmentLoading || environment === null;
  dropzone.classList.toggle("is-disabled", active || environmentLoading);
  inspectRunButton.disabled = !Object.values(pipelineArtifacts).some((value) => value !== undefined)
    && trajectory === null
    && !hasRunLogData();

  for (const button of drawerTabs.querySelectorAll<HTMLButtonElement>("button[data-tab]")) {
    button.classList.toggle("has-data", hasArtifactForTab(button.dataset.tab as DrawerTab));
  }
}

function resetPipelineArtifacts(): void {
  pipelineStages = emptyStageState();
  pipelineArtifacts = {};
  pipelineUiError = null;
  pipelineRunId = null;
  pipelineEvents = [];
  refreshDrawer();
  renderPipelineUi();
}

function recordStageArtifact(stage: PipelineStage, artifact: unknown): void {
  if (artifact === undefined) return;
  if (stage === "draft") {
    pipelineArtifacts.draft = artifact as PipelineArtifacts["draft"];
  } else if (stage === "grounding" && isRecord(artifact)) {
    const grounding = artifact as unknown as GroundingArtifact;
    pipelineArtifacts.resolvedCsl = grounding.resolvedCsl;
    pipelineArtifacts.bindings = grounding.bindings;
  } else if (stage === "timeline" && isRecord(artifact)) {
    const solved = artifact as unknown as TimelineArtifact;
    pipelineArtifacts.timeline = solved.timeline;
    pipelineArtifacts.flattenedTimeline = solved.flattenedTimeline;
  } else if (stage === "optimization" && isRecord(artifact)) {
    const optimized = artifact as unknown as OptimizationArtifact;
    pipelineArtifacts.diagnostics = optimized.diagnostics;
    pipelineArtifacts.compiledPlan = optimized.compiledPlan;
  }
  refreshDrawer();
}

function absorbCompleteArtifacts(result: PipelineCompleteResult): void {
  pipelineArtifacts = {
    draft: result.draftCsl,
    resolvedCsl: result.resolvedCsl,
    bindings: result.bindings,
    timeline: result.timeline,
    flattenedTimeline: result.flattenedTimeline,
    diagnostics: result.diagnostics,
    compiledPlan: result.compiledPlan,
    models: result.models,
    timings: result.timings,
  };
}

function directorButton(): HTMLButtonElement {
  return viewMode.querySelector<HTMLButtonElement>('button[data-view="director"]')!;
}

function resetTrajectory(): void {
  trajectory = null;
  renderer.setTrajectory(null);
  directorButton().disabled = true;
  sampleValue.textContent = "None";
  orientationValue.textContent = "—";
  actionValue.textContent = "—";
  sceneRateValue.textContent = "Normal · 1×";
  sceneTimeValue.textContent = "0.00 s";
  rateBand.replaceChildren();
  coordinateValue.textContent = `x — · y — · z — · t ${currentTime.toFixed(2)}`;
  setUploadMessage("Looking for generated optimizer output. You can also upload or paste a trajectory.");
  if (activeView === "director") setView("god");
  refreshDrawer();
  renderPipelineUi();
}

interface AutomaticTrajectoryFailure {
  source: AutomaticTrajectorySource;
  message: string;
  status?: number;
}

function describeFallback(
  loadedSource: AutomaticTrajectorySource,
  failures: AutomaticTrajectoryFailure[],
): void {
  const reportable = failures.find(({ source, status }) =>
    source.kind === "requested" || status !== 404);
  if (!reportable) return;
  showToast(
    `${reportable.source.label} could not be loaded; using ${loadedSource.label.toLowerCase()}.`,
    "warning",
  );
}

async function loadAutomaticTrajectory(
  entry: EnvironmentManifestEntry,
  requestedTrajectoryUrl: string | null,
  request: number,
): Promise<void> {
  const failures: AutomaticTrajectoryFailure[] = [];

  for (const source of automaticTrajectorySources(entry, requestedTrajectoryUrl)) {
    if (request !== environmentRequest) return;
    try {
      const response = await fetch(trajectoryUrl(source.url));
      if (request !== environmentRequest) return;
      if (!response.ok) {
        failures.push({
          source,
          status: response.status,
          message: `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`,
        });
        continue;
      }

      const value: unknown = await response.json();
      if (request !== environmentRequest) return;
      await applyTrajectory(value, source.label);
      describeFallback(source, failures);
      return;
    } catch (error) {
      if (request !== environmentRequest) return;
      failures.push({
        source,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (request !== environmentRequest) return;
  const reportable = failures.find(({ source, status }) =>
    source.kind === "requested" || status !== 404);
  if (reportable) {
    setUploadMessage(
      `${reportable.source.label} could not be loaded. You can still upload or paste a trajectory.`,
      "warning",
    );
    showToast(`${reportable.source.label}: ${reportable.message}`, "warning");
  } else {
    setUploadMessage("No generated trajectory found. Upload or paste camera movement to preview it.");
  }
}

function selectedManifestEntry(): EnvironmentManifestEntry | undefined {
  return manifest?.environments.find((candidate) => candidate.id === environmentSelect.value);
}

function closePipelineEventStream(options: { abortStart?: boolean } = {}): void {
  activePipelineStream?.close();
  activePipelineStream = null;
  if (options.abortStart !== false) pipelineStartController?.abort();
  pipelineStartController = null;
}

function pipelineContextIsCurrent(generation: number, environmentId: string): boolean {
  return generation === pipelineGeneration && environment?.id === environmentId;
}

function clearPipelineForEnvironmentChange(): void {
  const runId = activePipelineRunId;
  pipelineGeneration += 1;
  // Let an in-flight POST return its runId; its stale continuation will issue
  // DELETE. Aborting the response here could orphan a run already accepted by
  // the server but whose ID never reached the browser.
  closePipelineEventStream({ abortStart: false });
  activePipelineRunId = null;
  pipelineStatus = "idle";
  pipelineConnection.textContent = "";
  lastPipelineRequest = null;
  resetPipelineArtifacts();
  if (runId) {
    void cancelPipelineRun(runId).catch(() => {
      // The stale run is already detached locally; the server may have completed first.
    });
  }
}

async function cancelActivePipeline(): Promise<void> {
  if (pipelineStatus !== "starting" && pipelineStatus !== "running") return;
  const runId = activePipelineRunId;
  const wasStarting = pipelineStatus === "starting";
  pipelineGeneration += 1;
  closePipelineEventStream({ abortStart: !wasStarting });
  activePipelineRunId = null;
  pipelineStatus = "cancelled";
  pipelineConnection.textContent = "";
  pipelineUiError = null;
  renderPipelineUi();

  if (!runId) return;
  try {
    await cancelPipelineRun(runId);
    showToast("Pipeline run cancelled.");
  } catch (error) {
    showToast(error instanceof Error ? error.message : String(error), "warning");
  }
}

function failPipelineLocally(
  error: PipelineUiError,
  generation: number,
  environmentId: string,
): void {
  if (!pipelineContextIsCurrent(generation, environmentId)) return;
  closePipelineEventStream();
  activePipelineRunId = null;
  pipelineStatus = "failed";
  pipelineUiError = {
    ...(error.runId === undefined && pipelineRunId !== null ? { runId: pipelineRunId } : {}),
    ...(error.timestamp === undefined ? { timestamp: new Date().toISOString() } : {}),
    ...error,
  };
  pipelineConnection.textContent = "";
  if (error.stage) {
    pipelineStages[error.stage] = { ...pipelineStages[error.stage], status: "failed" };
  }
  renderPipelineUi();
  refreshDrawer();
  showToast(error.message, "error");
}

function handleStageEvent(event: PipelineStageEvent): void {
  pipelineStatus = "running";
  pipelineConnection.textContent = "Live";
  pipelineStages[event.stage] = {
    status: event.status,
    ...(event.elapsedMilliseconds === undefined
      ? {}
      : { elapsedMilliseconds: event.elapsedMilliseconds }),
  };
  if (event.status === "completed") recordStageArtifact(event.stage, event.artifact);
  renderPipelineUi();
}

function handlePipelineErrorEvent(event: PipelineErrorEvent): void {
  closePipelineEventStream();
  activePipelineRunId = null;
  pipelineStatus = "failed";
  pipelineStages[event.stage] = { ...pipelineStages[event.stage], status: "failed" };
  pipelineUiError = {
    stage: event.stage,
    runId: event.runId,
    sequence: event.sequence,
    timestamp: event.timestamp,
    errorId: event.errorId,
    code: event.code,
    message: event.message,
    retryable: event.retryable,
    ...(event.issues === undefined ? {} : { issues: event.issues }),
    ...(event.details === undefined ? {} : { details: event.details }),
  };
  pipelineConnection.textContent = "";
  renderPipelineUi();
  refreshDrawer();
  showToast(event.message, "error");
}

async function handlePipelineEvent(
  event: PipelineEvent,
  generation: number,
  environmentId: string,
): Promise<void> {
  if (
    !pipelineContextIsCurrent(generation, environmentId)
    || event.runId !== activePipelineRunId
  ) return;

  pipelineEvents = [...pipelineEvents, event];
  pipelineRunId = event.runId;

  if (event.type === "stage") {
    handleStageEvent(event);
    return;
  }
  if (event.type === "error") {
    handlePipelineErrorEvent(event);
    return;
  }

  // A complete event is terminal; close the stream before validating/rendering.
  closePipelineEventStream();
  activePipelineRunId = null;
  pipelineConnection.textContent = "";
  absorbCompleteArtifacts(event.result);
  for (const stage of PIPELINE_STAGES) {
    const elapsedMilliseconds = pipelineStages[stage].elapsedMilliseconds ?? event.result.timings?.[stage];
    pipelineStages[stage] = {
      status: "completed",
      ...(elapsedMilliseconds === undefined ? {} : { elapsedMilliseconds }),
    };
  }

  try {
    await applyTrajectory(event.result.trajectory, "Generated pipeline");
    if (!pipelineContextIsCurrent(generation, environmentId)) return;
    pipelineStatus = "completed";
    pipelineUiError = null;
    promptText.textContent = lastPipelineRequest?.prompt ?? promptText.textContent;
    renderPipelineUi();
    refreshDrawer();
  } catch (error) {
    failPipelineLocally({
      stage: "optimization",
      code: "invalid-trajectory",
      message: error instanceof Error ? error.message : String(error),
      retryable: false,
    }, generation, environmentId);
  }
}

async function runPipeline(request: PipelineRunRequest): Promise<void> {
  if (!environment || request.environmentId !== environment.id) {
    showToast("Select an environment before running the pipeline.", "warning");
    return;
  }
  const prompt = request.prompt.trim();
  if (!prompt) {
    showToast("Write a camera-direction prompt first.", "warning");
    customPrompt.focus();
    return;
  }

  const normalizedRequest = { environmentId: request.environmentId, prompt };
  const generation = ++pipelineGeneration;
  const environmentId = environment.id;
  closePipelineEventStream();
  activePipelineRunId = null;
  pipelineStatus = "starting";
  pipelineConnection.textContent = "Connecting";
  lastPipelineRequest = normalizedRequest;
  resetPipelineArtifacts();
  setPlaying(false);
  resetTrajectory();
  promptText.textContent = prompt;
  const startController = new AbortController();
  pipelineStartController = startController;
  renderPipelineUi();

  try {
    const { runId } = await startPipelineRun(normalizedRequest, startController.signal);
    if (pipelineStartController === startController) pipelineStartController = null;
    if (!pipelineContextIsCurrent(generation, environmentId)) {
      void cancelPipelineRun(runId).catch(() => undefined);
      return;
    }

    activePipelineRunId = runId;
    pipelineRunId = runId;
    pipelineStatus = "running";
    pipelineConnection.textContent = "Connecting";
    activePipelineStream = openPipelineEvents(runId, {
      onOpen: () => {
        if (!pipelineContextIsCurrent(generation, environmentId) || activePipelineRunId !== runId) return;
        pipelineConnection.textContent = "Live";
        renderPipelineUi();
      },
      onConnectionError: () => {
        if (!pipelineContextIsCurrent(generation, environmentId) || activePipelineRunId !== runId) return;
        pipelineConnection.textContent = "Reconnecting";
        renderPipelineUi();
      },
      onEvent: (event) => { void handlePipelineEvent(event, generation, environmentId); },
      onProtocolError: (error) => {
        const staleRunId = activePipelineRunId;
        failPipelineLocally({
          ...(pipelineRunId === null ? {} : { runId: pipelineRunId }),
          code: error.code ?? "invalid-event",
          message: error.message,
          retryable: true,
          ...(error.status === undefined ? {} : { httpStatus: error.status }),
          ...(error.errorId === undefined ? {} : { errorId: error.errorId }),
          ...(error.issues === undefined ? {} : { issues: error.issues }),
          ...(error.details === undefined ? {} : { details: error.details }),
        }, generation, environmentId);
        if (staleRunId) void cancelPipelineRun(staleRunId).catch(() => undefined);
      },
    });
    renderPipelineUi();
  } catch (error) {
    if (pipelineStartController === startController) pipelineStartController = null;
    if (!pipelineContextIsCurrent(generation, environmentId)) return;
    if (error instanceof DOMException && error.name === "AbortError") return;
    const clientError = error instanceof PipelineClientError ? error : null;
    failPipelineLocally({
      code: clientError?.code
        ?? (isRecord(error) && typeof error.code === "string" ? error.code : "start-failed"),
      message: error instanceof Error ? error.message : String(error),
      retryable: true,
      ...(clientError?.status === undefined ? {} : { httpStatus: clientError.status }),
      ...(clientError?.errorId === undefined ? {} : { errorId: clientError.errorId }),
      ...(clientError?.issues === undefined ? {} : { issues: clientError.issues }),
      ...(clientError?.details === undefined ? {} : { details: clientError.details }),
    }, generation, environmentId);
  }
}

async function replayBundledExample(): Promise<void> {
  const entry = selectedManifestEntry();
  if (!entry || !environment) return;
  const request = environmentRequest;
  pipelineStatus = "idle";
  pipelineConnection.textContent = "";
  lastPipelineRequest = null;
  resetPipelineArtifacts();
  setPlaying(false);
  resetTrajectory();
  promptText.textContent = entry.prompt || environment.prompt;

  if (!entry.sampleTrajectoryUrl) {
    await loadAutomaticTrajectory(entry, null, request);
    return;
  }
  try {
    const response = await fetch(trajectoryUrl(entry.sampleTrajectoryUrl));
    if (request !== environmentRequest) return;
    if (!response.ok) throw new Error(`Could not load bundled example (HTTP ${response.status}).`);
    await applyTrajectory(await response.json() as unknown, "Bundled demo");
  } catch (error) {
    if (request !== environmentRequest) return;
    const message = error instanceof Error ? error.message : String(error);
    setUploadMessage(message, "error");
    showToast(message, "error");
  }
}

async function selectEnvironment(
  entry: EnvironmentManifestEntry,
  requestedTrajectoryUrl: string | null = null,
): Promise<void> {
  clearPipelineForEnvironmentChange();
  const request = ++environmentRequest;
  environmentLoading = true;
  environmentSelect.disabled = true;
  sceneStatus.textContent = "Loading environment";
  setPlaying(false);
  renderPipelineUi();

  try {
    const nextEnvironment = await fetchEnvironment(publicUrl(entry.url));
    if (request !== environmentRequest) return;

    environment = nextEnvironment;
    currentTime = 0;
    timeline.min = "0";
    timeline.max = String(environment.clock.durationSeconds);
    timeline.value = "0";
    timeline.step = "0.001";
    timeline.style.setProperty("--progress", "0%");
    endTime.textContent = formatTime(environment.clock.durationSeconds);
    clockValue.textContent = `0.00 / ${environment.clock.durationSeconds.toFixed(2)}`;

    renderer.setEnvironment(environment);
    resetTrajectory();

    const exampleNumber = environment.promptExampleId.replace("example-", "");
    sceneTitle.textContent = `Example ${exampleNumber} · ${entry.title ?? shortEnvironmentName(environment).split(" · ").slice(1).join(" · ")}`;
    promptText.textContent = environment.prompt;
    examplePrompt.textContent = entry.prompt || environment.prompt;
    durationValue.textContent = `${environment.clock.durationSeconds.toFixed(1)} s`;
    entityValue.textContent = String(environment.entities.length);
    sceneStatus.textContent = "Environment ready";
    document.title = `${shortEnvironmentName(environment)} · Camera Lab`;

    await loadAutomaticTrajectory(entry, requestedTrajectoryUrl, request);
    refreshDrawer();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sceneStatus.textContent = "Environment error";
    if (environment && manifest.environments.some((candidate) => candidate.id === environment?.id)) {
      environmentSelect.value = environment.id;
      const previous = selectedManifestEntry();
      examplePrompt.textContent = previous?.prompt ?? environment.prompt;
    }
    showToast(message, "error");
  } finally {
    if (request === environmentRequest) {
      environmentLoading = false;
      environmentSelect.disabled = false;
    }
    renderPipelineUi();
  }
}

async function applyTrajectory(value: unknown, sourceName: string): Promise<void> {
  if (!environment) throw new Error("Select an environment before loading camera movement.");
  const parsed = parseCameraTrajectory(value, {
    environment,
    environmentIdMismatch: "error",
  });
  renderer.setTrajectory(parsed.trajectory);
  trajectory = parsed.trajectory;
  directorButton().disabled = false;
  currentTime = Math.max(0, Math.min(trajectory.samples[0]?.t ?? 0, environment.clock.durationSeconds));
  renderer.setTime(
    currentTime,
    Math.min(environment.clock.durationSeconds, environmentTimeAtPlayback(trajectory, currentTime)),
  );
  sampleValue.textContent = trajectory.samples.length.toLocaleString();
  orientationValue.textContent = trajectory.orientation.mode;
  renderRateBand(trajectory);
  setUploadMessage(`${sourceName}: ${trajectory.samples.length.toLocaleString()} camera samples loaded.`, parsed.warnings.length ? "warning" : "success");
  if (parsed.warnings.length) showToast(parsed.warnings.join(" "), "warning");
  else showToast(`${sourceName} is ready to preview.`);
  setPlaying(true);
  refreshDrawer();
  renderPipelineUi();
}

function renderRateBand(cameraTrajectory: CameraTrajectoryV1): void {
  rateBand.replaceChildren();
  const duration = cameraTrajectory.clock.durationSeconds;
  for (const segment of cameraTrajectory.playback?.rateSegments ?? []) {
    const marker = document.createElement("span");
    marker.style.left = `${segment.startTime / duration * 100}%`;
    marker.style.width = `${(segment.endTime - segment.startTime) / duration * 100}%`;
    marker.className = segment.rate === 0
      ? "is-frozen"
      : segment.rate < 1
        ? "is-slow"
        : segment.rate > 1
          ? "is-fast"
          : "";
    marker.title = `${formatRateLabel(segment.label ?? "custom")} · ${segment.rate}×`;
    rateBand.append(marker);
  }
}

async function loadFile(file: File): Promise<void> {
  if (file.size > MAX_UPLOAD_BYTES) throw new Error("Trajectory files must be 20 MB or smaller.");
  let value: unknown;
  try {
    value = JSON.parse(await file.text()) as unknown;
  } catch {
    throw new Error(`${file.name} is not valid JSON.`);
  }
  await applyTrajectory(value, file.name);
  pipelineStatus = "idle";
  pipelineConnection.textContent = "";
  lastPipelineRequest = null;
  resetPipelineArtifacts();
}

function formatTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60).toString().padStart(2, "0");
  return `${minutes}:${remainder}`;
}

function formatRateLabel(label: string): string {
  return label
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (character) => character.toUpperCase());
}

function updateTimeUi(environmentTime: number): void {
  if (!environment) return;
  const duration = environment.clock.durationSeconds;
  timeline.value = String(currentTime);
  timeline.style.setProperty("--progress", `${duration > 0 ? currentTime / duration * 100 : 0}%`);
  clockValue.textContent = `${currentTime.toFixed(2)} / ${duration.toFixed(2)}`;

  if (trajectory) {
    const sample = sampleCameraTrajectory(trajectory, currentTime);
    const rateState = playbackRateAt(trajectory, currentTime);
    const [x, y, z] = sample.position;
    coordinateValue.textContent = `x ${x.toFixed(2)} · y ${y.toFixed(2)} · z ${z.toFixed(2)} · t ${currentTime.toFixed(2)}`;
    actionValue.textContent = sample.actionId ?? "—";
    sceneRateValue.textContent = `${formatRateLabel(rateState.label)} · ${rateState.rate.toFixed(rateState.rate % 1 === 0 ? 0 : 2)}×`;
  } else {
    coordinateValue.textContent = `x — · y — · z — · t ${currentTime.toFixed(2)}`;
    actionValue.textContent = "—";
    sceneRateValue.textContent = "Normal · 1×";
  }
  sceneTimeValue.textContent = `${environmentTime.toFixed(2)} s`;
}

function animationFrame(now: number): void {
  const delta = Math.min((now - lastFrameAt) / 1000, 0.1);
  lastFrameAt = now;
  if (playing && environment) {
    currentTime += delta * playbackSpeed;
    if (currentTime > environment.clock.durationSeconds) currentTime = 0;
  }
  if (environment) {
    const environmentTime = Math.min(
      environment.clock.durationSeconds,
      trajectory ? environmentTimeAtPlayback(trajectory, currentTime) : currentTime,
    );
    renderer.setTime(currentTime, environmentTime);
    renderer.render();
    updateTimeUi(environmentTime);
  }
  requestAnimationFrame(animationFrame);
}

function trajectoryPreview(): unknown {
  if (!trajectory || trajectory.samples.length <= 40) return trajectory;
  return {
    ...trajectory,
    samples: [
      ...trajectory.samples.slice(0, 20),
      { note: `… ${trajectory.samples.length - 25} samples omitted from this preview …` },
      ...trajectory.samples.slice(-5),
    ],
  };
}

function summarizePipelineEvent(event: PipelineEvent): unknown {
  if (event.type === "error") return event;
  if (event.type === "stage") {
    const { artifact, ...summary } = event;
    if (artifact === undefined) return summary;
    return {
      ...summary,
      artifact: {
        available: true,
        drawerTab: event.stage === "optimization" ? "diagnostics" : event.stage,
      },
    };
  }

  return {
    type: event.type,
    runId: event.runId,
    sequence: event.sequence,
    timestamp: event.timestamp,
    result: {
      schemaVersion: event.result.schemaVersion,
      kind: event.result.kind,
      environmentId: event.result.environmentId,
      models: event.result.models,
      timings: event.result.timings,
      artifactsAvailable: ["draft", "grounding", "timeline", "optimization", "trajectory"],
      trajectorySamples: event.result.trajectory.samples.length,
    },
  };
}

function runLogPreview(): unknown {
  return {
    runId: pipelineRunId,
    request: lastPipelineRequest,
    status: pipelineStatus,
    stages: pipelineStages,
    error: pipelineUiError,
    events: pipelineEvents.map(summarizePipelineEvent),
  };
}

function refreshDrawer(): void {
  let note: string;
  let value: unknown;
  let empty: string;
  switch (activeDrawerTab) {
    case "environment":
      note = "The selected environment is authoritative: renderable entities, semantic targets, and world-space motion over playback time.";
      value = environment;
      empty = "No environment loaded.";
      break;
    case "run":
      note = "Chronological run events and safe error diagnostics. Stage artifacts stay in their dedicated tabs.";
      value = hasRunLogData() ? runLogPreview() : undefined;
      empty = "Run the pipeline to inspect its event log.";
      break;
    case "draft":
      note = "The first model produces semantic CSL references without inventing runtime scene IDs.";
      value = pipelineArtifacts.draft;
      empty = "Run the pipeline to inspect its draft CSL.";
      break;
    case "grounding":
      note = "The grounding stage resolves semantic references against the selected environment and records every binding.";
      value = pipelineArtifacts.resolvedCsl === undefined && pipelineArtifacts.bindings === undefined
        ? undefined
        : {
            resolvedCsl: pipelineArtifacts.resolvedCsl,
            bindings: pipelineArtifacts.bindings,
          };
      empty = "Resolved CSL and bindings are not available yet.";
      break;
    case "timeline":
      note = "The solver output preserves section timing; the flattened timeline is the optimizer handoff.";
      value = pipelineArtifacts.timeline === undefined && pipelineArtifacts.flattenedTimeline === undefined
        ? undefined
        : {
            timeline: pipelineArtifacts.timeline,
            flattenedTimeline: pipelineArtifacts.flattenedTimeline,
          };
      empty = "Timeline artifacts are not available yet.";
      break;
    case "diagnostics":
      note = "Optimization diagnostics report the real numerical result, compiled losses, conflicts, and warnings.";
      value = pipelineArtifacts.diagnostics === undefined
        && pipelineArtifacts.compiledPlan === undefined
        && pipelineArtifacts.models === undefined
        && pipelineArtifacts.timings === undefined
        ? undefined
        : {
            models: pipelineArtifacts.models,
            timings: pipelineArtifacts.timings,
            diagnostics: pipelineArtifacts.diagnostics,
            compiledPlan: pipelineArtifacts.compiledPlan,
          };
      empty = "Optimization diagnostics are not available yet.";
      break;
    case "trajectory":
      note = "All trajectory inputs are normalized before rendering. Dense samples are shortened only in this preview, never in playback.";
      value = trajectoryPreview();
      empty = "No camera trajectory loaded.";
      break;
  }
  drawerNote.textContent = note;
  jsonPreview.textContent = value === null || value === undefined
    ? empty
    : JSON.stringify(value, null, 2);

  for (const button of drawerTabs.querySelectorAll<HTMLButtonElement>("button[data-tab]")) {
    button.classList.toggle("has-data", hasArtifactForTab(button.dataset.tab as DrawerTab));
  }
}

function openDrawer(): void {
  drawerReturnFocus = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null;
  dataDrawer.inert = false;
  refreshDrawer();
  dataDrawer.classList.add("is-open");
  dataDrawer.setAttribute("aria-hidden", "false");
  scrim.hidden = false;
  requestAnimationFrame(() => byId<HTMLButtonElement>("closeDrawer").focus());
}

function openDrawerTab(tab: DrawerTab): void {
  activeDrawerTab = tab;
  for (const button of drawerTabs.querySelectorAll<HTMLButtonElement>("button[data-tab]")) {
    button.classList.toggle("is-active", button.dataset.tab === tab);
  }
  openDrawer();
}

function closeDrawer(): void {
  if (!dataDrawer.classList.contains("is-open")) return;
  dataDrawer.classList.remove("is-open");
  dataDrawer.setAttribute("aria-hidden", "true");
  dataDrawer.inert = true;
  scrim.hidden = true;
  drawerReturnFocus?.focus();
  drawerReturnFocus = null;
}

function cameraTemplate(env: EnvironmentV1): CameraPath4dV1 {
  const duration = env.clock.durationSeconds;
  const targetId = env.targets[0]?.id;
  return {
    schemaVersion: "1.0",
    kind: "cameraPath4d",
    environmentId: env.id,
    layout: ["x", "y", "z", "t"],
    orientation: targetId
      ? { mode: "lookAtTarget", targetId, up: [0, 1, 0] }
      : { mode: "pathTangent", up: [0, 1, 0] },
    points: [
      [0, 2.5, 8, 0],
      [3, 3.5, 5, duration / 2],
      [0, 5, 3, duration],
    ],
  };
}

function downloadJson(filename: string, value: unknown): void {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 500);
}

function bindEvents(): void {
  environmentSelect.addEventListener("change", () => {
    const entry = manifest.environments.find((candidate) => candidate.id === environmentSelect.value);
    if (entry) void selectEnvironment(entry);
  });

  composerTabs.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-mode]");
    if (button) setComposerMode(button.dataset.mode as ComposerMode);
  });
  composerTabs.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    setComposerMode(composerMode === "example" ? "custom" : "example", true);
  });
  customPrompt.addEventListener("input", () => {
    promptCount.textContent = `${customPrompt.value.length.toLocaleString()} / 4000`;
    renderPipelineUi();
  });
  replayExampleButton.addEventListener("click", () => { void replayBundledExample(); });
  runExampleButton.addEventListener("click", () => {
    const entry = selectedManifestEntry();
    if (environment && entry) {
      void runPipeline({ environmentId: environment.id, prompt: entry.prompt || environment.prompt });
    }
  });
  runCustomButton.addEventListener("click", () => {
    if (environment) void runPipeline({ environmentId: environment.id, prompt: customPrompt.value });
  });
  cancelRunButton.addEventListener("click", () => { void cancelActivePipeline(); });
  retryRunButton.addEventListener("click", () => {
    if (lastPipelineRequest) void runPipeline(lastPipelineRequest);
  });
  pipelineErrorDetailsButton.addEventListener("click", () => openDrawerTab("run"));
  inspectRunButton.addEventListener("click", () => {
    openDrawerTab(hasRunLogData() ? "run" : "trajectory");
  });
  stageList.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-open-tab]");
    if (!button || button.disabled) return;
    const failed = button.closest<HTMLLIElement>("li[data-stage]")?.dataset.status === "failed";
    openDrawerTab(failed ? "run" : button.dataset.openTab as DrawerTab);
  });

  viewMode.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-view]");
    if (button && !button.disabled) setView(button.dataset.view as ViewMode);
  });

  playButton.addEventListener("click", () => setPlaying(!playing));
  timeline.addEventListener("input", () => {
    currentTime = Number(timeline.value);
    setPlaying(false);
  });
  speedButton.addEventListener("click", () => {
    const currentIndex = SPEEDS.indexOf(playbackSpeed);
    playbackSpeed = SPEEDS[(currentIndex + 1) % SPEEDS.length]!;
    speedButton.textContent = `${playbackSpeed}×`;
  });

  pathToggle.addEventListener("change", () => renderer.setShowPath(pathToggle.checked));
  boundsToggle.addEventListener("change", () => renderer.setShowBounds(boundsToggle.checked));
  labelsToggle.addEventListener("change", () => renderer.setShowLabels(labelsToggle.checked));

  trajectoryInput.addEventListener("change", () => {
    const file = trajectoryInput.files?.[0];
    if (file) void loadFile(file).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      setUploadMessage(message, "error");
      showToast(message, "error");
    });
    trajectoryInput.value = "";
  });

  for (const type of ["dragenter", "dragover"]) {
    dropzone.addEventListener(type, (event) => { event.preventDefault(); dropzone.classList.add("is-dragging"); });
  }
  for (const type of ["dragleave", "drop"]) {
    dropzone.addEventListener(type, (event) => { event.preventDefault(); dropzone.classList.remove("is-dragging"); });
  }
  dropzone.addEventListener("drop", (event) => {
    if (pipelineStatus === "starting" || pipelineStatus === "running") {
      showToast("Cancel the active pipeline before loading a manual trajectory.", "warning");
      return;
    }
    const file = event.dataTransfer?.files[0];
    if (file) void loadFile(file).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      setUploadMessage(message, "error");
      showToast(message, "error");
    });
  });

  pasteButton.addEventListener("click", () => {
    if (environment) pasteValue.value = JSON.stringify(cameraTemplate(environment), null, 2);
    pasteDialog.showModal();
  });
  loadPastedButton.addEventListener("click", (event) => {
    event.preventDefault();
    try {
      const value: unknown = JSON.parse(pasteValue.value);
      void applyTrajectory(value, "Pasted JSON").then(() => {
        pipelineStatus = "idle";
        pipelineConnection.textContent = "";
        lastPipelineRequest = null;
        resetPipelineArtifacts();
        pasteDialog.close();
      }).catch((error: unknown) => {
        showToast(error instanceof Error ? error.message : String(error), "error");
      });
    } catch {
      showToast("The pasted text is not valid JSON.", "error");
    }
  });
  templateButton.addEventListener("click", () => {
    if (!environment) return;
    downloadJson(`${environment.id}-camera-template.json`, cameraTemplate(environment));
  });

  byId("dataButton").addEventListener("click", openDrawer);
  byId("closeDrawer").addEventListener("click", closeDrawer);
  scrim.addEventListener("click", closeDrawer);
  drawerTabs.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-tab]");
    if (!button) return;
    activeDrawerTab = button.dataset.tab as DrawerTab;
    for (const tab of drawerTabs.querySelectorAll("button")) tab.classList.toggle("is-active", tab === button);
    refreshDrawer();
  });
  dataDrawer.addEventListener("keydown", (event) => {
    if (event.key !== "Tab" || !dataDrawer.classList.contains("is-open")) return;
    const focusable = [...dataDrawer.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )].filter((element) => !element.hidden);
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  window.addEventListener("keydown", (event) => {
    if (event.code === "Space" && event.target === document.body) {
      event.preventDefault();
      setPlaying(!playing);
    }
    if (event.key.toLowerCase() === "v" && trajectory) setView(activeView === "god" ? "director" : "god");
    if (event.key === "Escape") closeDrawer();
  });
}

async function bootstrap(): Promise<void> {
  try {
    renderer = new SceneRenderer(canvas);
    manifest = await fetchManifest();
    populateEnvironmentPicker();
    bindEvents();

    const search = new URLSearchParams(location.search);
    const requestedId = search.get("environment");
    const requestedTrajectoryUrl = search.get("trajectory");
    const first = manifest.environments.find((entry) => entry.id === requestedId) ?? manifest.environments[0]!;
    environmentSelect.value = first.id;
    await selectEnvironment(first, requestedTrajectoryUrl);

    lastFrameAt = performance.now();
    requestAnimationFrame(animationFrame);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fatalError.textContent = `Camera Lab could not start.\n${message}`;
    fatalError.hidden = false;
  }
}

void bootstrap();
