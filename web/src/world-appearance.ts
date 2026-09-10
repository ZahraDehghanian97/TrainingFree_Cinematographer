import * as THREE from "three";
import type { EnvironmentV1 } from "../../src/types/environment";

export type WorldProfile = NonNullable<EnvironmentV1["world"]>["profile"];
type Surface = NonNullable<NonNullable<EnvironmentV1["world"]>["ground"]>["surface"];

/** Deterministic, tileable surface relief. No network or canvas dependency. */
export function createSurfaceMaterial(
  surface: Surface = "concrete",
  color: THREE.ColorRepresentation = "#777979",
  size: readonly [number, number] = [4, 4],
): THREE.MeshStandardMaterial {
  const resolution = 256;
  const albedo = new Uint8Array(resolution * resolution * 4);
  const relief = new Uint8Array(albedo.length);
  let seed = 1847;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  for (let y = 0; y < resolution; y++) {
    for (let x = 0; x < resolution; x++) {
      const noise = random();
      const wave = Math.sin(x / resolution * Math.PI * 8 + Math.sin(y / resolution * Math.PI * 2));
      let shade = 0.83 + noise * 0.17;
      if (surface === "wood" || surface === "stage") {
        const grain = Math.sin(x * Math.PI / 4 + Math.sin(y * Math.PI / 128) * 2);
        shade = 0.9 + grain * 0.015 + noise * 0.035;
        if (x % 16 < 1 || (y + Math.floor(x / 16) * 64) % 128 < 1) shade *= 0.8;
      } else if (surface === "grass") {
        shade = 0.65 + noise * 0.3 + wave * 0.045;
      } else if (surface === "asphalt") {
        shade = noise > 0.94 ? 1 : 0.68 + noise * 0.22;
      } else {
        shade += wave * 0.018;
        if (x < 1 || y < 1) shade *= 0.68;
      }
      const offset = (y * resolution + x) * 4;
      const value = Math.round(THREE.MathUtils.clamp(shade, 0, 1) * 255);
      albedo.set([value, value, value, 255], offset);
      const height = Math.round((surface === "asphalt" ? noise : shade) * 255);
      relief.set([height, height, height, 255], offset);
    }
  }
  const map = new THREE.DataTexture(albedo, resolution, resolution);
  const bumpMap = new THREE.DataTexture(relief, resolution, resolution);
  map.colorSpace = THREE.SRGBColorSpace;
  for (const texture of [map, bumpMap]) {
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(size[0] / 4, size[1] / 4);
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.anisotropy = 8;
    texture.needsUpdate = true;
  }
  return new THREE.MeshStandardMaterial({
    color,
    map,
    bumpMap,
    bumpScale: surface === "grass" ? 0.035 : surface === "asphalt" ? 0.012 : 0.008,
    roughness: surface === "wood" ? 0.52 : surface === "stage" ? 0.42 : 0.9,
    metalness: 0,
  });
}

const looks = {
  studio: { background: "#36383e", sky: "#dce7ff", bounce: "#65594c", key: "#fff0d9", fill: "#bfd6ff", intensity: 3.2, ambient: 0.45, reflection: 0.55, surface: "wood", floor: "#83766c" },
  daylight: { background: "#b6cfde", sky: "#c3dfff", bounce: "#63794e", key: "#fff1d8", fill: "#c5e4ff", intensity: 3.6, ambient: 0.7, reflection: 0.45, surface: "grass", floor: "#598044" },
  road: { background: "#afc1cb", sky: "#c8e2ff", bounce: "#5a5c55", key: "#ffe3bf", fill: "#bddeff", intensity: 3.4, ambient: 0.65, reflection: 0.65, surface: "asphalt", floor: "#62666a" },
  park: { background: "#bbcfc4", sky: "#d6e9ff", bounce: "#657c48", key: "#ffeac4", fill: "#bddaff", intensity: 3.6, ambient: 0.65, reflection: 0.4, surface: "grass", floor: "#627f45" },
  industrial: { background: "#343b40", sky: "#d9e7ec", bounce: "#5b5141", key: "#ffe9ca", fill: "#b6dcea", intensity: 2.9, ambient: 0.45, reflection: 0.5, surface: "concrete", floor: "#85847e" },
  corridor: { background: "#10191b", sky: "#9db4b4", bounce: "#302b23", key: "#ffbc7e", fill: "#71a9ae", intensity: 1.8, ambient: 0.22, reflection: 0.25, surface: "concrete", floor: "#66625c" },
  stage: { background: "#15131f", sky: "#b9c5e8", bounce: "#383040", key: "#ffe0c2", fill: "#a7bbff", intensity: 3.4, ambient: 0.32, reflection: 0.65, surface: "stage", floor: "#45404b" },
  rooftop: { background: "#bdc2c8", sky: "#ccdcf0", bounce: "#646365", key: "#ffdfbf", fill: "#bccfff", intensity: 3.2, ambient: 0.6, reflection: 0.6, surface: "concrete", floor: "#858383" },
} as const;

