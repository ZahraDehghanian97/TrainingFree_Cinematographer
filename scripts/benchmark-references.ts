import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { resolvedPromptExampleFixtures } from '../src/data/resolved-example-fixtures';
import { auditTrajectory, sampleReferenceTrajectory } from '../src/reference/audit';
import { sourceFingerprints, fingerprint } from '../src/reference/provenance';
import { optimizeCameraTrajectory } from '../src/optimizer';
import { flattenTimeline } from '../src/timeline/flattener';
import { solveTimeline } from '../src/timeline/solver';
import { assertEnvironmentV1 } from '../web/src/environment-loader';
import { assertCameraTrajectoryV1 } from '../web/src/trajectory-loader';
import type { CameraTrajectoryV1 } from '../src/types/trajectory';
const args=process.argv.slice(2);let examples=resolvedPromptExampleFixtures.map((_,i)=>i+1),optimize=false,allowStale=false,iterations=20,optimizationFps=3,output='docs/reference-benchmark.json';
for(let i=0;i<args.length;i++){
  const arg=args[i];if(arg==='--optimize'){optimize=true;continue;}if(arg==='--allow-stale'){allowStale=true;continue;}
  const value=args[++i];if(value===undefined)throw new Error(`Missing value for ${arg}`);
  if(arg==='--examples')examples=value.split(',').map(Number);
  else if(arg==='--iterations')iterations=Number(value);
  else if(arg==='--optimization-fps')optimizationFps=Number(value);
  else if(arg==='--output')output=value;else throw new Error(`Unknown option ${arg}`);
}
if(examples.some(n=>!Number.isInteger(n)||n<1||n>resolvedPromptExampleFixtures.length)||!Number.isInteger(iterations)||iterations<0||!Number.isFinite(optimizationFps)||optimizationFps<=0)throw new Error('Invalid benchmark options');
const root=path.resolve(__dirname,'..');const read=(file:string)=>JSON.parse(fs.readFileSync(path.join(root,file),'utf8'));
const results:any[]=[];
for(const n of [...new Set(examples)]){
 const f=resolvedPromptExampleFixtures[n-1]!,env:unknown=read(`web/public/environments/${f.environmentId}.json`);assertEnvironmentV1(env);
 const ref:unknown=read(`web/public/trajectories/ai-generated/${f.id}-camera.json`);assertCameraTrajectoryV1(ref);
 const metadata=read(`web/public/trajectories/reference-metadata/${f.environmentId}.json`);
 const fileHash=(file:string)=>createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex');
 if(metadata.environmentSha256!==fileHash(`web/public/environments/${f.environmentId}.json`)||metadata.trajectorySha256!==fileHash(`web/public/trajectories/ai-generated/${f.id}-camera.json`))throw new Error('Reference bytes are stale; run generate:references');
 let candidate:CameraTrajectoryV1,diagnostics:unknown,stale=false;
 if(optimize){
  const result=optimizeCameraTrajectory({environment:env,timeline:flattenTimeline(solveTimeline(f.resolvedCsl,env)),options:{iterations,optimizationFps,outputFps:30}});
  candidate=result.trajectory;diagnostics=result.diagnostics;
 }else{
  const metaPath=`web/public/trajectories/optimized/${f.id}-provenance.json`;
  const saved=fs.existsSync(path.join(root,metaPath))?read(metaPath):{};
  if(!fs.existsSync(path.join(root,`web/public/trajectories/optimized/${f.id}-camera.json`))){results.push({exampleId:f.id,status:'not-generated',reason:'Run generate:trajectories or benchmark:references -- --optimize first.'});continue;}
  const raw:unknown=read(`web/public/trajectories/optimized/${f.id}-camera.json`);assertCameraTrajectoryV1(raw);candidate=raw;
  stale=Object.entries(sourceFingerprints(f,env)).some(([k,v])=>saved[k]!==v)||saved.trajectorySha256!==fingerprint(candidate);
  if(stale&&!allowStale){results.push({exampleId:f.id,status:'stale-rejected',reason:'Optimizer output has no matching source/trajectory fingerprint. Regenerate it, or explicitly use --allow-stale for historical diagnostics.'});console.log(`${f.id}: stale output rejected`);continue;}
 }
 assertCameraTrajectoryV1(candidate);
 const independent=auditTrajectory(f,env,candidate),referenceAudit=auditTrajectory(f,env,ref);
 const probes=Array.from({length:Math.ceil(f.resolvedCsl.totalDuration)+1},(_,i)=>Math.min(i,f.resolvedCsl.totalDuration));
 const poseRmse=Math.sqrt(probes.reduce((sum,t)=>{const a=sampleReferenceTrajectory(candidate,t),b=sampleReferenceTrajectory(ref,t);return sum+a.position.reduce((s,v,i)=>s+(v-b.position[i]!)**2,0);},0)/probes.length);
 results.push({exampleId:f.id,status:stale?'historical-diagnostic':'evaluated',stale,source:sourceFingerprints(f,env),referenceAudit,candidateAudit:independent,diagnostics,positionRmseMetresDiagnosticOnly:poseRmse});
 console.log(`${f.id}: candidate contract=${independent.contractFailures}, composition=${independent.compositionFailures}, geometry=${independent.geometryWarnings}; reference=${referenceAudit.qualification}`);
}
const report={schemaVersion:'1.0',settings:{examples,optimize,allowStale,iterations,optimizationFps},note:'Independent semantic checks are the comparison target. Pose RMSE is diagnostic only: unspecified artistic choices are NOT ground truth. Optimization receives NO reference keyframes. Small iteration budgets are smoke tests, not quality claims.',results};
const destination=path.resolve(root,output);fs.mkdirSync(path.dirname(destination),{recursive:true});fs.writeFileSync(destination,JSON.stringify(report,null,2)+'\n');
if(results.some(r=>r.status==='stale-rejected'))process.exitCode=2;
