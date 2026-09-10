import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";

import type { SceneEntityV1, Vec3 } from "../../src/types/environment";

type Material = THREE.MeshStandardMaterial;
type Dimensions = [number, number, number];

function material(color: THREE.ColorRepresentation, metalness = 0, roughness = 0.8): Material {
  return new THREE.MeshStandardMaterial({ color, metalness, roughness });
}

/** Repeated hardware shares geometry and is submitted in one draw call per material. */
class PropBuilder {
  private readonly boxGeometry = new THREE.BoxGeometry(1, 1, 1);
  private readonly roundedGeometry = new RoundedBoxGeometry(1, 1, 1, 2, 0.045);
  private readonly cylinderGeometry = new THREE.CylinderGeometry(1, 1, 1, 16);
  private readonly sphereGeometry = new THREE.SphereGeometry(1, 12, 8);
  private readonly batches = new Map<THREE.BufferGeometry, Map<Material, THREE.Matrix4[]>>();

  private part(geometry: THREE.BufferGeometry, paint: Material, size: Dimensions, position: Vec3, rotation?: THREE.Quaternion): void {
    let paints = this.batches.get(geometry);
    if (!paints) this.batches.set(geometry, paints = new Map());
    let transforms = paints.get(paint);
    if (!transforms) paints.set(paint, transforms = []);
    transforms.push(new THREE.Matrix4().compose(
      new THREE.Vector3(...position), rotation ?? new THREE.Quaternion(), new THREE.Vector3(...size),
    ));
  }

  box(size: Dimensions, position: Vec3, paint: Material, rounded = false): void {
    this.part(rounded ? this.roundedGeometry : this.boxGeometry, paint, size, position);
  }

  cylinder(radius: number, height: number, position: Vec3, paint: Material, axis: "x" | "y" | "z" = "y"): void {
    const rotation = axis === "y" ? undefined : new THREE.Quaternion().setFromAxisAngle(
      new THREE.Vector3(axis === "x" ? 0 : 1, 0, axis === "x" ? 1 : 0), Math.PI / 2,
    );
    this.part(this.cylinderGeometry, paint, [radius, height, radius], position, rotation);
  }

  ellipsoid(size: Dimensions, position: Vec3, paint: Material): void {
    this.part(this.sphereGeometry, paint, size, position);
  }

  rod(start: Vec3, end: Vec3, radius: number, paint: Material): void {
    const a = new THREE.Vector3(...start);
    const b = new THREE.Vector3(...end);
    const direction = b.clone().sub(a);
    this.part(this.cylinderGeometry, paint, [radius, direction.length(), radius],
      a.add(b).multiplyScalar(0.5).toArray(),
      new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize()));
  }

  finish(): THREE.Group {
    const group = new THREE.Group();
    for (const [geometry, paints] of this.batches) {
      for (const [paint, transforms] of paints) {
        const mesh = new THREE.InstancedMesh(geometry, paint, transforms.length);
        transforms.forEach((matrix, index) => mesh.setMatrixAt(index, matrix));
        mesh.instanceMatrix.needsUpdate = true;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        group.add(mesh);
      }
    }
    // These helpers are allocated once per prop; unused geometries never reach the renderer.
    for (const geometry of [this.boxGeometry, this.roundedGeometry, this.cylinderGeometry, this.sphereGeometry]) {
      if (!this.batches.has(geometry)) geometry.dispose();
    }
    return group;
  }
}

function tree(builder: PropBuilder, [w, h, d]: Dimensions): void {
  const bark = material("#584638");
  const leaves = [material("#394d2e"), material("#52603a"), material("#657246")];
  builder.cylinder(w * 0.1, h * 0.85, [0, -h * 0.075, 0], bark);
  // A columnar tree suits the narrow authored trunk envelope without adding camera obstacles.
  for (let level = 0; level < 8; level++) {
    const y = -h * 0.2 + level * h * 0.079;
    const spread = Math.sin((level + 1) / 9 * Math.PI) * 0.25 + 0.04;
    for (let side = 0; side < 3; side++) {
      const angle = level * 1.7 + side * Math.PI * 2 / 3;
      const x = Math.cos(angle) * w * spread;
      const z = Math.sin(angle) * d * spread;
      builder.rod([0, y - h * 0.06, 0], [x, y, z], w * 0.023, bark);
      builder.ellipsoid([w * 0.18, h * (0.06 + (level % 2) * 0.012), d * 0.18], [x, y, z], leaves[(level + side) % 3]);
    }
  }
}

