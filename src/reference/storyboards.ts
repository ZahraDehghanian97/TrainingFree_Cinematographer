/** Authored camera rigs, not optimizer exports. Radius, lens and composition
 * choices here are explicitly marked artistic whenever absent from the prompt.
 * Events refer to action boundaries instead of fragile copied timestamps. */
import type { ReferenceAnchor as A, ReferenceKnot as K, ReferencePlan, ReferenceTime as T } from './types';
import type { Vec3, EnvironmentV1 } from '../types/environment';
import { sampleEnvironmentSubject } from '../environment/sampler';
import { sub, add, mul } from './math';
const subject=(ids: string|string[]): A=>({ids:typeof ids==='string'?[ids]:ids});
const at=(actionId: string,edge: 'start'|'end'='start'): T=>({actionId,edge});
const locked=(ids: string|string[],freezeAt:T): A=>({...subject(ids),freezeAt});
const stopped=(ids: string|string[],holdAfter:T): A=>({...subject(ids),holdAfter});
const anchor=(a: string|string[]|A): A=>typeof a==='string'||Array.isArray(a)?subject(a):a;
function p(t:T,rig:string|string[]|A,offset:Vec3,fov=48,aim?:string|string[]|A,extras:Partial<K>={}):K {
 return {at:t,rig:anchor(rig),offset,aim:anchor(aim??rig),fov,...extras};
}
function o(t:T,rig:string|string[]|A,angle:number,height:number,radius:number,fov=48,aim?:string|string[]|A,extras:Partial<K>={}):K {
 return {at:t,rig:anchor(rig),polar:[angle,height,radius],aim:anchor(aim??rig),fov,...extras};
}
function world(t:T,position:Vec3,aim:string|string[]|A,fov=48,extras:Partial<K>={}):K { return p(t,{point:[0,0,0]},position,fov,aim,extras); }
const end='end' as const;

