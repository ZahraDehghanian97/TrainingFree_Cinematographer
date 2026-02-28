import * as fs from 'fs';
import { solveTimeline } from './timeline/solver';
import { generateSvgTimeline, generatePngTimeline } from './timeline/visualizer';
import { promptExamples } from './data/examples';
import { flattenTimeline } from './timeline/flattener';

const OUTPUT_DIR = './outputs';

if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

async function main() {
  for (let i = 0; i < promptExamples.length; i++) {
    const example = promptExamples[i]!;
    console.log(`\n${'='.repeat(80)}`);
    console.log(`Example ${i + 1}: ${example.prompt.slice(0, 80)}...`);
    console.log('='.repeat(80));

    const solverOutput = solveTimeline(example.csl);
    const flattened = flattenTimeline(solverOutput);

    const jsonPath = `${OUTPUT_DIR}/output_${i + 1}.json`;
    const outputWrapper = {
      prompt: example.prompt,
      totalDuration: example.csl.totalDuration,
      timeline: flattened,
    };

    fs.writeFileSync(jsonPath, JSON.stringify(outputWrapper, null, 2), 'utf8');
    generateSvgTimeline(jsonPath);
    await generatePngTimeline(jsonPath);
  }

  console.log(`\n✅ Done! Processed ${promptExamples.length} examples.`);
  console.log(`Outputs in: ${OUTPUT_DIR}/`);
}

main().catch(console.error);
