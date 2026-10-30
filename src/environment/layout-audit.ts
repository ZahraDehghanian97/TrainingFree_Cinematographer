/** Independent geometric checks on authored buildings (not a building-code certificate).
 * Uses exported geometry, not generator helper functions. Distances are in metres.
 */
import type { EnvironmentV1, SceneEntityV1, Vec3 } from '../types/environment';
import { sampleEnvironmentEntityTransform, worldAabbForBounds } from './sampler';
import type { WorldAabbV1 } from '../types/environment-spatial';

export interface LayoutReceipt {
  exampleId: string;
  rooms: Array<{ id: string; rect: number[]; floor: number; ceiling: number; roof: string | null; walls: Record<string, string[]> }>;
  openings: Array<{ id: string; axis: string; fixed: number; min: number; max: number; bottom: number; top: number; kind: string; wall: string }>;
  stairs: Array<{ id: string; start: Vec3; direction: number[]; count: number; rise: number; riser: number; going: number; width: number; steps: string[]; landing: string; landingDepth: number; end: Vec3; target: string }>;
}
export interface LayoutIssue { check: string; entity: string; detail: string }
export interface LayoutAudit {
  exampleId: string; checks: number; issues: LayoutIssue[];
  rooms: number; stairs: number; purposeDocumented: number;
}
const EPS = .003;
function containsXZ(b: WorldAabbV1, p: Vec3, inset = 0): boolean {
  return p[0] >= b.min[0] + inset - EPS && p[0] <= b.max[0] - inset + EPS
    && p[2] >= b.min[2] + inset - EPS && p[2] <= b.max[2] - inset + EPS;
}
function horizontalOverlap(a: WorldAabbV1, b: WorldAabbV1): boolean {
  return Math.min(a.max[0], b.max[0]) - Math.max(a.min[0], b.min[0]) > .02
    && Math.min(a.max[2], b.max[2]) - Math.max(a.min[2], b.min[2]) > .02;
}
export function auditEnvironmentLayout(environment: EnvironmentV1, receipt: LayoutReceipt): LayoutAudit {
  const issues: LayoutIssue[] = [];
  let checks = 0;
  const check = (ok: boolean, name: string, id: string, detail: string) => {
    checks++;
    if (!ok) issues.push({ check: name, entity: id, detail });
  };
  const byId = new Map(environment.entities.map(e => [e.id, e]));
  const boxes = new Map<string, WorldAabbV1>();
  for (const e of environment.entities) if (e.bounds)
    boxes.set(e.id, worldAabbForBounds(e.bounds, sampleEnvironmentEntityTransform(e, 0)));
  const box = (id: string) => boxes.get(id);
  check(environment.promptExampleId === receipt.exampleId, 'receipt-match', receipt.exampleId, 'Receipt and scene must match');
  check(byId.size === environment.entities.length, 'unique-ids', receipt.exampleId, 'Duplicate entity IDs');

  for (const e of environment.entities) {
    check(Boolean(e.layout?.purpose.trim()), 'documented-purpose', e.id, 'Missing functional purpose');
    const chain = new Set<string>();
    let next: string | undefined = e.id;
    while (next && next !== 'ground') {
      if (chain.has(next)) { check(false, 'support-cycle', e.id, next); break; }
      chain.add(next);
      const item = byId.get(next);
      if (!item) { check(false, 'support-reference', e.id, next); break; }
      next = item.layout?.support;
    }
    checks++;
  }

  // Partition each wall at every real geometry/opening boundary. Test one
  // midpoint per resulting cell, so a narrow missing wall strip cannot fall
  // between a fixed-resolution sampling grid.
  for (const room of receipt.rooms) {
    const [x0, x1, z0, z1] = room.rect;
    for (const [side, ids] of Object.entries(room.walls)) {
      const along = side === 'north' || side === 'south' ? 0 : 2;
      const normal = along === 0 ? 2 : 0;
      const fixed = side === 'north' ? z0 : side === 'south' ? z1 : side === 'west' ? x0 : x1;
      const lo = along === 0 ? x0 : z0, hi = along === 0 ? x1 : z1;
      const wallName = `arch-${room.id}-${side}`;
      const apertures = receipt.openings.filter(o => o.wall === wallName);
      const parts: WorldAabbV1[] = [];
      for (const id of ids) {
        const b = box(id);
        check(Boolean(b), 'wall-piece-exists', id, 'Recorded wall piece is absent');
        if (b) parts.push(b);
      }
      const cuts = (values: number[], min: number, max: number) => [min, max, ...values.filter(v => v > min && v < max)].sort((a, b) => a-b).filter((v,i,all) => i === 0 || v-all[i-1] > 1e-7);
      const xs = cuts([...parts.flatMap(b => [b.min[along], b.max[along]]), ...apertures.flatMap(o => [o.min, o.max])], lo, hi);
      const ys = cuts([...parts.flatMap(b => [b.min[1], b.max[1]]), ...apertures.flatMap(o => [o.bottom, o.top])], room.floor, room.ceiling);
      for (let i = 1; i < xs.length; i++) for (let j = 1; j < ys.length; j++) {
        const a = (xs[i-1] + xs[i])/2, y = (ys[j-1] + ys[j])/2;
        const open = apertures.some(o => a > o.min && a < o.max && y > o.bottom && y < o.top);
        const solid = parts.some(b => a >= b.min[along]-1e-8 && a <= b.max[along]+1e-8 && y >= b.min[1]-1e-8 && y <= b.max[1]+1e-8 && fixed >= b.min[normal] && fixed <= b.max[normal]);
        check(open !== solid, open ? 'unblocked-opening' : 'wall-coverage', wallName, `along=${a}, height=${y}`);
      }
    }
    if (room.roof) {
      const roof = box(room.roof);
      check(Boolean(roof), 'ceiling-exists', room.id, 'No full ceiling found');
      if (roof) {
        check(Math.abs(roof.min[1]-room.ceiling) < EPS, 'ceiling-contact', room.roof, 'Roof underside must meet wall tops');
        check(roof.min[0] <= x0 && roof.max[0] >= x1 && roof.min[2] <= z0 && roof.max[2] >= z1,
          'ceiling-coverage', room.roof, 'Roof must cover the full enclosed room');
      }
    }
  }

  for (const stair of receipt.stairs) {
    const [dx, dz] = stair.direction;
    const approach: Vec3 = [stair.start[0]-dx*.6, stair.start[1], stair.start[2]-dz*.6];
    const approachFloor = environment.entities.some(e => {
      if (!['floor','landing','paving'].includes(e.layout?.role ?? '')) return false;
      const b=box(e.id);
      return Boolean(b && Math.abs(b.max[1]-approach[1]) < .025 && containsXZ(b,approach,.1));
    }) || (environment.world?.ground?.render !== false && Math.abs(approach[1]) < EPS);
    check(approachFloor, 'bottom-stair-approach', stair.id, 'No supported approach before the first riser');
    check(stair.count === stair.steps.length && stair.count >= 1, 'step-count', stair.id, 'Missing tread');
    check(stair.riser > 0 && stair.riser <= .18 + EPS && stair.going >= .28 - EPS && stair.width >= 1.2,
      'stair-proportions', stair.id, 'Check rise, going and clear width');
    for (let i = 0; i < stair.count; i++) {
      const id = stair.steps[i];
      const b = box(id);
      check(Boolean(b), 'tread-exists', id, 'Missing physical step');
      if (!b) continue;
      const top = stair.start[1] + (i+1)*stair.riser;
      check(Math.abs(b.max[1]-top) < EPS, 'equal-risers', id, `Expected elevation ${top}`);
      const centre: Vec3 = [stair.start[0]+dx*(i+.5)*stair.going, top, stair.start[2]+dz*(i+.5)*stair.going];
      check(containsXZ(b, centre), 'tread-position', id, 'Step does not occupy its expected run');
      const along = dx ? 0 : 2, across = dx ? 2 : 0;
      check(Math.abs((b.max[along]-b.min[along])-stair.going) < EPS
        && Math.abs((b.max[across]-b.min[across])-stair.width) < EPS,
        'tread-dimensions', id, 'Tread has a gap, wrong going or wrong width');
      // Central headroom, with nosings/rails excluded. Test centre and both
      // sides of the walking band, independently of overview visibility.
      for (const offset of [-.4, 0, .4]) {
        const p: Vec3 = [centre[0]-dz*offset, top, centre[2]+dx*offset];
        const blockers = environment.entities.filter(e => ['floor','ceiling','beam','wall','landing'].includes(e.layout?.role ?? '') && e.id !== stair.landing && e.id !== stair.target);
        const obstruction = blockers.find(e => { const q=box(e.id); return q && containsXZ(q,p,.01) && q.max[1] > top+.1 && q.min[1] < top+2.0; });
        check(!obstruction, 'stair-headroom', id, obstruction?.id ?? '');
      }
    }
    const landing = box(stair.landing), target = box(stair.target);
    check(Boolean(landing && target), 'landing-target-exists', stair.id, 'Stair must connect to a real occupied floor');
    if (landing && target) {
      check(Math.abs(landing.max[1]-stair.end[1]) < EPS && Math.abs(target.max[1]-stair.end[1]) < EPS,
        'landing-level', stair.id, 'Landing and destination elevations do not match');
      const end = stair.end;
      check(containsXZ(landing,end) && containsXZ(target,end), 'landing-connectivity', stair.id, 'Landing does not touch destination deck');
      const dest = byId.get(stair.target)!;
      if (dest.visual.type === 'primitive' && dest.visual.shape === 'cylinder') {
        const position = sampleEnvironmentEntityTransform(dest,0).position;
        const radius = Number(dest.visual.params.radius);
        for (const side of [-.4,.4]) check(Math.hypot(end[0]-position[0]-dz*side, end[2]-position[2]+dx*side) <= radius+EPS,
          'round-stage-contact', stair.id, 'Rectangular landing misses actual circular stage');
      }
    }
    for (const side of [-1,1]) check(byId.has(`${stair.id}-handrail-${side}`), 'handrail-exists', stair.id, 'Missing continuous handrail');
  }

  // Check contact of ordinary furniture and table props. Hanging fixtures,
  // actors, hand-held story props, and load-spanning beams are not treated as
  // floor-standing boxes.
  const supports = environment.entities.filter(e => ['floor','landing','paving'].includes(e.layout?.role ?? ''));
  for (const e of environment.entities) {
    const l = e.layout, b = box(e.id);
    if (!l || !b || !l.support || !['furniture','prop'].includes(l.role)) continue;
    if (l.support !== 'ground') {
      const carrier = box(l.support);
      if (!carrier || ['railing','column','wall'].includes(byId.get(l.support)?.layout?.role ?? '')) continue;
      check(Math.abs(b.min[1]-carrier.max[1]) <= .025 && horizontalOverlap(b,carrier), 'object-contact', e.id,
        `Object bottom ${b.min[1]} / support top ${carrier.max[1]}`);
    } else {
      const worldFloor = environment.world?.ground?.render !== false && Math.abs(b.min[1]) <= .025;
      const platform = supports.some(p => { const q=box(p.id); return p.id !== e.id && q && Math.abs(q.max[1]-b.min[1]) <= .025 && horizontalOverlap(b,q); });
      check(Boolean(worldFloor || platform), 'furniture-ground-contact', e.id, `No floor at object base Y=${b.min[1]}`);
    }
  }
  // Conservative 5 Hz walking-core clearance against static architecture and
  // furniture. Animated props and driving poses require separate motion tests.
  const staticSolids = environment.entities.filter(e => e.bounds
    && ['wall','column','furniture','window'].includes(e.layout?.role ?? '')
    && Array.isArray(e.transform.position)
    && (!e.transform.rotation || Array.isArray(e.transform.rotation)));
  for (const actor of environment.entities) {
    if (actor.visual.type !== 'preset' || actor.visual.name !== 'humanoid' || actor.visual.params?.pose === 'driving') continue;
    const collisions = new Set<string>();
    for (let frame=0; frame<=Math.ceil(environment.clock.durationSeconds*5); frame++) {
      const t=Math.min(frame/5,environment.clock.durationSeconds);
      const p=sampleEnvironmentEntityTransform(actor,t).position;
      for (const obstacle of staticSolids) {
        if (obstacle.id===actor.id) continue;
        const b=box(obstacle.id)!;
        if (p[0]+.15>b.min[0] && p[0]-.15<b.max[0] && p[2]+.15>b.min[2] && p[2]-.15<b.max[2]
          && p[1]+1.5>b.min[1] && p[1]+.4<b.max[1]) collisions.add(obstacle.id);
      }
    }
    check(collisions.size===0, 'sampled-walking-clearance', actor.id, [...collisions].join(', '));
  }
  return { exampleId: receipt.exampleId, checks, issues, rooms: receipt.rooms.length, stairs: receipt.stairs.length,
    purposeDocumented: environment.entities.filter(e=>e.layout?.purpose.trim()).length };
}
