import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolvedPromptExampleFixtures as fixtures } from '../src/data/resolved-example-fixtures';
import { dontCarePromptExampleFixtures } from '../src/data/dont-care-examples';
import { generateReference, referenceSceneTime } from '../src/reference/generator';
import { referenceStoryboard } from '../src/reference/storyboards';
import { referenceMotionProgress } from '../src/reference/pacing';
import { fingerprint, assertFreshReference } from '../src/reference/provenance';
import { referenceSoftKeyframes } from '../src/reference/supervision';
import { auditTrajectory, sampleReferenceTrajectory, rayIntersectsBox } from '../src/reference/audit';
import { sampleEnvironmentSubject, distanceBetweenAabbs } from '../src/environment/sampler';
import { assertEnvironmentV1 } from '../web/src/environment-loader';
import { assertCameraTrajectoryV1 } from '../web/src/trajectory-loader';
import { automaticTrajectorySources } from '../web/src/trajectory-source';
import { SpeedFunction } from '../src/types/enums';
import type { EnvironmentV1 } from '../src/types/environment';
import type { CameraTrajectoryV1 } from '../src/types/trajectory';
const root=path.resolve(__dirname,'..');const read=(file:string)=>JSON.parse(fs.readFileSync(path.join(root,file),'utf8'));
function load(n:number){const f=fixtures[n-1]!;const env=read(`web/public/environments/${f.id}.json`) as EnvironmentV1;const tr=read(`web/public/trajectories/ai-generated/${f.id}-camera.json`) as CameraTrajectoryV1;const metadata=read(`web/public/trajectories/reference-metadata/${f.id}.json`);return {f,env,tr,metadata};}
for(let n=1;n<=32;n++)test(`reference ${n}: synchronized, deterministic, semantically audited`,()=>{
  const {f,env,tr,metadata}=load(n);assertEnvironmentV1(env);assertCameraTrajectoryV1(tr);
  assert.equal(env.prompt,f.prompt);assertFreshReference(metadata,f,env,tr);
  const generated=generateReference(f,env,referenceStoryboard(n,env));assert.deepEqual(generated.trajectory,tr);
  const report=auditTrajectory(f,env,tr);assert.equal(report.qualification,'sampled-checks-pass',JSON.stringify(report.checks.filter(c=>c.status!=='pass')));
  assert.deepEqual(read(`shared/trajectories/ai_generated/${env.id}_trajectory.json`),tr);
});
test('all nine omission/ablation fixtures stay exactly unchanged',()=>assert.deepEqual(fixtures.slice(23),dontCarePromptExampleFixtures));
test('integrated scene clock freezes, resumes and clamps',()=>{
 const bands=[{startTime:2,endTime:4,rate:0}];assert.equal(referenceSceneTime(1,bands,5),1);assert.equal(referenceSceneTime(3,bands,5),2);assert.equal(referenceSceneTime(5,bands,5),3);assert.equal(referenceSceneTime(20,bands,5),5);
});
test('piecewise speed integration has analytic, scale-invariant progress',()=>{
 const keys=[{normalizedTime:0,speedMultiplier:0},{normalizedTime:1,speedMultiplier:2}];assert.equal(referenceMotionProgress(.5,keys),.25);
 assert.equal(referenceMotionProgress(.5,[keys[0]!,{...keys[1]!,easing:SpeedFunction.Increase}]),.125);
 assert.equal(referenceMotionProgress(.5,keys.map(k=>({...k,speedMultiplier:k.speedMultiplier*1e200}))),.25);
 assert.throws(()=>referenceMotionProgress(.5,[{normalizedTime:0,speedMultiplier:0}]));
});
test('football trigger is tied to the bounds-surface crossing',()=>{
 const {f,env}=load(1),result=generateReference(f,env,referenceStoryboard(1,env));const t=result.actions.find(a=>a.id==='pedestal_up')!.startTime!;
 const gap=(time:number)=>distanceBetweenAabbs(sampleEnvironmentSubject(env,'ball',time).box!,sampleEnvironmentSubject(env,'goal',time).box!);
 assert.ok(gap(t)<=5);assert.ok(gap(t-.05)>5);
});
test('only the rendezvous and two-person ablation contain cuts',()=>{
 const cutExamples=fixtures.filter((_,i)=>load(i+1).tr.samples.some(s=>s.cutBefore)).map(f=>f.id);assert.deepEqual(cutExamples,['example-09','example-31']);
 const {tr}=load(31),a=sampleReferenceTrajectory(tr,4-1e-7),b=sampleReferenceTrajectory(tr,4);assert.ok(Math.hypot(...a.position.map((x,i)=>x-b.position[i]!))>1);
});
test('negative controls detect wrong radius, optical zoom and scene timing',()=>{
 {const {f,env,tr}=load(25);tr.samples.forEach(s=>s.position[0]+=3);assert.ok(auditTrajectory(f,env,tr).checks.some(c=>c.name==='arc-radius-metres'&&c.status==='fail'));}
 {const {f,env,tr}=load(32);tr.samples.forEach(s=>s.fovYDegrees=70);assert.ok(auditTrajectory(f,env,tr).checks.some(c=>c.name==='optical-focal-multiplier'&&c.status==='fail'));}
 {const {f,env,tr}=load(6);delete tr.playback;assert.ok(auditTrajectory(f,env,tr).checks.some(c=>c.name==='scene-rate-bands'&&c.status==='fail'));}
});
test('stale prompt, scene, recipe and trajectory fingerprints reject',()=>{
 const {f,env,tr,metadata}=load(1);assert.equal(fingerprint({a:1,b:2}),fingerprint({b:2,a:1}));
 assert.throws(()=>assertFreshReference(metadata,{...f,prompt:f.prompt+' changed'},env,tr),/Stale/);
 const changed=structuredClone(env);changed.entities[0]!.label='modified';assert.throws(()=>assertFreshReference(metadata,f,changed,tr),/Stale/);
 const edited=structuredClone(tr);edited.samples[0]!.position[0]+=1;assert.throws(()=>assertFreshReference(metadata,f,env,edited),/Stale/);
 assert.throws(()=>assertFreshReference({...metadata,plan:{}},f,env,tr),/Stale/);
});
test('soft supervision requires explicit channels and never adds unspecified channels',()=>{
 const {f,env,tr,metadata}=load(25);
 const keys=referenceSoftKeyframes(f,env,tr,metadata,{times:[10,0,10],channels:['position'],weight:.2});assert.equal(keys.length,2);
 keys.forEach(k=>{assert.equal(k.mode,'soft');assert.ok(k.position);assert.equal(k.rotation,undefined);assert.equal(k.fovYDegrees,undefined);});
 assert.throws(()=>referenceSoftKeyframes(f,env,tr,metadata,{times:[0],channels:[],weight:1}));
 assert.throws(()=>referenceSoftKeyframes(f,env,tr,metadata,{times:[-1],channels:['rotation'],weight:1}));
});
test('invalid rigs and mismatched cuts are rejected',()=>{
 const {f,env}=load(1),plan=referenceStoryboard(1,env);
 assert.throws(()=>generateReference(f,env,plan,0));assert.throws(()=>generateReference(f,{...env,id:'wrong'},plan));
 const bad=structuredClone(plan);bad.knots[1]!.cutBefore=true;assert.throws(()=>generateReference(f,env,bad),/cuts/);
 const missing=structuredClone(plan);missing.knots[0]!.rig={ids:['invented-subject']};assert.throws(()=>generateReference(f,env,missing),/Unknown/);
});
test('reference playback wins, explicit URLs override, stale optimized fallback is blocked',()=>{
 const entry={promptExampleId:'example-01',sampleTrajectoryUrl:'/ref.json',referenceTrajectoryUrl:'/ref.json',optimizedTrajectoryStale:true};
 assert.deepEqual(automaticTrajectorySources(entry).map(s=>s.kind),['reference']);
 assert.deepEqual(automaticTrajectorySources(entry,'/live.json').map(s=>s.kind),['requested','reference']);
 assert.equal(automaticTrajectorySources({...entry,optimizedTrajectoryStale:false})[1]!.kind,'optimized');
});
test('independent slab ray test handles misses and parallel rays',()=>{
 assert.equal(rayIntersectsBox([0,0,4],[0,0,-4],[-1,-1,-1],[1,1,1]),true);
 assert.equal(rayIntersectsBox([2,0,4],[2,0,-4],[-1,-1,-1],[1,1,1]),false);
});

test('stage speed matches the half-speed opening in the prompt',()=>{
  const {tr}=load(15),rates=tr.playback!.rateSegments;
  assert.equal(referenceSceneTime(4,rates,10),2);
  assert.equal(referenceSceneTime(10,rates,10),8);
});
test('the warehouse crane explicitly reveals the named mezzanine',()=>{
  const {f}=load(22);const action=f.resolvedCsl.sections[0]!.actions.find(a=>a.id==='climb_mezzanine')!;
  assert.ok(action.constraints!.some(c=>c.targets?.some(t=>t.id==='set-mezzanine')));
});

test('virtual interior permission is scoped to the cabin and exit, not the orbit',()=>{
 const actions=load(12).f.resolvedCsl.sections.flatMap(s=>s.actions);
 assert.deepEqual(actions.filter(a=>a.movement.parameters?.allowSubjectIntersection).map(a=>a.id),['dashboard_static','exit_through_windshield']);
});
