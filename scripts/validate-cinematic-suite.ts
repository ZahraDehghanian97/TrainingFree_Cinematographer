/** Compatibility checks against the actual project runtime. No external API. */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { assertResolvedCameraDirection } from '../src/grounding/validation';
import { resolveActionTimings } from '../src/timeline/timing';
import { solveTimeline } from '../src/timeline/solver';
import { flattenTimeline } from '../src/timeline/flattener';
import { sampleEnvironmentSubject, resolveEnvironmentSubject } from '../src/environment/sampler';
import { parseCameraTrajectory, sampleCameraTrajectoryAt, environmentTimeAtPlayback } from '../web/src/trajectory-loader';
import type { EnvironmentV1 } from '../src/types/environment';
import type { ResolvedCameraDirectionDSL } from '../src/types/dsl';

const root = path.resolve(__dirname, '..');
const out = path.join(root, 'examples/cinematic-suite');
const load = (name:string) => JSON.parse(fs.readFileSync(name,'utf8'));
const dataset = load(path.join(out,'dataset.json'));
const environments = new Map<string,EnvironmentV1>();
for (const id of ['stadium','factory']) environments.set(id,load(path.join(root,`web/public/environments/${id}.json`)));
const results:unknown[]=[];
for (const example of dataset.examples) {
  const env = environments.get(example.environmentId)!;
  assert.ok(env, `Unknown environment: ${example.environmentId}`);
  const csl = load(path.join(out,example.files.csl)) as ResolvedCameraDirectionDSL;
  assertResolvedCameraDirection(csl);
  const allTargets = new Set<string>();
  function walk(value:unknown):void {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (!value || typeof value!=='object') return;
    const o=value as Record<string,unknown>;
    if(typeof o.id==='string'&&typeof o.description==='string') {resolveEnvironmentSubject(env,o.id);allTargets.add(o.id);}
    Object.values(o).forEach(walk);
  }
  walk(csl);
  const timed=resolveActionTimings(csl.sections,csl.totalDuration,env);
  assert.ok(timed.every(a=>a.startTime!==undefined&&a.endTime!==undefined&&a.startTime>=0&&a.endTime<=48+1e-8));
  const timeline=flattenTimeline(solveTimeline(csl,env));
  assert.equal((timeline.cutTimes??[]).length,0);
  const tr=load(path.join(out,example.files.trajectory));
  const parsed=parseCameraTrajectory(tr,{environment:env,environmentIdMismatch:'error',timeCoverage:'error'});
  assert.equal(parsed.warnings.length,0);
  assert.equal(parsed.trajectory.samples.length,1441);
  let sampleChecks=0;
  for(let i=0;i<=48*60;i++){
    const t=i/60, s=sampleCameraTrajectoryAt(parsed.trajectory,t);
    assert.ok(s.position.every(Number.isFinite));
    assert.ok(s.rotation?.every(Number.isFinite));
    assert.ok(Math.abs(environmentTimeAtPlayback(parsed.trajectory,t)-t)<1e-8);
    sampleChecks++;
  }
  // Export source-sampler control points for independent cross-language agreement.
  const subjectChecks=[...allTargets].map(id=>({id,samples:[0,2,13.7,20,21.7,38,39.8,48].map(t=>({t,center:sampleEnvironmentSubject(env,id,t).center}))}));
  fs.writeFileSync(path.join(out,example.id,'timeline.json'),JSON.stringify(timeline,null,2)+'\n');
  results.push({exampleId:example.id,status:'pass',resolvedActions:timed.length,subjects:[...allTargets],timelineSegments:timeline.timeline.length,replayChecks:sampleChecks,subjectChecks});
  console.log('PASS',example.id,`${timed.length} actions, ${sampleChecks} replay probes`);
}
fs.writeFileSync(path.join(out,'runtime-validation.json'),JSON.stringify({runtime:'Project grounding + timeline + browser trajectory loader/sampler',examples:results},null,2)+'\n');
console.log('All 10 examples pass runtime compatibility.');
