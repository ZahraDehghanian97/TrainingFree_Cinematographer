/** Deterministic environment-item animation. Every pose is a function of absolute scene time. */
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { PresetVisualV1 } from "../../src/types/environment";

type Point = [number, number, number];
const updates = new WeakMap<THREE.Object3D, (time: number) => void>();
const material = (color: string, metalness = 0, roughness = .7) =>
  new THREE.MeshStandardMaterial({ color, metalness, roughness });
const num = (v: PresetVisualV1, key: string, fallback: number) =>
  typeof v.params?.[key] === "number" && Number.isFinite(v.params[key]) ? v.params[key] as number : fallback;
const text = (v: PresetVisualV1, key: string, fallback: string) =>
  typeof v.params?.[key] === "string" ? v.params[key] as string : fallback;


const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));
const ease = (value: number): number => { const u = clamp01(value); return u * u * (3 - 2 * u); };
const positiveMod = (value: number, length: number): number => ((value % length) + length) % length;

/** Share the existing renderer update hook with detailed environment props.
 * Caching only avoids identical-time uploads; no integration/history is used.
 */
export function registerScenarioPropUpdate(object: THREE.Object3D, update: (time: number) => void): void {
  let previousTime = Number.NaN;
  updates.set(object, time => {
    if (time === previousTime) return;
    update(time);
    previousTime = time;
  });
}

export type MechanicalState = "running" | "stopping" | "stopped";
export function mechanicalState(time: number, stopTime: number, rampSeconds = 1): MechanicalState {
  if (![time, stopTime, rampSeconds].every(Number.isFinite) || rampSeconds <= 0) {
    throw new Error("Mechanical state requires finite times and a positive stop ramp");
  }
  return time < stopTime ? "running" : time < stopTime + rampSeconds ? "stopping" : "stopped";
}

/** Batch static parts by material; roller/robot/flag animation stays separate. */
class Parts {
  private buckets = new Map<THREE.Material, THREE.BufferGeometry[]>();
  add(g: THREE.BufferGeometry, m: THREE.Material, p: Point = [0,0,0], q?: THREE.Quaternion): void {
    if (q) g.applyQuaternion(q);
    g.translate(...p);
    const flat = g.index ? g.toNonIndexed() : g;
    if (flat !== g) g.dispose();
    const bucket = this.buckets.get(m) ?? [];
    bucket.push(flat); this.buckets.set(m, bucket);
  }
  box(size: Point, p: Point, m: THREE.Material): void { this.add(new THREE.BoxGeometry(...size), m, p); }
  cylinder(r: number, length: number, p: Point, m: THREE.Material, axis: "y" | "z" = "y"): void {
    this.add(new THREE.CylinderGeometry(r,r,length,12),m,p,axis === "z" ? new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0),Math.PI/2) : undefined);
  }
  finish(group = new THREE.Group()): THREE.Group {
    for (const [m, pieces] of this.buckets) {
      const geo = mergeGeometries(pieces, false);
      if (!geo) throw new Error("Could not merge procedural prop geometry");
      const mesh = new THREE.Mesh(geo,m); mesh.castShadow = mesh.receiveShadow = true; group.add(mesh);
      pieces.forEach(p=>p.dispose());
    }
    return group;
  }
}

