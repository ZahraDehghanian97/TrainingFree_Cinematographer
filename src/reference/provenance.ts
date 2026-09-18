import { createHash } from 'node:crypto';
import type { EnvironmentV1 } from '../types/environment';
import type { CameraTrajectoryV1 } from '../types/trajectory';
import type { ResolvedPromptExampleFixture } from '../data/resolved-example-fixtures';
/** Stable fingerprints ignore JSON object key order, but retain array order. */
export function fingerprint(value:unknown):string {
  const canonical=(v:any):any=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
  return createHash('sha256').update(JSON.stringify(canonical(JSON.parse(JSON.stringify(value))))).digest('hex');
}
export function sourceFingerprints(fixture:ResolvedPromptExampleFixture,environment:EnvironmentV1){
  return {promptSha256:fingerprint(fixture.prompt),environmentSha256:fingerprint(environment),cslSha256:fingerprint(fixture.resolvedCsl)};
}
export interface ReferenceMetadata {
  schemaVersion:'1.0'; kind:'authoredCameraReference'; exampleId:string; environmentId:string;
  promptSha256:string; environmentSha256:string; cslSha256:string; trajectorySha256:string;
  recipeSha256:string; plan:unknown; fullPoseIsGroundTruth:false;
  provenance:{optimizerDerived:false;llmInferenceRun:false;measuredGroundTruth:false;method:string};
}
export function assertFreshReference(metadata:ReferenceMetadata,fixture:ResolvedPromptExampleFixture,environment:EnvironmentV1,trajectory:CameraTrajectoryV1):void {
  if(metadata.kind!=='authoredCameraReference'||metadata.exampleId!==fixture.id||metadata.environmentId!==environment.id||trajectory.environmentId!==environment.id)throw new Error('Reference identity mismatch');
  const expected={...sourceFingerprints(fixture,environment),trajectorySha256:fingerprint(trajectory),recipeSha256:fingerprint(metadata.plan)};
  for(const [key,hash] of Object.entries(expected))if(metadata[key as keyof typeof expected]!==hash)throw new Error(`Stale or modified reference: ${key}; regenerate references before evaluation`);
  if(metadata.fullPoseIsGroundTruth!==false||metadata.provenance.optimizerDerived!==false)throw new Error('Reference provenance does not support independent evaluation');
}