export function getWorldLook(environment: EnvironmentV1) {
  return looks[environment.world?.profile ?? "studio"];
}

/** Authored floor details stay on the ground and introduce no collision obstacles. */
export function createWorldGround(environment: EnvironmentV1): THREE.Group {
  const root = new THREE.Group();
  const ground = environment.world?.ground;
  if (!ground) return root;
  const profile = environment.world?.profile;
  const look = getWorldLook(environment);
  const [width, depth] = ground.size;
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(width, depth),
    createSurfaceMaterial(ground.surface ?? look.surface, ground.color ?? look.floor, ground.size),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = ground.y;
  floor.receiveShadow = true;
  floor.name = "world:ground";
  root.add(floor);

  // A lower continuation prevents the authored ground rectangle from looking
  // like a floating tile, without covering its markings or changing ground Y.
  const horizonSize = [Math.max(200, width * 8), Math.max(200, depth * 3)] as const;
  const horizonMaterial = floor.material.clone();
  for (const slot of ["map", "bumpMap"] as const) {
    const texture = floor.material[slot]!.clone();
    texture.repeat.set(horizonSize[0] / 4, horizonSize[1] / 4);
    horizonMaterial[slot] = texture;
  }
  const horizon = new THREE.Mesh(new THREE.PlaneGeometry(...horizonSize), horizonMaterial);
  horizon.rotation.x = -Math.PI / 2;
  horizon.position.y = ground.y - 0.035;
  horizon.receiveShadow = true;
  root.add(horizon);

  const paint = new THREE.MeshStandardMaterial({ color: "#ece7d5", roughness: 0.85, polygonOffset: true, polygonOffsetFactor: -1 });
  const stripe = (w: number, d: number, x: number, z: number, material = paint) => {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, d), material);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(x, ground.y + 0.004, z);
    mesh.receiveShadow = true;
    root.add(mesh);
  };
  if (profile === "road") {
    for (const side of [-1, 1]) stripe(0.12, depth, side * width * 0.28, 0);
    const count = Math.min(120, Math.ceil(depth / 7));
    for (let i = 0; i < count; i++) stripe(0.1, 2.6, 0, -depth / 2 + (i + 0.5) * depth / count);
  } else if (profile === "daylight" && environment.id.includes("football")) {
    const w = width * 0.78;
    const d = depth * 0.82;
    for (const side of [-1, 1]) {
      stripe(0.08, d, side * w / 2, 0);
      stripe(w, 0.08, 0, side * d / 2);
    }
    stripe(w, 0.08, 0, 0);
    const circle = new THREE.Mesh(new THREE.RingGeometry(2.6, 2.68, 80), paint);
    circle.rotation.x = -Math.PI / 2;
    circle.position.y = ground.y + 0.005;
    root.add(circle);
    const mowing = new THREE.MeshStandardMaterial({ color: "#8baf66", transparent: true, opacity: 0.09, depthWrite: false });
    for (let i = 0; i < 8; i++) stripe(width, depth / 16, 0, -depth / 2 + (i * 2 + 0.5) * depth / 16, mowing);
  } else if (profile === "park") {
    const paving = createSurfaceMaterial("concrete", "#b6ad94", [3.3, depth]);
    stripe(3.3, depth, 0, 0, paving);
    const plaza = new THREE.Mesh(new THREE.CircleGeometry(3.2, 64), createSurfaceMaterial("concrete", "#a69e8c", [6.4, 6.4]));
    plaza.rotation.x = -Math.PI / 2;
    plaza.position.set(0.5, ground.y + 0.006, -3.5);
    plaza.receiveShadow = true;
    root.add(plaza);
  } else if (profile === "industrial") {
    const safety = new THREE.MeshStandardMaterial({ color: "#c6a449", roughness: 0.85 });
    for (const side of [-1, 1]) stripe(0.065, depth * 0.88, side * width * 0.23, 0, safety);
  } else if (profile === "daylight") {
    const track = new THREE.MeshStandardMaterial({ color: "#986853", roughness: 0.95 });
    stripe(width, 9, 0, 3, track);
    for (let i = 0; i < 6; i++) stripe(width, 0.055, 0, -1.5 + i * 1.8);
  }
  return root;
}