function track(v: PresetVisualV1): THREE.Group {
  const half = num(v,"halfStraight",46), inner = num(v,"innerRadius",33), lanes = num(v,"lanes",6), width=num(v,"laneWidth",1.22);
  const group = new THREE.Group();
  function oval(r: number): THREE.Vector3[] {
    const points: THREE.Vector3[]=[];
    for(let i=0;i<=100;i++) { const a=Math.PI/2-i*Math.PI/100; points.push(new THREE.Vector3(half+r*Math.cos(a),.012,r*Math.sin(a))); }
    for(let i=0;i<=100;i++) { const a=-Math.PI/2-i*Math.PI/100; points.push(new THREE.Vector3(-half+r*Math.cos(a),.012,r*Math.sin(a))); }
    points.push(points[0].clone()); return points;
  }
  for(let lane=0;lane<lanes;lane++) {
    const a=oval(inner+lane*width),b=oval(inner+(lane+1)*width),p:number[]=[],ix:number[]=[];
    a.forEach((point,i)=>{p.push(point.x,0,point.z,b[i].x,0,b[i].z); if(i<a.length-1){const j=i*2;ix.push(j,j+1,j+2,j+1,j+3,j+2);}});
    const g=new THREE.BufferGeometry();g.setAttribute("position",new THREE.Float32BufferAttribute(p,3));g.setIndex(ix);g.computeVertexNormals();
    const m=material(lane%2?"#b05448":"#b95c4f"); m.side=THREE.DoubleSide;
    const mesh=new THREE.Mesh(g,m);mesh.receiveShadow=true;group.add(mesh);
  }
  // Painted strips, not screen-space lines: they keep physical width at every distance.
  for(let lane=0;lane<=lanes;lane++) {
    const a=oval(inner+lane*width-.035),b=oval(inner+lane*width+.035),p:number[]=[],ix:number[]=[];
    a.forEach((pt,i)=>{p.push(pt.x,.018,pt.z,b[i].x,.018,b[i].z);if(i<a.length-1){const j=i*2;ix.push(j,j+1,j+2,j+1,j+3,j+2);}});
    const g=new THREE.BufferGeometry();g.setAttribute("position",new THREE.Float32BufferAttribute(p,3));g.setIndex(ix);g.computeVertexNormals();
    const m=material("#f4e9dc");m.side=THREE.DoubleSide;group.add(new THREE.Mesh(g,m));
  }
  return group;
}

function flag(v: PresetVisualV1): THREE.Group {
  const group = new THREE.Group(), parts = new Parts(), steel = material("#becbd1", .65, .32);
  parts.cylinder(.045, 3.4, [0, 1.7, 0], steel);
  parts.box([.38, .08, .38], [0, .04, 0], steel);
  parts.add(new THREE.SphereGeometry(.075, 12, 8), steel, [0, 3.4, 0]);
  parts.finish(group);
  const canvas = document.createElement("canvas"); canvas.width = 512; canvas.height = 256;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Flag texture requires a 2D canvas context");
  ctx.fillStyle = text(v, "color", "#f1e8cd"); ctx.fillRect(0, 0, 512, 256);
  if (text(v, "label", "") === "FINISH") {
    for (let y = 0; y < 4; y++) for (let x = 0; x < 8; x++) if ((x + y) % 2 === 0) {
      ctx.fillStyle = "#243440"; ctx.fillRect(x * 64, y * 64, 64, 64);
    }
  } else {
    ctx.fillStyle = "#12364a"; ctx.textAlign = "center";
    ctx.font = "bold 80px sans-serif"; ctx.fillText("START", 256, 157);
  }
  ctx.strokeStyle = "rgba(240,235,213,0.75)"; ctx.lineWidth = 4; ctx.strokeRect(5, 5, 502, 246);
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
  const geo = new THREE.PlaneGeometry(1.6, .8, 24, 8); geo.translate(.8, 2.78, 0);
  const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: texture, side: THREE.DoubleSide, roughness: .94 }));
  mesh.castShadow = true; mesh.receiveShadow = true; group.add(mesh);
  const positions = geo.getAttribute("position") as THREE.BufferAttribute;
  positions.setUsage(THREE.DynamicDrawUsage);
  const rest = Float32Array.from(positions.array), phase = num(v, "phase", 0), strength = Math.max(0, Math.min(1.5, num(v, "windStrength", .75)));
  // Conservative bounds include every deformation; frozen/rewound frames cannot inherit old culling bounds.
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(.8, 2.74, 0), 1.05);
  registerScenarioPropUpdate(group, time => {
    const gust = strength * (.72 + .18 * Math.sin(time * .63) + .1 * Math.sin(time * 1.17 + .4));
    for (let i = 0; i < positions.count; i++) {
      const x = rest[i * 3], y = rest[i * 3 + 1], u = clamp01(x / 1.6);
      // Pin the entire hoist edge, add slow billow plus a smaller travelling edge ripple.
      const billow = Math.sin(4.6 * x - 3.2 * time + phase);
      const ripple = Math.sin(10.8 * x - 7.1 * time + phase + (y - 2.78) * 3);
      positions.setXYZ(i, x, y - .045 * u * u + gust * .018 * u * ripple,
        gust * u * (.16 * billow + .035 * ripple));
    }
    positions.needsUpdate = true; geo.computeVertexNormals();
  });
  return group;
}

