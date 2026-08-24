import * as fs from "fs";
import * as path from "path";
import { loadEnvFile } from "node:process";

import { solveTimeline } from "./timeline/solver";
import { flattenTimeline } from "./timeline/flattener";
import { generateSvgTimeline, generatePngTimeline } from "./timeline/visualizer";
import {
  parseExampleBindingMode,
  resolvePromptExampleForRun,
  type ExampleBindingMode,
} from "./data/examples";
import {
  resolvedPromptExampleFixtures,
  type ResolvedPromptExampleFixture,
} from "./data/resolved-example-fixtures";
import {
  createEnvironmentSubjectResolver,
  getEnvironmentQueryModel,
} from "./environment";
import type { EnvironmentV1 } from "./types/environment";
import {
  optimizeCameraTrajectory,
  type CameraOptimizerDiagnosticsDocumentV1,
  type CameraOptimizerResult,
  type UserCameraKeyframe,
} from "./optimizer";
import type { FlattenedTimeline } from "./types/solver";

const OUTPUT_DIR = path.resolve(__dirname, "./outputs");
const SHARED_DIR = path.resolve(__dirname, "../shared/timeline");
const SHARED_OPTIMIZED_DIR = path.resolve(__dirname, "../shared/optimized");
const VIEWER_TRAJECTORY_DIR = path.resolve(
  __dirname,
  "../web/public/trajectories/optimized"
);
const ENVIRONMENTS_DIR = path.resolve(__dirname, "../web/public/environments");

interface SelectedExample {
  fixture: ResolvedPromptExampleFixture;
  index: number;
}

interface PipelineOptions {
  bindingMode: ExampleBindingMode;
  selectedExamples: SelectedExample[];
  keyframesPath?: string;
  optimizerIterations?: number;
}

