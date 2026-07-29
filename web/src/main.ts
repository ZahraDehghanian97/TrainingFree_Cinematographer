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

interface EnvironmentManifestEntry {
  id: string;
  promptExampleId: string;
  title?: string;
  prompt: string;
  durationSeconds: number;
  url: string;
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

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const SPEEDS = [0.1, 0.25, 0.5, 1, 2, 4];

let renderer: SceneRenderer;
let manifest: EnvironmentManifest;
let environment: EnvironmentV1 | null = null;
let trajectory: CameraTrajectoryV1 | null = null;
let currentTime = 0;
let playbackSpeed = 1;
let playing = false;
let activeView: ViewMode = "god";
let activeDrawerTab: "environment" | "trajectory" = "environment";
let lastFrameAt = performance.now();
let environmentRequest = 0;
let toastTimer: number | undefined;

function publicUrl(path: string): string {
  const cleanPath = path.replace(/^\/+/, "");
  const base = import.meta.env.BASE_URL.endsWith("/") ? import.meta.env.BASE_URL : `${import.meta.env.BASE_URL}/`;
  return `${base}${cleanPath}`;
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
  setUploadMessage("Upload model output as canonical frames or [x,y,z,t] points.");
  if (activeView === "director") setView("god");
  refreshDrawer();
}

async function selectEnvironment(entry: EnvironmentManifestEntry, loadBundledTrajectory = true): Promise<void> {
  const request = ++environmentRequest;
  environmentSelect.disabled = true;
  sceneStatus.textContent = "Loading environment";
  setPlaying(false);

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
    durationValue.textContent = `${environment.clock.durationSeconds.toFixed(1)} s`;
    entityValue.textContent = String(environment.entities.length);
    sceneStatus.textContent = "Environment ready";
    document.title = `${shortEnvironmentName(environment)} · Camera Lab`;

    if (loadBundledTrajectory && entry.sampleTrajectoryUrl) {
      try {
        const response = await fetch(publicUrl(entry.sampleTrajectoryUrl));
        if (response.ok && request === environmentRequest) await applyTrajectory(await response.json(), "Bundled demo");
      } catch {
        // The viewer remains useful in God view if the optional demo cannot load.
      }
    }
    refreshDrawer();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sceneStatus.textContent = "Environment error";
    showToast(message, "error");
  } finally {
    if (request === environmentRequest) environmentSelect.disabled = false;
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

function refreshDrawer(): void {
  if (activeDrawerTab === "environment") {
    drawerNote.textContent = "The selected environment is authoritative: renderable entities, semantic targets, and world-space motion over playback time.";
    jsonPreview.textContent = environment ? JSON.stringify(environment, null, 2) : "No environment loaded.";
  } else {
    drawerNote.textContent = "Uploaded data is normalized before rendering. Dense camera samples are shortened only in this preview, never in playback.";
    jsonPreview.textContent = trajectory ? JSON.stringify(trajectoryPreview(), null, 2) : "No camera trajectory loaded.";
  }
}

function openDrawer(): void {
  refreshDrawer();
  dataDrawer.classList.add("is-open");
  dataDrawer.setAttribute("aria-hidden", "false");
  scrim.hidden = false;
}

function closeDrawer(): void {
  dataDrawer.classList.remove("is-open");
  dataDrawer.setAttribute("aria-hidden", "true");
  scrim.hidden = true;
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
    const file = event.dataTransfer?.files[0];
    if (file) void loadFile(file).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      setUploadMessage(message, "error");
      showToast(message, "error");
    });
  });

  byId("pasteButton").addEventListener("click", () => {
    if (environment) pasteValue.value = JSON.stringify(cameraTemplate(environment), null, 2);
    pasteDialog.showModal();
  });
  byId("loadPastedButton").addEventListener("click", (event) => {
    event.preventDefault();
    try {
      const value: unknown = JSON.parse(pasteValue.value);
      void applyTrajectory(value, "Pasted JSON").then(() => pasteDialog.close()).catch((error: unknown) => {
        showToast(error instanceof Error ? error.message : String(error), "error");
      });
    } catch {
      showToast("The pasted text is not valid JSON.", "error");
    }
  });
  byId("templateButton").addEventListener("click", () => {
    if (!environment) return;
    downloadJson(`${environment.id}-camera-template.json`, cameraTemplate(environment));
  });

  byId("dataButton").addEventListener("click", openDrawer);
  byId("closeDrawer").addEventListener("click", closeDrawer);
  scrim.addEventListener("click", closeDrawer);
  drawerTabs.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-tab]");
    if (!button) return;
    activeDrawerTab = button.dataset.tab as typeof activeDrawerTab;
    for (const tab of drawerTabs.querySelectorAll("button")) tab.classList.toggle("is-active", tab === button);
    refreshDrawer();
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

    const requestedId = new URLSearchParams(location.search).get("environment");
    const first = manifest.environments.find((entry) => entry.id === requestedId) ?? manifest.environments[0]!;
    environmentSelect.value = first.id;
    await selectEnvironment(first, true);

    lastFrameAt = performance.now();
    requestAnimationFrame(animationFrame);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fatalError.textContent = `Camera Lab could not start.\n${message}`;
    fatalError.hidden = false;
  }
}

void bootstrap();
