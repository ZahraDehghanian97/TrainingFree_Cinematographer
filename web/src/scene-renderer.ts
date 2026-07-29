import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import type {
  BoundsV1,
  EnvironmentV1,
  PresetVisualV1,
  PrimitiveVisualV1,
  SceneEntityV1,
  Vec3,
} from "../../src/types/environment";
import type {
  CameraSampleV1,
  CameraTrajectoryV1,
} from "../../src/types/trajectory";
import { sampleEntityTransform } from "./environment-loader";
import { sampleCameraTrajectory } from "./trajectory-loader";

export type SceneViewMode = "god" | "director";
/** Backward-friendly short name used by the visualizer UI. */
export type ViewMode = SceneViewMode;

export interface SceneRendererOptions {
  /** Initial viewport. The default is the orbitable overview camera. */
  viewMode?: SceneViewMode;
  showPath?: boolean;
  showBounds?: boolean;
  showLabels?: boolean;
  /** Upper bound for the renderer's pixel ratio. Defaults to 2. */
  maxPixelRatio?: number;
}

export interface SceneRendererToggles {
  path?: boolean;
  bounds?: boolean;
  labels?: boolean;
}

interface LabelRecord {
  sprite: THREE.Sprite;
  texture: THREE.CanvasTexture;
}

interface TargetMarkerRecord {
  entityId: string;
  localAnchor: THREE.Vector3;
  marker: THREE.Object3D;
}

const DEFAULT_BACKGROUND = "#080b12";
const DEFAULT_OBJECT_COLOR = "#718096";
const PATH_COLORS = [0x40e0d0, 0x4aa8ff, 0xc084fc, 0xffa24a];
const WORLD_UP = new THREE.Vector3(0, 1, 0);

function vec3(value: Vec3): THREE.Vector3 {
  return new THREE.Vector3(value[0], value[1], value[2]);
}

function cloneSample(sample: CameraSampleV1): CameraSampleV1 {
  return {
    ...sample,
    position: [...sample.position] as Vec3,
    rotation: sample.rotation ? [...sample.rotation] : undefined,
    lookAt: sample.lookAt ? [...sample.lookAt] as Vec3 : undefined,
  };
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function presetNumber(
  visual: PresetVisualV1,
  name: string,
  fallback: number,
): number {
  return finiteNumber(visual.params?.[name], fallback);
}

function presetString(
  visual: PresetVisualV1,
  name: string,
  fallback: string,
): string {
  const value = visual.params?.[name];
  return typeof value === "string" ? value : fallback;
}

function presetBoolean(
  visual: PresetVisualV1,
  name: string,
  fallback = false,
): boolean {
  const value = visual.params?.[name];
  return typeof value === "boolean" ? value : fallback;
}

function primitiveNumber(
  visual: PrimitiveVisualV1,
  name: string,
  fallback: number,
): number {
  return finiteNumber(visual.params[name], fallback);
}

function primitiveSize(
  visual: PrimitiveVisualV1,
  fallback: Vec3,
): Vec3 {
  const value = visual.params.size;
  if (
    Array.isArray(value)
    && value.length === 3
    && value.every((component) => typeof component === "number" && Number.isFinite(component))
  ) {
    return [...value] as Vec3;
  }
  return [
    primitiveNumber(visual, "width", fallback[0]),
    primitiveNumber(visual, "height", fallback[1]),
    primitiveNumber(visual, "depth", fallback[2]),
  ];
}

function standardMaterial(
  color: THREE.ColorRepresentation,
  options: Partial<THREE.MeshStandardMaterialParameters> = {},
): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: 0.72,
    metalness: 0.08,
    ...options,
  });
}

function basicMesh(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  position?: readonly [number, number, number],
): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material);
  if (position) mesh.position.set(...position);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** Creates one of the schema's data-driven primitive visuals. */
export function createPrimitiveVisual(visual: PrimitiveVisualV1): THREE.Object3D {
  const color = visual.color ?? DEFAULT_OBJECT_COLOR;
  const material = standardMaterial(color, {
    side: visual.shape === "plane" ? THREE.DoubleSide : THREE.FrontSide,
  });

  switch (visual.shape) {
    case "box": {
      const size = primitiveSize(visual, [1, 1, 1]);
      return basicMesh(new THREE.BoxGeometry(...size), material);
    }
    case "sphere": {
      const radius = primitiveNumber(visual, "radius", 0.5);
      const widthSegments = Math.max(8, Math.round(primitiveNumber(visual, "widthSegments", 32)));
      const heightSegments = Math.max(6, Math.round(primitiveNumber(visual, "heightSegments", 18)));
      return basicMesh(
        new THREE.SphereGeometry(radius, widthSegments, heightSegments),
        material,
      );
    }
    case "cylinder": {
      const radius = primitiveNumber(visual, "radius", 0.5);
      const radiusTop = primitiveNumber(visual, "radiusTop", radius);
      const radiusBottom = primitiveNumber(visual, "radiusBottom", radius);
      const height = primitiveNumber(visual, "height", 1);
      const radialSegments = Math.max(6, Math.round(primitiveNumber(visual, "radialSegments", 32)));
      return basicMesh(
        new THREE.CylinderGeometry(radiusTop, radiusBottom, height, radialSegments),
        material,
      );
    }
    case "cone": {
      const radius = primitiveNumber(visual, "radius", 0.5);
      const height = primitiveNumber(visual, "height", 1);
      const radialSegments = Math.max(6, Math.round(primitiveNumber(visual, "radialSegments", 32)));
      return basicMesh(new THREE.ConeGeometry(radius, height, radialSegments), material);
    }
    case "plane": {
      const size = primitiveSize(visual, [1, 1, 0]);
      const mesh = basicMesh(new THREE.PlaneGeometry(size[0], size[1]), material);
      mesh.castShadow = false;
      return mesh;
    }
    case "torus": {
      const radius = primitiveNumber(visual, "radius", 0.5);
      const tube = primitiveNumber(visual, "tube", Math.max(0.01, radius * 0.08));
      const radialSegments = Math.max(6, Math.round(primitiveNumber(visual, "radialSegments", 16)));
      const tubularSegments = Math.max(12, Math.round(primitiveNumber(visual, "tubularSegments", 64)));
      return basicMesh(
        new THREE.TorusGeometry(radius, tube, radialSegments, tubularSegments),
        material,
      );
    }
  }
}