function fountain(builder: PropBuilder, [w, h, d]: Dimensions): void {
  const r = Math.min(w, d) * 0.5;
  const stone = material("#9b9b8d", 0, 0.87);
  const edge = material("#bdbbae", 0, 0.72);
  const water = material("#346e72", 0.32, 0.12);
  const foam = material("#b8d5cc", 0.12, 0.24);
  builder.cylinder(r, h * 0.14, [0, -h * 0.43, 0], stone);
  builder.cylinder(r * 0.88, h * 0.44, [0, -h * 0.14, 0], stone);
  builder.cylinder(r * 0.79, h * 0.025, [0, h * 0.09, 0], water);
  // Individual cut stones expose mortar joints around the coping.
  for (let i = 0; i < 24; i++) {
    const angle = i * Math.PI / 12;
    const next = angle + Math.PI / 12 * 0.96;
    builder.rod([Math.cos(angle) * r * 0.87, h * 0.12, Math.sin(angle) * r * 0.87],
      [Math.cos(next) * r * 0.87, h * 0.12, Math.sin(next) * r * 0.87], r * 0.09, edge);
  }
  builder.cylinder(r * 0.13, h * 0.64, [0, h * 0.12, 0], stone);
  builder.cylinder(r * 0.32, h * 0.07, [0, h * 0.42, 0], edge);
  builder.cylinder(r * 0.27, h * 0.02, [0, h * 0.464, 0], water);
  for (let i = 0; i < 8; i++) {
    const angle = i * Math.PI / 4;
    const x = Math.cos(angle) * r * 0.28;
    const z = Math.sin(angle) * r * 0.28;
    builder.rod([x, h * 0.42, z], [x * 1.3, h * 0.12, z * 1.3], r * 0.009, foam);
  }
}

function lamp(builder: PropBuilder, [w, h, d]: Dimensions): void {
  const iron = material("#303832", 0.7, 0.45);
  const bronze = material("#5c5a46", 0.65, 0.4);
  const glass = material("#e8dfb1", 0.12, 0.24);
  glass.emissive.set("#ffcf83");
  glass.emissiveIntensity = 0.65;
  const r = Math.min(w, d);
  builder.cylinder(r * 0.46, h * 0.035, [0, -h * 0.4825, 0], iron);
  builder.cylinder(r * 0.25, h * 0.79, [0, -h * 0.07, 0], iron);
  builder.cylinder(r * 0.35, h * 0.025, [0, h * 0.33, 0], bronze);
  builder.box([w * 0.65, h * 0.13, d * 0.65], [0, h * 0.4, 0], glass, true);
  for (const x of [-1, 1]) for (const z of [-1, 1]) {
    builder.box([w * 0.08, h * 0.14, d * 0.08], [x * w * 0.35, h * 0.4, z * d * 0.35], iron);
  }
  builder.box([w, h * 0.025, d], [0, h * 0.482, 0], iron, true);
}

function hvac(builder: PropBuilder, [w, h, d]: Dimensions): void {
  const casing = material("#969b98", 0.5, 0.58);
  const metal = material("#545d5f", 0.72, 0.5);
  const dark = material("#252f31", 0.35, 0.8);
  builder.box([w * 0.94, h * 0.9, d * 0.94], [0, h * 0.015, 0], casing, true);
  for (const x of [-1, 1]) builder.box([w * 0.13, h * 0.08, d], [x * w * 0.32, -h * 0.46, 0], metal);
  builder.box([w * 0.78, h * 0.61, d * 0.03], [0, h * 0.025, d * 0.48], dark);
  for (let i = 0; i < 12; i++) {
    builder.box([w * 0.76, h * 0.012, d * 0.045], [0, -h * 0.26 + i * h * 0.052, d * 0.477], metal);
  }
  const r = Math.min(w, d) * 0.32;
  builder.cylinder(r, h * 0.012, [0, h * 0.477, 0], dark);
  for (let i = -4; i <= 4; i++) {
    const offset = i * r * 0.19;
    const span = Math.sqrt(r * r - offset * offset) * 1.95;
    builder.box([span, h * 0.006, d * 0.009], [0, h * 0.49, offset], metal);
    builder.box([w * 0.009, h * 0.006, span], [offset, h * 0.49, 0], metal);
  }
  builder.box([w * 0.16, h * 0.045, d * 0.008], [w * 0.26, h * 0.377, d * 0.473], dark);
}

