import type { EnvironmentV1, Vec3 } from '../types/environment';
import type { CameraSampleV1, CameraTrajectoryV1, PlaybackRateSegmentV1 } from '../types/trajectory';
import type { ResolvedPromptExampleFixture } from '../data/resolved-example-fixtures';
import { resolveActionTimings, type TimedAction } from '../timeline/timing';
import { solveTimeline } from '../timeline/solver';
import { flattenTimeline } from '../timeline/flattener';
import { sampleEnvironmentSubject } from '../environment/sampler';
import type { ReferenceAnchor, ReferencePlan, ReferencePose, ReferenceTime } from './types';
import { referenceMotionProgress } from './pacing';
import { add, sub, mix, mix3, rad, deg, smooth, composeCamera, project, lookRotation } from './math';

/** Independent integration of the canonical scene-rate bands. */
export function referenceSceneTime(t: number,rates: readonly PlaybackRateSegmentV1[],duration: number): number {
  const end=Math.max(0,t), breaks=[...new Set([0,end,...rates.flatMap(s=>[s.startTime,s.endTime]).filter(x=>x>0&&x<end)])].sort((a,b)=>a-b);
  let scene=0;
  for(let i=0;i+1<breaks.length;i++){
    const a=breaks[i]!,b=breaks[i+1]!,mid=(a+b)/2;
    const rate=rates.filter(s=>s.startTime<=mid&&mid<s.endTime).at(-1)?.rate??1;
    scene+=(b-a)*rate;
  }
  return Math.min(duration,scene);
}
export function resolveReferenceTime(value: ReferenceTime,actions: readonly TimedAction[]): number {
  if(typeof value==='number') return value;
  const action=actions.find(a=>a.id===value.actionId);
  if(!action) throw new Error(`Unknown reference action: ${value.actionId}`);
  const time=value.edge==='start'?action.startTime:action.endTime;
  if(time===undefined) throw new Error(`Unresolved reference action: ${value.actionId}`);
  return time+(value.offset??0);
}