function flower(v: PresetVisualV1): THREE.Group {
  const p = new Parts(), green = material("#438250"), petal = material(text(v, "color", "#f27b9a"), 0, .9);
  p.cylinder(.012, .4, [0, 0, 0], green);
  const seed = num(v, "seed", 0);
  for (let i = 0; i < 8; i++) {
    const angle = i * Math.PI / 4 + seed * .19;
    const g = new THREE.SphereGeometry(1, 8, 5); g.scale(.038, .023, .073);
    g.rotateY(-angle);
    p.add(g, petal, [Math.sin(angle) * .043, .2, Math.cos(angle) * .043]);
  }
  p.add(new THREE.SphereGeometry(.029, 10, 6), material("#ffc752"), [0, .212, 0]);
  for (const sign of [-1, 1]) {
    const leaf = new THREE.SphereGeometry(1, 8, 5); leaf.scale(.062, .009, .032); leaf.rotateZ(sign * .3);
    p.add(leaf, green, [sign * .037, -.025 + sign * .04, 0]);
  }
  return p.finish();
}

/** Integrated belt distance with the same one-second stop law as the baked cargo channels. */
export function conveyorTravel(time: number, speed: number, stopTime: number): number {
  if (![time, speed, stopTime].every(Number.isFinite)) throw new Error("Conveyor motion requires finite inputs");
  const t = Math.max(0, time), stop = Math.max(0, stopTime);
  if (t <= stop) return t * speed;
  const d = Math.min(1, t - stop);
  return speed * stop + speed * (d - d * d / 2);
}

/** Closed return loop, so belt slats do not teleport visibly from one exposed end to the other. */
export function conveyorSlatPose(distance: number, length: number, height: number, radius = .12): { x: number; y: number; angle: number } {
  if (![distance, length, height, radius].every(Number.isFinite) || length <= 0 || radius <= 0) {
    throw new Error("Belt loop requires finite values, positive length and positive radius");
  }
  let s = positiveMod(distance, 2 * length + 2 * Math.PI * radius);
  const top = height - .006;
  if (s < length) return { x: -length / 2 + s, y: top, angle: 0 };
  s -= length;
  if (s < Math.PI * radius) {
    const a = s / radius;
    return { x: length / 2 + radius * Math.sin(a), y: top - radius + radius * Math.cos(a), angle: -a };
  }
  s -= Math.PI * radius;
  if (s < length) return { x: length / 2 - s, y: top - 2 * radius, angle: -Math.PI };
  const a = (s - length) / radius;
  return { x: -length / 2 - radius * Math.sin(a), y: top - radius - radius * Math.cos(a), angle: -Math.PI - a };
}

function conveyor(v: PresetVisualV1): THREE.Group {
  const group = new THREE.Group(), p = new Parts();
  const steel = material("#516775", .65, .36), dark = material("#202b35", .3), yellow = material("#dfad35", .15);
  const length = Math.max(1, num(v, "length", 28)), width = Math.max(.7, num(v, "width", 1.8));
  const height = Math.max(.5, num(v, "height", 1.05)), speed = num(v, "speed", .55), stop = Math.max(0, num(v, "stopTime", 21.7));
  // Keep the end rollers inside the entity's existing length envelope.
  const loopLength = length - .4, rollerRadius = .12;
  for (const sign of [-1, 1]) {
    p.box([length, .22, .12], [0, height - .2, sign * width / 2], steel);
    p.box([length, .07, .055], [0, height + .09, sign * (width / 2 + .035)], yellow);
    for (let x = -length / 2 + .8; x < length / 2; x += 2.4) {
      p.box([.11, height - .2, .11], [x, (height - .2) / 2, sign * .68], steel);
      p.box([.3, .06, .32], [x, .03, sign * .68], steel);
      p.box([.035, .065, .07], [x, height - .2, sign * (width / 2 + .067)], yellow);
    }
  }
  p.box([loopLength, .065, width - .15], [0, height - .14, 0], dark);
  for (let x = -loopLength / 2 + .3; x < loopLength / 2; x += .6) p.cylinder(.085, width - .16, [x, height - .105, 0], steel, "z");
  for (const sign of [-1, 1]) p.cylinder(rollerRadius, width - .16, [sign * loopLength / 2, height - .126, 0], steel, "z");
  p.finish(group);
  const perimeter = 2 * loopLength + 2 * Math.PI * rollerRadius, count = Math.ceil(perimeter / .29);
  const slats = new THREE.InstancedMesh(new THREE.BoxGeometry(.22, .012, width - .18), material("#72838b", .48, .48), count);
  slats.instanceMatrix.setUsage(THREE.DynamicDrawUsage); slats.castShadow = true; slats.receiveShadow = true;
  slats.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, height - .12, 0), Math.hypot(length / 2 + .15, width / 2, .3));
  group.add(slats);
  const matrix = new THREE.Matrix4();
  registerScenarioPropUpdate(group, time => {
    const travel = conveyorTravel(time, speed, stop);
    for (let i = 0; i < count; i++) {
      const pose = conveyorSlatPose(i * perimeter / count + travel, loopLength, height, rollerRadius);
      matrix.makeRotationZ(pose.angle); matrix.setPosition(pose.x, pose.y, 0); slats.setMatrixAt(i, matrix);
    }
    slats.instanceMatrix.needsUpdate = true;
  });
  // Valid matrices before the first render, without relying on a future animation tick.
  updateScenarioProp(group, 0);
  return group;
}