function loadProjectEnv(): void {
  try {
    loadEnvFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function printUsage(): void {
  console.log(
    [
      "Usage: npm run pipeline -- [--example <number|example-id>] [--binding-mode <resolved|llm>] [--keyframes <json>] [--optimizer-iterations <n>]",
      "",
      "Examples:",
      "  npm run pipeline",
      "  npm run pipeline -- --example 1",
      "  npm run pipeline -- --example example-01 --binding-mode resolved",
      "  npm run pipeline -- --example example-01 --binding-mode llm",
      "  npm run pipeline -- --example example-07 --keyframes ./my-keyframes.json",
      "",
      "EXAMPLE_BINDING_MODE can set the default mode; --binding-mode overrides it.",
    ].join("\n")
  );
}

function parsePipelineOptions(args: string[]): PipelineOptions | undefined {
  let selector: string | undefined;
  let bindingModeValue: string | undefined;
  let keyframesPath: string | undefined;
  let optimizerIterations: number | undefined;

  for (let i = 0; i < args.length; i++) {
    const argument = args[i]!;

    if (argument === "--help" || argument === "-h") {
      printUsage();
      return undefined;
    }

    let value: string | undefined;
    let option: "example" | "bindingMode" | "keyframes" | "optimizerIterations";
    if (argument === "--example") {
      value = args[++i];
      option = "example";
    } else if (argument.startsWith("--example=")) {
      value = argument.slice("--example=".length);
      option = "example";
    } else if (argument === "--binding-mode") {
      value = args[++i];
      option = "bindingMode";
    } else if (argument.startsWith("--binding-mode=")) {
      value = argument.slice("--binding-mode=".length);
      option = "bindingMode";
    } else if (argument === "--keyframes") {
      value = args[++i];
      option = "keyframes";
    } else if (argument.startsWith("--keyframes=")) {
      value = argument.slice("--keyframes=".length);
      option = "keyframes";
    } else if (argument === "--optimizer-iterations") {
      value = args[++i];
      option = "optimizerIterations";
    } else if (argument.startsWith("--optimizer-iterations=")) {
      value = argument.slice("--optimizer-iterations=".length);
      option = "optimizerIterations";
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }

    if (!value || value.startsWith("--")) {
      throw new Error(
        `--${option === "bindingMode" ? "binding-mode" : option === "optimizerIterations" ? "optimizer-iterations" : option} requires a value.`,
      );
    }
    if (option === "example") {
      if (selector !== undefined) {
        throw new Error("--example can only be provided once.");
      }
      selector = value;
    } else if (option === "bindingMode") {
      if (bindingModeValue !== undefined) {
        throw new Error("--binding-mode can only be provided once.");
      }
      bindingModeValue = value;
    } else if (option === "keyframes") {
      if (keyframesPath !== undefined) throw new Error("--keyframes can only be provided once.");
      keyframesPath = path.resolve(value);
    } else {
      if (optimizerIterations !== undefined) {
        throw new Error("--optimizer-iterations can only be provided once.");
      }
      optimizerIterations = Number(value);
      if (!Number.isInteger(optimizerIterations) || optimizerIterations < 0) {
        throw new Error("--optimizer-iterations must be a non-negative integer.");
      }
    }
  }

  const bindingMode = parseExampleBindingMode(
    bindingModeValue ?? process.env.EXAMPLE_BINDING_MODE,
  );
  if (selector === undefined) {
    return {
      bindingMode,
      ...(keyframesPath ? { keyframesPath } : {}),
      ...(optimizerIterations === undefined ? {} : { optimizerIterations }),
      selectedExamples: resolvedPromptExampleFixtures.map(
        (fixture, index) => ({ fixture, index }),
      ),
    };
  }

  const numericIndex = /^\d+$/.test(selector)
    ? Number.parseInt(selector, 10) - 1
    : -1;
  const index = numericIndex >= 0
    ? numericIndex
    : resolvedPromptExampleFixtures.findIndex((fixture) => fixture.id === selector);

  if (index < 0 || index >= resolvedPromptExampleFixtures.length) {
    throw new Error(
      `Unknown example ${JSON.stringify(selector)}. Use 1-${resolvedPromptExampleFixtures.length} `
      + `or one of: ${resolvedPromptExampleFixtures.map((fixture) => fixture.id).join(", ")}.`
    );
  }

  return {
    bindingMode,
    ...(keyframesPath ? { keyframesPath } : {}),
    ...(optimizerIterations === undefined ? {} : { optimizerIterations }),
    selectedExamples: [{ fixture: resolvedPromptExampleFixtures[index]!, index }],
  };
}

function loadUserKeyframes(
  keyframesPath: string | undefined,
  environmentId: string,
): UserCameraKeyframe[] {
  if (!keyframesPath) return [];
  let document: unknown;
  try {
    document = JSON.parse(fs.readFileSync(keyframesPath, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not load user keyframes ${keyframesPath}: ${detail}`);
  }
  if (Array.isArray(document)) return document as UserCameraKeyframe[];
  if (document && typeof document === "object") {
    const object = document as { environmentId?: unknown; keyframes?: unknown };
    if (object.environmentId !== undefined && object.environmentId !== environmentId) {
      throw new Error(
        `Keyframe environment mismatch: expected ${environmentId}, received ${String(object.environmentId)}`,
      );
    }
    if (Array.isArray(object.keyframes)) return object.keyframes as UserCameraKeyframe[];
  }
  throw new Error("Keyframe JSON must be an array or { environmentId, keyframes: [...] }");
}

function writeJsonAtomically(filePath: string, document: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.tmp`);
  fs.writeFileSync(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  fs.renameSync(temporaryPath, filePath);
}

function loadExampleEnvironment(fixture: ResolvedPromptExampleFixture): EnvironmentV1 {
  const environmentPath = path.join(ENVIRONMENTS_DIR, `${fixture.id}.json`);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(environmentPath, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not load environment ${environmentPath}: ${detail}`);
  }

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`Environment ${environmentPath} must contain a JSON object`);
  }
  const environment = raw as Partial<EnvironmentV1>;
  if (
    environment.schemaVersion !== "1.0"
    || environment.kind !== "environment"
    || !Array.isArray(environment.entities)
    || !Array.isArray(environment.targets)
  ) {
    throw new Error(`Environment ${environmentPath} is not an EnvironmentV1 document`);
  }
  if (
    environment.id !== fixture.environmentId
    || environment.promptExampleId !== fixture.id
  ) {
    throw new Error(
      `Environment identity mismatch for ${fixture.id}: expected ${fixture.environmentId}, `
      + `received ${environment.id ?? "unknown"}/${environment.promptExampleId ?? "unknown"}`,
    );
  }
  if (environment.clock?.durationSeconds !== fixture.resolvedCsl.totalDuration) {
    throw new Error(
      `Environment duration for ${fixture.id} does not match its resolved CSL`,
    );
  }

  return environment as EnvironmentV1;
}

function runOptimizer(
  environment: EnvironmentV1,
  timeline: FlattenedTimeline,
  userKeyframes: UserCameraKeyframe[],
  trajectoryOutputPath: string,
  diagnosticsOutputPath: string,
  optimizerIterations?: number,
): CameraOptimizerResult {
  const result = optimizeCameraTrajectory({
    environment,
    timeline,
    userKeyframes,
    ...(optimizerIterations === undefined ? {} : { options: { iterations: optimizerIterations } }),
  });
  writeJsonAtomically(trajectoryOutputPath, result.trajectory);
  writeJsonAtomically(diagnosticsOutputPath, {
    schemaVersion: "1.0",
    kind: "cameraOptimizerDiagnostics",
    environmentId: environment.id,
    trajectory: result.trajectory,
    diagnostics: result.diagnostics,
    compiledPlan: result.compiledPlan,
  } satisfies CameraOptimizerDiagnosticsDocumentV1);
  return result;
}

async function main(): Promise<void> {
  loadProjectEnv();
  const options = parsePipelineOptions(process.argv.slice(2));
  if (options === undefined) {
    return;
  }
  const { bindingMode, selectedExamples } = options;
  if (options.keyframesPath && selectedExamples.length !== 1) {
    throw new Error("--keyframes requires selecting exactly one --example");
  }

  for (const directory of [OUTPUT_DIR, SHARED_DIR, SHARED_OPTIMIZED_DIR, VIEWER_TRAJECTORY_DIR]) {
    fs.mkdirSync(directory, { recursive: true });
  }

  console.log(`Subject binding mode: ${bindingMode}`);

  for (const { fixture, index } of selectedExamples) {
    const exampleNumber = index + 1;
    const outputStem = `output_${exampleNumber}`;

    console.log(`\n${"=".repeat(80)}`);
    console.log(`Example ${exampleNumber}: ${fixture.prompt.slice(0, 80)}...`);
    console.log("=".repeat(80));

    const environment = loadExampleEnvironment(fixture);
    const model = bindingMode === "llm" ? getEnvironmentQueryModel() : undefined;
    const run = bindingMode === "resolved"
      ? await resolvePromptExampleForRun(fixture, bindingMode)
      : await resolvePromptExampleForRun(
          fixture,
          bindingMode,
          createEnvironmentSubjectResolver(environment),
        );
    const { csl } = run;

    if (run.evaluation) {
      const { evaluation } = run;
      const summary = `${evaluation.matchedReferences}/${evaluation.totalReferences}`;
      if (evaluation.exactMatch) {
        console.log(`LLM subject binding matched fixture ground truth (${summary}).`);
      } else {
        console.warn(`LLM subject binding differs from fixture ground truth (${summary} matched).`);
        evaluation.mismatches.forEach((mismatch) => {
          console.warn(
            `  ${mismatch.ref}: expected [${mismatch.expectedSubjectIds.join(", ")}], `
            + `LLM selected [${mismatch.actualSubjectIds.join(", ")}]`,
          );
        });
        console.warn("Continuing with the valid LLM-selected bindings.");
      }
    }

    const solverOutput = solveTimeline(csl);
    const flattened = flattenTimeline(solverOutput);

    const outputWrapper = {
      schemaVersion: "1.0",
      kind: "timelineSolverOutput",
      exampleId: fixture.id,
      environmentId: fixture.environmentId,
      prompt: fixture.prompt,
      totalDuration: csl.totalDuration,
      subjectBinding: run.mode === "resolved"
        ? { mode: run.mode, source: "resolved-fixture" }
        : {
            mode: run.mode,
            model,
            bindings: run.bindings,
            evaluation: run.evaluation,
          },
      timeline: flattened,
    };

    const outputJsonPath = path.join(
      OUTPUT_DIR,
      `${outputStem}.json`
    );

    const sharedJsonPath = path.join(
      SHARED_DIR,
      `${outputStem}.json`
    );

    const viewerTrajectoryPath = path.join(
      VIEWER_TRAJECTORY_DIR,
      `${fixture.id}-camera.json`
    );
    const optimizerDiagnosticsPath = path.join(
      SHARED_OPTIMIZED_DIR,
      `${outputStem}_optimized.json`,
    );
    const optimizerArchivePath = path.join(
      SHARED_OPTIMIZED_DIR,
      `${outputStem}_camera.json`,
    );

    fs.writeFileSync(
      outputJsonPath,
      JSON.stringify(outputWrapper, null, 2),
      "utf8"
    );

    fs.writeFileSync(
      sharedJsonPath,
      JSON.stringify(outputWrapper, null, 2),
      "utf8"
    );

    generateSvgTimeline(outputJsonPath);
    await generatePngTimeline(outputJsonPath);

    console.log("-".repeat(80));
    console.log(`Running optimizer on ${outputStem}.json`);
    const optimizerResult = runOptimizer(
      environment,
      flattened,
      loadUserKeyframes(options.keyframesPath, environment.id),
      viewerTrajectoryPath,
      optimizerDiagnosticsPath,
      options.optimizerIterations,
    );
    writeJsonAtomically(optimizerArchivePath, optimizerResult.trajectory);

    if (!fs.existsSync(viewerTrajectoryPath)) {
      throw new Error(
        `Optimizer completed without writing viewer trajectory: ${viewerTrajectoryPath}`
      );
    }

    console.log(`Viewer trajectory: ${viewerTrajectoryPath}`);
    console.log(
      `Optimizer: ${optimizerResult.diagnostics.terminationReason}; `
      + `${optimizerResult.diagnostics.initialLoss.toFixed(3)} → ${optimizerResult.diagnostics.finalLoss.toFixed(3)}`,
    );
    console.log(
      "Camera Lab: "
      + `http://127.0.0.1:4173/?environment=${encodeURIComponent(fixture.environmentId)}`
    );
  }

  console.log(`\n✅ Done! Processed ${selectedExamples.length} example(s).`);
  console.log(`Timeline outputs in: ${OUTPUT_DIR}/`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error
    ? error.stack ?? error.message
    : String(error);
  console.error(`\nPipeline failed:\n${message}`);
  process.exitCode = 1;
});
