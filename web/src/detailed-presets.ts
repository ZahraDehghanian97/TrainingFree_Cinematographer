import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

import type { PresetVisualV1 } from "../../src/types/environment";
import { createHumanoid } from "./humanoid";

type Point = readonly [number, number, number];
const UP = new THREE.Vector3(0, 1, 0);

function number(visual: PresetVisualV1, key: string, fallback: number, allowZero = false): number {
  const value = visual.params?.[key];
  return typeof value === "number" && Number.isFinite(value) && (value > 0 || (allowZero && value === 0)) ? value : fallback;
}

function color(visual: PresetVisualV1, key: string, fallback: string): string {
  const value = visual.params?.[key];
  return typeof value === "string" ? value : fallback;
}

function material(
  name: string,
  value: THREE.ColorRepresentation,
  options: THREE.MeshStandardMaterialParameters = {},
): THREE.MeshStandardMaterial {
  const result = new THREE.MeshStandardMaterial({ color: value, roughness: 0.7, ...options });
  result.name = name;
  return result;
}

/** Rigid details share one draw call per material, rather than one per bolt or panel. */
class Model {
  private readonly parts = new Map<THREE.Material, THREE.BufferGeometry[]>();
  private readonly sources = new Set<THREE.BufferGeometry>();

  add(
    geometry: THREE.BufferGeometry,
    surface: THREE.Material,
    position: Point = [0, 0, 0],
    rotation: Point = [0, 0, 0],
    scale: Point = [1, 1, 1],
  ): void {
    this.sources.add(geometry);
    const transformed = geometry.clone();
    transformed.applyMatrix4(new THREE.Matrix4().compose(
      new THREE.Vector3(...position),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(...rotation)),
      new THREE.Vector3(...scale),
    ));
    const part = transformed.index ? transformed.toNonIndexed() : transformed;
    if (part !== transformed) transformed.dispose();
    const bucket = this.parts.get(surface) ?? [];
    bucket.push(part);
    this.parts.set(surface, bucket);
  }

  box(size: Point, surface: THREE.Material, position: Point, radius = 0.015, rotation: Point = [0, 0, 0]): void {
    this.add(new RoundedBoxGeometry(...size, 2, Math.min(radius, ...size.map((n) => n / 3))), surface, position, rotation);
  }

  ellipsoid(size: Point, surface: THREE.Material, position: Point): void {
    this.add(new THREE.SphereGeometry(1, 24, 16), surface, position, [0, 0, 0], size);
  }

  rod(a: Point, b: Point, radius: number, surface: THREE.Material, endRadius = radius): void {
    const start = new THREE.Vector3(...a);
    const end = new THREE.Vector3(...b);
    const delta = end.clone().sub(start);
    const rotation = new THREE.Euler().setFromQuaternion(new THREE.Quaternion().setFromUnitVectors(UP, delta.clone().normalize()));
    const midpoint = start.add(end).multiplyScalar(0.5);
    this.add(new THREE.CylinderGeometry(endRadius, radius, delta.length(), 16), surface,
      midpoint.toArray() as [number, number, number], [rotation.x, rotation.y, rotation.z]);
  }

  finish(name: string): THREE.Group {
    const group = new THREE.Group();
    group.name = name;
    for (const [surface, geometries] of this.parts) {
      const geometry = mergeGeometries(geometries, false);
      if (geometry === null) throw new Error(`Could not merge ${name} geometry`);
      const mesh = new THREE.Mesh(geometry, surface);
      mesh.name = surface.name;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
      for (const part of geometries) part.dispose();
    }
    for (const source of this.sources) source.dispose();
    return group;
  }
}

function quad(points: readonly Point[]): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(points.flat(), 3));
  geometry.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 1, 0, 1, 1, 0, 1], 2));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.computeVertexNormals();
  return geometry;
}