export interface RobotJointPose { shoulder: number; swivel: number; elbow: number; wrist: number; jaw: number }
/** Pick/inspect/return staging with short dwells, all driven by the shared mechanical clock. */
export function robotJointPose(time: number, phase = 0, stopTime = 21.7, cycleSeconds = 5.2): RobotJointPose {
  if (![phase, cycleSeconds].every(Number.isFinite) || cycleSeconds <= 0) throw new Error("Robot cycle must be finite and positive");
  const u = positiveMod(conveyorTravel(time, 1, stopTime) / cycleSeconds + phase / (2 * Math.PI), 1);
  const keys = [
    [0, .38, -.12, .83, -.12, .07], [.18, .72, .06, 1.03, -.05, .07],
    [.28, .72, .06, 1.03, -.05, .012], [.46, .42, .12, .80, .12, .012],
    [.64, .59, -.10, .92, .22, .012], [.73, .59, -.10, .92, .22, .07],
    [.94, .38, -.12, .83, -.12, .07], [1, .38, -.12, .83, -.12, .07],
  ];
  let i = 0; while (i < keys.length - 2 && u > keys[i + 1][0]) i++;
  const a = keys[i], b = keys[i + 1], blend = ease((u - a[0]) / (b[0] - a[0]));
  const mix = (index: number): number => a[index] + (b[index] - a[index]) * blend;
  return { shoulder: mix(1), swivel: mix(2), elbow: mix(3), wrist: mix(4), jaw: mix(5) };
}

function robot(v: PresetVisualV1): THREE.Group {
  const group = new THREE.Group(), base = new Parts();
  const orange = material("#d89336", .35, .44), steel = material("#42515b", .65, .35), black = material("#26313a", .4);
  base.cylinder(.62, .3, [0, .15, 0], steel); base.box([.6, .85, .6], [0, .7, 0], orange);
  for (const x of [-.38, .38]) for (const z of [-.38, .38]) base.cylinder(.045, .055, [x, .31, z], black);
  base.finish(group);
  const shoulder = new THREE.Group(); shoulder.position.y = 1.1; group.add(shoulder);
  const arm = new Parts(); arm.cylinder(.25, .5, [0, 0, 0], steel, "z"); arm.box([.28, 1.35, .36], [0, .68, 0], orange);
  arm.box([.04, .95, .075], [.17, .69, 0], black); arm.finish(shoulder);
  const elbow = new THREE.Group(); elbow.position.y = 1.35; shoulder.add(elbow);
  const forearm = new Parts(); forearm.cylinder(.22, .5, [0, 0, 0], steel, "z"); forearm.box([.23, 1.15, .28], [0, .58, 0], orange);
  forearm.box([.035, .85, .05], [.14, .56, 0], black); forearm.finish(elbow);
  const wrist = new THREE.Group(); wrist.position.y = 1.16; elbow.add(wrist);
  const claw = new Parts(); claw.box([.34, .23, .3], [0, .11, 0], steel); claw.finish(wrist);
  const jaws: THREE.Mesh[] = [];
  for (const sign of [-1, 1]) {
    const jaw = new THREE.Mesh(new THREE.BoxGeometry(.055, .28, .09), steel); jaw.position.set(sign * .15, .32, 0); jaw.castShadow = true;
    jaws.push(jaw); wrist.add(jaw);
  }
  registerScenarioPropUpdate(group, time => {
    const pose = robotJointPose(time, num(v, "phase", 0), num(v, "stopTime", 21.7), num(v, "cycleSeconds", 5.2));
    shoulder.rotation.set(pose.shoulder, pose.swivel, 0); elbow.rotation.x = pose.elbow; wrist.rotation.x = pose.wrist;
    jaws[0].position.x = -.105 - pose.jaw; jaws[1].position.x = .105 + pose.jaw;
  });
  updateScenarioProp(group, 0);
  return group;
}