function vent(builder: PropBuilder, [w, h, d]: Dimensions): void {
  const zinc = material("#a0a6a2", 0.8, 0.47);
  const seams = material("#626c6b", 0.75, 0.44);
  const dark = material("#283033", 0.35, 0.8);
  const r = Math.min(w, d) * 0.5;
  builder.cylinder(r * 0.64, h * 0.92, [0, -h * 0.04, 0], zinc);
  for (const y of [-0.4, -0.1, 0.2]) builder.cylinder(r * 0.71, h * 0.018, [0, h * y, 0], seams);
  builder.cylinder(r * 0.84, h * 0.03, [0, h * 0.39, 0], zinc);
  builder.cylinder(r * 0.55, h * 0.07, [0, h * 0.44, 0], dark);
  builder.cylinder(r, h * 0.025, [0, h * 0.4875, 0], zinc);
  for (const x of [-1, 1]) builder.box([w * 0.07, h * 0.08, d * 0.07], [x * w * 0.31, h * 0.44, 0], seams);
}

function crate(builder: PropBuilder, size: Dimensions, center: Vec3, wood: Material, trim: Material): void {
  const [w, h, d] = size;
  const [x, y, z] = center;
  builder.box([w * 0.94, h * 0.94, d * 0.94], center, wood, true);
  for (const face of [-1, 1]) {
    for (const edge of [-1, 1]) {
      builder.box([w * 0.09, h, d * 0.04], [x + edge * w * 0.4, y, z + face * d * 0.48], trim);
      builder.box([w * 0.04, h, d * 0.09], [x + face * w * 0.48, y, z + edge * d * 0.4], trim);
    }
    for (const edge of [-1, 1]) builder.box([w, h * 0.08, d * 0.04], [x, y + edge * h * 0.44, z + face * d * 0.48], trim);
  }
}

function shelving(builder: PropBuilder, [w, h, d]: Dimensions): void {
  const steel = material("#555f61", 0.7, 0.55);
  const beams = material("#9b6842", 0.5, 0.68);
  const pallets = material("#998365");
  const cartons = [material("#ab9674"), material("#827b67"), material("#a2977f")];
  const labels = material("#d0cabc");
  const post = Math.min(w * 0.085, 0.085);
  const bays = Math.max(2, Math.min(4, Math.round(d / 2)));
  const levels = h > 3 ? 4 : 3;
  for (const x of [-1, 1]) for (let bay = 0; bay <= bays; bay++) {
    builder.box([post, h, post], [x * (w - post) * 0.5, 0, -d * 0.5 + post * 0.5 + bay * (d - post) / bays], steel);
  }
  for (let level = 0; level < levels; level++) {
    const y = -h * 0.46 + level * h * 0.245;
    builder.box([w * 0.95, h * 0.018, d * 0.98], [0, y, 0], steel);
    for (const x of [-1, 1]) builder.box([post, h * 0.038, d], [x * (w - post) * 0.5, y, 0], beams);
    for (let bay = 0; bay < bays; bay++) {
      const z = -d * 0.5 + (bay + 0.5) * d / bays;
      const height = h * (0.13 + ((level + bay) % 3) * 0.025);
      const boxWidth = w * (0.67 + ((level + bay) % 2) * 0.1);
      builder.box([w * 0.84, h * 0.022, d / bays * 0.84], [0, y + h * 0.02, z], pallets);
      builder.box([boxWidth, height, d / bays * 0.72], [0, y + h * 0.033 + height * 0.5, z], cartons[(bay + level) % 3], true);
      for (const x of [-1, 1]) builder.box([w * 0.004, height * 0.23, d / bays * 0.23], [x * (boxWidth * 0.5 + w * 0.003), y + h * 0.035 + height * 0.58, z], labels);
    }
  }
}

