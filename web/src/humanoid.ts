import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

import { createBroadcastCamera } from "./scenario-props";

import type { PresetVisualV1 } from "../../src/types/environment";

/** Bone rotations are relative to a relaxed standing pose, with the face toward +Z. */
export interface HumanoidRig {
  root: THREE.Group;
  hips: THREE.Bone;
  spine: THREE.Bone;
  head: THREE.Bone;
  leftUpperArm: THREE.Bone;
  leftForearm: THREE.Bone;
  leftHand: THREE.Bone;
  rightUpperArm: THREE.Bone;
  rightForearm: THREE.Bone;
  rightHand: THREE.Bone;
  leftThigh: THREE.Bone;
  leftShin: THREE.Bone;
  leftFoot: THREE.Bone;
  rightThigh: THREE.Bone;
  rightShin: THREE.Bone;
  rightFoot: THREE.Bone;
}

const rigs = new WeakMap<THREE.Object3D, HumanoidRig>();

export function getHumanoidRig(root: THREE.Object3D): HumanoidRig | undefined {
  return rigs.get(root);
}

type Point = readonly [number, number, number];
type Influence = readonly [THREE.Bone, number];
type Weights = (position: THREE.Vector3) => readonly Influence[];
type Section = readonly [number, number, number, number, number];
const TAU = Math.PI * 2;

function smoothstep(min: number, max: number, value: number): number {
  const t = THREE.MathUtils.clamp((value - min) / (max - min), 0, 1);
  return t * t * (3 - 2 * t);
}

function paramColor(visual: PresetVisualV1, key: string, fallback: string): string {
  const value = visual.params?.[key];
  return typeof value === "string" ? value : fallback;
}

function material(name: string, value: THREE.ColorRepresentation, roughness = 0.8): THREE.MeshStandardMaterial {
  const surface = new THREE.MeshStandardMaterial({ color: value, roughness });
  surface.name = name;
  return surface;
}

function smoothRingSeams(geometry: THREE.BufferGeometry, rings: number, sides: number): void {
  const normals = geometry.getAttribute("normal");
  const normal = new THREE.Vector3();
  const other = new THREE.Vector3();
  for (let ring = 0; ring < rings; ring += 1) {
    const first = ring * (sides + 1);
    const last = first + sides;
    normal.fromBufferAttribute(normals, first).add(other.fromBufferAttribute(normals, last)).normalize();
    normals.setXYZ(first, normal.x, normal.y, normal.z);
    normals.setXYZ(last, normal.x, normal.y, normal.z);
  }
}

/** Merge by material while retaining the weights, so moving joints do not add draw calls. */
class SkinnedModel {
  private readonly parts = new Map<THREE.Material, THREE.BufferGeometry[]>();
  private readonly boneIndices: Map<THREE.Bone, number>;

  constructor(private readonly bones: THREE.Bone[]) {
    this.boneIndices = new Map(bones.map((bone, index) => [bone, index]));
  }

  add(geometry: THREE.BufferGeometry, surface: THREE.Material, weights: Weights): void {
    const part = geometry.index ? geometry.toNonIndexed() : geometry;
    if (part !== geometry) geometry.dispose();
    if (!part.hasAttribute("uv")) {
      part.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array(part.getAttribute("position").count * 2), 2));
    }
    const positions = part.getAttribute("position");
    const indices = new Uint16Array(positions.count * 4);
    const values = new Float32Array(positions.count * 4);
    const skinColors = surface.name === "skin" ? new Float32Array(positions.count * 3) : undefined;
    const point = new THREE.Vector3();
    for (let vertex = 0; vertex < positions.count; vertex += 1) {
      point.fromBufferAttribute(positions, vertex);
      if (skinColors) {
        const front = smoothstep(0.015, 0.07, point.z);
        let shade = 0;
        let warmth = 0;
        for (const side of [-1, 1]) {
          shade += 0.11 * gaussian(point.x, point.y, side * 0.045, 1.762, 0.027, 0.007);
          shade += 0.035 * gaussian(point.x, point.y, side * 0.046, 1.740, 0.028, 0.010);
          warmth += 0.055 * gaussian(point.x, point.y, side * 0.070, 1.705, 0.037, 0.025);
          shade += 0.05 * gaussian(point.x, point.y, side * 0.020, 1.701, 0.008, 0.008);
        }
        shade += 0.065 * gaussian(point.x, point.y, 0, 1.650, 0.028, 0.006);
        shade += 0.045 * gaussian(point.x, point.y, 0, 1.685, 0.010, 0.008);
        skinColors[vertex * 3] = 1 - shade * front;
        skinColors[vertex * 3 + 1] = 1 - (shade + warmth) * front;
        skinColors[vertex * 3 + 2] = 1 - (shade + warmth * 1.25) * front;
      }
      for (const [influence, [bone, weight]] of weights(point).entries()) {
        indices[vertex * 4 + influence] = this.boneIndices.get(bone)!;
        values[vertex * 4 + influence] = weight;
      }
    }
    part.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(indices, 4));
    part.setAttribute("skinWeight", new THREE.Float32BufferAttribute(values, 4));
    if (skinColors) part.setAttribute("color", new THREE.Float32BufferAttribute(skinColors, 3));
    const bucket = this.parts.get(surface) ?? [];
    bucket.push(part);
    this.parts.set(surface, bucket);
  }

  ellipsoid(size: Point, position: Point, surface: THREE.Material, bone: THREE.Bone, segments = 20): void {
    const geometry = new THREE.SphereGeometry(1, segments, 12);
    geometry.scale(...size).translate(...position);
    this.add(geometry, surface, () => [[bone, 1]]);
  }

  finish(root: THREE.Group): void {
    root.updateMatrixWorld(true);
    const skeleton = new THREE.Skeleton(this.bones);
    for (const [surface, parts] of this.parts) {
      const geometry = mergeGeometries(parts, false);
      if (!geometry) throw new Error("Could not merge humanoid geometry");
      const mesh = new THREE.SkinnedMesh(geometry, surface);
      mesh.name = `humanoid-${surface.name}`;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      // The posed bounds vary during a stride; these few small meshes should not be
      // culled using their original standing-pose bounding sphere.
      mesh.frustumCulled = false;
      root.add(mesh);
      mesh.bind(skeleton);
      for (const part of parts) part.dispose();
    }
  }
}