function createSoccerBall(visual: PresetVisualV1): THREE.Object3D {
  const radius = presetNumber(visual, "radius", 0.35);
  const group = new THREE.Group();
  const ball = basicMesh(
    new THREE.SphereGeometry(radius, 40, 24),
    standardMaterial(presetString(visual, "color", "#f4f4f1"), {
      roughness: 0.62,
    }),
  );
  group.add(ball);

  // A dark icosahedral seam reads clearly as a football without a texture asset.
  const seams = new THREE.LineSegments(
    new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(radius * 1.004, 2)),
    new THREE.LineBasicMaterial({ color: 0x20242b, transparent: true, opacity: 0.65 }),
  );
  group.add(seams);
  return group;
}

function createSoccerGoal(visual: PresetVisualV1): THREE.Object3D {
  const width = presetNumber(visual, "width", 6);
  const height = presetNumber(visual, "height", 2.5);
  const depth = presetNumber(visual, "depth", 1.2);
  const postSize = Math.max(0.055, presetNumber(visual, "postSize", 0.1));
  const group = new THREE.Group();
  const frameMaterial = standardMaterial(
    presetString(visual, "color", "#f2f5f7"),
    { roughness: 0.38, metalness: 0.25 },
  );

  group.add(
    basicMesh(new THREE.BoxGeometry(postSize, height, postSize), frameMaterial, [-width / 2, height / 2, 0]),
    basicMesh(new THREE.BoxGeometry(postSize, height, postSize), frameMaterial, [width / 2, height / 2, 0]),
    basicMesh(new THREE.BoxGeometry(width + postSize, postSize, postSize), frameMaterial, [0, height, 0]),
    basicMesh(new THREE.BoxGeometry(postSize, postSize, depth), frameMaterial, [-width / 2, postSize / 2, -depth / 2]),
    basicMesh(new THREE.BoxGeometry(postSize, postSize, depth), frameMaterial, [width / 2, postSize / 2, -depth / 2]),
  );

  const netPoints: number[] = [];
  const columns = Math.max(6, Math.round(width / 0.5));
  const rows = Math.max(4, Math.round(height / 0.45));
  for (let column = 0; column <= columns; column += 1) {
    const x = -width / 2 + (width * column) / columns;
    netPoints.push(x, 0, -depth, x, height, -depth);
  }
  for (let row = 0; row <= rows; row += 1) {
    const y = (height * row) / rows;
    netPoints.push(-width / 2, y, -depth, width / 2, y, -depth);
  }
  for (let column = 0; column <= columns; column += 1) {
    const x = -width / 2 + (width * column) / columns;
    netPoints.push(x, 0, 0, x, 0, -depth);
  }
  const netGeometry = new THREE.BufferGeometry();
  netGeometry.setAttribute("position", new THREE.Float32BufferAttribute(netPoints, 3));
  group.add(new THREE.LineSegments(
    netGeometry,
    new THREE.LineBasicMaterial({ color: 0xa9c1c8, transparent: true, opacity: 0.42 }),
  ));
  return group;
}

function createHumanoid(visual: PresetVisualV1): THREE.Object3D {
  const group = new THREE.Group();
  const skin = standardMaterial(presetString(visual, "color", "#d3a889"), { roughness: 0.78 });
  const shirt = standardMaterial(presetString(visual, "shirtColor", "#365b78"), { roughness: 0.86 });
  const trousers = standardMaterial(presetString(visual, "trouserColor", "#252b35"), { roughness: 0.9 });
  const shoe = standardMaterial("#11151a", { roughness: 0.92 });

  group.add(
    basicMesh(new THREE.BoxGeometry(0.62, 0.68, 0.34), shirt, [0, 1.14, 0]),
    basicMesh(new THREE.CylinderGeometry(0.19, 0.2, 0.72, 18), trousers, [-0.19, 0.49, 0]),
    basicMesh(new THREE.CylinderGeometry(0.19, 0.2, 0.72, 18), trousers, [0.19, 0.49, 0]),
    basicMesh(new THREE.BoxGeometry(0.28, 0.14, 0.48), shoe, [-0.19, 0.1, 0.07]),
    basicMesh(new THREE.BoxGeometry(0.28, 0.14, 0.48), shoe, [0.19, 0.1, 0.07]),
    basicMesh(new THREE.CylinderGeometry(0.075, 0.075, 0.13, 16), skin, [0, 1.51, 0]),
    basicMesh(new THREE.SphereGeometry(0.225, 28, 18), skin, [0, 1.69, 0]),
  );

  for (const side of [-1, 1] as const) {
    const arm = basicMesh(new THREE.CylinderGeometry(0.09, 0.1, 0.62, 16), shirt, [side * 0.4, 1.13, 0]);
    arm.rotation.z = side * -0.09;
    group.add(arm);
    group.add(basicMesh(new THREE.SphereGeometry(0.105, 18, 12), skin, [side * 0.43, 0.8, 0]));
  }

  const eyeMaterial = standardMaterial("#111820", { roughness: 0.35 });
  group.add(
    basicMesh(new THREE.SphereGeometry(0.026, 12, 8), eyeMaterial, [-0.07, 1.72, 0.205]),
    basicMesh(new THREE.SphereGeometry(0.026, 12, 8), eyeMaterial, [0.07, 1.72, 0.205]),
  );
  return group;
}

