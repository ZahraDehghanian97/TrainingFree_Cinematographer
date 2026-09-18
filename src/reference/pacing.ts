import type { SpeedKeyframe } from '../types/dsl';
/** Independent cumulative integral of the CSL's non-negative speed envelope.
 * `increase` integrates u², `decrease` integrates 2u-u², `static` holds.
 * The right keyframe's easing wins, matching the documented CSL convention.
 */
export function referenceMotionProgress(time:number,keys:readonly SpeedKeyframe[]):number {
  if(!Number.isFinite(time))throw new Error('Progress time must be finite');
  if(!keys.length)return Math.max(0,Math.min(1,time));
  keys.forEach((k,i)=>{if(!Number.isFinite(k.normalizedTime)||k.normalizedTime<0||k.normalizedTime>1||!Number.isFinite(k.speedMultiplier)||k.speedMultiplier<0||(i&&k.normalizedTime<=keys[i-1]!.normalizedTime))throw new Error('Invalid speed envelope');});
  const peak=Math.max(...keys.map(k=>k.speedMultiplier));if(peak<=0)throw new Error('A moving envelope needs positive area');
  const frames=[...(keys[0]!.normalizedTime>0?[{...keys[0]!,normalizedTime:0}]:[]),...keys,...(keys.at(-1)!.normalizedTime<1?[{...keys.at(-1)!,normalizedTime:1}]:[])];
  const integrate=(until:number)=>frames.slice(1).reduce((area,right,i)=>{
    const left=frames[i]!,span=right.normalizedTime-left.normalizedTime,u=Math.max(0,Math.min(1,(until-left.normalizedTime)/span));
    const easing=right.easing??left.easing;
    const integral=easing==='static'?0:easing==='increase'?u**3/3:easing==='decrease'?u*u-u**3/3:u*u/2;
    return area+span*(left.speedMultiplier/peak*(u-integral)+right.speedMultiplier/peak*integral);
  },0);
  const area=integrate(1);if(area<=0)throw new Error('A moving envelope needs positive area');
  return integrate(Math.max(0,Math.min(1,time)))/area;
}