/** A smooth elliptical sweep; each section is [y, centerX, centerZ, radiusX, radiusZ]. */
function sweep(sections: readonly Section[], sides = 24): THREE.BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  const uv: number[] = [];
  for (const [ring, [y, x, z, rx, rz]] of sections.entries()) {
    for (let side = 0; side <= sides; side += 1) {
      const angle = side / sides * TAU;
      positions.push(x + Math.sin(angle) * rx, y, z + Math.cos(angle) * rz);
      uv.push(side / sides, ring / (sections.length - 1));
      if (ring > 0 && side > 0) {
        const i = ring * (sides + 1) + side;
        indices.push(i - 1, i - sides - 1, i, i - 1, i - sides - 2, i - sides - 1);
      }
    }
  }
  // End caps are inconspicuous under sleeves, at the waist and inside the shoes.
  for (const ring of [0, sections.length - 1]) {
    const [y, x, z] = sections[ring]!;
    const center = positions.length / 3;
    positions.push(x, y, z);
    uv.push(0.5, 0.5);
    for (let side = 0; side < sides; side += 1) {
      const a = ring * (sides + 1) + side;
      if (ring === 0) indices.push(center, a + 1, a);
      else indices.push(center, a, a + 1);
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  smoothRingSeams(geometry, sections.length, sides);
  return geometry;
}

function ribbon(points: Point[], widths: number[], direction: THREE.Vector3): THREE.BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  for (const [i, point] of points.entries()) {
    const p = new THREE.Vector3(...point);
    for (const side of [-1, 1]) positions.push(...p.clone().addScaledVector(direction, side * widths[i]!).toArray());
    if (i > 0) indices.push(i * 2 - 2, i * 2, i * 2 - 1, i * 2, i * 2 + 1, i * 2 - 1);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

// Continuous skull cross sections give the face a jaw, temples and a chin instead
// of overlapping spheres. Front and back depths are intentionally asymmetric.
const HEAD_PROFILE: readonly (readonly [number, number, number, number])[] = [
  [1.571, 0.030, 0.052, 0.027],
  [1.582, 0.051, 0.077, -0.008],
  [1.603, 0.073, 0.084, -0.049],
  [1.635, 0.091, 0.089, -0.076],
  [1.680, 0.105, 0.094, -0.098],
  [1.718, 0.112, 0.101, -0.112],
  [1.759, 0.109, 0.099, -0.119],
  [1.805, 0.104, 0.104, -0.119],
  [1.846, 0.090, 0.091, -0.106],
  [1.878, 0.053, 0.055, -0.070],
  [1.890, 0.002, -0.006, -0.010],
];

function headSection(y: number): [number, number, number] {
  const i = HEAD_PROFILE.findIndex((entry) => entry[0] >= y);
  if (i <= 0) return HEAD_PROFILE[i < 0 ? HEAD_PROFILE.length - 1 : 0]!.slice(1) as [number, number, number];
  const a = HEAD_PROFILE[i - 1]!;
  const b = HEAD_PROFILE[i]!;
  const t = (y - a[0]) / (b[0] - a[0]);
  const previous = HEAD_PROFILE[Math.max(0, i - 2)]!;
  const next = HEAD_PROFILE[Math.min(HEAD_PROFILE.length - 1, i + 1)]!;
  const t2 = t * t;
  const t3 = t2 * t;
  return [1, 2, 3].map((axis) => {
    const tangentA = (b[axis]! - previous[axis]!) / (b[0] - previous[0]) * (b[0] - a[0]);
    const tangentB = (next[axis]! - a[axis]!) / (next[0] - a[0]) * (b[0] - a[0]);
    return (2 * t3 - 3 * t2 + 1) * a[axis]! + (t3 - 2 * t2 + t) * tangentA
      + (-2 * t3 + 3 * t2) * b[axis]! + (t3 - t2) * tangentB;
  }) as [number, number, number];
}

function gaussian(x: number, y: number, cx: number, cy: number, sx: number, sy: number): number {
  return Math.exp(-(((x - cx) / sx) ** 2) - ((y - cy) / sy) ** 2);
}

function faceRelief(x: number, y: number): number {
  let result = 0;
  for (const side of [-1, 1]) {
    result += 0.008 * gaussian(x, y, side * 0.069, 1.702, 0.037, 0.027); // cheekbone
    result -= 0.011 * gaussian(x, y, side * 0.046, 1.751, 0.030, 0.018); // eye socket
    result += 0.006 * gaussian(x, y, side * 0.046, 1.776, 0.039, 0.014); // brow ridge
    result += 0.013 * gaussian(x, y, side * 0.014, 1.704, 0.012, 0.010); // nose wings
    result -= 0.002 * gaussian(x, y, side * 0.027, 1.683, 0.009, 0.020);
  }
  result += 0.023 * gaussian(x, y, 0, 1.742, 0.013, 0.038); // bridge
  result += 0.040 * gaussian(x, y, 0, 1.712, 0.016, 0.016); // rounded nose tip
  result += 0.006 * gaussian(x, y, 0, 1.673, 0.035, 0.018); // muzzle
  result += 0.010 * gaussian(x, y, 0, 1.610, 0.042, 0.023); // chin
  result -= 0.002 * gaussian(x, y, 0, 1.683, 0.004, 0.011); // philtrum
  return result;
}

function faceZ(x: number, y: number): number {
  const [radius, front, back] = headSection(y);
  const c = Math.sqrt(Math.max(0, 1 - (x / radius) ** 2));
  const center = (front + back) / 2;
  return center + (front - center) * c ** 0.65 + faceRelief(x, y) * c ** 2;
}

function headPoint(y: number, angle: number): THREE.Vector3 {
  const [radius, front, back] = headSection(y);
  const x = radius * Math.sin(angle);
  const c = Math.cos(angle);
  const center = (front + back) / 2;
  return new THREE.Vector3(x, y, c >= 0 ? faceZ(x, y) : center + (center - back) * c);
}

function headGeometry(hair = false): THREE.BufferGeometry {
  const segments = hair ? 80 : 112;
  const rows = hair ? 28 : 80;
  const positions: number[] = [];
  const indices: number[] = [];
  for (let row = 0; row <= rows; row += 1) {
    for (let column = 0; column <= segments; column += 1) {
      const angle = column / segments * TAU;
      const front = Math.max(0, Math.cos(angle));
      // The forehead stays clear across its width; the cut drops only behind the
      // temples, with a very small asymmetric forelock instead of hanging bangs.
      const hairline = 1.725 + smoothstep(-0.05, 0.50, Math.cos(angle)) * 0.089
        - 0.004 * Math.sin(angle * 3 + 0.8) * front ** 4;
      const y = hair ? THREE.MathUtils.lerp(hairline, 1.890, row / rows) : THREE.MathUtils.lerp(1.571, 1.890, row / rows);
      const p = headPoint(y, angle);
      if (hair) {
        const lift = 0.003 + 0.004 * Math.sin(row / rows * Math.PI) + 0.0006 * Math.sin(angle * 24 + row * 0.65);
        p.x += Math.sin(angle) * lift;
        p.z += Math.cos(angle) * lift;
        p.y += smoothstep(1.81, 1.89, y) * 0.007;
      }
      positions.push(...p.toArray());
      if (row > 0 && column > 0) {
        const i = row * (segments + 1) + column;
        indices.push(i - 1, i - segments - 1, i, i - 1, i - segments - 2, i - segments - 1);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  smoothRingSeams(geometry, rows + 1, segments);
  return geometry;
}

function addFace(model: SkinnedModel, head: THREE.Bone, skin: THREE.Material, hair: THREE.Material, whites: THREE.Material,
  iris: THREE.Material, dark: THREE.Material, lips: THREE.Material): void {
  const weight: Weights = () => [[head, 1]];
  model.add(headGeometry(), skin, weight);
  model.add(headGeometry(true), hair, weight);
  for (const side of [-1, 1]) {
    // Helix, concha and tragus share the head bone; ears remain behind the cheeks.
    model.ellipsoid([0.013, 0.032, 0.018], [side * 0.111, 1.707, -0.008], skin, head);
    model.ellipsoid([0.003, 0.019, 0.011], [side * 0.122, 1.707, -0.004], lips, head, 16);
    model.ellipsoid([0.007, 0.009, 0.009], [side * 0.113, 1.697, 0.005], skin, head, 16);

    const cx = side * 0.045;
    const cy = 1.751;
    const positions: number[] = [];
    const indices: number[] = [];
    const upper: Point[] = [];
    const lower: Point[] = [];
    const widths: number[] = [];
    for (let i = 0; i <= 24; i += 1) {
      const t = i / 24;
      const x = cx + (t - 0.5) * 0.046;
      const shape = Math.sin(t * Math.PI) ** 0.85;
      const baseline = cy + side * (t - 0.5) * 0.001;
      const top = baseline + 0.0063 * shape;
      const bottom = baseline - 0.0045 * shape;
      upper.push([x, top, faceZ(x, top) + 0.0022]);
      lower.push([x, bottom, faceZ(x, bottom) + 0.0022]);
      widths.push(0.0008 + 0.0010 * shape);
      for (let row = 0; row <= 6; row += 1) {
        const y = THREE.MathUtils.lerp(bottom, top, row / 6);
        positions.push(x, y, faceZ(x, y) + 0.0015 + 0.0025 * shape * Math.sin(row / 6 * Math.PI));
        if (i > 0 && row > 0) {
          const n = i * 7 + row;
          indices.push(n - 8, n, n - 7, n - 8, n - 1, n);
        }
      }
    }
    const white = new THREE.BufferGeometry();
    white.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    white.setIndex(indices);
    white.computeVertexNormals();
    model.add(white, whites, weight);
    model.add(ribbon(upper, widths, new THREE.Vector3(0, 1, 0)), skin, weight);
    model.add(ribbon(lower, widths.map((width) => width * 0.7), new THREE.Vector3(0, 1, 0)), skin, weight);
    // Irises are clipped by the eyelid opening, instead of sitting on its surface as beads.
    for (const [radius, surface, depth] of [[0.0052, iris, 0.0044], [0.0025, dark, 0.0048]] as const) {
      const geometry = new THREE.CircleGeometry(radius, 24);
      const p = geometry.getAttribute("position");
      for (let i = 0; i < p.count; i += 1) {
        const x = p.getX(i) + cx;
        const y = cy + THREE.MathUtils.clamp(p.getY(i), -0.0041, 0.0057);
        p.setXYZ(i, x, y, faceZ(x, y) + depth);
      }
      geometry.computeVertexNormals();
      model.add(geometry, surface, weight);
    }
    model.ellipsoid([0.0011, 0.0011, 0.0005], [cx - 0.0016, cy + 0.0018, faceZ(cx, cy) + 0.0052], whites, head, 12);
    const brow: Point[] = [];
    const browWidths: number[] = [];
    for (let i = 0; i <= 16; i += 1) {
      const t = i / 16;
      const x = side * (0.021 + t * 0.048);
      const y = 1.773 + 0.006 * Math.sin(t * Math.PI) - t * 0.004;
      brow.push([x, y, faceZ(x, y) + 0.0019]);
      browWidths.push((0.0003 + 0.0020 * Math.sin(t * Math.PI) ** 0.6) * (1 - t * 0.35));
    }
    // Reverse the left-facing strip to preserve its outward winding.
    if (side < 0) { brow.reverse(); browWidths.reverse(); }
    model.add(ribbon(brow, browWidths, new THREE.Vector3(0, 1, 0)), hair, weight);
    model.ellipsoid([0.0030, 0.0011, 0.0005], [side * 0.012, 1.701, faceZ(side * 0.012, 1.701) + 0.0004], dark, head, 16);
  }
  // A shallow cupid's bow follows the actual sculpted face, with a fine mouth seam.
  const upper: Point[] = [];
  const lower: Point[] = [];
  const seam: Point[] = [];
  const upperWidths: number[] = [];
  const lowerWidths: number[] = [];
  for (let i = 0; i <= 32; i += 1) {
    const x = (i / 32 - 0.5) * 0.058;
    const t = x / 0.029;
    const shape = Math.max(0, 1 - t * t);
    const line = 1.659 + 0.0014 * t * t;
    const cupid = 0.0015 * Math.exp(-(((Math.abs(x) - 0.008) / 0.006) ** 2));
    const top = line + 0.0020 * shape + cupid;
    const bottom = line - 0.0024 * shape;
    upper.push([x, top, faceZ(x, top) + 0.0020 * shape + 0.0003]);
    lower.push([x, bottom, faceZ(x, bottom) + 0.0026 * shape + 0.0003]);
    seam.push([x, line, faceZ(x, line) + 0.0028 * shape + 0.0005]);
    upperWidths.push(0.0017 * shape);
    lowerWidths.push(0.0020 * shape);
  }
  model.add(ribbon(upper, upperWidths, new THREE.Vector3(0, 1, 0)), lips, weight);
  model.add(ribbon(lower, lowerWidths, new THREE.Vector3(0, 1, 0)), lips, weight);
  model.add(ribbon(seam, upperWidths.map((width) => width * 0.14), new THREE.Vector3(0, 1, 0)), dark, weight);
}

export function createHumanoid(visual: PresetVisualV1): THREE.Group {
  const root = new THREE.Group();
  root.name = "detailed-humanoid";
  const bones: THREE.Bone[] = [];
  const restPositions = new Map<THREE.Bone, THREE.Vector3>();
  function bone(name: string, parent: THREE.Object3D, world: Point): THREE.Bone {
    const result = new THREE.Bone();
    result.name = name;
    const position = new THREE.Vector3(...world);
    result.position.copy(position).sub(parent instanceof THREE.Bone ? restPositions.get(parent)! : new THREE.Vector3());
    parent.add(result);
    restPositions.set(result, position);
    bones.push(result);
    return result;
  }
  const hips = bone("hips", root, [0, 0.96, 0]);
  const spine = bone("spine", hips, [0, 1.075, 0]);
  const head = bone("head", spine, [0, 1.50, 0]);
  const leftUpperArm = bone("left-upper-arm", spine, [0.237, 1.407, 0]);
  const leftForearm = bone("left-forearm", leftUpperArm, [0.294, 1.107, 0]);
  const leftHand = bone("left-hand", leftForearm, [0.319, 0.873, 0.016]);
  const rightUpperArm = bone("right-upper-arm", spine, [-0.237, 1.407, 0]);
  const rightForearm = bone("right-forearm", rightUpperArm, [-0.294, 1.107, 0]);
  const rightHand = bone("right-hand", rightForearm, [-0.319, 0.873, 0.016]);
  const leftThigh = bone("left-thigh", hips, [0.107, 0.96, 0]);
  const leftShin = bone("left-shin", leftThigh, [0.119, 0.53, 0]);
  const leftFoot = bone("left-foot", leftShin, [0.126, 0.13, 0]);
  const rightThigh = bone("right-thigh", hips, [-0.107, 0.96, 0]);
  const rightShin = bone("right-shin", rightThigh, [-0.119, 0.53, 0]);
  const rightFoot = bone("right-foot", rightShin, [-0.126, 0.13, 0]);
  const rig: HumanoidRig = { root, hips, spine, head, leftUpperArm, leftForearm, leftHand, rightUpperArm, rightForearm,
    rightHand, leftThigh, leftShin, leftFoot, rightThigh, rightShin, rightFoot };
  if (visual.params?.detail === "crowd" || visual.params?.detail === "support") {
    buildSupportingHuman(root, rig, bones, visual);
    addWardrobe(rig, visual);
    rigs.set(root, rig);
    return root;
  }
  const model = new SkinnedModel(bones);
  const skinColor = new THREE.Color(paramColor(visual, "color", "#c6987c"));
  const skin = material("skin", skinColor, 0.82);
  skin.vertexColors = true;
  const shirt = material("shirt", paramColor(visual, "shirtColor", "#365b78"), 0.94);
  const trousers = material("trousers", paramColor(visual, "trouserColor", "#252b35"), 0.96);
  const shoes = material("shoes-and-belt", visual.params?.outfit === "sports" ? "#e8e7df" : "#252321", 0.63);
  const hair = material("hair", paramColor(visual, "hairColor", "#30251f"), 0.9);
  const whites = material("eye-white", "#d5cdc1", 0.4);
  const iris = material("iris", "#655547", 0.42);
  const dark = material("pupils-and-seams", "#24201f", 0.56);
  const lips = material("lips", skinColor.clone().lerp(new THREE.Color("#814b43"), 0.53), 0.86);
  const torsoWeights: Weights = (p) => {
    const w = smoothstep(0.99, 1.14, p.y);
    return [[hips, 1 - w], [spine, w]];
  };
  model.add(sweep([
    [0.982, 0, 0, 0.166, 0.105], [1.015, 0, 0.001, 0.178, 0.116],
    [1.09, 0, 0.002, 0.172, 0.113], [1.18, 0, 0, 0.183, 0.118],
    [1.29, 0, -0.003, 0.211, 0.132], [1.365, 0, -0.005, 0.229, 0.117],
    [1.414, 0, -0.007, 0.223, 0.098], [1.444, 0, -0.010, 0.194, 0.086],
    [1.470, 0, -0.012, 0.123, 0.073], [1.486, 0, -0.012, 0.075, 0.067],
  ], 40), shirt, torsoWeights);
  model.add(sweep([
    [0.861, 0, -0.011, 0.152, 0.089], [0.908, 0, -0.012, 0.181, 0.115],
    [0.962, 0, -0.004, 0.179, 0.113], [1.002, 0, 0, 0.165, 0.104],
  ], 32), trousers, () => [[hips, 1]]);
  model.add(sweep([[0.987, 0, 0, 0.169, 0.108], [1.006, 0, 0, 0.169, 0.108]], 32), shoes, () => [[hips, 1]]);
  model.add(sweep([
    [1.443, 0, -0.016, 0.080, 0.068], [1.494, 0, -0.012, 0.069, 0.062],
    [1.548, 0, -0.010, 0.061, 0.059], [1.602, 0, -0.014, 0.063, 0.058],
  ], 28), skin, (p) => { const w = smoothstep(1.46, 1.57, p.y); return [[spine, 1 - w], [head, w]]; });
  // A low collar follows the neck rather than a floating cylinder.
  model.add(sweep([[1.474, 0, -0.012, 0.080, 0.071], [1.491, 0, -0.012, 0.073, 0.066]], 32), shirt, () => [[spine, 1]]);

  for (const side of [-1, 1]) {
    const thigh = side > 0 ? leftThigh : rightThigh;
    const shin = side > 0 ? leftShin : rightShin;
    const foot = side > 0 ? leftFoot : rightFoot;
    const arm = side > 0 ? leftUpperArm : rightUpperArm;
    const forearm = side > 0 ? leftForearm : rightForearm;
    const hand = side > 0 ? leftHand : rightHand;
    const legWeights: Weights = (p) => {
      if (p.y > 0.89) { const w = smoothstep(0.89, 1.0, p.y); return [[thigh, 1 - w], [hips, w]]; }
      if (p.y < 0.18) { const w = smoothstep(0.115, 0.18, p.y); return [[foot, 1 - w], [shin, w]]; }
      const w = smoothstep(0.485, 0.59, p.y);
      return [[shin, 1 - w], [thigh, w]];
    };
    if (visual.params?.outfit === "sports") {
      const sock = material("sports-socks", "#eaece4");
      model.add(sweep([
        [0.13, side*.126, 0, .05, .055], [0.24, side*.124, 0, .058, .06],
        [0.34, side*.122, -.005, .068, .071],
      ], 20), sock, legWeights);
      model.add(sweep([
        [0.33, side*.122, -.005, .067, .070], [0.44, side*.121, -.004, .070, .074],
        [0.53, side*.119, .004, .061, .069], [0.63, side*.116, 0, .073, .077],
        [0.74, side*.113, 0, .084, .092],
      ], 24), skin, legWeights);
      model.add(sweep([
        [0.70, side*.114, 0, .088, .096], [0.80, side*.11, -.004, .096, .106],
        [0.90, side*.107, -.007, .098, .112], [0.96, side*.102, -.003, .090, .102],
      ], 24), trousers, legWeights);
    } else {
    model.add(sweep([
      [0.127, side * 0.126, 0, 0.052, 0.058], [0.19, side * 0.125, 0, 0.054, 0.060],
      [0.31, side * 0.123, -0.006, 0.068, 0.074], [0.42, side * 0.121, -0.006, 0.072, 0.079],
      [0.49, side * 0.120, 0.002, 0.064, 0.070], [0.53, side * 0.119, 0.004, 0.065, 0.073],
      [0.575, side * 0.118, 0.002, 0.069, 0.076], [0.67, side * 0.115, 0, 0.080, 0.088],
      [0.78, side * 0.111, -0.004, 0.094, 0.103], [0.89, side * 0.107, -0.007, 0.097, 0.110],
      [0.96, side * 0.102, -0.003, 0.090, 0.102],
    ], 28), trousers, legWeights);
    }
    const shoe = new RoundedBoxGeometry(0.143, 0.115, 0.274, 3, 0.039);
    shoe.translate(side * 0.126, 0.076, 0.059);
    model.add(shoe, shoes, () => [[foot, 1]]);
    const sole = new RoundedBoxGeometry(0.146, 0.026, 0.28, 2, 0.009);
    sole.translate(side * 0.126, 0.016, 0.061);
    model.add(sole, dark, () => [[foot, 1]]);
    for (let lace = 0; lace < 3; lace += 1) {
      const geometry = new THREE.BoxGeometry(0.067, 0.003, 0.005);
      geometry.translate(side * 0.126, 0.132, 0.044 + lace * 0.022);
      model.add(geometry, trousers, () => [[foot, 1]]);
    }
    const armWeights: Weights = (p) => {
      if (p.y > 1.335) { const w = smoothstep(0.29, 0.19, Math.abs(p.x)); return [[arm, 1 - w], [spine, w]]; }
      if (p.y < 0.915) { const w = smoothstep(0.856, 0.915, p.y); return [[hand, 1 - w], [forearm, w]]; }
      const w = smoothstep(1.068, 1.16, p.y);
      return [[forearm, 1 - w], [arm, w]];
    };
    model.add(sweep([
      [1.223, side * 0.272, 0, 0.063, 0.063], [1.25, side * 0.267, 0, 0.068, 0.068],
      [1.33, side * 0.251, 0, 0.078, 0.079], [1.402, side * 0.236, -0.001, 0.075, 0.077],
      [1.434, side * 0.222, -0.005, 0.061, 0.064], [1.451, side * 0.215, -0.009, 0.031, 0.039],
      [1.455, side * 0.212, -0.012, 0.004, 0.010],
    ], 28), visual.params?.role === "runner" ? skin : shirt, armWeights);
    model.add(sweep([
      [0.869, side * 0.319, 0.016, 0.029, 0.034], [0.923, side * 0.314, 0.012, 0.032, 0.037],
      [1.006, side * 0.306, 0.004, 0.044, 0.044], [1.056, side * 0.299, 0.001, 0.046, 0.046],
      [1.10, side * 0.294, 0, 0.042, 0.043], [1.137, side * 0.288, 0, 0.046, 0.047],
      [1.195, side * 0.277, 0, 0.054, 0.054], [1.233, side * 0.271, 0, 0.057, 0.057],
    ], 28), skin, armWeights);
    model.add(sweep([
      [0.803, side * 0.325, 0.020, 0.025, 0.038], [0.825, side * 0.324, 0.018, 0.027, 0.044],
      [0.85, side * 0.321, 0.017, 0.026, 0.039], [0.875, side * 0.319, 0.016, 0.027, 0.032],
    ], 20), skin, () => [[hand, 1]]);
    for (let finger = 0; finger < 4; finger += 1) {
      const z = 0.049 - finger * 0.020;
      const length = [0.055, 0.064, 0.059, 0.046][finger]!;
      model.add(sweep([
        [0.803 - length, side * 0.313, z + 0.003, 0.006, 0.006],
        [0.816 - length, side * 0.315, z + 0.002, 0.008, 0.008],
        [0.783, side * 0.325, z, 0.009, 0.009], [0.811, side * 0.326, z, 0.009, 0.009],
      ], 12), skin, () => [[hand, 1]]);
    }
    model.add(sweep([
      [0.811, side * 0.305, 0.057, 0.008, 0.008], [0.827, side * 0.304, 0.059, 0.012, 0.012],
      [0.850, side * 0.306, 0.045, 0.013, 0.014],
    ], 14), skin, () => [[hand, 1]]);
  }
  addFace(model, head, skin, hair, whites, iris, dark, lips);
  model.finish(root);
  addWardrobe(rig, visual);
  if (visual.params?.pose === "driving") poseSeatedDriver(rig, visual);
  rigs.set(root, rig);
  return root;
}

/** Driving visuals use the head center as their entity origin, facing the car's -Z front. */
function poseSeatedDriver(rig: HumanoidRig, visual: PresetVisualV1): void {
  const height = typeof visual.params?.carHeight === "number" && visual.params.carHeight > 0 ? visual.params.carHeight : 1.4;
  const length = typeof visual.params?.carLength === "number" && visual.params.carLength > 0 ? visual.params.carLength : 4.4;
  const scale = height * 0.5;
  rig.root.name = "seated-driver";
  rig.root.scale.setScalar(scale);
  rig.root.position.y = -1.736 * scale;
  rig.root.rotation.y = Math.PI;
  for (const side of ["left", "right"] as const) {
    rig[`${side}Thigh`].rotation.x = -1.3;
    rig[`${side}Shin`].rotation.x = 1.45;
    rig[`${side}Foot`].rotation.x = -0.15;
  }
  rig.root.updateMatrixWorld(true);

  const rimRadius = height * 0.095;
  for (const side of ["left", "right"] as const) {
    const upper = rig[`${side}UpperArm`];
    const forearm = rig[`${side}Forearm`];
    const hand = rig[`${side}Hand`];
    const sign = side === "left" ? 1 : -1;
    // Place the palms on the same tilted wheel rendered by the car preset.
    const wrist = rig.root.worldToLocal(new THREE.Vector3(
      -sign * rimRadius,
      -height * 0.1,
      -length * 0.118 + 0.15 + scale * 0.085,
    ));
    const shoulder = upper.getWorldPosition(new THREE.Vector3());
    rig.root.worldToLocal(shoulder);
    const upperLength = forearm.position.length();
    const lowerLength = hand.position.length();
    const direction = wrist.clone().sub(shoulder);
    const distance = Math.min(direction.length(), (upperLength + lowerLength) * 0.999);
    direction.normalize();
    const along = (upperLength ** 2 - lowerLength ** 2 + distance ** 2) / (2 * distance);
    const bend = new THREE.Vector3(sign * 0.35, -1, 0);
    bend.addScaledVector(direction, -bend.dot(direction)).normalize();
    const elbow = shoulder.clone().addScaledVector(direction, along)
      .addScaledVector(bend, Math.sqrt(Math.max(0, upperLength ** 2 - along ** 2)));
    upper.quaternion.setFromUnitVectors(forearm.position.clone().normalize(), elbow.clone().sub(shoulder).normalize());
    forearm.quaternion.setFromUnitVectors(hand.position.clone().normalize(),
      wrist.clone().sub(elbow).normalize().applyQuaternion(upper.quaternion.clone().invert()));
    hand.quaternion.copy(upper.quaternion).multiply(forearm.quaternion).invert()
      .multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2));
  }
  rig.root.updateMatrixWorld(true);
}

/** Lower-detail skinned geometry for spectators and the football ensemble. */
function buildSupportingHuman(root: THREE.Group, rig: HumanoidRig, bones: THREE.Bone[], visual: PresetVisualV1): void {
  const model = new SkinnedModel(bones);
  const skin = material("support-skin", paramColor(visual,"color","#bd906f"));
  const shirt = material("support-shirt", paramColor(visual,"shirtColor","#487389"));
  const pants = material("support-pants", paramColor(visual,"trouserColor","#263847"));
  const shoes = material("support-shoes", "#e4e5db");
  const hair = material("support-hair", "#302820");
  const sports = visual.params?.outfit === "sports";
  const shape=(size: Point,p: Point,m: THREE.Material,b: THREE.Bone)=>{
    const g=new THREE.BoxGeometry(...size);g.translate(...p);model.add(g,m,()=>[[b,1]]);
  };
  shape([.35,.19,.23],[0,.93,0],pants,rig.hips);
  shape([.42,.43,.23],[0,1.255,0],shirt,rig.spine);
  model.ellipsoid([.074,.075,.07],[0,1.515,0],skin,rig.head,10);
  model.ellipsoid([.113,.157,.11],[0,1.725,0],skin,rig.head,12);
  model.ellipsoid([.114,.065,.112],[0,1.825,-.01],hair,rig.head,10);
  for(const side of [1,-1]){
    const thigh=side>0?rig.leftThigh:rig.rightThigh,shin=side>0?rig.leftShin:rig.rightShin,foot=side>0?rig.leftFoot:rig.rightFoot;
    const arm=side>0?rig.leftUpperArm:rig.rightUpperArm,forearm=side>0?rig.leftForearm:rig.rightForearm,hand=side>0?rig.leftHand:rig.rightHand;
    const segment=(a: Point,b: Point,r:number,m:THREE.Material,bone:THREE.Bone)=>{
      const start=new THREE.Vector3(...a),end=new THREE.Vector3(...b),direction=end.clone().sub(start);
      const g=new THREE.CylinderGeometry(r,r*.87,direction.length(),8,1);
      g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,1,0),direction.clone().normalize()));
      const middle=start.add(end).multiplyScalar(.5);g.translate(middle.x,middle.y,middle.z);model.add(g,m,()=>[[bone,1]]);
    };
    segment([side*.11,.93,0],[side*.12,.7,0],.09,pants,thigh);
    segment([side*.12,.7,0],[side*.12,.53,0],.068,sports?skin:pants,thigh);
    segment([side*.12,.52,0],[side*.126,.14,0],.06,sports?shoes:pants,shin);
    shape([.14,.11,.26],[side*.126,.067,.055],shoes,foot);
    segment([side*.237,1.41,0],[side*.276,1.21,0],.071,shirt,arm);
    segment([side*.276,1.21,0],[side*.294,1.11,0],.049,skin,arm);
    segment([side*.294,1.107,0],[side*.319,.873,.016],.038,skin,forearm);
    model.ellipsoid([.029,.065,.038],[side*.32,.837,.016],skin,hand,8);
    model.ellipsoid([.009,.01,.004],[side*.043,1.743,.103],hair,rig.head,8);
  }
  model.finish(root);
}