/** Two cloth halves retain their outer attachments and recoil at the actual winning lane. */
function finishRibbon(v: PresetVisualV1): THREE.Group {
  const group = new THREE.Group(), width = Math.max(.4, num(v, "width", 7.4)), half = width / 2;
  const cut = THREE.MathUtils.clamp(num(v, "crossOffset", -3.09), -half + .05, half - .05);
  const breakTime = num(v, "breakTime", 38), wind = Math.min(1.5, Math.max(0, num(v, "windStrength", .75)));
  const cloth = material(text(v, "color", "#f3e9ce"), 0, .96); cloth.side = THREE.DoubleSide;
  const pieces = [[-half, cut, -half], [cut, half, half]].map(([start, end, anchor]) => {
    const geometry = new THREE.PlaneGeometry(end - start, .12, Math.max(2, Math.ceil((end - start) / .14)), 2);
    geometry.rotateY(Math.PI / 2); geometry.translate(0, 0, (start + end) / 2);
    const positions = geometry.getAttribute("position") as THREE.BufferAttribute; positions.setUsage(THREE.DynamicDrawUsage);
    const mesh = new THREE.Mesh(geometry, cloth); mesh.castShadow = true; group.add(mesh);
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, -.4, 0), half + .6);
    return { geometry, positions, rest: Float32Array.from(positions.array), anchor };
  });
  registerScenarioPropUpdate(group, time => {
    const elapsed = Math.max(0, time - breakTime), release = ease(elapsed / .4);
    for (const piece of pieces) {
      const { geometry, positions, rest, anchor } = piece;
      for (let i = 0; i < positions.count; i++) {
        const y = rest[3 * i + 1], z = rest[3 * i + 2], u = clamp01((z - anchor) / (cut - anchor));
        const ripple = wind * Math.sin(8 * u - time * 6) * Math.exp(-elapsed * .8);
        positions.setXYZ(i,
          (1 - release) * .018 * Math.sin(z * 3 - time * 3.2) * Math.sin(Math.PI * u) + release * u * (.7 + .085 * ripple),
          y - .85 * release * Math.pow(u, .75) + .035 * release * u * ripple,
          z + (anchor - z) * .62 * release * Math.pow(u, .6));
      }
      positions.needsUpdate = true; geometry.computeVertexNormals();
    }
  });
  updateScenarioProp(group, 0);
  return group;
}

function signalTower(v: PresetVisualV1): THREE.Group {
  const group = new THREE.Group(), p = new Parts(), housing = material("#293741", .6, .35);
  p.cylinder(.13, .06, [0, .03, 0], housing); p.cylinder(.034, .25, [0, .17, 0], housing);
  const lenses = [material("#59bb80", .05, .25), material("#f1b846", .05, .25), material("#e36051", .05, .25)];
  lenses.forEach((paint, i) => {
    paint.emissive.copy(paint.color);
    p.cylinder(.11, .15, [0, .4 + i * .2, 0], paint);
    p.cylinder(.12, .035, [0, .305 + i * .2, 0], housing);
  });
  p.cylinder(.12, .045, [0, .902, 0], housing); p.finish(group);
  registerScenarioPropUpdate(group, time => {
    const state = mechanicalState(time, num(v, "stopTime", 21.7));
    lenses[0].emissiveIntensity = state === "running" ? .9 : .015;
    lenses[1].emissiveIntensity = state === "stopping" ? .75 + .15 * Math.sin(time * 5) : .015;
    lenses[2].emissiveIntensity = state === "stopped" ? .95 : .015;
  });
  updateScenarioProp(group, 0); return group;
}

