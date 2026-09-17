import * as fs from "node:fs";
import * as path from "node:path";
import { fork } from "node:child_process";
import { resolvedPromptExampleFixtures } from "../src/data/resolved-example-fixtures";
import { optimizeCameraTrajectory, compileLossPlan } from "../src/optimizer";
import { resolveOptimizerOptions } from "../src/optimizer/config/options";
import { buildOptimizationTimes, preserveMandatoryTimes } from "../src/optimizer/shared/time";
import { ObjectiveEvaluator } from "../src/optimizer/solver/objective";
import { createCameraPositionCurve } from "../src/optimizer/trajectory/position-curve";
import { solveTimeline } from "../src/timeline/solver";
import { flattenTimeline } from "../src/timeline/flattener";
import { assertEnvironmentV1 } from "../web/src/environment-loader";
import { assertCameraTrajectoryV1, sampleCameraTrajectoryAt } from "../web/src/trajectory-loader";
import type {
  CameraOptimizerDiagnosticsDocumentV1,
  CameraOptimizerInput,
  CameraStateSample,
} from "../src/optimizer/types";

interface Settings {
  baseline?: string;
  output: string;
  examples: number[];
  jobs: number;
  iterations?: number;
  writeTrajectories: boolean;
  worker?: number;
}

function positiveInteger(value: string | undefined, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function settings(args: string[]): Settings {
  const result: Settings = {
    output: path.resolve("docs/optimizer-benchmark.json"), jobs: 3,
    examples: resolvedPromptExampleFixtures.map((_, i) => i + 1), writeTrajectories: false,
  };
  for (let i = 0; i < args.length; i++) {
    const option = args[i]!;
    if (option === "--write-trajectories") { result.writeTrajectories = true; continue; }
    const value = args[++i];
    if (value === undefined) throw new Error(`Missing value for ${option}`);
    if (option === "--baseline") result.baseline = path.resolve(value);
    else if (option === "--output") result.output = path.resolve(value);
    else if (option === "--jobs") result.jobs = positiveInteger(value, option);
    else if (option === "--iterations") result.iterations = positiveInteger(value, option);
    else if (option === "--worker") result.worker = positiveInteger(value, option);
    else if (option === "--examples") result.examples = value.split(",").map(n => positiveInteger(n, option));
    else throw new Error(`Unknown option: ${option}`);
  }
  result.examples = [...new Set(result.examples)];
  if (result.examples.some(n => n > resolvedPromptExampleFixtures.length)) throw new Error("Unknown example number");
  return result;
}

function readJson(file: string): unknown { return JSON.parse(fs.readFileSync(file, "utf8")); }
function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n");
  fs.renameSync(temporary, file);
}
function percent(from: number, to: number): number | null {
  return Math.abs(from) > 1e-12 ? 100 * (from - to) / Math.abs(from) : null;
}

/** Re-score the saved path with CURRENT geometry and losses for a fair comparison. */
function evaluatePrevious(input: CameraOptimizerInput, previous: CameraOptimizerDiagnosticsDocumentV1): number {
  const options = resolveOptimizerOptions(input);
  const effective = { ...input, options: { ...input.options, ...options } };
  const plan = compileLossPlan(effective);
  // New motion contracts may add sampling times absent from an older export.
  // Include the saved polynomial boundaries and evaluate that actual path at
  // the union of times; nearest-sample lookup both failed and lost its jets.
  const times = preserveMandatoryTimes(
    buildOptimizationTimes(input.environment, input.timeline, [], options.optimizationFps, plan.motionTransitions),
    previous.trajectory.samples.map(sample => sample.t),
  );
  const savedCurve = createCameraPositionCurve(previous.trajectory.samples.map(sample => ({
    time: sample.t, position: sample.position, rotation: sample.rotation!,
    fovYDegrees: sample.fovYDegrees ?? previous.trajectory.intrinsics.fovYDegrees,
    positionVelocity: sample.positionVelocity, positionAcceleration: sample.positionAcceleration,
  })), previous.trajectory.samples.filter(sample => sample.cutBefore).map(sample => sample.t));
  const states: CameraStateSample[] = times.map(time => {
    const sample = sampleCameraTrajectoryAt(previous.trajectory, time), jets = savedCurve.sample(time);
    if (!sample.rotation || sample.fovYDegrees === undefined) throw new Error("Saved path lacks camera channels");
    return { time, position: sample.position, rotation: sample.rotation, fovYDegrees: sample.fovYDegrees,
      positionVelocity: jets.velocity, positionAcceleration: jets.acceleration };
  });
  return new ObjectiveEvaluator(effective, plan, times, options).evaluate(states, false).total;
}