/** Clothing/equipment stays attached to bones through every pose and seek. */
function addWardrobe(rig: HumanoidRig, visual: PresetVisualV1): void {
  if(visual.params?.outfit === "worker"){
    const safety=material("safety-reflector","#e8edb8",.2);
    for(const side of [-1,1]){
      const stripe=new THREE.Mesh(new THREE.BoxGeometry(.036,.32,.018),safety);
      stripe.position.set(side*.12,.18,.128);rig.spine.add(stripe);
    }
    const belt=new THREE.Mesh(new THREE.BoxGeometry(.36,.037,.018),safety);belt.position.set(0,.07,.125);rig.spine.add(belt);
    const hardhat=new THREE.Mesh(new THREE.SphereGeometry(.145,16,8,0,Math.PI*2,0,Math.PI/2),material("hard-hat","#f4c33f",.14));
    hardhat.position.set(0,.345,-.007);rig.head.add(hardhat);
    const brim=new THREE.Mesh(new THREE.CylinderGeometry(.165,.165,.025,20),material("hard-hat-brim","#f4c33f",.14));
    brim.position.set(0,.345,.008);rig.head.add(brim);
  }
  if(visual.params?.outfit === "sports" && typeof document !== "undefined"){
    const canvas=document.createElement("canvas");canvas.width=128;canvas.height=128;
    const ctx=canvas.getContext("2d")!;ctx.fillStyle=visual.params?.role==="runner"?"#f5f0de":paramColor(visual,"shirtColor","#39758c");ctx.fillRect(0,0,128,128);
    ctx.fillStyle=visual.params?.role==="runner"?"#253c49":"#f9f5e9";ctx.textAlign="center";ctx.font="bold 80px sans-serif";ctx.fillText(String(visual.params?.number??1).padStart(2,"0"),64,94);
    const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;
    for(const side of [1,-1]){
      const bib=new THREE.Mesh(new THREE.PlaneGeometry(.24,.23),new THREE.MeshStandardMaterial({map:texture,roughness:1}));
      bib.position.set(0,.19,side*.137);bib.rotation.y=side<0?Math.PI:0;rig.spine.add(bib);
    }
  }
  if(visual.params?.role === "cameraman"){
    const camera=createBroadcastCamera();camera.position.set(.18,.36,.03);camera.rotation.y=Math.PI/2;rig.spine.add(camera);
  }
}
