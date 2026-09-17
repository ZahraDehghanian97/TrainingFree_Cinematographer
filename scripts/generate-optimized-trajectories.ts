import * as fs from "node:fs";
import * as path from "node:path";

import { resolvedPromptExampleFixtures } from "../src/data/resolved-example-fixtures";
import { dontCarePromptExampleFixtures } from "../src/data/dont-care-examples";
import { optimizeCameraTrajectory } from "../src/optimizer/index";
import { DEFAULT_OPTIONS } from "../src/optimizer/config/defaults";
import { flattenTimeline } from "../src/timeline/flattener";
import { solveTimeline } from "../src/timeline/solver";
import type { EnvironmentV1 } from "../src/types/environment";
import type {
  CameraOptimizerDiagnosticsDocumentV1,
  UserCameraKeyframe,
} from "../src/optimizer/types";
import { assertCameraTrajectoryV1 } from "../web/src/trajectory-loader";

interface GeneratorOptions {
  iterations: number;
  timelineOnly?: boolean;
  optimizationFps?: number;
  outputFps?: number;
  exampleId?: string;
  keyframesPath?: string;
  suite?: "dont-care";
}

function parsePositiveNumber(value: string | undefined, option: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${option} must be a positive finite number`);
  }
  return parsed;
}

function parseOptions(args: readonly string[]): GeneratorOptions {
  const options: GeneratorOptions = { iterations: DEFAULT_OPTIONS.iterations };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    const [name, inlineValue] = argument.split("=", 2);
    if (name === "--timeline-only") {
      if (inlineValue !== undefined) throw new Error("--timeline-only does not accept a value");
      options.timelineOnly = true;
      continue;
    }
    const value = inlineValue ?? args[++index];
    if (name === "--iterations") {
      const iterations = Number(value);
      if (!Number.isInteger(iterations) || iterations < 0) {
        throw new Error("--iterations must be a non-negative integer");
      }
      options.iterations = iterations;
    } else if (name === "--optimization-fps") {
      options.optimizationFps = parsePositiveNumber(value, name);
    } else if (name === "--output-fps") {
      options.outputFps = parsePositiveNumber(value, name);
    } else if (name === "--example") {
      if (!value) throw new Error("--example requires an example ID");
      options.exampleId = value;
    } else if (name === "--keyframes") {
      if (!value) throw new Error("--keyframes requires a JSON path");
      options.keyframesPath = path.resolve(process.cwd(), value);
    } else if (name === "--suite") {
      if (value !== "dont-care") throw new Error("--suite must be dont-care");
      options.suite = value;
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
  return options;
}

function writeJsonAtomically(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.tmp`);
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, filePath);
}

function loadEnvironment(exampleId: string): EnvironmentV1 {
  const filePath = path.resolve(
    process.cwd(),
    "web/public/environments",
    `${exampleId}.json`,
  );
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as EnvironmentV1;
}

function loadUserKeyframes(
  filePath: string | undefined,
  environmentId: string,
): UserCameraKeyframe[] {
  if (filePath === undefined) return [];
  const document = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
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

function main(): void {
  const options = parseOptions(process.argv.slice(2));
  const trajectoryDirectory = path.resolve(
    process.cwd(),
    "web/public/trajectories/optimized",
  );
  const diagnosticsDirectory = path.resolve(
    process.cwd(),
    "shared/optimized",
  );
  const timelineDirectory = path.resolve(process.cwd(), "shared/timeline");

  const suiteIds = new Set(dontCarePromptExampleFixtures.map(({ id }) => id));
  const selected = resolvedPromptExampleFixtures
    .map((fixture, index) => ({ fixture, index }))
    .filter(({ fixture }) => (options.exampleId === undefined || fixture.id === options.exampleId)
      && (options.suite === undefined || suiteIds.has(fixture.id)));
  if (selected.length === 0) throw new Error(`Unknown example ID: ${options.exampleId}`);
  if (options.keyframesPath !== undefined && selected.length !== 1) {
    throw new Error("--keyframes requires exactly one --example");
  }

  selected.forEach(({ fixture, index }) => {
    const environment = loadEnvironment(fixture.id);
    const timeline = flattenTimeline(solveTimeline(fixture.resolvedCsl, environment));
    writeJsonAtomically(
      path.join(timelineDirectory, `output_${index + 1}.json`),
      {
        schemaVersion: "1.0",
        kind: "timelineSolverOutput",
        exampleId: fixture.id,
        environmentId: fixture.environmentId,
        prompt: fixture.prompt,
        totalDuration: fixture.resolvedCsl.totalDuration,
        subjectBinding: { mode: "resolved", source: "resolved-fixture" },
        timeline,
      },
    );
    if (options.timelineOnly) {
      console.log(`${fixture.id}: timeline refreshed`);
      return;
    }
    const result = optimizeCameraTrajectory({
      environment,
      timeline,
      userKeyframes: loadUserKeyframes(options.keyframesPath, environment.id),
      options: {
        iterations: options.iterations,
        ...(options.optimizationFps === undefined
          ? {}
          : { optimizationFps: options.optimizationFps }),
        ...(options.outputFps === undefined ? {} : { outputFps: options.outputFps }),
      },
    });
    assertCameraTrajectoryV1(result.trajectory);
    writeJsonAtomically(
      path.join(trajectoryDirectory, `${fixture.id}-camera.json`),
      result.trajectory,
    );
    writeJsonAtomically(path.join(diagnosticsDirectory, `output_${index + 1}_camera.json`), result.trajectory);
    const document = {
      schemaVersion: "1.0", kind: "cameraOptimizerDiagnostics", exampleId: fixture.id,
      environmentId: environment.id, trajectory: result.trajectory,
      diagnostics: result.diagnostics, compiledPlan: result.compiledPlan,
    } satisfies CameraOptimizerDiagnosticsDocumentV1;
    writeJsonAtomically(path.join(diagnosticsDirectory, `output_${index + 1}.json`), document);
    writeJsonAtomically(
      path.join(diagnosticsDirectory, `output_${index + 1}_optimized.json`),
      document,
    );
    const diagnostics = result.diagnostics;
    const percentage = (value: number | null): string => value === null ? "n/a" : `${value.toFixed(2)}%`;
    console.log(
      `${fixture.id}: baseline ${diagnostics.baselineLoss?.toFixed(3) ?? "non-finite"}`
      + ` → selected seed ${diagnostics.initialLoss.toFixed(3)}`
      + ` → refined ${diagnostics.finalLoss.toFixed(3)}; `
      + `seed ${percentage(diagnostics.seedImprovementPercent)}, `
      + `refinement ${percentage(diagnostics.refinementImprovementPercent)}, `
      + `total ${percentage(diagnostics.totalImprovementPercent)}; `
      + `${diagnostics.terminationReason}, ${diagnostics.iterations} directional searches, `
      + `${diagnostics.searchSweeps} sweeps, `
      + `${diagnostics.seedCandidateCount} seed candidates, `
      + `${diagnostics.objectiveEvaluations} refinement evaluations, `
      + `${diagnostics.acceptedSteps} accepted steps`,
    );
  });
}

main();