function machine(builder: PropBuilder, [w, h, d]: Dimensions): void {
  const paint = material("#66776d", 0.45, 0.6);
  const dark = material("#293234", 0.65, 0.58);
  const steel = material("#9ca5a2", 0.8, 0.32);
  const label = material("#c0b68d");
  const screen = material("#2d5550", 0.1, 0.26);
  screen.emissive.set("#6ab298");
  screen.emissiveIntensity = 0.18;
  builder.box([w, h * 0.1, d], [0, -h * 0.45, 0], dark, true);
  builder.box([w * 0.95, h * 0.38, d * 0.94], [0, -h * 0.21, 0], paint, true);
  builder.box([w * 0.45, h * 0.58, d * 0.8], [w * 0.235, h * 0.21, -d * 0.05], paint, true);
  builder.box([w * 0.47, h * 0.26, d * 0.45], [-w * 0.235, h * 0.28, -d * 0.21], dark, true);
  for (const x of [-0.405, -0.075]) builder.cylinder(w * 0.025, h * 0.45, [w * x, h * 0.185, d * 0.08], steel);
  builder.box([w * 0.43, h * 0.045, d * 0.45], [-w * 0.235, h * 0.02, d * 0.08], steel);
  builder.box([w * 0.36, h * 0.25, d * 0.06], [w * 0.235, h * 0.27, d * 0.38], dark, true);
  builder.box([w * 0.21, h * 0.12, d * 0.013], [w * 0.20, h * 0.30, d * 0.419], screen);
  const red = material("#95483c", 0.12, 0.4);
  for (let i = 0; i < 4; i++) builder.cylinder(w * 0.012, d * 0.025, [w * (0.11 + i * 0.07), h * 0.20, d * 0.425], i === 3 ? red : steel, "z");
  for (let i = 0; i < 8; i++) builder.box([w * 0.26, h * 0.013, d * 0.008], [w * 0.235, -h * 0.31 + i * h * 0.028, d * 0.475], dark);
  builder.box([w * 0.12, h * 0.045, d * 0.009], [-w * 0.25, -h * 0.17, d * 0.475], label);
}

function loadingBay(builder: PropBuilder, [w, h, d]: Dimensions): void {
  const steel = material("#545b5b", 0.65, 0.55);
  const rubber = material("#292c2a");
  const shutter = material("#969c98", 0.62, 0.6);
  const warning = material("#c1a14a", 0.12, 0.7);
  for (const side of [-1, 1]) {
    builder.box([w * 0.9, h, d * 0.065], [0, 0, side * d * 0.4675], steel);
    builder.box([w, h * 0.26, d * 0.085], [0, -h * 0.35, side * d * 0.425], rubber, true);
    for (let i = 0; i < 4; i++) builder.box([w * 0.013, h * 0.023, d * 0.083], [-w * 0.499, -h * 0.43 + i * h * 0.055, side * d * 0.425], warning);
  }
  builder.box([w, h * 0.12, d], [0, h * 0.44, 0], steel);
  for (let i = 0; i < 7; i++) builder.box([w * 0.12, h * 0.034, d * 0.87], [w * 0.2, h * 0.38 - i * h * 0.037, 0], shutter, true);
}

function briefcase(builder: PropBuilder, [w, h, d]: Dimensions): void {
  const leather = material("#644d33", 0.04, 0.72);
  const edging = material("#352d24", 0.12, 0.63);
  const brass = material("#a18d59", 0.75, 0.34);
  builder.box([w, h * 0.81, d], [0, -h * 0.095, 0], leather, true);
  builder.box([w * 0.995, h * 0.022, d * 0.995], [0, h * 0.13, 0], edging);
  for (const x of [-1, 1]) {
    builder.box([w * 0.1, h * 0.13, d * 0.045], [x * w * 0.3, h * 0.11, d * 0.47], brass, true);
    builder.box([w * 0.027, h * 0.16, d * 0.23], [x * w * 0.17, h * 0.38, 0], brass, true);
  }
  builder.box([w * 0.37, h * 0.065, d * 0.27], [0, h * 0.4675, 0], edging, true);
}

const PROP_IDS = new Set([
  "tree-entity", "fountain-entity", "lamppost-entity", "desk-entity", "shelving-entity",
  "crate-stack-entity", "ac-unit-entity", "vent-pipe-entity", "central_machine",
  "shelf_left", "shelf_right", "loading_bay_frame", "briefcase-entity",
]);

