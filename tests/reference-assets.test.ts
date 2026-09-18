import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
const root=path.resolve(__dirname,'../web/public');
const manifest=JSON.parse(fs.readFileSync(path.join(root,'models/generated/manifest.json'),'utf8'));
for(const asset of manifest.assets)test(`GLB ${asset.id}: buffers, triangles, normals, bounds and checksum`,()=>{
 const data=fs.readFileSync(path.join(root,asset.url));assert.equal(createHash('sha256').update(data).digest('hex'),asset.sha256);
 assert.equal(data.readUInt32LE(0),0x46546c67);assert.equal(data.readUInt32LE(4),2);assert.equal(data.readUInt32LE(8),data.length);
 const jsonLength=data.readUInt32LE(12),doc=JSON.parse(data.subarray(20,20+jsonLength).toString('utf8'));
 const start=20+jsonLength,bin=data.subarray(start+8);assert.equal(data.readUInt32LE(start+4),0x004e4942);assert.equal(doc.asset.version,'2.0');
 for(const v of doc.bufferViews)assert.ok((v.byteOffset??0)+v.byteLength<=bin.length);
 const accessor=(id:number)=>{const a=doc.accessors[id],v=doc.bufferViews[a.bufferView],offset=(v.byteOffset??0)+(a.byteOffset??0),stride=a.type==='VEC3'?3:1;return Array.from({length:a.count},(_,i)=>Array.from({length:stride},(_,k)=>a.componentType===5126?bin.readFloatLE(offset+(i*stride+k)*4):bin.readUInt32LE(offset+(i*stride+k)*4)));};
 for(const mesh of doc.meshes)for(const p of mesh.primitives){
  const v=accessor(p.attributes.POSITION),n=accessor(p.attributes.NORMAL),ix=accessor(p.indices).flat();assert.equal(ix.length%3,0);assert.equal(v.length,n.length);
  for(const point of v)point.forEach((x,i)=>{assert.ok(Number.isFinite(x));assert.ok(x>=asset.bounds.min[i]-1e-5&&x<=asset.bounds.max[i]+1e-5);});
  n.forEach((normal:number[])=>assert.ok(Math.abs(Math.hypot(...normal)-1)<1e-5));
  ix.forEach(i=>assert.ok(i>=0&&i<v.length));
  for(let i=0;i<ix.length;i+=3){const a=v[ix[i]!]!,b=v[ix[i+1]!]!,c=v[ix[i+2]!]!,u=b.map((x,k)=>x-a[k]!),w=c.map((x,k)=>x-a[k]!);const cross=[u[1]!*w[2]!-u[2]!*w[1]!,u[2]!*w[0]!-u[0]!*w[2]!,u[0]!*w[1]!-u[1]!*w[0]!];const normal=n[ix[i]!]!;assert.ok(cross.reduce((s,x,k)=>s+x*normal[k]!,0)>=-1e-6,'triangle winding opposes vertex normal');}
 }
});
test('all 32 scenes have unique IDs and locally available model dependencies',()=>{
 for(let n=1;n<=32;n++){
  const env=JSON.parse(fs.readFileSync(path.join(root,`environments/example-${String(n).padStart(2,'0')}.json`),'utf8'));
  const ids=env.entities.map((e:any)=>e.id);assert.equal(new Set(ids).size,ids.length);assert.ok(ids.length>=11);
  const semantic=env.semanticAnchors.map((a:any)=>a.id);assert.equal(new Set([...ids,...semantic]).size,ids.length+semantic.length);
  for(const entity of env.entities)if(entity.visual.type==='model')assert.ok(fs.existsSync(path.join(root,entity.visual.url)),entity.visual.url);
  env.semanticAnchors.forEach((a:any)=>assert.ok(ids.includes(a.entityId),a.id));
 }
});