function car(visual: PresetVisualV1): THREE.Group {
  const w = number(visual, "width", 2);
  const h = number(visual, "height", 1.4);
  const l = number(visual, "length", 4.4);
  const model = new Model();
  const paint = new THREE.MeshPhysicalMaterial({
    color: color(visual, "color", "#ae4035"), metalness: 0.58, roughness: 0.28,
    clearcoat: 0.85, clearcoatRoughness: 0.15,
  });
  paint.name = "paint";
  const rubber = material("tires", "#17191b", { roughness: 0.94 });
  const trim = material("trim-and-interior", "#20252a", { roughness: 0.57 });
  const alloy = material("alloy", "#a2a8ac", { metalness: 0.88, roughness: 0.25 });
  const glass = material("glass", "#3c5360", {
    metalness: 0.3, roughness: 0.09, side: THREE.DoubleSide,
    transparent: visual.params?.interior === true, opacity: visual.params?.interior === true ? 0.22 : 1,
    depthWrite: visual.params?.interior !== true,
  });
  const headlights = material("headlights", "#e7f2f8", {
    emissive: "#b9d3e3", emissiveIntensity: 0.35, metalness: 0.3, roughness: 0.18,
  });
  const tailLights = material("tail-lights", "#8a1018", {
    emissive: "#b1121b", emissiveIntensity: 0.4, roughness: 0.23,
  });

  model.box([w, h * 0.37, l], paint, [0, h * 0.36, 0], h * 0.11);
  model.box([w * 0.94, h * 0.07, l * 0.9], trim, [0, h * 0.17, 0], h * 0.025);
  model.box([w * 0.93, h * 0.08, l * 0.28], paint, [0, h * 0.561, -l * 0.337], h * 0.026);
  model.box([w * 0.93, h * 0.075, l * 0.19], paint, [0, h * 0.563, l * 0.37], h * 0.025);
  model.box([w * 0.71, h * 0.052, l * 0.282], paint, [0, h * 0.956, l * 0.022], h * 0.022);

  // Sloped windscreen and rear glass; the car's front remains local -Z.
  model.add(quad([
    [-w * 0.412, h * 0.592, -l * 0.225], [w * 0.412, h * 0.592, -l * 0.225],
    [w * 0.344, h * 0.939, -l * 0.116], [-w * 0.344, h * 0.939, -l * 0.116],
  ]), glass);
  model.add(quad([
    [w * 0.405, h * 0.595, l * 0.273], [-w * 0.405, h * 0.595, l * 0.273],
    [-w * 0.344, h * 0.939, l * 0.16], [w * 0.344, h * 0.939, l * 0.16],
  ]), glass);
  for (const side of [-1, 1]) {
    const frontBase: Point = [side * w * 0.417, h * 0.582, -l * 0.231];
    const frontRoof: Point = [side * w * 0.351, h * 0.949, -l * 0.119];
    const rearRoof: Point = [side * w * 0.351, h * 0.949, l * 0.165];
    const rearBase: Point = [side * w * 0.417, h * 0.582, l * 0.283];
    model.add(quad([frontBase, frontRoof, rearRoof, rearBase]), glass);
    model.rod(frontBase, frontRoof, h * 0.027, paint);
    model.rod(rearBase, rearRoof, h * 0.036, paint);
    model.rod(frontRoof, rearRoof, h * 0.019, paint);
    model.rod(frontBase, rearBase, h * 0.018, alloy);
    model.rod([side * w * 0.418, h * 0.591, l * 0.017], [side * w * 0.352, h * 0.938, l * 0.017], h * 0.024, trim);

    model.box([w * 0.085, h * 0.074, l * 0.055], paint,
      [side * w * 0.505, h * 0.655, -l * 0.171], h * 0.026);
    model.box([w * 0.066, h * 0.054, l * 0.004], alloy,
      [side * w * 0.51, h * 0.657, -l * 0.141], h * 0.008);
    for (const doorZ of [-0.116, 0.19]) {
      model.box([w * 0.007, h * 0.014, l * 0.069], alloy,
        [side * w * 0.501, h * 0.51, l * doorZ], h * 0.004);
    }
    // Restrained panel gaps catch light without outlining every body polygon.
    for (const seamZ of [0.02, 0.263]) {
      model.box([w * 0.003, h * 0.23, l * 0.0015], trim,
        [side * w * 0.5002, h * 0.388, l * seamZ], h * 0.001);
    }

    for (const axle of [-1, 1]) {
      const z = axle * l * 0.31;
      const wheelY = h * 0.25;
      model.add(new THREE.TorusGeometry(h * 0.162, h * 0.044, 12, 36), rubber,
        [side * w * 0.493, wheelY, z], [0, Math.PI / 2, 0]);
      model.add(new THREE.CylinderGeometry(h * 0.184, h * 0.184, w * 0.108, 36), rubber,
        [side * w * 0.516, wheelY, z], [0, 0, Math.PI / 2]);
      model.add(new THREE.CylinderGeometry(h * 0.115, h * 0.115, w * 0.008, 32), trim,
        [side * w * 0.572, wheelY, z], [0, 0, Math.PI / 2]);
      model.add(new THREE.TorusGeometry(h * 0.108, h * 0.009, 8, 32), alloy,
        [side * w * 0.578, wheelY, z], [0, Math.PI / 2, 0]);
      for (let spoke = 0; spoke < 5; spoke += 1) {
        const angle = spoke * Math.PI * 2 / 5;
        model.box([w * 0.009, h * 0.022, h * 0.097], alloy,
          [side * w * 0.579, wheelY - Math.sin(angle) * h * 0.052, z + Math.cos(angle) * h * 0.052],
          h * 0.006, [angle, 0, 0]);
      }
      model.add(new THREE.CylinderGeometry(h * 0.031, h * 0.031, w * 0.012, 20), alloy,
        [side * w * 0.582, wheelY, z], [0, 0, Math.PI / 2]);
    }

    model.box([w * 0.227, h * 0.091, l * 0.011], trim,
      [side * w * 0.335, h * 0.476, -l * 0.491], h * 0.024);
    model.box([w * 0.206, h * 0.063, l * 0.009], headlights,
      [side * w * 0.335, h * 0.483, -l * 0.498], h * 0.014);
    model.box([w * 0.235, h * 0.07, l * 0.01], tailLights,
      [side * w * 0.337, h * 0.478, l * 0.498], h * 0.018);
  }
  model.box([w * 0.39, h * 0.115, l * 0.013], trim, [0, h * 0.342, -l * 0.499], h * 0.02);
  for (let fin = 0; fin < 4; fin += 1) {
    model.box([w * 0.345, h * 0.007, l * 0.004], alloy,
      [0, h * (0.305 + fin * 0.024), -l * 0.507], h * 0.002);
  }
  model.box([w * 0.19, h * 0.063, l * 0.005], headlights, [0, h * 0.365, l * 0.502], h * 0.004);

  if (visual.params?.style === "race") {
    model.box([w * 1.04, h * 0.04, l * 0.074], trim, [0, h * 0.832, l * 0.427], h * 0.015);
    for (const side of [-1, 1]) {
      model.box([w * 0.026, h * 0.22, l * 0.027], trim, [side * w * 0.34, h * 0.711, l * 0.427], h * 0.007);
    }
  }
  if (visual.params?.interior === true) {
    model.box([w * 0.77, h * 0.095, l * 0.082], trim, [0, h * 0.672, -l * 0.169], h * 0.025);
    for (const side of [-1, 1]) {
      model.box([w * 0.265, h * 0.28, l * 0.06], trim, [side * w * 0.202, h * 0.633, l * 0.074], h * 0.045, [-0.12, 0, 0]);
      model.box([w * 0.126, h * 0.105, l * 0.042], trim, [side * w * 0.202, h * 0.831, l * 0.086], h * 0.031);
    }
  }
  const group = model.finish("detailed-car");
  if (visual.params?.interior === true) {
    const steering = new Model();
    steering.add(new THREE.TorusGeometry(h * 0.095, h * 0.011, 8, 28), rubber);
    steering.ellipsoid([h * 0.032, h * 0.027, h * 0.014], trim, [0, 0, 0]);
    for (const angle of [0, Math.PI, -Math.PI / 2]) {
      steering.rod([0, 0, 0], [Math.cos(angle) * h * 0.09, Math.sin(angle) * h * 0.09, 0], h * 0.008, trim);
    }
    const wheel = steering.finish("steering-wheel");
    // A car facing -Z has its left-hand driver's seat on +X.
    wheel.position.set(w * 0.202, h * 0.73, -l * 0.118);
    wheel.rotation.x = -0.32;
    group.add(wheel);
  }
  return group;
}