function createCar(visual: PresetVisualV1): THREE.Object3D {
  const length = presetNumber(visual, "length", 4.4);
  const width = presetNumber(visual, "width", 2);
  const height = presetNumber(visual, "height", 1.4);
  const group = new THREE.Group();
  const paint = standardMaterial(presetString(visual, "color", "#c74f42"), {
    roughness: 0.3,
    metalness: 0.48,
  });
  const dark = standardMaterial("#111820", { roughness: 0.38, metalness: 0.3 });
  const glass = standardMaterial("#426779", {
    roughness: 0.16,
    metalness: 0.1,
    transparent: true,
    opacity: 0.74,
  });

  group.add(
    basicMesh(new THREE.BoxGeometry(width, height * 0.46, length), paint, [0, height * 0.34, 0]),
    basicMesh(new THREE.BoxGeometry(width * 0.82, height * 0.46, length * 0.49), glass, [0, height * 0.75, length * 0.03]),
    basicMesh(new THREE.BoxGeometry(width * 0.9, height * 0.08, length * 0.26), paint, [0, height * 0.57, -length * 0.34]),
  );

  const wheelGeometry = new THREE.CylinderGeometry(height * 0.19, height * 0.19, width * 0.11, 24);
  const hubMaterial = standardMaterial("#85919b", { roughness: 0.32, metalness: 0.7 });
  for (const xSide of [-1, 1] as const) {
    for (const zSide of [-1, 1] as const) {
      const wheel = basicMesh(wheelGeometry, dark, [xSide * width * 0.51, height * 0.25, zSide * length * 0.31]);
      wheel.rotation.z = Math.PI / 2;
      group.add(wheel);
      const hub = basicMesh(
        new THREE.CylinderGeometry(height * 0.09, height * 0.09, width * 0.12, 18),
        hubMaterial,
        [xSide * width * 0.515, height * 0.25, zSide * length * 0.31],
      );
      hub.rotation.z = Math.PI / 2;
      group.add(hub);
    }
  }

  if (presetString(visual, "style", "") === "race") {
    group.add(
      basicMesh(new THREE.BoxGeometry(width * 1.05, 0.07, 0.32), dark, [0, height * 0.83, length * 0.43]),
      basicMesh(new THREE.BoxGeometry(0.07, 0.3, 0.07), dark, [-width * 0.34, height * 0.68, length * 0.43]),
      basicMesh(new THREE.BoxGeometry(0.07, 0.3, 0.07), dark, [width * 0.34, height * 0.68, length * 0.43]),
    );
  }
  if (presetBoolean(visual, "interior")) {
    group.add(basicMesh(
      new THREE.BoxGeometry(width * 0.75, 0.12, 0.35),
      dark,
      [0, height * 0.73, -length * 0.12],
    ));
  }
  return group;
}

function createDoor(visual: PresetVisualV1): THREE.Object3D {
  const width = presetNumber(visual, "width", 1.05);
  const height = presetNumber(visual, "height", 2.2);
  const depth = presetNumber(visual, "depth", 0.12);
  const group = new THREE.Group();
  const panel = standardMaterial(presetString(visual, "color", "#46352a"), {
    roughness: 0.78,
  });
  const trim = standardMaterial("#181b20", { roughness: 0.55, metalness: 0.35 });
  group.add(basicMesh(new THREE.BoxGeometry(width, height, depth), panel, [0, height / 2, 0]));
  const inset = basicMesh(
    new THREE.BoxGeometry(width * 0.7, height * 0.68, depth * 1.04),
    standardMaterial("#251e1a", { roughness: 0.82 }),
    [0, height * 0.53, depth * 0.02],
  );
  group.add(inset);
  group.add(basicMesh(
    new THREE.SphereGeometry(Math.max(0.035, width * 0.045), 18, 12),
    trim,
    [width * 0.34, height * 0.49, depth * 0.62],
  ));
  return group;
}

function createVase(visual: PresetVisualV1): THREE.Object3D {
  const height = presetNumber(visual, "height", 0.95);
  const radius = presetNumber(visual, "radius", height * 0.28);
  const points = [
    new THREE.Vector2(radius * 0.52, 0),
    new THREE.Vector2(radius * 0.9, height * 0.08),
    new THREE.Vector2(radius, height * 0.34),
    new THREE.Vector2(radius * 0.72, height * 0.7),
    new THREE.Vector2(radius * 0.47, height * 0.84),
    new THREE.Vector2(radius * 0.5, height),
  ];
  return basicMesh(
    new THREE.LatheGeometry(points, 32),
    standardMaterial(presetString(visual, "color", "#39cdbb"), {
      roughness: 0.3,
      metalness: 0.12,
      side: THREE.DoubleSide,
    }),
  );
}

