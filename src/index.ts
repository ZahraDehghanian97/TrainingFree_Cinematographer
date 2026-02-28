import * as fs from 'fs';
import { solveTimeline } from './timeline/solver';
import { generateSvgTimeline } from './timeline/visualizer';
import { promptExamples } from './constants/examples';
import { TimelineSolverOutput } from './types/CSL';


const OUTPUT_DIR = './outputs';

if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

for (let i = 0; i < promptExamples.length; i++) {
  const example = promptExamples[i]!;
  console.log(`\n${'='.repeat(80)}`);
  console.log(`Example ${i + 1}: ${example.prompt.slice(0, 80)}...`);
  console.log('='.repeat(80));

  const solverOutput = solveTimeline(example.csl);
  const normalized = normalizeTimeline(solverOutput);

  const jsonPath = `${OUTPUT_DIR}/output_${i + 1}.json`;
  const outputWrapper = {
    prompt: example.prompt,
    totalDuration: example.csl.totalDuration,
    timeline: normalized,
  };

  try {
    fs.writeFileSync(jsonPath, JSON.stringify(outputWrapper, null, 2), 'utf8');
    console.log(`JSON saved: ${jsonPath}`);
  } catch (err) {
    console.error(`Error writing JSON: ${err}`);
    continue;
  }

  try {
    generateSvgTimeline(jsonPath);
    console.log(`SVG generated for example ${i + 1}`);
  } catch (err) {
    console.error(`Error generating SVG: ${err}`);
  }
}

console.log(`\n✅ Done! Processed ${promptExamples.length} examples.`);
console.log(`Outputs in: ${OUTPUT_DIR}/`);
function normalizeTimeline(solverOutput: TimelineSolverOutput) {
  throw new Error('Function not implemented.');
}

