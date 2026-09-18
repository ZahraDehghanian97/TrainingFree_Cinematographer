import * as fs from 'node:fs';
import * as path from 'node:path';
import { assertEnvironmentV1 } from '../web/src/environment-loader';
import { auditEnvironmentLayout, type LayoutReceipt } from '../src/environment/layout-audit';
const root = path.resolve(__dirname, '..');
const receipts: { scenes: LayoutReceipt[] } = JSON.parse(fs.readFileSync(path.join(root,'docs/environment-layouts.json'),'utf8'));
const results = receipts.scenes.map(receipt => {
  const data: unknown = JSON.parse(fs.readFileSync(path.join(root,`web/public/environments/${receipt.exampleId}.json`),'utf8'));
  assertEnvironmentV1(data);
  const report = auditEnvironmentLayout(data,receipt);
  console.log(`${report.exampleId}: ${report.checks} checks, ${report.issues.length} issues`);
  report.issues.forEach(issue=>console.log(`  ${issue.check}: ${issue.entity}: ${issue.detail}`));
  return report;
});
const summary = { scenes:results.length, checks:results.reduce((n,r)=>n+r.checks,0), issues:results.reduce((n,r)=>n+r.issues.length,0),
  rooms:results.reduce((n,r)=>n+r.rooms,0), stairFlights:results.reduce((n,r)=>n+r.stairs,0) };
const report = { schemaVersion:'1.0', method:'Exported geometry: partitioned wall coverage, roof contact, stair connectivity/headroom, furniture contacts, support graph; walking-core clearance at 5 Hz',
  limitations:['Not a structural-engineering or accessibility/code certification.', 'AABB contact checks and 5 Hz static-obstacle sampling do not prove detailed mesh contact or continuous collision clearance; moving obstacles and limb motion are not covered.', 'Art direction still requires browser review.'], summary, results };
fs.writeFileSync(path.join(root,'docs/environment-audit.json'), JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(summary));
if (summary.issues || summary.scenes !== 32) process.exitCode = 1;
