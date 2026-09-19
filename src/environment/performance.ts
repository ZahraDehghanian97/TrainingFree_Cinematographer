import type { EnvironmentV1, PerformanceClipV1 } from "../types/environment";
export const PERFORMANCE_ACTIONS = ["ready","fall","recover","celebrate","sit","cheer","throw","film","work","argue","shove","recoil","kick","dive"] as const;
const clamp=(n:number)=>Math.max(0,Math.min(1,n));
const ease=(n:number)=>{const u=clamp(n);return u*u*(3-2*u);};
/** Absolute-time evaluation: never accumulates state, including a reverse seek. */
export function performanceWeight(clip: PerformanceClipV1,time: number,duration: number): number {
  if(!Number.isFinite(time)||time<clip.start||time>clip.end)return 0;
  const blend=Math.min(clip.blend??.2,(clip.end-clip.start)/2);
  if(blend<=0)return clip.intensity??1;
  const enter=clip.start===0?1:ease((time-clip.start)/blend);
  const leave=clip.end>=duration?1:ease((clip.end-time)/blend);
  return enter*leave*(clip.intensity??1);
}
/** Same validation on server and browser; rejects dangling IDs and invalid clips. */
export function assertScenarioData(env: EnvironmentV1): void {
  const duration=env.clock.durationSeconds;
  const ids=new Set([...env.entities.map(e=>e.id),...env.semanticAnchors.map(a=>a.id)]);
  for(const entity of env.entities){
    if(entity.performance===undefined)continue;
    if(!Array.isArray(entity.performance))throw new Error(`${entity.id}.performance must be an array`);
    for(const c of entity.performance){
      if(!c||!PERFORMANCE_ACTIONS.includes(c.action)||!Number.isFinite(c.start)||!Number.isFinite(c.end)||c.start<0||c.end<=c.start||c.end>duration)
        throw new Error(`${entity.id}: invalid performance clip or time range`);
      if(c.blend!==undefined&&(!Number.isFinite(c.blend)||c.blend<0))throw new Error(`${entity.id}: invalid clip blend`);
      if(c.intensity!==undefined&&(!Number.isFinite(c.intensity)||c.intensity<0||c.intensity>1))throw new Error(`${entity.id}: clip intensity must be in [0,1]`);
    }
  }
  if(env.events===undefined)return;
  if(!Array.isArray(env.events))throw new Error("Environment events must be an array");
  const events=new Set<string>();let previous=-Infinity;
  for(const e of env.events){
    if(!e||typeof e.id!=="string"||!e.id.trim()||events.has(e.id)||typeof e.label!=="string"||!e.label.trim()||typeof e.type!=="string"||!e.type.trim())throw new Error("Invalid or duplicate scene event");
    events.add(e.id);
    if(!Number.isFinite(e.time)||e.time<0||e.time>duration||e.time<previous)throw new Error(`Invalid scene event time: ${e.id}`);
    previous=e.time;
    if(e.endTime!==undefined&&(!Number.isFinite(e.endTime)||e.endTime<e.time||e.endTime>duration))throw new Error(`Invalid event endTime: ${e.id}`);
    if(!Array.isArray(e.subjects)||!e.subjects.length||e.subjects.some(id=>!ids.has(id)))throw new Error(`Missing event subject: ${e.id}`);
  }
}
