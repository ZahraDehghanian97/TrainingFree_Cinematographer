import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { auditEnvironmentLayout, type LayoutReceipt } from '../src/environment/layout-audit';
import { assertEnvironmentV1 } from '../web/src/environment-loader';
import { visibleInArchitectureOverview } from '../web/src/architecture-visibility';
import type { EnvironmentV1, Vec3 } from '../src/types/environment';
const root=path.resolve(__dirname,'..');
const read=(file:string)=>JSON.parse(fs.readFileSync(path.join(root,file),'utf8'));
const receipts:LayoutReceipt[]=read('docs/environment-layouts.json').scenes;
function load(n:number):EnvironmentV1 { return read(`web/public/environments/example-${String(n).padStart(2,'0')}.json`); }
for(let n=1;n<=32;n++) test(`environment ${n}: shell, openings, contacts, stairs and static circulation`,()=>{
  const env=load(n); assertEnvironmentV1(env);
  const report=auditEnvironmentLayout(env,receipts[n-1]);
  assert.equal(report.issues.length,0,JSON.stringify(report.issues));
});
test('missing ceiling and disconnected stair are rejected by geometric controls',()=>{
  const ceiling=load(3); ceiling.entities=ceiling.entities.filter(e=>e.id!=='arch-workspace-ceiling');
  assert.ok(auditEnvironmentLayout(ceiling,receipts[2]).issues.some(i=>i.check==='ceiling-exists'));
  const stair=load(19); const flight=stair.entities.find(e=>e.id==='arch-main-stair-landing')!;
  (flight.transform.position as Vec3)[2]+=1;
  assert.ok(auditEnvironmentLayout(stair,receipts[18]).issues.some(i=>i.check==='landing-connectivity'));
});
test('roof gaps, missing treads, and floating furniture are detected',()=>{
  const roof=load(14); (roof.entities.find(e=>e.id==='arch-living-ceiling')!.transform.position as Vec3)[1]+=.2;
  assert.ok(auditEnvironmentLayout(roof,receipts[13]).issues.some(i=>i.check==='ceiling-contact'));
  const stair=load(22); stair.entities=stair.entities.filter(e=>e.id!=='set-mezzanine-access-tread-02');
  assert.ok(auditEnvironmentLayout(stair,receipts[21]).issues.some(i=>i.check==='tread-exists'));
  const chair=load(3); (chair.entities.find(e=>e.id==='set-desk-chair')!.transform.position as Vec3)[1]+=.12;
  assert.ok(auditEnvironmentLayout(chair,receipts[2]).issues.some(i=>i.check==='furniture-ground-contact'));
});
test('a wall filling an authored opening and missing wall strips fail coverage',()=>{
  const env=load(3); const ids=receipts[2].rooms[0].walls.south;
  const wall=env.entities.find(e=>e.id===ids[0])!;
  assert.equal(wall.bounds!.type,'box');
  if(wall.bounds?.type==='box')wall.bounds.max[0]+=1.8;
  assert.ok(auditEnvironmentLayout(env,receipts[2]).issues.some(i=>i.check==='unblocked-opening'));
  const missing=load(3);missing.entities=missing.entities.filter(e=>e.id!==ids[0]);
  assert.ok(auditEnvironmentLayout(missing,receipts[2]).issues.some(i=>i.check==='wall-coverage'));
});
test('support references must exist and cannot form a cycle',()=>{
  const env=load(3); const a=env.entities[0],b=env.entities[1];
  a.layout!.support='missing-floor';assert.throws(()=>assertEnvironmentV1(env),/missing entity/);
  a.layout!.support=b.id;b.layout!.support=a.id;assert.throws(()=>assertEnvironmentV1(env),/cyclic support/);
});
test('architectural cutaway never removes walls or ceilings in Director POV',()=>{
  for(const env of [load(3),load(19),load(21),load(22)])for(const e of env.entities){
    assert.equal(visibleInArchitectureOverview(e,[30,30,30],[0,0,0],true,true),true);
    assert.equal(visibleInArchitectureOverview(e,[30,30,30],[0,0,0],false,false),true);
    if(e.layout?.cutaway==='roof')assert.equal(visibleInArchitectureOverview(e,[30,30,30],[0,0,0],true,false),false);
    if(e.layout?.cutaway==='wall') {
      const n=e.layout.outwardNormal!;
      assert.equal(visibleInArchitectureOverview(e,n.map(x=>x*10) as Vec3,[0,0,0],true,false),false);
      assert.equal(visibleInArchitectureOverview(e,n.map(x=>-x*10) as Vec3,[0,0,0],true,false),true);
    }
  }
});
test('animated corridor door pivots at a fixed hinge and has a real wall opening',()=>{
  for(const n of [11,13]){
    const env=load(n);const door=env.entities.find(e=>e.layout?.role==='door')!;
    assert.equal(door.visual.type,'preset');
    if(door.visual.type==='preset')assert.equal(door.visual.params?.hingeOrigin,true);
    assert.ok(Array.isArray(door.transform.position));
    assert.ok(receipts[n-1].openings.some(o=>o.id==='destination-opening'));
    if(door.bounds?.type==='box')assert.equal(door.bounds.min[0],0);
  }
});
test('finite roof has an access stair, physical slab aperture and building below',()=>{
  const env=load(21);assert.equal(env.world?.ground?.render,false);
  assert.equal(env.world?.ground?.continuation,'none');
  assert.ok(receipts[20].stairs.some(s=>s.start[1]===-3.06&&s.end[1]===0));
  const slabs=env.entities.filter(e=>e.id.startsWith('arch-roof-slab-'));
  assert.equal(slabs.length,4);
  assert.ok(env.entities.some(e=>e.id==='arch-building-slab'));
});
test('floor-lamp emitter is attached near the shade, not below the floor',()=>{
  for(const n of [14,18])assert.ok(load(n).entities.find(e=>e.id==='set-reading-lamp')!.layout!.light!.offset![1]>1.4);
});