export function createBroadcastCamera(): THREE.Group {
  const p=new Parts(),dark=material("#1b2530",.32,.42),metal=material("#87969d",.65,.32),glass=material("#193c50",.5,.12);
  p.box([.26,.23,.48],[0,0,0],dark);p.cylinder(.093,.19,[0,0,.33],dark,"z");p.cylinder(.078,.014,[0,0,.431],glass,"z");
  p.box([.10,.05,.32],[0,.18,-.04],metal);p.box([.055,.15,.055],[0,.09,-.18],metal);p.box([.11,.09,.16],[-.15,.09,-.12],dark);
  p.box([.035,.17,.23],[.17,.07,-.06],dark);p.box([.037,.12,.16],[.18,.07,-.06],glass);
  p.add(new THREE.SphereGeometry(.013,8,5),material("#f34345"),[.12,.09,.244]);
  return p.finish();
}
function scoreboard(v: PresetVisualV1): THREE.Group {
  const group = new THREE.Group(), width = num(v, "width", 8), height = num(v, "height", 3);
  const housing = new THREE.Mesh(new THREE.BoxGeometry(width + .2, height + .2, .25), material("#223b48", .4)); group.add(housing);
  const canvas = document.createElement("canvas"); canvas.width = 1024; canvas.height = 384;
  const ctx = canvas.getContext("2d"); if (!ctx) throw new Error("Scoreboard requires a 2D canvas context");
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(width, height), new THREE.MeshBasicMaterial({ map: texture }));
  screen.position.z = .132; group.add(screen);
  let last = "";
  registerScenarioPropUpdate(group, time => {
    const sports = text(v, "kind", "stadium") === "stadium";
    const goal = time >= num(v, "goalTime", 38.2), finish = time >= num(v, "finishTime", 38);
    const state = mechanicalState(time, num(v, "stopTime", 21.7), Math.max(.01, num(v, "rampSeconds", 1)));
    const key = `${Math.floor(time * 10)}-${goal}-${finish}-${state}`;
    if (key === last) return; last = key;
    ctx.fillStyle = "#10252d"; ctx.fillRect(0, 0, 1024, 384); ctx.textAlign = "center";
    ctx.fillStyle = "#77cfba"; ctx.font = "bold 36px sans-serif";
    ctx.fillText(sports ? "ATHLETICS  /  FOOTBALL" : "ASSEMBLY LINE  01", 512, 67);
    ctx.fillStyle = sports ? "#f8efcf" : state === "running" ? "#79ddb8" : state === "stopping" ? "#f1bd67" : "#ff9879";
    ctx.font = "bold 100px sans-serif";
    ctx.fillText(sports ? (goal ? "RED   1 : 0   BLUE" : "RED   0 : 0   BLUE") : state === "running" ? "RUNNING" : state === "stopping" ? "STOPPING" : "STOPPED", 512, 218, 940);
    ctx.font = "30px sans-serif"; ctx.fillStyle = "#e1ece7";
    const footer = sports
      ? `${goal ? "GOAL!  /  " : ""}${finish ? "RUNNER 01 WINS" : `RACE ${Math.max(0, time - 2).toFixed(1)} s`}`
      : state === "running" ? "PRESS  >  ASSEMBLE  >  INSPECT  >  PACK"
        : state === "stopping" ? "SAFETY COMMAND  /  CONTROLLED RAMP-DOWN" : "LINE SECURED  /  CREW RESPONSE";
    ctx.fillText(footer, 512, 328, 970); texture.needsUpdate = true;
  });
  updateScenarioProp(group, 0); return group;
}

export function createScenarioPreset(v: PresetVisualV1): THREE.Object3D | null {
  switch (v.name) {
    case "stadiumTrack": return track(v);
    case "raceFlag": return flag(v);
    case "flower": return flower(v);
    case "productionLine": return conveyor(v);
    case "industrialRobot": return robot(v);
    case "broadcastCamera": return createBroadcastCamera();
    case "scoreboard": return scoreboard(v);
    // Parameterised environment items use the existing genericObject schema.
    case "genericObject": {
      const kind = text(v, "propKind", "");
      return kind === "finishRibbon" ? finishRibbon(v) : kind === "signalTower" ? signalTower(v) : null;
    }
    default: return null;
  }
}
export function updateScenarioProp(object: THREE.Object3D, time: number): void {
  if (!Number.isFinite(time)) throw new Error("Environment item time must be finite");
  updates.get(object)?.(Math.max(0, time));
}
