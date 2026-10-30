import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ResolvedPromptExampleFixture } from '../src/data/resolved-example-fixtures';
import type { EnvironmentV1 } from '../src/types/environment';
import type { CameraTrajectoryV1 } from '../src/types/trajectory';
import { fingerprint, sourceFingerprints } from '../src/reference/provenance';
export function publishOptimizedProvenance(root:string,fixture:ResolvedPromptExampleFixture,env:EnvironmentV1,trajectory:CameraTrajectoryV1):void {
  const file=path.join(root,`web/public/trajectories/optimized/${fixture.id}-provenance.json`);
  fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file,JSON.stringify({schemaVersion:'1.0',kind:'optimizedTrajectoryProvenance',exampleId:fixture.id,environmentId:env.id,...sourceFingerprints(fixture,env),trajectorySha256:fingerprint(trajectory)},null,2)+'\n');
  const manifestFile=path.join(root,'web/public/environments/manifest.json');
  const manifest=JSON.parse(fs.readFileSync(manifestFile,'utf8'));
  const entry=manifest.environments.find((e:{id:string})=>e.id===env.id);
  if(entry){entry.optimizedTrajectoryUrl=`/trajectories/optimized/${fixture.id}-camera.json`;entry.optimizedTrajectoryStale=false;entry.optimizedProvenanceUrl=`/trajectories/optimized/${fixture.id}-provenance.json`;}
  fs.writeFileSync(manifestFile,JSON.stringify(manifest,null,2)+'\n');
}
