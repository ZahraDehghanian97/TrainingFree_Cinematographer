import * as fs from "node:fs";
import * as path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { assertEnvironmentV1 } from "../web/src/environment-loader";
import { assertCameraTrajectoryV1 } from "../web/src/trajectory-loader";
import { sampleEnvironmentSubject } from "../src/environment/sampler";
const root=path.resolve(__dirname,"..");
const read=(file:string):any=>JSON.parse(fs.readFileSync(path.join(root,file),"utf8"));
const hash=(file:string)=>createHash("sha256").update(fs.readFileSync(path.join(root,file))).digest("hex");
const results=["stadium","factory"].map(id=>{
 const raw:unknown=read(`web/public/environments/${id}.json`);assertEnvironmentV1(raw);const env=raw;
 const value:unknown=read(`web/public/trajectories/ai-generated/${id}-camera.json`);assertCameraTrajectoryV1(value);const tr=value;
 assert.equal(tr.environmentId,id);assert.equal(tr.clock.durationSeconds,env.clock.durationSeconds);
 const metadata=read(`web/public/trajectories/reference-metadata/${id}.json`);
 assert.equal(metadata.environmentSha256,hash(`web/public/environments/${id}.json`));assert.equal(metadata.trajectorySha256,hash(`web/public/trajectories/ai-generated/${id}-camera.json`));
 let continuityChecks=0;const boundingBoxWarnings:{time:number;entityId:string}[]=[];
 for(let i=1;i<tr.samples.length;i++){
  const a=tr.samples[i-1]!,b=tr.samples[i]!;
  if(!b.cutBefore){assert.ok(Math.hypot(...a.position.map((v,k)=>v-b.position[k]!))<2.5,`Unmarked camera teleport at ${b.t}`);continuityChecks++;}
  // Conservative point-vs-AABB probe every 0.1s. It is diagnostic, not a detailed mesh test.
  if(i%3===0)for(const entity of env.entities){
   if(!entity.bounds)continue;
   const box=sampleEnvironmentSubject(env,entity.id,b.t).box;
   if(box&&b.position.every((v,k)=>v>box.min[k]!+.02&&v<box.max[k]!-.02))boundingBoxWarnings.push({time:b.t,entityId:entity.id});
  }
 }
 const result={environmentId:id,samples:tr.samples.length,cuts:tr.samples.filter(p=>p.cutBefore).map(p=>p.t),continuityChecks,contractFailures:0,boundingBoxWarnings};console.log(`${id}: contracts pass; ${boundingBoxWarnings.length} conservative AABB warnings`);return result;
});
fs.writeFileSync(path.join(root,"docs/reference-audit.json"),JSON.stringify({schemaVersion:"1.0",method:"Identity, schema, byte hashes, sample continuity and 10 Hz point/AABB probes",results,
 limitations:["Authored storyboard references, not optimized results or measured ground truth.","AABB warnings are conservative diagnostics; zero warnings do not prove visibility, limb clearance, composition or cinematic quality.","WebGL review and the live LLM pipeline are separate checks."]},null,2)+"\n");
