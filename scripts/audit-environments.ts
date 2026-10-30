import * as fs from "node:fs";
import * as path from "node:path";
import assert from "node:assert/strict";
import { assertEnvironmentV1, sampleEntityTransform } from "../web/src/environment-loader";
import { sampleEnvironmentEntityTransform } from "../src/environment/sampler";
const root=path.resolve(__dirname,"..");
const read=(p:string):any=>JSON.parse(fs.readFileSync(path.join(root,p),"utf8"));
const entries=read("web/public/environments/manifest.json").environments;
assert.deepEqual(entries.map((e:any)=>e.id).sort(),["factory","stadium"]);
assert.deepEqual(fs.readdirSync(path.join(root,"web/public/environments")).sort(),["factory.json","manifest.json","stadium.json"]);
const results=entries.map((entry:any)=>{
 const raw:unknown=read(`web/public/environments/${entry.id}.json`);assertEnvironmentV1(raw);const env=raw;
 let samples=0;
 for(let t=0;t<=env.clock.durationSeconds;t+=.25)for(const entity of env.entities){
  const a=sampleEnvironmentEntityTransform(entity,t),b=sampleEntityTransform(entity,t);
  for(const channel of ["position","rotation","scale"] as const)a[channel].forEach((value,i)=>{
   assert.ok(Number.isFinite(value));assert.ok(Math.abs(value-b[channel][i]!)<1e-6);
  });samples++;
 }
 const count=(role:string)=>env.entities.filter(e=>e.visual.type==="preset"&&e.visual.name==="humanoid"&&e.visual.params?.role===role).length;
 if(env.id==="stadium"){assert.equal(count("runner"),6);assert.equal(count("football"),24);assert.equal(count("spectator"),72);assert.equal(count("cameraman"),1);}
 else assert.equal(count("worker"),8);
 const result={environmentId:env.id,entities:env.entities.length,semanticAnchors:env.semanticAnchors.length,events:env.events?.length??0,transformSamples:samples,issues:0};
 console.log(JSON.stringify(result));return result;
});
const report={schemaVersion:"1.0",method:"Schema, two-world allowlist, cast counts, finite transforms and browser/optimizer parity sampled at 4 Hz",results,
 limitations:["Not a WebGL render, a frame-rate benchmark or continuous collision proof.","Pose overlays and root motion are staged animation, not rigid-body physics.","Detailed behavioral acceptance tests run separately with npm run test:scenarios."]};
fs.mkdirSync(path.join(root,"docs"),{recursive:true});fs.writeFileSync(path.join(root,"docs/environment-audit.json"),JSON.stringify(report,null,2)+"\n");