function woodGrain(): THREE.DataTexture {
  const width = 96;
  const height = 192;
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const warp = x + 1.8 * Math.sin(y * 0.035) + 0.7 * Math.sin(y * 0.11 + x * 0.06);
      const grain = Math.sin(warp * 1.8) * 0.07 + Math.sin(warp * 5.1) * 0.035;
      const pore = Math.sin(x * 31.17 + y * 13.3) * Math.sin(x * 7.1 - y * 3.4) * 0.035;
      const shade = Math.round(255 * (0.88 + grain + pore));
      const index = (y * width + x) * 4;
      data[index] = shade;
      data[index + 1] = shade;
      data[index + 2] = shade;
      data[index + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, width, height);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

function door(visual: PresetVisualV1): THREE.Group {
  const w = number(visual, "width", 1.05);
  const h = number(visual, "height", 2.2);
  const d = number(visual, "depth", 0.12);
  const model = new Model();
  const baseColor = new THREE.Color(color(visual, "color", "#75543a"));
  const grain = woodGrain();
  const wood = material("wood", baseColor, { map: grain, roughness: 0.56 });
  const inset = material("recessed-wood", baseColor.clone().multiplyScalar(0.72), { map: grain, roughness: 0.64 });
  const brass = material("brushed-brass", "#af9870", { metalness: 0.84, roughness: 0.31 });
  model.box([w, h, d], wood, [0, h / 2, 0], Math.min(w, d) * 0.08);
  for (const face of [-1, 1]) {
    for (const side of [-1, 1]) {
      for (const [center, panelHeight] of [[0.705, 0.415], [0.275, 0.29]]) {
        const panelWidth = w * 0.355;
        const panelY = h * center;
        const panelX = side * w * 0.218;
        const mould = w * 0.022;
        model.box([panelWidth, h * panelHeight, d * 0.05], inset,
          [panelX, panelY, face * d * 0.507], d * 0.023);
        model.box([panelWidth - mould * 3, h * panelHeight - mould * 3, d * 0.1], wood,
          [panelX, panelY, face * d * 0.531], d * 0.032);
        for (const edge of [-1, 1]) {
          model.box([mould, h * panelHeight, d * 0.105], wood,
            [panelX + edge * panelWidth / 2, panelY, face * d * 0.555], d * 0.032);
          model.box([panelWidth, mould, d * 0.105], wood,
            [panelX, panelY + edge * h * panelHeight / 2, face * d * 0.555], d * 0.032);
        }
      }
    }
    model.add(new THREE.CylinderGeometry(w * 0.034, w * 0.034, d * 0.13, 24), brass,
      [w * 0.345, h * 0.485, face * d * 0.591], [Math.PI / 2, 0, 0]);
    model.rod([w * 0.345, h * 0.485, face * d * 0.62],
      [w * 0.345, h * 0.485, face * d * 0.98], w * 0.012, brass);
    model.box([w * 0.13, w * 0.024, d * 0.2], brass,
      [w * 0.296, h * 0.485, face * d * 0.98], w * 0.009);
  }
  for (const hinge of [0.18, 0.5, 0.84]) {
    model.add(new THREE.CylinderGeometry(d * 0.13, d * 0.13, h * 0.037, 16), brass,
      [-w * 0.487, h * hinge, d * 0.37]);
  }
  return model.finish("detailed-door");
}

function vase(visual: PresetVisualV1): THREE.Group {
  const h = number(visual, "height", 0.95);
  const r = number(visual, "radius", h * 0.28);
  const model = new Model();
  const glaze = new THREE.MeshPhysicalMaterial({
    color: color(visual, "color", "#489b91"), roughness: 0.28, metalness: 0,
    clearcoat: 0.9, clearcoatRoughness: 0.13,
  });
  glaze.name = "ceramic-glaze";
  const foot = material("unglazed-foot", "#b9a992", { roughness: 0.95 });
  const outer = new THREE.SplineCurve([
    new THREE.Vector2(r * 0.52, h * 0.024), new THREE.Vector2(r * 0.9, h * 0.1),
    new THREE.Vector2(r, h * 0.34), new THREE.Vector2(r * 0.73, h * 0.7),
    new THREE.Vector2(r * 0.47, h * 0.86), new THREE.Vector2(r * 0.5, h),
  ]).getPoints(56).map((point) => new THREE.Vector2(Math.min(r, point.x), point.y));
  const thickness = Math.min(r * 0.065, h * 0.025);
  // A complete wall profile makes the mouth visibly hollow in high camera angles.
  const profile = [new THREE.Vector2(0, h * 0.024), ...outer];
  profile.push(new THREE.Vector2(r * 0.5 - thickness, h));
  for (let i = outer.length - 2; i >= 3; i -= 1) {
    profile.push(new THREE.Vector2(Math.max(thickness, outer[i].x - thickness), Math.max(h * 0.065, outer[i].y)));
  }
  profile.push(new THREE.Vector2(0, h * 0.065));
  model.add(new THREE.LatheGeometry(profile, 48), glaze);
  model.add(new THREE.CylinderGeometry(r * 0.52, r * 0.49, h * 0.024, 40), foot, [0, h * 0.012, 0]);
  return model.finish("detailed-vase");
}

function screenTexture(value: string): THREE.DataTexture {
  const width = 128;
  const height = 80;
  const tint = new THREE.Color(value);
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const u = x / width;
      const v = y / height;
      const glow = Math.exp(-((u - 0.7) ** 2 + (v - 0.63) ** 2) * 5);
      const ridge = v < 0.34 + 0.12 * Math.sin(u * 7) ? 0.19 : 0.45 + glow * 0.4;
      const foreground = v < 0.16 + 0.045 * Math.sin(u * 10 + 2) ? 0.1 : ridge;
      const shade = new THREE.Color().copy(tint).multiplyScalar(foreground).convertLinearToSRGB();
      const index = (y * width + x) * 4;
      data[index] = Math.round(shade.r * 255);
      data[index + 1] = Math.round(shade.g * 255);
      data[index + 2] = Math.round(shade.b * 255);
      data[index + 3] = 255;
    }
  }
  const texture = new THREE.DataTexture(data, width, height);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.needsUpdate = true;
  return texture;
}

