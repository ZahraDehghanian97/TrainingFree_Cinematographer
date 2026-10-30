/** Independent, sampled semantic audit. Does not call the optimizer or its loss.
 * Passing these checks is NOT a continuous collision/visibility certificate.
 */
import type { CameraSampleV1, CameraTrajectoryV1 } from '../types/trajectory';
import type { EnvironmentV1, Quat, Vec3 } from '../types/environment';
import type { ResolvedPromptExampleFixture } from '../data/resolved-example-fixtures';
import type { ActionConstraintConfig } from '../types/dsl';
import { sampleEnvironmentSubject, sampleEnvironmentEntityTransform, worldAabbForBounds, resolveEnvironmentSubject } from '../environment/sampler';
import { resolveActionTimings } from '../timeline/timing';
import { flattenTimeline } from '../timeline/flattener';
import { solveTimeline } from '../timeline/solver';
import { referenceSceneTime } from './generator';
import { sub, add, mul, project, rad, deg, qnorm, mix3, rotate } from './math';

export interface AuditCheck {
  name: string; actionId?: string; status: 'pass'|'fail'|'review';
  category: 'contract'|'composition'|'geometry';
  measured?: number; expected?: number; tolerance?: number; detail?: string;
}
export interface ReferenceAudit {
  exampleId: string; checks: AuditCheck[]; contractFailures: number;
  compositionFailures: number; geometryWarnings: number;
  qualification: 'sampled-checks-pass'|'review-required';
  limitations: string[];
}
const translated = new Set(['follow','track','dollyIn','dollyOut','arcLeft','arcRight','orbit','truckLeft','truckRight','pedestalUp','pedestalDown','craneUp','craneDown']);
const arc = new Set(['arcLeft','arcRight','orbit']);
/** Public CSL framing prototypes (not imported from optimizer constants).
 * These are semantic conventions, not calibrated perceptual laws. */
const frame: Record<string,[number,number]>={topLeft:[.25,.25],top:[.5,.25],topRight:[.75,.25],left:[.25,.5],center:[.5,.5],right:[.75,.5],bottomLeft:[.25,.75],bottom:[.5,.75],bottomRight:[.75,.75]};
const sizes: Record<string,number>={extremeCloseUp:.9,closeUp:.7,mediumCloseUp:.56,mediumShot:.43,mediumLongShot:.34,fullShot:.27,longShot:.19,veryLongShot:.12,extremeLongShot:.07};