function createMonitor(visual: PresetVisualV1): THREE.Object3D {
  const width = presetNumber(visual, "width", 1.35);
  const height = presetNumber(visual, "height", 0.82);
  const depth = presetNumber(visual, "depth", 0.13);
  const standHeight = presetNumber(visual, "standHeight", 0.27);
  const group = new THREE.Group();
  const bezel = standardMaterial("#11161d", { roughness: 0.38, metalness: 0.34 });
  const screen = standardMaterial(presetString(visual, "screenColor", "#4aa8ff"), {
    roughness: 0.22,
    emissive: new THREE.Color(presetString(visual, "screenColor", "#4aa8ff")),
    emissiveIntensity: 0.25,
  });
  const screenY = standHeight + height / 2;
  group.add(
    basicMesh(new THREE.BoxGeometry(width, height, depth), bezel, [0, screenY, 0]),
    basicMesh(new THREE.PlaneGeometry(width * 0.9, height * 0.82), screen, [0, screenY, depth / 2 + 0.004]),
    basicMesh(new THREE.BoxGeometry(0.1, standHeight, 0.08), bezel, [0, standHeight / 2, 0]),
    basicMesh(new THREE.BoxGeometry(width * 0.38, 0.055, depth * 1.8), bezel, [0, 0.028, 0]),
  );
  return group;
}

function createGenericObject(visual: PresetVisualV1): THREE.Object3D {
  const width = presetNumber(visual, "width", 1);
  const height = presetNumber(visual, "height", 1);
  const depth = presetNumber(visual, "depth", 1);
  const shape = presetString(visual, "shape", "box");
  const material = standardMaterial(presetString(visual, "color", DEFAULT_OBJECT_COLOR));
  if (shape === "sphere") {
    return basicMesh(new THREE.SphereGeometry(Math.max(width, height, depth) / 2, 28, 18), material);
  }
  if (shape === "cylinder") {
    return basicMesh(new THREE.CylinderGeometry(width / 2, width / 2, height, 28), material);
  }
  return basicMesh(new THREE.BoxGeometry(width, height, depth), material);
}

/** Creates one of the semantic preset visuals supported by EnvironmentV1. */
export function createPresetVisual(visual: PresetVisualV1): THREE.Object3D {
  switch (visual.name) {
    case "soccerBall":
      return createSoccerBall(visual);
    case "soccerGoal":
      return createSoccerGoal(visual);
    case "humanoid":
      return createHumanoid(visual);
    case "car":
      return createCar(visual);
    case "door":
      return createDoor(visual);
    case "vase":
      return createVase(visual);
    case "monitor":
      return createMonitor(visual);
    case "genericObject":
      return createGenericObject(visual);
  }
}

function createEntityVisual(entity: SceneEntityV1): THREE.Object3D {
  return entity.visual.type === "primitive"
    ? createPrimitiveVisual(entity.visual)
    : createPresetVisual(entity.visual);
}

function createBoundsVisual(bounds: BoundsV1, color: THREE.ColorRepresentation): THREE.Mesh {
  let geometry: THREE.BufferGeometry;
  const center = new THREE.Vector3();
  if (bounds.type === "sphere") {
    geometry = new THREE.SphereGeometry(bounds.radius, 18, 12);
    center.fromArray(bounds.center);
  } else {
    const minimum = vec3(bounds.min);
    const maximum = vec3(bounds.max);
    geometry = new THREE.BoxGeometry(
      maximum.x - minimum.x,
      maximum.y - minimum.y,
      maximum.z - minimum.z,
    );
    center.addVectors(minimum, maximum).multiplyScalar(0.5);
  }
  const mesh = new THREE.Mesh(
    geometry,
    new THREE.MeshBasicMaterial({
      color,
      wireframe: true,
      transparent: true,
      opacity: 0.62,
      depthTest: false,
    }),
  );
  mesh.position.copy(center);
  mesh.renderOrder = 20;
  return mesh;
}

function createLabel(text: string): LabelRecord {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 128;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D is unavailable; labels cannot be created");

  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "rgba(5, 9, 15, 0.82)";
  context.strokeStyle = "rgba(99, 224, 208, 0.85)";
  context.lineWidth = 3;
  context.beginPath();
  context.roundRect(5, 10, canvas.width - 10, canvas.height - 20, 22);
  context.fill();
  context.stroke();
  context.fillStyle = "#eef8fb";
  context.font = "600 36px system-ui, sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.direction = "inherit";
  const renderedText = text.length > 30 ? `${text.slice(0, 29)}…` : text;
  context.fillText(renderedText, canvas.width / 2, canvas.height / 2 + 1, canvas.width - 36);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearFilter;
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(1.8, 0.45, 1);
  sprite.renderOrder = 30;
  return { sprite, texture };
}

function disposeMaterial(material: THREE.Material): void {
  const candidate = material as THREE.Material & {
    map?: THREE.Texture | null;
    emissiveMap?: THREE.Texture | null;
    alphaMap?: THREE.Texture | null;
  };
  candidate.map?.dispose();
  candidate.emissiveMap?.dispose();
  candidate.alphaMap?.dispose();
  material.dispose();
}

