import * as fs from 'node:fs';
import * as path from 'node:path';
import { fingerprint, sourceFingerprints } from '../src/reference/provenance';
import { resolvedPromptExampleFixtures } from '../src/data/resolved-example-fixtures';
import { cinematicTitles } from '../src/data/cinematic-improvements';
import { referenceStoryboard } from '../src/reference/storyboards';
import { generateReference } from '../src/reference/generator';
import { assertEnvironmentV1 } from '../web/src/environment-loader';
import { assertCameraTrajectoryV1 } from '../web/src/trajectory-loader';

const root=path.resolve(__dirname,'..');
function write(file:string,value:unknown):void { fs.mkdirSync(path.dirname(file),{recursive:true}); fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n'); }
function main():void {
 const manifestPath=path.join(root,'web/public/environments/manifest.json');
 const manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
 const rows=[];
 for(const [index,fixture] of resolvedPromptExampleFixtures.entries()){
  const envPath=path.join(root,'web/public/environments',fixture.id+'.json');
  const env:unknown=JSON.parse(fs.readFileSync(envPath,'utf8')); assertEnvironmentV1(env);
  env.prompt=fixture.prompt; write(envPath,env);
  const plan=referenceStoryboard(index+1,env);
  const result=generateReference(fixture,env,plan); assertCameraTrajectoryV1(result.trajectory);
  const publicUrl=`/trajectories/ai-generated/${fixture.id}-camera.json`;
  write(path.join(root,'web/public',publicUrl),result.trajectory);
  write(path.join(root,'shared/trajectories/ai_generated',`${fixture.environmentId}_trajectory.json`),result.trajectory);
  const entry=manifest.environments.find((e:{id:string})=>e.id===env.id);
  if(!entry)throw new Error(`Missing catalog entry ${env.id}`);
  entry.prompt=fixture.prompt; entry.title=cinematicTitles[index]??entry.title;
  entry.sampleTrajectoryUrl=publicUrl; entry.referenceTrajectoryUrl=publicUrl;
  const optimizedMeta=path.join(root,`web/public/trajectories/optimized/${fixture.id}-provenance.json`);
  const prior=fs.existsSync(optimizedMeta)?JSON.parse(fs.readFileSync(optimizedMeta,'utf8')):{};
  entry.optimizedTrajectoryStale=Object.entries(sourceFingerprints(fixture,env)).some(([k,v])=>prior[k]!==v);
  entry.referenceMetadataUrl=`/trajectories/reference-metadata/${fixture.id}.json`;
  const metadata={schemaVersion:'1.0',kind:'authoredCameraReference',exampleId:fixture.id,environmentId:env.id,
   provenance:{method:'assistant-authored analytical storyboard',optimizerDerived:false,llmInferenceRun:false,measuredGroundTruth:false},
   prompt:fixture.prompt,promptSha256:fingerprint(fixture.prompt),environmentSha256:fingerprint(env),cslSha256:fingerprint(fixture.resolvedCsl),recipeSha256:fingerprint(plan),trajectorySha256:fingerprint(result.trajectory),
   fullPoseIsGroundTruth:false,artisticChoices:plan.artisticChoices,limitations:plan.limitations??[],
   plan,actions:result.actions.map(a=>({id:a.id,act:a.movement.act,start:a.startTime,end:a.endTime,targets:a.movement.targets?.map(t=>t.id)??[]})),
   cutTimes:result.timeline.cutTimes??[],rateSegments:result.trajectory.playback?.rateSegments??[],sampleCount:result.trajectory.samples.length};
  write(path.join(root,'web/public',entry.referenceMetadataUrl),metadata);
  write(path.join(root,'shared/timeline',`output_${index+1}.json`),{schemaVersion:'1.0',kind:'timelineSolverOutput',exampleId:fixture.id,environmentId:env.id,prompt:fixture.prompt,totalDuration:fixture.resolvedCsl.totalDuration,subjectBinding:{mode:'resolved',source:'resolved-fixture'},timeline:result.timeline});
  rows.push({exampleId:fixture.id,environmentId:env.id,entities:env.entities.length,sampleCount:result.trajectory.samples.length,referenceTrajectoryUrl:publicUrl,referenceMetadataUrl:entry.referenceMetadataUrl});
  console.log(`${fixture.id}: ${env.entities.length} entities, ${result.trajectory.samples.length} camera samples`);
 }
 write(manifestPath,manifest);
 write(path.join(root,'docs/reference-inventory.json'),{schemaVersion:'1.0',note:'Synthetic authored references; no external AI model was called. Former optimized outputs must be regenerated against the updated scenes.',examples:rows});
}
if(require.main===module)main();
