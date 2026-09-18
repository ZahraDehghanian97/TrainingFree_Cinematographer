import type { EnvironmentV1 } from '../types/environment';
import type { CameraTrajectoryV1 } from '../types/trajectory';
import type { UserCameraKeyframe } from '../optimizer/types';
import type { ResolvedPromptExampleFixture } from '../data/resolved-example-fixtures';
import { assertFreshReference, type ReferenceMetadata } from './provenance';
import { sampleReferenceTrajectory } from './audit';
/** Explicitly opt in to selected authored channels. NEVER an automatic objective
 * or a full-pose ground-truth label; omitted channels remain unconstrained. */
export function referenceSoftKeyframes(
  fixture:ResolvedPromptExampleFixture,environment:EnvironmentV1,
  trajectory:CameraTrajectoryV1,metadata:ReferenceMetadata,
  selection:{times:number[];channels:Array<'position'|'rotation'|'fovYDegrees'>;weight:number},
):UserCameraKeyframe[]{
  assertFreshReference(metadata,fixture,environment,trajectory);
  if(!selection.channels.length||selection.channels.some(c=>!['position','rotation','fovYDegrees'].includes(c)))throw new Error('Select explicit reference channels');
  if(!Number.isFinite(selection.weight)||selection.weight<=0)throw new Error('Soft reference weight must be positive');
  if(!selection.times.length||selection.times.some(t=>!Number.isFinite(t)||t<0||t>trajectory.clock.durationSeconds))throw new Error('Select valid reference times');
  return [...new Set(selection.times)].sort((a,b)=>a-b).map(time=>{
    const sample=sampleReferenceTrajectory(trajectory,time);
    const key:UserCameraKeyframe={id:`authored-${fixture.id}-${time}`,time,mode:'soft',weight:selection.weight};
    if(selection.channels.includes('position'))key.position=sample.position;
    if(selection.channels.includes('rotation'))key.rotation=sample.rotation;
    if(selection.channels.includes('fovYDegrees'))key.fovYDegrees=sample.fovYDegrees;
    if(trajectory.samples.some(s=>s.cutBefore&&Math.abs(s.t-time)<1e-8))key.cutBefore=true;
    return key;
  });
}