function disposeObject(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  root.traverse((object) => {
    const renderable = object as THREE.Object3D & {
      geometry?: THREE.BufferGeometry;
      material?: THREE.Material | THREE.Material[];
    };
    if (renderable.geometry) geometries.add(renderable.geometry);
    if (Array.isArray(renderable.material)) {
      renderable.material.forEach((material) => materials.add(material));
    } else if (renderable.material) {
      materials.add(renderable.material);
    }
  });
  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach(disposeMaterial);
  root.clear();
  root.removeFromParent();
}

/**
 * Three.js renderer for an EnvironmentV1 and an uploaded CameraTrajectoryV1.
 *
 * The host owns playback/RAF: call setTime(), then render().
 */
export class SceneRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly godCamera = new THREE.PerspectiveCamera(50, 1, 0.05, 5000);
  readonly directorCamera = new THREE.PerspectiveCamera(50, 1, 0.05, 5000);
  readonly controls: OrbitControls;

  private readonly canvas: HTMLCanvasElement;
  private readonly environmentRoot = new THREE.Group();
  private readonly trajectoryRoot = new THREE.Group();
  private readonly overlayRoot = new THREE.Group();
  private readonly entityObjects = new Map<string, THREE.Object3D>();
  private readonly boundsObjects: THREE.Object3D[] = [];
  private readonly labels: LabelRecord[] = [];
  private readonly targetMarkers = new Map<string, TargetMarkerRecord>();
  private readonly currentCameraMarker: THREE.Mesh;
  /** Display-only proxy: its capped far plane keeps the helper legible. */
  private readonly helperCamera = new THREE.PerspectiveCamera(50, 1, 0.05, 5);
  private readonly cameraHelper: THREE.CameraHelper;
  private readonly resizeObserver: ResizeObserver | null;
  private readonly maxPixelRatio: number;

  private environment: EnvironmentV1 | null = null;
  private trajectory: CameraTrajectoryV1 | null = null;
  private currentSample: CameraSampleV1 | null = null;
  private currentTime = 0;
  private currentEnvironmentTime = 0;
  private viewMode: SceneViewMode;
  private showPath: boolean;
  private showBounds: boolean;
  private showLabels: boolean;
  private disposed = false;

  constructor(canvas: HTMLCanvasElement, options: SceneRendererOptions = {}) {
    this.canvas = canvas;
    this.viewMode = options.viewMode ?? "god";
    this.showPath = options.showPath ?? true;
    this.showBounds = options.showBounds ?? false;
    this.showLabels = options.showLabels ?? true;
    this.maxPixelRatio = Math.max(1, options.maxPixelRatio ?? 2);

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.06;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.scene.background = new THREE.Color(DEFAULT_BACKGROUND);

    this.godCamera.position.set(10, 8, 12);
    this.godCamera.lookAt(0, 0, 0);
    this.controls = new OrbitControls(this.godCamera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.075;
    this.controls.target.set(0, 0.8, 0);
    this.controls.minDistance = 0.2;
    this.controls.maxDistance = 2500;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.update();

    this.scene.add(this.environmentRoot, this.trajectoryRoot, this.overlayRoot);
    this.addLights();

    this.currentCameraMarker = basicMesh(
      new THREE.SphereGeometry(0.09, 16, 10),
      standardMaterial("#ffb454", {
        emissive: new THREE.Color("#ff8a35"),
        emissiveIntensity: 0.55,
      }),
    );
    this.currentCameraMarker.castShadow = false;
    this.overlayRoot.add(this.currentCameraMarker);

    this.cameraHelper = new THREE.CameraHelper(this.helperCamera);
    this.cameraHelper.renderOrder = 12;
    this.overlayRoot.add(this.cameraHelper);

    this.resize();
    this.resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => this.resize());
    this.resizeObserver?.observe(canvas);
    this.applyVisibility();
  }

  private addLights(): void {
    const hemisphere = new THREE.HemisphereLight(0xb6d5f4, 0x172012, 1.25);
    const ambient = new THREE.AmbientLight(0x9bb1c7, 0.42);
    const key = new THREE.DirectionalLight(0xfff0dd, 2.25);
    key.position.set(10, 18, 8);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.near = 0.5;
    key.shadow.camera.far = 150;
    key.shadow.bias = -0.0002;
    this.scene.add(hemisphere, ambient, key);
  }

  get hasTrajectory(): boolean {
    return this.trajectory !== null;
  }

  getViewMode(): SceneViewMode {
    return this.viewMode;
  }

  getEnvironment(): EnvironmentV1 | null {
    return this.environment;
  }

  getTrajectory(): CameraTrajectoryV1 | null {
    return this.trajectory;
  }

  getActiveCamera(): THREE.PerspectiveCamera {
    return this.viewMode === "director" ? this.directorCamera : this.godCamera;
  }

  getEntityObject(entityId: string): THREE.Object3D | undefined {
    return this.entityObjects.get(entityId);
  }

  getCurrentCameraSample(): CameraSampleV1 | null {
    return this.currentSample ? cloneSample(this.currentSample) : null;
  }

  getTargetPosition(targetId: string): THREE.Vector3 | null {
    const record = this.targetMarkers.get(targetId);
    const entity = record ? this.entityObjects.get(record.entityId) : undefined;
    if (!record || !entity) return null;
    entity.updateWorldMatrix(true, false);
    return record.localAnchor.clone().applyMatrix4(entity.matrixWorld);
  }

  setEnvironment(environment: EnvironmentV1): void {
    this.assertUsable();
    if (this.trajectory && this.trajectory.environmentId !== environment.id) {
      this.setTrajectory(null);
    }
    this.clearEnvironment();
    this.environment = environment;
    this.scene.background = new THREE.Color(environment.world?.background ?? DEFAULT_BACKGROUND);
    this.buildWorld(environment);

    for (const entity of environment.entities) {
      const root = new THREE.Group();
      root.name = `entity:${entity.id}`;
      root.userData.entityId = entity.id;
      root.add(createEntityVisual(entity));
      this.environmentRoot.add(root);
      this.entityObjects.set(entity.id, root);

      if (entity.bounds) {
        const bounds = createBoundsVisual(entity.bounds, 0x4aa8ff);
        root.add(bounds);
        this.boundsObjects.push(bounds);
      }
    }

    for (const target of environment.targets) {
      const entity = this.entityObjects.get(target.entityId);
      if (!entity) continue;
      if (target.localBounds) {
        const bounds = createBoundsVisual(target.localBounds, 0xffb454);
        entity.add(bounds);
        this.boundsObjects.push(bounds);
      }

      const marker = new THREE.Group();
      marker.name = `target:${target.id}`;
      const dot = basicMesh(
        new THREE.OctahedronGeometry(0.085, 0),
        standardMaterial("#ffb454", {
          emissive: new THREE.Color("#ff8a35"),
          emissiveIntensity: 0.6,
        }),
      );
      dot.castShadow = false;
      marker.add(dot);
      if (target.label) {
        const label = createLabel(target.label);
        label.sprite.position.set(0, 0.28, 0);
        marker.add(label.sprite);
        this.labels.push(label);
      }
      this.overlayRoot.add(marker);
      this.targetMarkers.set(target.id, {
        entityId: target.entityId,
        localAnchor: vec3(target.localAnchor),
        marker,
      });
    }

    this.resetGodView();
    this.setTime(this.currentTime);
    this.applyVisibility();
  }

  setTrajectory(trajectory: CameraTrajectoryV1 | null): void {
    this.assertUsable();
    if (
      trajectory
      && this.environment
      && trajectory.environmentId !== this.environment.id
    ) {
      throw new Error(
        `Trajectory environmentId ${JSON.stringify(trajectory.environmentId)} does not match ${JSON.stringify(this.environment.id)}`,
      );
    }

    this.clearTrajectory();
    this.trajectory = trajectory;
    if (!trajectory) {
      this.currentSample = null;
      this.applyVisibility();
      return;
    }

    this.directorCamera.near = trajectory.intrinsics.near;
    this.directorCamera.far = trajectory.intrinsics.far;
    this.directorCamera.fov = trajectory.intrinsics.fovYDegrees;
    this.directorCamera.updateProjectionMatrix();
    this.buildTrajectoryPath(trajectory);
    this.setTime(this.currentTime);
    this.applyVisibility();
  }

  setViewMode(mode: SceneViewMode): void {
    this.assertUsable();
    this.viewMode = mode;
    this.controls.enabled = mode === "god";
    this.applyVisibility();
  }

  setShowPath(show: boolean): void {
    this.showPath = show;
    this.applyVisibility();
  }

  setShowBounds(show: boolean): void {
    this.showBounds = show;
    this.applyVisibility();
  }

  setShowLabels(show: boolean): void {
    this.showLabels = show;
    this.applyVisibility();
  }

  setToggles(toggles: SceneRendererToggles): void {
    if (toggles.path !== undefined) this.showPath = toggles.path;
    if (toggles.bounds !== undefined) this.showBounds = toggles.bounds;
    if (toggles.labels !== undefined) this.showLabels = toggles.labels;
    this.applyVisibility();
  }

  /**
   * Updates animated entities and the director camera. Camera playback time and
   * environment time may differ during frozen, slow-motion, or fast segments.
   */
  setTime(timeSeconds: number, environmentTimeSeconds = timeSeconds): CameraSampleV1 | null {
    this.assertUsable();
    if (!Number.isFinite(timeSeconds)) throw new Error("Playback time must be finite");
    if (!Number.isFinite(environmentTimeSeconds)) throw new Error("Environment time must be finite");
    this.currentTime = Math.max(0, timeSeconds);
    this.currentEnvironmentTime = Math.max(0, environmentTimeSeconds);

    if (this.environment) {
      for (const entity of this.environment.entities) {
        const object = this.entityObjects.get(entity.id);
        if (!object) continue;
        const transform = sampleEntityTransform(entity, this.currentEnvironmentTime);
        object.position.fromArray(transform.position);
        object.quaternion.fromArray(transform.rotation);
        object.scale.fromArray(transform.scale);
      }
      this.environmentRoot.updateMatrixWorld(true);
      this.updateTargetMarkers();
    }

    if (this.trajectory) {
      const sample = sampleCameraTrajectory(this.trajectory, this.currentTime);
      this.currentSample = sample;
      this.applyDirectorPose(sample);
    } else {
      this.currentSample = null;
    }
    this.applyVisibility();
    return this.getCurrentCameraSample();
  }

  /** Draws one frame. Playback state is not advanced here. */
  render(): void {
    this.assertUsable();
    if (this.viewMode === "god") this.controls.update();
    this.cameraHelper.update();
    this.renderer.render(this.scene, this.getActiveCamera());
  }

  /** Resizes drawing buffers while preserving the canvas's CSS size. */
  resize(width?: number, height?: number, pixelRatio?: number): void {
    if (this.disposed) return;
    const resolvedWidth = Math.max(1, Math.floor(width ?? this.canvas.clientWidth ?? this.canvas.width ?? 1));
    const resolvedHeight = Math.max(1, Math.floor(height ?? this.canvas.clientHeight ?? this.canvas.height ?? 1));
    const ratio = Math.min(
      this.maxPixelRatio,
      Math.max(1, pixelRatio ?? globalThis.devicePixelRatio ?? 1),
    );
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(resolvedWidth, resolvedHeight, false);
    const aspect = resolvedWidth / resolvedHeight;
    this.godCamera.aspect = aspect;
    this.godCamera.updateProjectionMatrix();
    this.directorCamera.aspect = aspect;
    this.directorCamera.updateProjectionMatrix();
    this.helperCamera.aspect = aspect;
    this.helperCamera.updateProjectionMatrix();
  }

  resetGodView(): void {
    const groundSize = this.environment?.world?.ground?.size;
    const gridSize = this.environment?.world?.grid?.size;
    const extent = Math.max(8, groundSize?.[0] ?? 0, groundSize?.[1] ?? 0, gridSize ?? 0);
    const groundY = this.environment?.world?.ground?.y ?? 0;
    const overviewCamera = this.environment?.world?.overviewCamera;
    if (overviewCamera) {
      this.controls.target.fromArray(overviewCamera.target);
      this.godCamera.position.fromArray(overviewCamera.position);
    } else {
      const distance = extent * 0.58;
      this.controls.target.set(0, groundY + Math.min(2, extent * 0.035), 0);
      this.godCamera.position.set(distance * 0.85, distance * 0.62, distance);
    }
    this.godCamera.near = Math.max(0.02, extent / 10_000);
    this.godCamera.far = Math.max(5000, extent * 12);
    this.godCamera.updateProjectionMatrix();
    this.controls.maxDistance = Math.max(250, extent * 4);
    this.controls.update();
  }

  dispose(): void {
    if (this.disposed) return;
    this.resizeObserver?.disconnect();
    this.controls.dispose();
    this.clearTrajectory();
    this.clearEnvironment();
    this.cameraHelper.geometry.dispose();
    const helperMaterials = Array.isArray(this.cameraHelper.material)
      ? this.cameraHelper.material
      : [this.cameraHelper.material];
    helperMaterials.forEach((material) => material.dispose());
    this.currentCameraMarker.geometry.dispose();
    const markerMaterial = this.currentCameraMarker.material;
    if (Array.isArray(markerMaterial)) markerMaterial.forEach(disposeMaterial);
    else disposeMaterial(markerMaterial);
    this.renderer.dispose();
    this.disposed = true;
  }

  private buildWorld(environment: EnvironmentV1): void {
    const ground = environment.world?.ground;
    if (ground) {
      const geometry = new THREE.PlaneGeometry(ground.size[0], ground.size[1]);
      const material = standardMaterial(ground.color ?? "#171d24", {
        roughness: 0.94,
        metalness: 0,
      });
      const mesh = basicMesh(geometry, material, [0, ground.y, 0]);
      mesh.rotation.x = -Math.PI / 2;
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      mesh.name = "world:ground";
      this.environmentRoot.add(mesh);
    }

    const grid = environment.world?.grid;
    if (grid) {
      const helper = new THREE.GridHelper(grid.size, grid.divisions, 0x41677a, 0x263a45);
      helper.position.y = (ground?.y ?? 0) + 0.006;
      helper.name = "world:grid";
      const materials = Array.isArray(helper.material) ? helper.material : [helper.material];
      materials.forEach((material) => {
        material.transparent = true;
        material.opacity = 0.44;
      });
      this.environmentRoot.add(helper);
    }
  }

  private buildTrajectoryPath(trajectory: CameraTrajectoryV1): void {
    const segments: CameraSampleV1[][] = [];
    let segment: CameraSampleV1[] = [];
    for (const sample of trajectory.samples) {
      if (sample.cutBefore && segment.length > 0) {
        segments.push(segment);
        segment = [];
      }
      segment.push(sample);
    }
    if (segment.length > 0) segments.push(segment);

    segments.forEach((samples, index) => {
      const material = new THREE.LineBasicMaterial({
        color: PATH_COLORS[index % PATH_COLORS.length],
        transparent: true,
        opacity: 0.92,
        depthTest: false,
      });
      if (samples.length >= 2) {
        const geometry = new THREE.BufferGeometry().setFromPoints(
          samples.map((sample) => vec3(sample.position)),
        );
        const line = new THREE.Line(geometry, material);
        line.renderOrder = 10;
        line.name = `camera-path:${index}`;
        this.trajectoryRoot.add(line);
      } else {
        const point = basicMesh(
          new THREE.SphereGeometry(0.06, 10, 8),
          standardMaterial(PATH_COLORS[index % PATH_COLORS.length]),
          samples[0].position,
        );
        point.castShadow = false;
        point.name = `camera-path:${index}`;
        this.trajectoryRoot.add(point);
        material.dispose();
      }
    });
  }

  private applyDirectorPose(sample: CameraSampleV1): void {
    const camera = this.directorCamera;
    camera.position.fromArray(sample.position);
    camera.fov = sample.fovYDegrees ?? this.trajectory?.intrinsics.fovYDegrees ?? camera.fov;
    const orientation = this.trajectory?.orientation;

    if (orientation?.mode === "quaternion" && sample.rotation) {
      camera.quaternion.fromArray(sample.rotation).normalize();
    } else if (orientation?.mode === "perSampleLookAt" && sample.lookAt) {
      camera.up.fromArray(orientation.up).normalize();
      camera.lookAt(vec3(sample.lookAt));
    } else if (orientation?.mode === "lookAtTarget") {
      camera.up.fromArray(orientation.up).normalize();
      const target = this.getTargetPosition(orientation.targetId);
      if (target && target.distanceToSquared(camera.position) > 1e-12) camera.lookAt(target);
    } else if (orientation?.mode === "lookAtPoint") {
      camera.up.fromArray(orientation.up).normalize();
      const target = vec3(orientation.point);
      if (target.distanceToSquared(camera.position) > 1e-12) camera.lookAt(target);
    } else if (orientation?.mode === "pathTangent") {
      camera.up.fromArray(orientation.up).normalize();
      const tangent = this.pathTangentAt(this.currentTime);
      if (tangent.lengthSq() > 1e-12) camera.lookAt(camera.position.clone().add(tangent));
    }

    camera.updateProjectionMatrix();
    camera.updateMatrixWorld(true);
    this.currentCameraMarker.position.copy(camera.position);
    this.syncHelperCamera();
    this.cameraHelper.update();
  }

  private syncHelperCamera(): void {
    const groundSize = this.environment?.world?.ground?.size;
    const gridSize = this.environment?.world?.grid?.size;
    const displayExtent = Math.max(
      8,
      gridSize ?? 0,
      groundSize ? Math.min(groundSize[0], groundSize[1]) : 0,
    );
    const displayFar = Math.max(
      this.directorCamera.near * 1.5,
      Math.min(this.directorCamera.far, 5, displayExtent * 0.15),
    );
    this.helperCamera.position.copy(this.directorCamera.position);
    this.helperCamera.quaternion.copy(this.directorCamera.quaternion);
    this.helperCamera.up.copy(this.directorCamera.up);
    this.helperCamera.fov = this.directorCamera.fov;
    this.helperCamera.aspect = this.directorCamera.aspect;
    this.helperCamera.near = Math.min(this.directorCamera.near, displayFar * 0.45);
    this.helperCamera.far = displayFar;
    this.helperCamera.updateProjectionMatrix();
    this.helperCamera.updateMatrixWorld(true);
  }

  private pathTangentAt(timeSeconds: number): THREE.Vector3 {
    const samples = this.trajectory?.samples;
    if (!samples || samples.length < 2) return new THREE.Vector3(0, 0, -1);

    let segmentStart = 0;
    let segmentEnd = samples.length - 1;
    for (let index = 1; index < samples.length; index += 1) {
      if (!samples[index].cutBefore) continue;
      if (timeSeconds >= samples[index].t) {
        segmentStart = index;
      } else {
        segmentEnd = index - 1;
        break;
      }
    }
    if (segmentStart === segmentEnd) return new THREE.Vector3(0, 0, -1);

    let right = segmentStart + 1;
    while (right <= segmentEnd && samples[right].t <= timeSeconds) right += 1;
    right = Math.min(segmentEnd, right);
    const left = Math.max(segmentStart, right - 1);
    let tangent = vec3(samples[right].position).sub(vec3(samples[left].position));
    if (tangent.lengthSq() <= 1e-12 && left > segmentStart) {
      tangent = vec3(samples[left].position).sub(vec3(samples[left - 1].position));
    }
    if (tangent.lengthSq() <= 1e-12 && right < segmentEnd) {
      tangent = vec3(samples[right + 1].position).sub(vec3(samples[right].position));
    }
    return tangent.normalize();
  }

  private updateTargetMarkers(): void {
    for (const record of this.targetMarkers.values()) {
      const entity = this.entityObjects.get(record.entityId);
      if (!entity) continue;
      record.marker.position.copy(record.localAnchor).applyMatrix4(entity.matrixWorld);
    }
  }

  private applyVisibility(): void {
    this.trajectoryRoot.visible = this.showPath && this.trajectory !== null;
    this.boundsObjects.forEach((object) => {
      object.visible = this.showBounds;
    });
    const showSemanticOverlays = this.showLabels && this.viewMode === "god";
    this.labels.forEach(({ sprite }) => {
      sprite.visible = showSemanticOverlays;
    });
    this.targetMarkers.forEach(({ marker }) => {
      // Keep semantic target dots tied to the labels toggle too.
      marker.visible = showSemanticOverlays;
    });
    const showCameraOverlay = this.viewMode === "god" && this.trajectory !== null;
    this.currentCameraMarker.visible = showCameraOverlay;
    this.cameraHelper.visible = showCameraOverlay;
  }

  private clearEnvironment(): void {
    this.labels.forEach(({ texture }) => texture.dispose());
    this.labels.length = 0;
    this.boundsObjects.length = 0;
    this.entityObjects.clear();
    this.targetMarkers.clear();
    for (const child of [...this.environmentRoot.children]) disposeObject(child);
    // Target marker objects are overlay children; preserve the camera overlays.
    for (const child of [...this.overlayRoot.children]) {
      if (child !== this.currentCameraMarker && child !== this.cameraHelper) disposeObject(child);
    }
    this.environment = null;
  }

  private clearTrajectory(): void {
    for (const child of [...this.trajectoryRoot.children]) disposeObject(child);
    this.trajectory = null;
    this.currentSample = null;
  }

  private assertUsable(): void {
    if (this.disposed) throw new Error("SceneRenderer has been disposed");
  }
}
