import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";

import { solveTimeline } from "./timeline/solver";
import { flattenTimeline } from "./timeline/flattener";
import { generateSvgTimeline, generatePngTimeline } from "./timeline/visualizer";
import { promptExamples } from "./data/examples";

const OUTPUT_DIR = path.resolve(__dirname, "./outputs");
const SHARED_DIR = path.resolve(__dirname, "../shared/timeline");
const OPTIMIZER_DIR = path.resolve(__dirname, "./opt");
const VIEWER_TRAJECTORY_DIR = path.resolve(
  __dirname,
  "../web/public/trajectories/optimized"
);

interface SelectedExample {
  example: (typeof promptExamples)[number];
  index: number;
}

function printUsage(): void {
  console.log(
    [
      "Usage: npm run pipeline -- [--example <number|example-id>]",
      "",
      "Examples:",
      "  npm run pipeline",
      "  npm run pipeline -- --example 1",
      "  npm run pipeline -- --example example-01",
    ].join("\n")
  );
}

function selectExamples(args: string[]): SelectedExample[] | undefined {
  let selector: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const argument = args[i]!;

    if (argument === "--help" || argument === "-h") {
      printUsage();
      return undefined;
    }

    let value: string | undefined;
    if (argument === "--example") {
      value = args[++i];
    } else if (argument.startsWith("--example=")) {
      value = argument.slice("--example=".length);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }

    if (!value || value.startsWith("--")) {
      throw new Error("--example requires an example number or id.");
    }
    if (selector !== undefined) {
      throw new Error("--example can only be provided once.");
    }
    selector = value;
  }

  if (selector === undefined) {
    return promptExamples.map((example, index) => ({ example, index }));
  }

  const numericIndex = /^\d+$/.test(selector)
    ? Number.parseInt(selector, 10) - 1
    : -1;
  const index = numericIndex >= 0
    ? numericIndex
    : promptExamples.findIndex((example) => example.id === selector);

  if (index < 0 || index >= promptExamples.length) {
    throw new Error(
      `Unknown example ${JSON.stringify(selector)}. Use 1-${promptExamples.length} `
      + `or one of: ${promptExamples.map((example) => example.id).join(", ")}.`
    );
  }

  return [{ example: promptExamples[index]!, index }];
}

function runOptimizer(
  timelinePath: string,
  trajectoryOutputPath: string
): Promise<void> {
  const pythonCommand = process.env.PYTHON_BIN?.trim() || "python3";

  return new Promise((resolve, reject) => {
    const child = spawn(
      pythonCommand,
      [
        "run_optimizer.py",
        timelinePath,
        "--trajectory-output",
        trajectoryOutputPath,
      ],
      {
        cwd: OPTIMIZER_DIR,
        stdio: "inherit",
      }
    );

    child.once("error", (error) => {
      reject(
        new Error(
          `Could not start optimizer with ${JSON.stringify(pythonCommand)}: ${error.message}`
        )
      );
    });

    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }

      const reason = signal
        ? `it was terminated by signal ${signal}`
        : `it exited with status ${code ?? "unknown"}`;
      reject(new Error(`Optimizer failed because ${reason}.`));
    });
  });
}

async function main(): Promise<void> {
  const selectedExamples = selectExamples(process.argv.slice(2));
  if (selectedExamples === undefined) {
    return;
  }

  for (const directory of [OUTPUT_DIR, SHARED_DIR, VIEWER_TRAJECTORY_DIR]) {
    fs.mkdirSync(directory, { recursive: true });
  }

  for (const { example, index } of selectedExamples) {
    const exampleNumber = index + 1;
    const outputStem = `output_${exampleNumber}`;

    console.log(`\n${"=".repeat(80)}`);
    console.log(`Example ${exampleNumber}: ${example.prompt.slice(0, 80)}...`);
    console.log("=".repeat(80));

    const solverOutput = solveTimeline(example.csl);
    const flattened = flattenTimeline(solverOutput);

    const outputWrapper = {
      schemaVersion: "1.0",
      kind: "timelineSolverOutput",
      exampleId: example.id,
      environmentId: example.environmentId,
      prompt: example.prompt,
      totalDuration: example.csl.totalDuration,
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
      `${example.id}-camera.json`
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
    await runOptimizer(sharedJsonPath, viewerTrajectoryPath);

    if (!fs.existsSync(viewerTrajectoryPath)) {
      throw new Error(
        `Optimizer completed without writing viewer trajectory: ${viewerTrajectoryPath}`
      );
    }

    console.log(`Viewer trajectory: ${viewerTrajectoryPath}`);
    console.log(
      "Camera Lab: "
      + `http://127.0.0.1:4173/?environment=${encodeURIComponent(example.environmentId)}`
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