function slerp(a:Quat,b:Quat,u:number):Quat {
  let cosine=a.reduce((sum,x,i)=>sum+x*b[i]!,0),c=b;
  if(cosine<0){cosine=-cosine;c=b.map(x=>-x) as Quat;}
  if(cosine>.9995)return qnorm(a.map((x,i)=>x+(c[i]!-x)*u) as Quat);
  const angle=Math.acos(Math.min(1,cosine)),s=Math.sin(angle);
  return qnorm(a.map((x,i)=>(x*Math.sin((1-u)*angle)+c[i]!*Math.sin(u*angle))/s) as Quat);
}
/** Reference-independent sample interpolation; cuts are right-continuous. */
export function sampleReferenceTrajectory(trajectory:CameraTrajectoryV1,t:number):CameraSampleV1 {
  const samples=trajectory.samples;
  if(trajectory.orientation.mode!=='quaternion')throw new Error('Audit requires normalized quaternion trajectories');
  let lo=0,hi=samples.length-1;
  while(lo+1<hi){const mid=(lo+hi)>>1;if(samples[mid]!.t<=t)lo=mid;else hi=mid;}
  if(t>=samples[hi]!.t)lo=hi;
  const a=samples[lo]!,b=samples[Math.min(lo+1,samples.length-1)]!;
  const u=b.cutBefore||b.t===a.t?0:Math.max(0,Math.min(1,(t-a.t)/(b.t-a.t)));
  // Optimizer exports can carry exact quintic jets. Evaluate them without
  // importing the optimizer's curve implementation.
  let position=mix3(a.position,b.position,u);
  if(trajectory.interpolation?.position==='quinticHermite' && a.positionVelocity && b.positionVelocity && a.positionAcceleration && b.positionAcceleration && !b.cutBefore){
    const h=b.t-a.t;
    position=[0,1,2].map(i=>{
      const p=a.position[i]!,v=a.positionVelocity![i]!*h,acc=a.positionAcceleration![i]!*h*h;
      const d=b.position[i]!-p,ve=b.positionVelocity![i]!*h,ae=b.positionAcceleration![i]!*h*h;
      const c3=10*d-6*v-4*ve-1.5*acc+.5*ae,c4=-15*d+8*v+7*ve+1.5*acc-ae,c5=6*d-3*v-3*ve-.5*acc+.5*ae;
      return p+v*u+.5*acc*u*u+c3*u**3+c4*u**4+c5*u**5;
    }) as Vec3;
  }
  return {t,position,rotation:slerp(a.rotation!,b.rotation!,u),fovYDegrees:(a.fovYDegrees??trajectory.intrinsics.fovYDegrees)*(1-u)+(b.fovYDegrees??trajectory.intrinsics.fovYDegrees)*u};
}
export function rayIntersectsBox(from:Vec3,to:Vec3,min:Vec3,max:Vec3):boolean {
  const d=sub(to,from);let low=.0001,high=.9999;
  for(let i=0;i<3;i++){
    if(Math.abs(d[i]!)<1e-10){if(from[i]!<min[i]!||from[i]!>max[i]!)return false;continue;}
    const a=(min[i]!-from[i]!)/d[i]!,b=(max[i]!-from[i]!)/d[i]!;
    low=Math.max(low,Math.min(a,b));high=Math.min(high,Math.max(a,b));if(high<low)return false;
  }
  return true;
}
export function auditTrajectory(fixture:ResolvedPromptExampleFixture,env:EnvironmentV1,tr:CameraTrajectoryV1,fps=10):ReferenceAudit {
  if(!Number.isFinite(fps)||fps<1||fps>120)throw new Error('Audit fps must be within 1..120');
  const checks:AuditCheck[]=[];
  const actions=resolveActionTimings(fixture.resolvedCsl.sections,fixture.resolvedCsl.totalDuration,env);
  const tl=flattenTimeline(solveTimeline(fixture.resolvedCsl,env));
  const rates=tr.playback?.rateSegments??[];
  const cutTimes=tr.samples.filter(s=>s.cutBefore).map(s=>s.t);
  const check=(name:string,ok:boolean,extra:Partial<AuditCheck>={})=>checks.push({name,status:ok?'pass':'fail',category:'contract',...extra});
  const near=(name:string,measured:number,expected:number,tolerance:number,actionId?:string,category:AuditCheck['category']='contract')=>check(name,Number.isFinite(measured)&&Math.abs(measured-expected)<=tolerance,{measured,expected,tolerance,actionId,category});
  check('scene-identity',tr.environmentId===env.id&&env.id===fixture.environmentId);
  near('duration',tr.clock.durationSeconds,fixture.resolvedCsl.totalDuration,1e-6);
  check('finite-normalized-camera',tr.samples.every(s=>[s.t,...s.position,...(s.rotation??[]),s.fovYDegrees??tr.intrinsics.fovYDegrees].every(Number.isFinite)&&s.rotation?.length===4&&Math.abs(Math.hypot(...s.rotation)-1)<1e-5));
  check('cuts-match-sections',JSON.stringify(cutTimes)===JSON.stringify(tl.cutTimes??[]));
  check('scene-rate-bands',JSON.stringify(rates.map(s=>[s.startTime,s.endTime,s.rate]))===JSON.stringify(tl.timeWarp.map(s=>[s.startTimePlayback,s.endTimePlayback,s.rate])));
  check('optimizer-lens-range',tr.samples.every(s=>(s.fovYDegrees??tr.intrinsics.fovYDegrees)>=8-1e-6&&(s.fovYDegrees??tr.intrinsics.fovYDegrees)<=120+1e-6));
  const scene=(t:number)=>referenceSceneTime(t,rates,env.clock.durationSeconds);
  const subject=(id:string,t:number)=>sampleEnvironmentSubject(env,id,scene(t));
  const center=(ids:string[],t:number):Vec3=>ids.length?mul(ids.map(id=>subject(id,t).center).reduce(add),1/ids.length):[0,0,0];
  const camera=(t:number)=>sampleReferenceTrajectory(tr,t);
  const beforeCut=(t:number)=>cutTimes.some(c=>Math.abs(c-t)<1e-8)?Math.max(0,t-1e-6):t;
  const times=(start:number,end:number,all=true)=>all?[...new Set([start,...Array.from({length:Math.ceil((end-start)*fps)},(_,i)=>start+i/fps).filter(t=>t<end),beforeCut(end)])]:[beforeCut(end)];
  const projectAt=(id:string,t:number)=>{const c=camera(t);return project(subject(id,t).center,c.position,c.rotation!,c.fovYDegrees!,tr.intrinsics.aspectRatio??16/9);};
  const cornersAt=(ids:string[],t:number)=>ids.flatMap(id=>{
    const s=subject(id,t),box=s.box,c=camera(t);
    const points:Vec3[]=[];
    if(box)for(const x of [box.min[0],box.max[0]])for(const y of [box.min[1],box.max[1]])for(const z of [box.min[2],box.max[2]])points.push([x,y,z]);
    else points.push(s.center);
    return points.map(p=>project(p,c.position,c.rotation!,c.fovYDegrees!,tr.intrinsics.aspectRatio??16/9));
  });
  const composition=(config:ActionConstraintConfig,at:number[],actionId:string,fallbackIds:string[])=>{
    const ids=config.targets?.map(t=>t.id)??fallbackIds;if(!ids.length)return;
    if(config.kind==='general'){
      if(config.constraint==='keepInFrame'){
        const violation=Math.max(...at.map(t=>Math.max(...cornersAt(ids,t).map(p=>p.depth<=0?1:Math.max(-p.x,p.x-1,-p.y,p.y-1,0)))));
        near('keep-in-frame',violation,0,.015,actionId,'composition');
      }
      if(config.constraint==='avoidOcclusion'){
        const blocked=new Set<string>();let count=0;
        for(const t of at)for(const id of ids){
          const s=subject(id,t),p=camera(t).position;let hit=false;
          for(const entity of env.entities){
            if(entity.id===s.entityId||entity.occlusion?.transparent||!entity.bounds)continue;
            const transform=sampleEnvironmentEntityTransform(entity,scene(t));
            for(const bounds of entity.occlusion?.bounds??[entity.bounds]){
              const box=worldAabbForBounds(bounds,transform);
              if(rayIntersectsBox(p,s.center,box.min,box.max)){blocked.add(entity.id);hit=true;break;}
            }
          }
          if(hit)count++;
        }
        check('requested-line-of-sight',count===0,{category:'geometry',status:count?'review':'pass',measured:count/(at.length*ids.length),expected:0,actionId,detail:blocked.size?'Conservative centre-ray blockers: '+[...blocked].join(', '):'Centre rays clear at audit samples; mesh occlusion not certified.'});
      }
      return;
    }
    if(config.config.type!=='subjectAware')return;
    const cfg=config.config;
    if(cfg.subjectFraming?.position){
      const desired=frame[cfg.subjectFraming.position]!;
      const error=Math.max(...at.map(t=>{const c=camera(t),p=project(center(ids,t),c.position,c.rotation!,c.fovYDegrees!,tr.intrinsics.aspectRatio??16/9);return Math.max(Math.abs(p.x-desired[0]),Math.abs(p.y-desired[1]),p.depth<=0?1:0);}));
      near('screen-composition:'+cfg.subjectFraming.position,error,0,.10,actionId,'composition');
    }
    if(cfg.shotSize){
      const expected=sizes[cfg.shotSize]!;
      const heights=at.map(t=>{const p=cornersAt(ids,t);return p.some(x=>x.depth<=0)?10:Math.max(...p.map(x=>x.y))-Math.min(...p.map(x=>x.y));});
      const error=Math.max(...heights.map(h=>Math.abs(h-expected)));
      check('shot-size:'+cfg.shotSize,error<=.18,{category:'composition',actionId,measured:error,expected:0,tolerance:.18,detail:`Requested coverage prototype ${expected}; observed height ${Math.min(...heights).toFixed(3)}–${Math.max(...heights).toFixed(3)}. AABB approximation.`});
    }
    if(cfg.cameraAngle){
      const elevations=at.map(t=>{const d=sub(camera(t).position,center(ids,t));return deg(Math.atan2(d[1],Math.hypot(d[0],d[2])));});
      const ranges:Record<string,[number,number]>={wormsEye:[-90,-20],low:[-45,-3],eye:[-12,12],high:[12,45],overhead:[30,60],birdsEye:[45,82],topDown:[80,90]};
      const [lo,hi]=ranges[cfg.cameraAngle]!;
      check('vertical-angle:'+cfg.cameraAngle,elevations.every(e=>e>=lo&&e<=hi),{category:'composition',actionId,detail:`Elevation ${Math.min(...elevations).toFixed(2)}–${Math.max(...elevations).toFixed(2)} degrees; expected ${lo}..${hi}.`});
    }
  };
  for(const [index,section] of fixture.resolvedCsl.sections.entries()){
    if(section.initCamera){const first=actions.find(a=>a.id===section.actions[0]?.id);const t=first?.startTime??0;
      composition({targets:section.initCamera.targets,config:section.initCamera.config,allFrames:false},[t],`section-${index+1}-init`,[]);
      const cfg=section.initCamera.config;
      if(cfg.type==='nonSubjectAware'){
        const p=cfg.extrinsics?.pose?.position;if(p)near('initial-position',Math.hypot(...sub(camera(t).position,[p.x,p.y,p.z])),0,.001,'init');
        const r=cfg.extrinsics?.pose?.rotation;if(r&&'w'in r){const q=camera(t).rotation!;near('initial-rotation',1-Math.abs(q[0]*r.x+q[1]*r.y+q[2]*r.z+q[3]*r.w),0,1e-5,'init');}
        if(cfg.intrinsics?.fov!==undefined)near('initial-fov',camera(t).fovYDegrees!,cfg.intrinsics.fov,.001,'init');
      }
    }
  }
  for(const a of actions){
    const start=a.startTime!,end=a.endTime!,at=times(start,end),act=a.movement.act,params=a.movement.parameters??{},ids=a.movement.targets?.map(t=>t.id)??[];
    const overlap=actions.filter(b=>b.id!==a.id&&b.startTime!<end-1e-6&&b.endTime!>start+1e-6);
    const relativeIds=overlap.find(b=>['follow','track'].includes(b.movement.act))?.movement.targets?.map(t=>t.id)??ids;
    const position=(t:number)=>camera(t).position;
    const relative=(t:number)=>sub(position(t),center(relativeIds,t));
    const delta=sub(relative(beforeCut(end)),relative(start));
    if(arc.has(act)&&ids.length){
      const angles=at.map(t=>{const d=sub(position(t),center(ids,t));return Math.atan2(d[0],d[2]);});let total=0;
      for(let i=1;i<angles.length;i++){let d=angles[i]!-angles[i-1]!;while(d>Math.PI)d-=2*Math.PI;while(d< -Math.PI)d+=2*Math.PI;total+=d;}
      if(params.arcAngle!==undefined)near('arc-angle-degrees',deg(total),act==='arcLeft'?-Math.abs(params.arcAngle):act==='arcRight'?Math.abs(params.arcAngle):params.arcAngle,3,a.id);
      else if(act!=='orbit')check('arc-direction',act==='arcLeft'?total<-.01:total>.01,{actionId:a.id,measured:deg(total)});
      if(params.arcRadius!==undefined){const error=Math.max(...at.map(t=>{const d=sub(position(t),center(ids,t));return Math.abs(Math.hypot(d[0],d[2])-params.arcRadius!);}));near('arc-radius-metres',error,0,.03,a.id);}
    }
    if(params.zoomFactor!==undefined){const actual=Math.tan(rad(camera(start).fovYDegrees!)/2)/Math.tan(rad(camera(beforeCut(end)).fovYDegrees!)/2);near('optical-focal-multiplier',actual,act==='zoomOut'?1/params.zoomFactor:params.zoomFactor,.015,a.id);}
    if(params.distance!==undefined){const actual=act.startsWith('pedestal')?Math.abs(delta[1]):Math.hypot(...delta);near('relative-travel-metres',actual,params.distance,.04,a.id);}
    if(params.heightChange!==undefined)near('height-change-metres',Math.abs(delta[1]),params.heightChange,.04,a.id);
    if(act==='static'&&!overlap.some(b=>translated.has(b.movement.act))){const error=Math.max(...at.map(t=>Math.hypot(...sub(position(t),position(start)))));near('static-translation-metres',error,0,.02,a.id);}
    if(['follow','track'].includes(act)&&ids.length&&!overlap.some(b=>translated.has(b.movement.act))){
      const r0=sub(position(start),center(ids,start)),error=Math.max(...at.map(t=>Math.hypot(...sub(sub(position(t),center(ids,t)),r0))));
      near('follow-offset-drift-metres',error,0,.04,a.id);
    }
    if(act==='truckLeft'||act==='truckRight'){check('truck-world-x-direction',act==='truckRight'?delta[0]>.01:delta[0]<-.01,{actionId:a.id,measured:delta[0]});near('truck-orthogonal-drift-metres',Math.hypot(delta[1],delta[2]),0,.03,a.id);}
    if(act==='pedestalUp'||act==='pedestalDown')check('pedestal-direction',act==='pedestalUp'?delta[1]>.01:delta[1]<-.01,{actionId:a.id,measured:delta[1]});
    if(act==='dutchLeft'||act==='dutchRight'){
      const roll=(t:number)=>{const c=camera(t),up=rotate([0,1,0],c.rotation!),right=rotate([1,0,0],c.rotation!);return deg(Math.atan2(right[1],up[1]));};
      const change=roll(beforeCut(end))-roll(start);
      if(params.rotationAngle!==undefined)near('dutch-roll-degrees',change,act==='dutchLeft'?params.rotationAngle:-params.rotationAngle,1,a.id);
    }
    for(const c of a.constraints??[])composition(c,times(start,end,c.allFrames),a.id,ids);
  }
  // Camera centres, not swept volumes or mesh intersections; deliberate cabin
  // occupancy is scoped to example 12, its car, and the two inside/exit actions.
  const collisions=new Set<string>();let collisionSamples=0;const sampled=times(0,tr.clock.durationSeconds);
  for(const t of sampled){const p=camera(t).position;let hit=false;
    for(const e of env.entities){
      if(!e.bounds)continue;
      const cabin=fixture.id==='example-12'&&resolveEnvironmentSubject(env,'car').entity.id===e.id&&actions.some(a=>['dashboard_static','exit_through_windshield'].includes(a.id)&&t>=a.startTime!&&t<=a.endTime!);
      if(cabin)continue;
      const b=worldAabbForBounds(e.bounds,sampleEnvironmentEntityTransform(e,scene(t)));
      if(p.every((v,i)=>v>b.min[i]!+.015&&v<b.max[i]!-.015)){collisions.add(e.id);hit=true;}
    }
    if(hit)collisionSamples++;
  }
  check('camera-centre-bounds-intersections',collisionSamples===0,{category:'geometry',status:collisionSamples?'review':'pass',measured:collisionSamples/sampled.length,expected:0,detail:collisions.size?[...collisions].join(', '):'No camera-centre AABB penetration at audit samples.'});
  const ground=env.world?.ground?.y??0;const minHeight=Math.min(...sampled.map(t=>camera(t).position[1]-ground));
  check('above-ground',minHeight>=.01,{category:'geometry',status:minHeight>=.01?'pass':'review',measured:minHeight,expected:.01});
  if(fixture.id==='example-05'){
    const heights=sampled.map(t=>{const p=cornersAt(['actor_face'],t);return Math.max(...p.map(v=>v.y))-Math.min(...p.map(v=>v.y));});
    near('dolly-zoom-projected-scale-drift',Math.max(...heights)/Math.min(...heights)-1,0,.06,'constant-face-size','composition');
  }
  const contractFailures=checks.filter(c=>c.category==='contract'&&c.status==='fail').length;
  const compositionFailures=checks.filter(c=>c.category==='composition'&&c.status==='fail').length;
  const geometryWarnings=checks.filter(c=>c.category==='geometry'&&c.status!=='pass').length;
  return {exampleId:fixture.id,checks,contractFailures,compositionFailures,geometryWarnings,qualification:contractFailures+compositionFailures+geometryWarnings?'review-required':'sampled-checks-pass',limitations:[
    `Sampled at ${fps} Hz plus action boundaries; no continuous collision certificate or mesh ray tracing.`,
    'Shot size uses conservative projected AABBs; view-side, speed-keyframe fidelity, jerk and all perceptual qualities still require review.',
    'Passing a subset of explicit contracts never makes the entire arbitrary reference pose ground truth.',
  ]};
}