function monitor(visual: PresetVisualV1): THREE.Group {
  const w = number(visual, "width", 1.35);
  const h = number(visual, "height", 0.82);
  const d = number(visual, "depth", 0.13);
  const stand = number(visual, "standHeight", 0.27, true);
  const model = new Model();
  const bezel = material("bezel", "#16191d", { roughness: 0.43, metalness: 0.22 });
  const aluminum = material("aluminum-stand", "#767e84", { roughness: 0.31, metalness: 0.86 });
  const black = material("rear-vents", "#07090b", { roughness: 0.9 });
  const wallpaper = screenTexture(color(visual, "screenColor", "#4aa8ff"));
  const screen = material("screen", "#ffffff", {
    map: wallpaper, emissiveMap: wallpaper, emissive: "#ffffff", emissiveIntensity: 0.32,
    roughness: 0.24, metalness: 0.05,
  });
  const led = material("power-led", "#a1cfd8", { emissive: "#69c5db", emissiveIntensity: 0.65 });
  const y = stand + h / 2;
  model.box([w, h, d], bezel, [0, y, 0], Math.min(w * 0.016, d * 0.17));
  model.add(new THREE.PlaneGeometry(w * 0.95, h * 0.902), screen, [0, y + h * 0.012, d / 2 + 0.001]);
  model.box([w * 0.58, h * 0.53, d * 0.24], bezel, [0, y - h * 0.06, -d * 0.56], d * 0.09);
  model.box([w * 0.077, stand + h * 0.22, d * 0.53], aluminum,
    [0, (stand + h * 0.22) / 2, -d * 0.13], d * 0.065);
  model.box([w * 0.38, 0.033, d * 1.8], aluminum, [0, 0.018, 0], 0.012);
  for (let vent = 0; vent < 16; vent += 1) {
    model.box([w * 0.014, h * 0.085, d * 0.014], black,
      [w * (-0.205 + vent * 0.027), y + h * 0.155, -d * 0.69], d * 0.002);
  }
  model.ellipsoid([w * 0.003, w * 0.003, d * 0.015], led, [w * 0.436, stand + h * 0.036, d * 0.508]);
  return model.finish("detailed-monitor");
}