export function referenceStoryboard(number:number, environment?:EnvironmentV1):ReferencePlan {
 const id=`example-${String(number).padStart(2,'0')}`;
 let knots:K[]=[]; let handheldActionIds:string[]|undefined; let constantScaleSubject:string|undefined;
 const limitations:string[]=[];
 switch(number){
 case 1: {
  const rise=at('pedestal_up'),finish=at('pedestal_up',end);
  knots=[p(0,'ball',[2.2,1.4,3.6],44),p(rise,'ball',[2.2,1.4,3.6],44),p(finish,'ball',[2.2,3.9,3.6],44),p(10,'ball',[2.2,3.9,3.6],44)];break;
 }
 case 2: knots=[o(0,'man_face',0,0,.75,38),o(15,'man_face',1080,0,.75,38,undefined,{easing:'linear'})];break;
 case 3: knots=[p(0,'vase',[0,.05,1.55],50),p(20,'vase',[0,.05,6.5],50,['vase','monitor'])];break;
 case 4: knots=[o(0,'car',-30,.437,3.4,48),o(2,'car',-30,.437,3.4,48),o(15,'car',60,.437,3.4,8,'driver')];limitations.push('Driver visibility through the cabin must be reviewed in Director POV; the static model has no glass refraction simulation.');break;
 case 5: knots=[p(0,'actor_face',[0,0,1.4],26),p(25,'actor_face',[0,0,4],26)];constantScaleSubject='actor_face';break;
 case 6: {const rig=locked('subject',2);knots=[o(0,rig,0,0,3.5,45),o(2,rig,0,0,3.5,45),o(4,rig,360,0,3.5,45,rig,{easing:'linear'}),o(5,rig,360,0,3.5,45)];break;}
 case 7: knots=[o(0,'subject',0,7.4,2.2,52),o(9,'subject_eyes',360,.03,.55,24)];break;
 case 8: {const hit=at('hyper_fast_impact'),rig=stopped('fist',hit);knots=[p(0,rig,[3,.7,4.5],52,'fist'),p(hit,rig,[3,.7,4.5],52,'impact_point'),p(12,rig,[3,.7,4.5],15,'impact_point')];break;}
 case 9: {
  const cut=at('ots_cut');
  knots=[p(0,['person1','person2'],[0,3,-18],50),p(cut,['person1','person2'],[0,3,-18],50),
   p(cut,'person2_face',[-1.44,0,1.36],40,'person2_face',{cutBefore:true}),p(24,'person2_face',[-1.44,0,1.36],40,'person2_face')];
  limitations.push('OTS foreground placement is a composition target; projected shoulder coverage is reported separately, not assumed from the cut.');break;
 }
 case 10: {const trigger=at('dolly_out_shake');knots=[p(0,'race_car',[2.3,1.2,7],47),p(trigger,'race_car',[2.3,1.2,7],47),p(13,'race_car',[3.6,1.8,12],47)];handheldActionIds=['dolly_out_shake'];break;}
 case 11: knots=[p(0,'half_open_door',[0,.15,7],52),p(6,'half_open_door',[0,.15,2.2],52,undefined,{roll:30})];handheldActionIds=['handheld_dolly_in'];break;
 case 12: {
  const brake=at('exit_through_windshield'),exit=at('arc_front_reveal');
  const angle=Math.atan2(-.15,-4.75)*180/Math.PI,radius=Math.hypot(.15,4.75);
  knots=[p(0,'dashboard',[-.15,.21,.73],70,'car_front_exit'),p(brake,'dashboard',[-.15,.21,.73],70,'car_front_exit'),
    p(exit,'dashboard',[-.15,.21,-4.27],70,'car'),
    o(exit,'car',angle,.48,radius,70,'car',{transitionBefore:true}),
    o(18,'car',angle+360,.48,radius,70,'car')];
  limitations.push('Mounted-cabin occupancy and the explicitly virtual windshield exit are scoped car-body exceptions; other geometry and the outside orbit remain checked.');break;
 }
 case 13: knots=[p(0,'half_open_door',[0,.12,8.5],52),p(7,'half_open_door',[0,.12,2.1],52,undefined,{roll:30})];handheldActionIds=['handheld_dolly_in'];break;
 case 14: {
  const rig=stopped('actor_face',8);
  knots=[o(0,locked('actor',0),-35,.35,5.8,46,'actor'),o(1.5,locked('actor',0),-35,.35,5.8,46,'actor'),o(8,rig,-10,.02,1.25,37,'actor_face',{screen:[1/3,.5]}),o(10,rig,-10,.02,1.25,35,'actor_face',{screen:[1/3,.5]})];break;
 }
 case 15: knots=[o(0,'dancer',10,-.7,6,50),o(4,'dancer',-35,-.7,6,50),o(8,'dancer',-165,1.7,6,50),o(10,'dancer',-165,.8,6,50,undefined,{screen:[2/3,.5]})];break;
 case 16: {
  const punch=at('briefcase_punch_in'),arc=at('axis_flip_arc_right');
  const angle=Math.atan2(2.5,9.575)*180/Math.PI,radius=Math.hypot(2.5,9.575);
  knots=[world(0,[-2.5,2.1,9.6],['actor_a','actor_b'],54),world(punch,[2.5,2.1,9.6],['actor_a','actor_b'],54),
   world(arc,[2.5,2.1,9.6],'briefcase',24),
   o(arc,['actor_a','actor_b'],angle,.92,radius,24,'briefcase',{transitionBefore:true}),
   o(10,['actor_a','actor_b'],190,.92,radius,54)];break;
 }
 case 17: {
  const slow=at('bullet_time_arc'),release=at('release_follow');
  knots=[o(0,'runner',-150,-.6,7.5,50,undefined,{screen:[1/3,.5]}),o(slow,'runner',-150,-.6,7.5,50,undefined,{screen:[1/3,.5]}),o(release,'runner',-270,-.6,7.5,50),o(11,'runner',-270,-.6,11,50,undefined,{screen:[1/3,.5]})];break;
 }
 case 18: {
  const camera:Vec3=[.15,1.66,.95];
  knots=[world(0,camera,'hand',30),world(2.5,camera,'eye',30),world(3,camera,'eye',30),p(8.5,stopped('pupil',8.5),[0,0,.35],18,'pupil'),p(10,stopped('pupil',8.5),[0,0,.35],18,'pupil',{roll:-10})];break;
 }
 case 19: knots=[world(0,[4.2,7,2.01],'detective',57),world(2,[4.2,1.18,2.01],'detective',57),world(7,[-2.5,1.18,2.01],'detective',47),world(8.2,[-2.5,1.18,2.01],'pursuer',53, {roll:-12}),world(10,[-2.5,1.18,2.01],['detective','pursuer'],110,{roll:-12})];break;
 case 20: knots=[p(0,'jogger',[2.8,.7,4.8],50),p(4,'jogger',[2.8,.7,4.8],50),p(7,'jogger',[3,4.4,6],58,['jogger','fountain']),p(10,'jogger',[3,4.4,6],58,['jogger','fountain'])];break;
 case 21: {
  const reveal=at('pursuer_closes_in'),finish=at('tense_hold');
  knots=[o(0,'runner',40,.6,6.5,54),o(reveal,'runner',40,.6,6.5,54),o(finish,['runner','pursuer'],120,.6,6.5,43),o(10,['runner','pursuer'],120,.6,6.5,43)];break;
 }
 case 22: {
  const pair=['worker','coworker'],group=[...pair,'set-forklift','set-mezzanine'];
  knots=[o(0,'worker',30,.5,5,50),o(6,'worker',30,.5,5,50),o(10,'worker',105,.5,3.7,50),o(14,pair,105,3.5,7.5,55,[...pair,'set-mezzanine']),o(18,pair,105,3.5,12,55),o(20,stopped(group,20),105,4.8,14,72,group),o(22,stopped(group,20),105,4.8,14,72,group)];break;
 }
 case 23: {
  if(!environment)throw new Error('Factory handoff requires the actual environment');
  const pair=['worker_a','worker_b'],group=[...pair,'set-forklift','set-mezzanine','loading_bay_frame'];
  const a=sampleEnvironmentSubject(environment,'worker_a',6).center,b=sampleEnvironmentSubject(environment,'worker_b',6).center;
  const midpoint=mul(add(a,b),.5),startOffset:Vec3=[0,4,12];
  const followOffset=sub(add(midpoint,startOffset),a);
  knots=[p(0,'worker_a',followOffset,62),p(6,'worker_a',followOffset,62,pair),o(6,pair,0,4,12,62,undefined,{transitionBefore:true}),
   o(10,pair,90,4,12,62),o(15,pair,90,4,12,62),o(18,stopped(pair,18),90,6.0,18,78,stopped(group,18)),o(20,stopped(pair,18),90,6.0,18,78,stopped(group,18))];break;
 }
 case 24: knots=[o(0,'dancer',0,.4,4.5,50),o(10,'dancer',110,.4,4.5,50)];break;
 case 25: knots=[o(0,'dancer',0,.4,4,50),o(10,'dancer',110,.4,4,50)];break;
 case 26: knots=[o(0,'dancer',0,.4,4.5,50,undefined,{screen:[2/3,.5]}),o(10,'dancer',-110,.4,4.5,50,undefined,{screen:[2/3,.5]})];break;
 case 27: knots=[o(0,'dancer_face',-45,0,1.15,47.5),o(10,'dancer_face',-115,0,1.15,47.5)];break;
 case 28: knots=[world(0,[-3,1.9,5.5],'dancer',50),world(10,[3,1.9,5.5],'dancer',50)];break;
 case 29: knots=[p(0,'runner',[-1,.2,-5],50),p(11,'runner',[-1,.2,-5],50)];break;
 case 30: knots=[p(0,['actor_a','actor_b'],[0,.8,9],55),p(10,['actor_a','actor_b'],[0,.8,9],55)];break;
 case 31: knots=[p(0,'actor_a',[1,.6,4],50),p(4,'actor_a',[1,.6,4],50),p(4,'actor_b',[-1,.6,4],50,undefined,{cutBefore:true}),p(10,'actor_b',[-1,.6,4],50)];break;
 case 32: {
  const rig=locked('dancer_face',0),fov2=2*Math.atan(Math.tan(70*Math.PI/360)/2)*180/Math.PI;
  knots=[p(0,rig,[0,0,3.5],70,'dancer_face'),p(10,rig,[0,0,3.5],fov2,'dancer_face')];break;
 }
 default: throw new Error(`No reference storyboard for ${id}`);
 }
 return {version:'1.0',exampleId:id,knots,handheldActionIds,constantScaleSubject,artisticChoices:[
  'Unrequested rig offsets, radii, lens choices and smoothstep pacing are authored illustration choices, not inferred user constraints.',
  'Camera paths are synthetic assistant-authored references, not measured ground truth, not LLM inference runs, and not optimized outputs.',
  ...(number>=24?['This is an under-specified ablation: compare only prompt-requested semantic constraints, never force its entire reference pose.']:[]),
 ],...(limitations.length?{limitations}:{})};
}
