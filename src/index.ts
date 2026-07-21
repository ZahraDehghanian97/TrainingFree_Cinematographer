import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";

import { solveTimeline } from "./timeline/solver";
import { flattenTimeline } from "./timeline/flattener";
import { generateSvgTimeline, generatePngTimeline } from "./timeline/visualizer";
import { promptExamples } from "./data/examples";

const OUTPUT_DIR = path.resolve(__dirname, "./outputs");
const SHARED_DIR = path.resolve(__dirname, "../shared/timeline");

if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

if (!fs.existsSync(SHARED_DIR)) {
  fs.mkdirSync(SHARED_DIR, { recursive: true });
}

async function main() {
  for (let i = 0; i < promptExamples.length; i++) {

    const example = promptExamples[i]!;

    console.log(`\n${"=".repeat(80)}`);
    console.log(`Example ${i + 1}: ${example.prompt.slice(0, 80)}...`);
    console.log("=".repeat(80));

    const solverOutput = solveTimeline(example.csl);
    const flattened = flattenTimeline(solverOutput);

    const outputWrapper = {
      prompt: example.prompt,
      totalDuration: example.csl.totalDuration,
      timeline: flattened,
    };

    const outputJsonPath = path.join(
      OUTPUT_DIR,
      `output_${i + 1}.json`
    );

    const sharedJsonPath = path.join(
      SHARED_DIR,
      `output_${i + 1}.json`
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
    console.log(`Running optimizer on output_${i + 1}.json`);

    const result = spawnSync(
      "python3",
      ["run_optimizer.py", sharedJsonPath],
      {
        cwd: path.resolve(__dirname, "../opt"),
        encoding: "utf8",
      }
    );

    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");

    if (result.status !== 0) {
      console.error(`Optimizer failed on example ${i + 1}.`);
      process.exit(result.status ?? 1);
    }
  }

  console.log(`\n✅ Done! Processed ${promptExamples.length} examples.`);
  console.log(`Timeline outputs in: ${OUTPUT_DIR}/`);
}
main().catch(console.error);