function soccerBall(visual: PresetVisualV1): THREE.Group {
  const radius = number(visual, "radius", 0.35);
  const model = new Model();
  const white = material("leather-panels", color(visual, "color", "#e6e3dc"), { roughness: 0.72 });
  const black = material("pentagon-panels", "#22252a", { roughness: 0.79 });
  model.add(new THREE.SphereGeometry(radius, 48, 32), white);

  const ico = new THREE.IcosahedronGeometry(1, 0);
  const positions = ico.getAttribute("position");
  const vertices: THREE.Vector3[] = [];
  const faces: number[][] = [];
  const vertexIds = new Map<string, number>();
  for (let i = 0; i < positions.count; i += 3) {
    const face: number[] = [];
    for (let j = 0; j < 3; j += 1) {
      const vertex = new THREE.Vector3().fromBufferAttribute(positions, i + j).normalize();
      const key = vertex.toArray().map((n) => n.toFixed(5)).join(",");
      let id = vertexIds.get(key);
      if (id === undefined) {
        id = vertices.length;
        vertices.push(vertex);
        vertexIds.set(key, id);
      }
      face.push(id);
    }
    faces.push(face);
  }
  ico.dispose();
  const neighbors = vertices.map(() => new Set<number>());
  for (const face of faces) {
    for (let i = 0; i < 3; i += 1) {
      neighbors[face[i]].add(face[(i + 1) % 3]);
      neighbors[face[i]].add(face[(i + 2) % 3]);
    }
  }
  const truncate = (a: number, b: number) => vertices[a].clone().multiplyScalar(2).add(vertices[b]).normalize();
  const seams: number[] = [];
  function seam(a: THREE.Vector3, b: THREE.Vector3): void {
    for (let step = 0; step < 5; step += 1) {
      seams.push(...a.clone().lerp(b, step / 5).normalize().multiplyScalar(radius * 1.003).toArray());
      seams.push(...a.clone().lerp(b, (step + 1) / 5).normalize().multiplyScalar(radius * 1.003).toArray());
    }
  }

  for (let vertex = 0; vertex < vertices.length; vertex += 1) {
    const center = vertices[vertex];
    const tangent = new THREE.Vector3().crossVectors(center, Math.abs(center.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : UP).normalize();
    const bitangent = new THREE.Vector3().crossVectors(center, tangent);
    const corners = [...neighbors[vertex]].map((neighbor) => truncate(vertex, neighbor));
    corners.sort((a, b) => Math.atan2(a.dot(bitangent), a.dot(tangent)) - Math.atan2(b.dot(bitangent), b.dot(tangent)));
    const patch: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    function point(a: THREE.Vector3, b: THREE.Vector3, row: number, column: number): THREE.Vector3 {
      return center.clone().multiplyScalar(1 - row / 5)
        .addScaledVector(a, (row - column) / 5).addScaledVector(b, column / 5).normalize();
    }
    function triangle(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3): void {
      for (const direction of [a, b, c]) {
        normals.push(...direction.toArray());
        patch.push(...direction.clone().multiplyScalar(radius * 1.002).toArray());
        uvs.push(0, 0);
      }
    }
    for (let edge = 0; edge < corners.length; edge += 1) {
      const a = corners[edge];
      const b = corners[(edge + 1) % corners.length];
      seam(a, b);
      for (let row = 0; row < 5; row += 1) {
        for (let column = 0; column <= row; column += 1) {
          triangle(point(a, b, row, column), point(a, b, row + 1, column), point(a, b, row + 1, column + 1));
          if (column < row) triangle(point(a, b, row, column), point(a, b, row + 1, column + 1), point(a, b, row, column + 1));
        }
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(patch, 3));
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute(normals, 3));
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2));
    model.add(geometry, black);
  }
  const seenEdges = new Set<string>();
  for (const face of faces) {
    for (let edge = 0; edge < 3; edge += 1) {
      const a = face[edge];
      const b = face[(edge + 1) % 3];
      const key = [a, b].sort((x, y) => x - y).join(",");
      if (seenEdges.has(key)) continue;
      seenEdges.add(key);
      seam(truncate(a, b), truncate(b, a));
    }
  }
  const group = model.finish("detailed-soccer-ball");
  const net = new THREE.BufferGeometry();
  net.setAttribute("position", new THREE.Float32BufferAttribute(seams, 3));
  group.add(new THREE.LineSegments(net, new THREE.LineBasicMaterial({ color: "#55534e", transparent: true, opacity: 0.5 })));
  return group;
}