export function generateReference(fixture: ResolvedPromptExampleFixture,environment: EnvironmentV1,plan: ReferencePlan,fps=30) {
  if(fixture.environmentId!==environment.id||fixture.id!==plan.exampleId) throw new Error('Reference, fixture and environment IDs do not agree');
  if(!Number.isFinite(fps)||fps<1||fps>240) throw new Error('Reference fps must be between 1 and 240');
  const actions=resolveActionTimings(fixture.resolvedCsl.sections,fixture.resolvedCsl.totalDuration,environment);
  const timeline=flattenTimeline(solveTimeline(fixture.resolvedCsl,environment));
  const duration=fixture.resolvedCsl.totalDuration;
  const rates: PlaybackRateSegmentV1[]=timeline.timeWarp.map(s=>({startTime:s.startTimePlayback,endTime:s.endTimePlayback,rate:s.rate,label:s.label}));
  const knots=plan.knots.map(k=>({...k,t:resolveReferenceTime(k.at,actions)}));
  const aspect=plan.aspectRatio??16/9;
  if(knots.length<2||Math.abs(knots[0]!.t)>1e-8||Math.abs(knots.at(-1)!.t-duration)>1e-8) throw new Error(`${fixture.id}: knots must cover the whole shot`);
  for(let i=0;i<knots.length;i++){
    const k=knots[i]!;
    if(!Number.isFinite(k.t)||k.t<0||k.t>duration+1e-8||!(k.fov>0&&k.fov<180)) throw new Error('Invalid reference knot');
    if(i&&k.t<knots[i-1]!.t) throw new Error(`${fixture.id}: reference times are not ordered`);
    if(i&&k.t===knots[i-1]!.t&&!k.cutBefore&&!k.transitionBefore) throw new Error('Duplicate times require an explicit cut or continuous handoff');
    if(Boolean(k.polar)===Boolean(k.offset)) throw new Error('Each rig needs exactly one Cartesian or polar offset');
  }
  const cuts=knots.filter(k=>k.cutBefore).map(k=>k.t);
  if(JSON.stringify(cuts)!==JSON.stringify(timeline.cutTimes??[])) throw new Error(`${fixture.id}: reference cuts differ from CSL sections`);
  const center=(a: ReferenceAnchor,t: number): Vec3=>{
    if(Boolean(a.point)===Boolean(a.ids?.length)) throw new Error('Reference anchor needs a point OR subject IDs');
    if(a.point)return a.point;
    const at=a.freezeAt!==undefined?resolveReferenceTime(a.freezeAt,actions):a.holdAfter!==undefined?Math.min(t,resolveReferenceTime(a.holdAfter,actions)):t;
    const scene=referenceSceneTime(at,rates,environment.clock.durationSeconds);
    const pts=a.ids!.map(id=>sampleEnvironmentSubject(environment,id,scene).center);
    return [0,1,2].map(i=>pts.reduce((s,p)=>s+p[i]!,0)/pts.length) as Vec3;
  };
  function position(p: ReferencePose,t: number): Vec3 {
    const o=p.polar?[Math.sin(rad(p.polar[0]))*p.polar[2],p.polar[1],Math.cos(rad(p.polar[0]))*p.polar[2]] as Vec3:p.offset!;
    return add(center(p.rig,t),o);
  }
  for(let i=1;i<knots.length;i++) {
    const a=knots[i-1]!,b=knots[i]!;
    if(b.transitionBefore && (Math.abs(a.t-b.t)>1e-9 || Math.hypot(...sub(position(a,b.t),position(b,b.t)))>1e-5)) {
      throw new Error(`${fixture.id}: discontinuous rig handoff at ${b.t}`);
    }
  }
  const initialPosition=position(knots[0]!,0);
  const scaleAnchor=plan.constantScaleSubject?{ids:[plan.constantScaleSubject]}:undefined;
  function projectedHeight(pos:Vec3,t:number,fov:number):number {
    const subject=sampleEnvironmentSubject(environment,plan.constantScaleSubject!,referenceSceneTime(t,rates,environment.clock.durationSeconds));
    if(!subject.box)throw new Error('Constant-scale reference requires subject bounds');
    const q=lookRotation(pos,subject.center),ys:number[]=[];
    for(const x of [subject.box.min[0],subject.box.max[0]])for(const y of [subject.box.min[1],subject.box.max[1]])for(const z of [subject.box.min[2],subject.box.max[2]]){
      const p=project([x,y,z],pos,q,fov,aspect);if(p.depth<=0)throw new Error('Constant-scale reference is inside target bounds');ys.push(p.y);
    }
    return Math.max(...ys)-Math.min(...ys);
  }
  const initialCoverage=scaleAnchor?projectedHeight(initialPosition,0,knots[0]!.fov):0;
  function evaluate(t: number): CameraSampleV1 {
    let i=0; while(i+1<knots.length&&knots[i+1]!.t<=t+1e-10)i++;
    const a=knots[i]!,b=knots[Math.min(i+1,knots.length-1)]!;
    const u=b.t>a.t?Math.max(0,Math.min(1,(t-a.t)/(b.t-a.t))):0;
    const w=b.easing==='linear'?u:smooth(u);
    const matching=actions.filter(x=>Math.abs(x.startTime!-a.t)<1e-6&&Math.abs(x.endTime!-b.t)<1e-6);
    const progress=(kinds:string[],fallback=w):number=>{
      const match=matching.find(x=>kinds.includes(x.movement.act)&&x.movement.speedKeyframes?.length);
      return match?referenceMotionProgress(u,match.movement.speedKeyframes!):fallback;
    };
    const spatial=progress(['dollyIn','dollyOut','truckLeft','truckRight','pedestalUp','pedestalDown','craneUp','craneDown','arcLeft','arcRight','orbit']);
    const angular=progress(['arcLeft','arcRight','orbit'],spatial);
    const vertical=progress(['pedestalUp','pedestalDown','craneUp','craneDown'],spatial);
    const radial=progress(['dollyIn','dollyOut'],spatial);
    const optical=progress(['zoomIn','zoomOut']);
    const pointing=progress(['panLeft','panRight','tiltUp','tiltDown']);
    const rolling=progress(['dutchLeft','dutchRight']);
    let pos: Vec3;
    if(a.polar&&b.polar){
      const p:Vec3=[mix(a.polar[0],b.polar[0],angular),mix(a.polar[1],b.polar[1],vertical),mix(a.polar[2],b.polar[2],radial)],o: Vec3=[Math.sin(rad(p[0]))*p[2],p[1],Math.cos(rad(p[0]))*p[2]];
      pos=add(mix3(center(a.rig,t),center(b.rig,t),spatial),o);
    }else pos=mix3(position(a,t),position(b,t),spatial);
    const aim=mix3(center(a.aim,t),center(b.aim,t),pointing);
    // Lens interpolation is linear in focal-length-equivalent units.
    const focal=mix(1/Math.tan(rad(a.fov)/2),1/Math.tan(rad(b.fov)/2),optical);
    let fov=deg(2*Math.atan(1/focal));
    if(scaleAnchor)fov=deg(2*Math.atan(Math.tan(rad(fov)/2)*projectedHeight(pos,t,fov)/initialCoverage));
    const active=actions.filter(x=>x.startTime!<=t+1e-9&&(x.endTime!>t+1e-9||(t===duration&&x.endTime===duration)));
    const handheld=active.find(x=>plan.handheldActionIds?.includes(x.id));
    if(handheld){
      const p=(t-handheld.startTime!)/Math.max(1e-8,handheld.endTime!-handheld.startTime!);
      const envelope=Math.sin(Math.PI*Math.min(1,Math.max(0,p)))**2;
      pos=add(pos,[.016*envelope*Math.sin(2*Math.PI*2.3*t),.012*envelope*Math.sin(2*Math.PI*3.7*t+.3),0]);
    }
    const screen: [number,number]=[mix(a.screen?.[0]??.5,b.screen?.[0]??.5,w),mix(a.screen?.[1]??.5,b.screen?.[1]??.5,w)];
    const rotation=composeCamera(pos,aim,fov,aspect,screen,mix(a.roll??0,b.roll??0,rolling));
    const main=active.find(x=>!['zoomIn','zoomOut','dutchLeft','dutchRight'].includes(x.movement.act))??active[0]??actions.at(-1);
    return {t,position:pos,rotation,fovYDegrees:fov,...(main?{actionId:main.id}:{}),...(cuts.some(c=>Math.abs(c-t)<1e-10)?{cutBefore:true}:{})};
  }
  const times=[...new Set([0,duration,...Array.from({length:Math.ceil(duration*fps)},(_,i)=>Math.min(duration,i/fps)),...knots.map(k=>k.t),...actions.flatMap(a=>[a.startTime!,a.endTime!]),...cuts.map(c=>Math.max(0,c-1e-6))])].sort((a,b)=>a-b);
  const samples=times.filter((t,i)=>i===0||t-times[i-1]!>1e-10).map(evaluate);
  const trajectory: CameraTrajectoryV1={schemaVersion:'1.0',kind:'cameraTrajectory',environmentId:environment.id,clock:{durationSeconds:duration,timeUnit:'second'},coordinates:environment.coordinates,intrinsics:{projection:'perspective',fovYDegrees:samples[0]!.fovYDegrees!,aspectRatio:aspect,near:.01,far:1200},orientation:{mode:'quaternion'},...(rates.length?{playback:{rateSegments:rates}}:{}),samples};
  return {trajectory,actions,timeline,evaluate,center,plan};
}
