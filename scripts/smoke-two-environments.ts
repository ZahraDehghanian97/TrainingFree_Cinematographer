/** Small numerical integration test, deliberately not a camera-quality benchmark. */
import * as fs from "node:fs";
import * as path from "node:path";
import { resolvedPromptExampleFixtures } from "../src/data/resolved-example-fixtures";
import { optimizeCameraTrajectory } from "../src/optimizer";
import { flattenTimeline } from "../src/timeline/flattener";
import { solveTimeline } from "../src/timeline/solver";
import { assertEnvironmentV1 } from "../web/src/environment-loader";
import { assertCameraTrajectoryV1 } from "../web/src/trajectory-loader";
const root=path.resolve(__dirname,"..");
const results=resolvedPromptExampleFixtures.map(fixture=>{
 const raw:unknown=JSON.parse(fs.readFileSync(path.join(root,`web/public/environments/${fixture.environmentId}.json`),"utf8"));
 assertEnvironmentV1(raw);
 const started=Date.now();
 const result=optimizeCameraTrajectory({environment:raw,timeline:flattenTimeline(solveTimeline(fixture.resolvedCsl,raw)),
   options:{iterations:0,optimizationFps:.25,outputFps:2}});
 assertCameraTrajectoryV1(result.trajectory);
 if(result.trajectory.environmentId!==fixture.environmentId)throw new Error("Wrong world in optimizer output");
 const row={environmentId:fixture.environmentId,elapsedMilliseconds:Date.now()-started,samples:result.trajectory.samples.length,
   validTrajectorySchema:true,settings:{iterations:0,optimizationFps:.25,outputFps:2}};
 console.log(JSON.stringify(row));return row;
});
fs.writeFileSync(path.join(root,"docs/optimizer-smoke.json"),JSON.stringify({method:"Initialization, loss compilation and trajectory export smoke test only; zero numerical refinement iterations. Not bundled as a final movie.",results},null,2)+"\n");