function soccerGoal(visual: PresetVisualV1): THREE.Group {
  const w = number(visual, "width", 6);
  const h = number(visual, "height", 2.5);
  const d = number(visual, "depth", 1.2);
  const r = Math.max(0.055, number(visual, "postSize", 0.1)) / 2;
  const model = new Model();
  const paint = material("painted-steel-frame", color(visual, "color", "#ebede8"), { roughness: 0.38, metalness: 0.35 });
  for (const side of [-1, 1]) {
    const x = side * w / 2;
    model.rod([x, 0, 0], [x, h, 0], r, paint);
    model.ellipsoid([r, r, r], paint, [x, h, 0]);
    model.rod([x, r, 0], [x, r, -d], r * 0.75, paint);
    model.rod([x, r, -d], [x, h, -d * 0.42], r * 0.48, paint);
    model.rod([x, h, 0], [x, h, -d * 0.42], r * 0.48, paint);
  }
  model.rod([-w / 2, h, 0], [w / 2, h, 0], r, paint);
  model.rod([-w / 2, r, -d], [w / 2, r, -d], r * 0.6, paint);
  model.rod([-w / 2, h, -d * 0.42], [w / 2, h, -d * 0.42], r * 0.35, paint);

  const points: number[] = [];
  function netPanel(a: Point, b: Point, c: Point, e: Point, columns: number, rows: number): void {
    const topLeft = new THREE.Vector3(...a);
    const topRight = new THREE.Vector3(...b);
    const bottomRight = new THREE.Vector3(...c);
    const bottomLeft = new THREE.Vector3(...e);
    for (let column = 0; column <= columns; column += 1) {
      const t = column / columns;
      points.push(...topLeft.clone().lerp(topRight, t).toArray(), ...bottomLeft.clone().lerp(bottomRight, t).toArray());
    }
    for (let row = 0; row <= rows; row += 1) {
      const t = row / rows;
      points.push(...topLeft.clone().lerp(bottomLeft, t).toArray(), ...topRight.clone().lerp(bottomRight, t).toArray());
    }
  }
  const columns = Math.max(6, Math.min(160, Math.round(w / 0.14)));
  const rows = Math.max(4, Math.min(100, Math.round(h / 0.14)));
  const depthRows = Math.max(3, Math.min(80, Math.round(d / 0.14)));
  netPanel([-w / 2, h, -d * 0.42], [w / 2, h, -d * 0.42], [w / 2, r, -d], [-w / 2, r, -d], columns, rows);
  netPanel([-w / 2, h, 0], [w / 2, h, 0], [w / 2, h, -d * 0.42], [-w / 2, h, -d * 0.42], columns, depthRows);
  for (const side of [-1, 1]) {
    const x = side * w / 2;
    netPanel([x, h, 0], [x, h, -d * 0.42], [x, r, -d], [x, r, 0], depthRows, rows);
  }
  const group = model.finish("detailed-soccer-goal");
  const net = new THREE.BufferGeometry();
  net.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
  const mesh = new THREE.LineSegments(net, new THREE.LineBasicMaterial({ color: "#e3e5db", transparent: true, opacity: 0.55 }));
  mesh.name = "woven-net";
  group.add(mesh);
  return group;
}

/** Drop-in rigid models; local origins, facing directions and authored dimensions stay unchanged. */
export function createDetailedPreset(visual: PresetVisualV1): THREE.Object3D | null {
  switch (visual.name) {
    case "humanoid": return createHumanoid(visual);
    case "car": return car(visual);
    case "door": return door(visual);
    case "vase": return vase(visual);
    case "monitor": return monitor(visual);
    case "soccerBall": return soccerBall(visual);
    case "soccerGoal": return soccerGoal(visual);
    default: return null;
  }
}