/** Refine bundled box placeholders while retaining their local collision/anchor envelope. */
export function createEnvironmentProp(entity: SceneEntityV1): THREE.Object3D | null {
  if (!PROP_IDS.has(entity.id)) return null;
  const visual = entity.visual;
  const isPlaceholder = (visual.type === "primitive" && visual.shape === "box")
    || (visual.type === "preset" && visual.name === "genericObject" && visual.params?.shape === "box");
  if (!isPlaceholder) return null;
  if (entity.bounds?.type !== "box") return null;
  const bounds = entity.bounds;
  const size = bounds.max.map((value, axis) => value - bounds.min[axis]) as Dimensions;
  if (!size.every(value => Number.isFinite(value) && value > 0)) return null;
  const builder = new PropBuilder();
  switch (entity.id) {
    case "tree-entity": tree(builder, size); break;
    case "fountain-entity": fountain(builder, size); break;
    case "lamppost-entity": lamp(builder, size); break;
    case "ac-unit-entity": hvac(builder, size); break;
    case "vent-pipe-entity": vent(builder, size); break;
    case "shelving-entity": case "shelf_left": case "shelf_right": shelving(builder, size); break;
    case "central_machine": machine(builder, size); break;
    case "loading_bay_frame": loadingBay(builder, size); break;
    case "briefcase-entity": briefcase(builder, size); break;
    case "crate-stack-entity": {
      const wood = material("#8e7754");
      const trim = material("#b09a71");
      crate(builder, [size[0] * 0.56, size[1], size[2]], [-size[0] * 0.22, 0, 0], wood, trim);
      crate(builder, [size[0] * 0.4, size[1] * 0.76, size[2] * 0.82], [size[0] * 0.3, -size[1] * 0.12, size[2] * 0.03], trim, wood);
      break;
    }
    case "desk-entity": {
      const [w, h, d] = size;
      const color = visual.type === "primitive" ? visual.color ?? "#755440" : "#755440";
      const authoredSize = visual.type === "primitive" ? visual.params.size : undefined;
      const authoredThickness = Array.isArray(authoredSize) ? authoredSize[1] : undefined;
      const thickness = THREE.MathUtils.clamp(
        typeof authoredThickness === "number" && Number.isFinite(authoredThickness) ? authoredThickness : h * 0.16,
        h * 0.025, h * 0.45,
      );
      const timber = material("#483426");
      const topY = h * 0.5;
      const undersideY = topY - thickness;
      const legHeight = h - thickness;
      const legWidth = Math.min(w, d) * 0.065;
      const inset = legWidth * 1.45;
      const legX = w * 0.5 - inset;
      const legZ = d * 0.5 - inset;
      builder.box([w, thickness * 0.92, d], [0, topY - thickness * 0.54, 0], timber, true);
      builder.box([w * 0.994, thickness * 0.08, d * 0.986], [0, topY - thickness * 0.04, 0], material(color), true);
      for (const x of [-1, 1]) for (const z of [-1, 1]) {
        builder.box([legWidth, legHeight, legWidth], [x * legX, -h * 0.5 + legHeight * 0.5, z * legZ], timber, true);
      }
      const apronHeight = Math.min(legHeight * 0.23, thickness * 0.85);
      for (const side of [-1, 1]) {
        builder.box([legX * 2, apronHeight, legWidth * 0.48], [0, undersideY - apronHeight * 0.5, side * legZ], timber);
        builder.box([legWidth * 0.48, apronHeight, legZ * 2], [side * legX, undersideY - apronHeight * 0.5, 0], timber);
      }
      const seam = material("#563e2d");
      seam.polygonOffset = true;
      seam.polygonOffsetFactor = -1;
      seam.polygonOffsetUnits = -1;
      for (let i = 1; i < 7; i++) builder.box([w * 0.985, thickness * 0.002, d * 0.0015], [0, topY - thickness * 0.001, d * (i / 7 - 0.5)], seam);
      break;
    }
  }
  const group = builder.finish();
  group.name = `environment-prop:${entity.id}`;
  // Guard even rounded geometry and future details against extending the authored envelope.
  const actual = new THREE.Box3().setFromObject(group);
  const actualSize = actual.getSize(new THREE.Vector3());
  const actualCenter = actual.getCenter(new THREE.Vector3());
  group.scale.set(...size.map((value, axis) => Math.min(1, value / actualSize.getComponent(axis))) as Vec3);
  group.position.set(...bounds.min.map((value, axis) =>
    (value + bounds.max[axis]) * 0.5 - actualCenter.getComponent(axis) * group.scale.getComponent(axis)) as Vec3);
  return group;
}