function runExample(number: number, config: Settings) {
  const fixture = resolvedPromptExampleFixtures[number - 1];
  if (!fixture) throw new Error(`Unknown example ${number}`);
  const environment = readJson(path.resolve("web/public/environments", `${fixture.id}.json`));
  assertEnvironmentV1(environment);
  const input: CameraOptimizerInput = {
    environment, timeline: flattenTimeline(solveTimeline(fixture.resolvedCsl, environment)),
    ...(config.iterations === undefined ? {} : { options: { iterations: config.iterations } }),
  };
  const previous = config.baseline
    ? readJson(path.join(config.baseline, `output_${number}_optimized.json`)) as CameraOptimizerDiagnosticsDocumentV1
    : undefined;
  const previousLossUnderCurrentObjective = previous ? evaluatePrevious(input, previous) : undefined;
  const result = optimizeCameraTrajectory(input);
  assertCameraTrajectoryV1(result.trajectory);
  const d = result.diagnostics;
  if (!Number.isFinite(d.finalLoss) || d.finalLoss > d.initialLoss + 1e-7) {
    throw new Error(`${fixture.id}: nonfinite or increasing refinement loss`);
  }
  const document: CameraOptimizerDiagnosticsDocumentV1 = {
    schemaVersion: "1.0", kind: "cameraOptimizerDiagnostics", exampleId: fixture.id,
    environmentId: environment.id, ...result,
  };
  if (config.writeTrajectories) {
    writeJson(path.resolve("shared/timeline", `output_${number}.json`), {
      schemaVersion: "1.0", kind: "timelineSolverOutput", exampleId: fixture.id,
      environmentId: fixture.environmentId, prompt: fixture.prompt,
      totalDuration: fixture.resolvedCsl.totalDuration,
      subjectBinding: { mode: "resolved", source: "resolved-fixture" }, timeline: input.timeline,
    });
    writeJson(path.resolve("shared/optimized", `output_${number}_optimized.json`), document);
    writeJson(path.resolve("shared/optimized", `output_${number}.json`), document);
    writeJson(path.resolve("shared/optimized", `output_${number}_camera.json`), result.trajectory);
    writeJson(path.resolve("web/public/trajectories/optimized", `${fixture.id}-camera.json`), result.trajectory);
  }
  return {
    example: number, exampleId: fixture.id, environmentId: environment.id,
    previous: previous?.diagnostics,
    previousLossUnderCurrentObjective,
    changeFromPreviousPercent: previousLossUnderCurrentObjective === undefined ? undefined
      : percent(previousLossUnderCurrentObjective, d.finalLoss),
    diagnostics: d,
  };
}

type ExampleResult = ReturnType<typeof runExample>;
async function main() {
  const config = settings(process.argv.slice(2));
  if (config.worker !== undefined) {
    try { process.send?.({ result: runExample(config.worker, config) }); }
    catch (error) { process.send?.({ error: error instanceof Error ? error.stack : String(error) }); process.exitCode = 1; }
    return;
  }
  const startedAt = new Date().toISOString();
  const rows: ExampleResult[] = [];
  const errors: Array<{ example: number; error: string }> = [];
  const pending = [...config.examples];
  const persist = () => writeJson(config.output, {
    startedAt, updatedAt: new Date().toISOString(), settings: config,
    note: "Compare previousLossUnderCurrentObjective to finalLoss; original raw losses may use different occlusion geometry.",
    complete: rows.length + errors.length === config.examples.length,
    results: [...rows].sort((a, b) => a.example - b.example), errors,
  });
  const worker = async () => {
    for (let number = pending.shift(); number !== undefined; number = pending.shift()) {
      const n = number;
      const args = ["--worker", String(n), "--output", config.output];
      if (config.baseline) args.push("--baseline", config.baseline);
      if (config.iterations !== undefined) args.push("--iterations", String(config.iterations));
      if (config.writeTrajectories) args.push("--write-trajectories");
      await new Promise<void>(resolve => {
        const child = fork(__filename, args, {
          execArgv: ["-r", "ts-node/register"], stdio: ["ignore", "inherit", "inherit", "ipc"],
        });
        let received = false;
        child.on("message", (message: { result?: ExampleResult; error?: string }) => {
          received = true;
          if (message.result) {
            rows.push(message.result);
            const d = message.result.diagnostics;
            console.log(`${message.result.exampleId}: baseline ${d.baselineLoss?.toFixed(4) ?? "n/a"} -> seed ${d.initialLoss.toFixed(4)} -> refined ${d.finalLoss.toFixed(4)}; ${d.terminationReason}; ${d.iterations} searches; safety=${d.maximumSafetyViolationMeters}; ${(d.elapsedMilliseconds / 1000).toFixed(1)}s`);
          } else errors.push({ example: n, error: message.error ?? "Missing worker result" });
          persist();
        });
        child.on("error", error => { if (!received) { received = true; errors.push({ example: n, error: String(error) }); } });
        child.on("close", code => {
          if (!received) errors.push({ example: n, error: `Worker exited with code ${code}` });
          persist(); resolve();
        });
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(config.jobs, pending.length) }, worker));
  persist();
  console.log(`Completed ${rows.length}/${config.examples.length}; report: ${config.output}`);
  if (errors.length) { console.error(errors); process.exitCode = 1; }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
