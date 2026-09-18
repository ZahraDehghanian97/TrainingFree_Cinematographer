import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

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
import { createDetailedPreset } from "./detailed-presets";
import { getHumanoidRig } from "./humanoid";
import { createHumanoidMotion } from "./humanoid-motion";
import { createArchitectureVisual } from "./architecture-materials";
import { visibleInArchitectureOverview } from "./architecture-visibility";
import { createEnvironmentProp } from "./environment-props";
import { ModelAssetManager, disposeObject3D, prepareVisualShadows } from "./model-assets";
import { createSurfaceMaterial, createWorldGround, getWorldLook } from "./world-appearance";

export type SceneViewMode = "god" | "director";
/** Backward-friendly short name used by the visualizer UI. */
export type ViewMode = SceneViewMode;

export interface SceneRendererOptions {
  /** Initial viewport. The default is the orbitable overview camera. */
  viewMode?: SceneViewMode;
  showPath?: boolean;
  showBounds?: boolean;
  showLabels?: boolean;
  cutaway?: boolean;
  /** Upper bound for the renderer's pixel ratio. Defaults to 2. */
  maxPixelRatio?: number;
}

export interface SceneRendererToggles {
  path?: boolean;
  bounds?: boolean;
  labels?: boolean;
  cutaway?: boolean;
}

interface LabelRecord {
  sprite: THREE.Sprite;
  texture: THREE.CanvasTexture;
}

interface SemanticAnchorMarkerRecord {
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

function boundsCenter(bounds: BoundsV1 | undefined): THREE.Vector3 {
  if (bounds === undefined) return new THREE.Vector3();
  if (bounds.type === "sphere") return vec3(bounds.center);
  return new THREE.Vector3(
    (bounds.min[0] + bounds.max[0]) / 2,
    (bounds.min[1] + bounds.max[1]) / 2,
    (bounds.min[2] + bounds.max[2]) / 2,
  );
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
  return createDetailedPreset(visual) ?? createGenericObject(visual);
}

function createEntityVisual(entity: SceneEntityV1): THREE.Object3D {
  if (entity.visual.type === "model") {
    const fallback = entity.visual.fallback;
    return fallback
      ? createEntityVisual({ ...entity, visual: fallback })
      : createBoundsVisual(entity.bounds ?? { type: "sphere", center: [0, 0.5, 0], radius: 0.5 }, 0x7c8a96);
  }
  const architecture = createArchitectureVisual(entity);
  if (architecture) return architecture;
  const detailed = createEnvironmentProp(entity);
  if (detailed) return detailed;
  if (entity.visual.type === "primitive" && entity.visual.shape === "box"
    && /wall|column|pillar|stair/.test(entity.id)) {
    const size = primitiveSize(entity.visual, [1, 1, 1]);
    return basicMesh(new THREE.BoxGeometry(...size), createSurfaceMaterial("concrete", entity.visual.color ?? "#8e918e", [size[0], size[1]]));
  }
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
  const textures = new Set<THREE.Texture>();
  Object.values(material).forEach((value) => { if (value?.isTexture) textures.add(value); });
  textures.forEach((texture) => texture.dispose());
  material.dispose();
}

function disposeObject(root: THREE.Object3D): void {
  disposeObject3D(root);
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
  private readonly humanoidMotions = new Map<string, {
    visual: THREE.Object3D;
    controller: ReturnType<typeof createHumanoidMotion>;
  }>();
  private readonly entitySubjectCenters = new Map<string, THREE.Vector3>();
  private readonly boundsObjects: THREE.Object3D[] = [];
  private readonly labels: LabelRecord[] = [];
  private readonly semanticAnchorMarkers = new Map<string, SemanticAnchorMarkerRecord>();
  private readonly currentCameraMarker: THREE.Mesh;
  /** Display-only proxy: its capped far plane keeps the helper legible. */
  private readonly helperCamera = new THREE.PerspectiveCamera(50, 1, 0.05, 5);
  private readonly cameraHelper: THREE.CameraHelper;
  private readonly resizeObserver: ResizeObserver | null;
  private readonly maxPixelRatio: number;
  private readonly models = new ModelAssetManager({
    onError: (_error, entity) => console.warn(`Model for ${entity.id} could not be loaded; using its fallback.`),
  });
  private readonly hemisphere = new THREE.HemisphereLight();
  private readonly keyLight = new THREE.DirectionalLight();
  private readonly fillLight = new THREE.DirectionalLight();
  private readonly reflectionMap: THREE.WebGLRenderTarget;
  private readonly groundGrid = new THREE.Group();

  private environment: EnvironmentV1 | null = null;
  private trajectory: CameraTrajectoryV1 | null = null;
  private currentSample: CameraSampleV1 | null = null;
  private currentTime = 0;
  private currentEnvironmentTime = 0;
  private viewMode: SceneViewMode;
  private showPath: boolean;
  private showBounds: boolean;
  private showLabels: boolean;
  private cutaway: boolean;
  private readonly architectureEntities = new Map<string, SceneEntityV1>();
  private disposed = false;

  constructor(canvas: HTMLCanvasElement, options: SceneRendererOptions = {}) {
    this.canvas = canvas;
    this.viewMode = options.viewMode ?? "god";
    this.showPath = options.showPath ?? true;
    this.showBounds = options.showBounds ?? false;
    this.showLabels = options.showLabels ?? true;
    this.cutaway = options.cutaway ?? true;
    this.maxPixelRatio = Math.max(1, options.maxPixelRatio ?? 2);

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.06;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.scene.background = new THREE.Color(DEFAULT_BACKGROUND);
    const reflectionScene = new RoomEnvironment();
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.reflectionMap = pmrem.fromScene(reflectionScene, 0.04);
    this.scene.environment = this.reflectionMap.texture;
    reflectionScene.dispose();
    pmrem.dispose();

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

    this.scene.add(this.environmentRoot, this.trajectoryRoot, this.overlayRoot, this.groundGrid);
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
    const key = this.keyLight;
    key.position.set(10, 18, 8);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.near = 0.5;
    key.shadow.camera.far = 150;
    key.shadow.bias = -0.0002;
    key.shadow.normalBias = 0.018;
    this.fillLight.position.set(-12, 7, -8);
    this.scene.add(this.hemisphere, key, key.target, this.fillLight, this.fillLight.target);
  }

  private configureLighting(environment: EnvironmentV1): void {
    const look = getWorldLook(environment);
    this.scene.background = new THREE.Color(environment.world?.background ?? look.background);
    this.scene.environmentIntensity = look.reflection;
    this.renderer.toneMappingExposure = environment.world?.exposure ?? 1;
    this.hemisphere.color.set(look.sky);
    this.hemisphere.groundColor.set(look.bounce);
    this.hemisphere.intensity = look.ambient;
    this.keyLight.color.set(look.key);
    this.keyLight.intensity = look.intensity;
    this.fillLight.color.set(look.fill);
    this.fillLight.intensity = environment.world?.profile === "stage" ? 1.6 : 0.65;
    const ground = environment.world?.ground;
    const span = Math.max(8, Math.min(ground?.size[0] ?? 24, ground?.size[1] ?? 24, 40) * 0.65);
    Object.assign(this.keyLight.shadow.camera, { left: -span, right: span, top: span, bottom: -span });
    this.keyLight.shadow.camera.updateProjectionMatrix();
    const distance = Math.max(ground?.size[0] ?? 20, ground?.size[1] ?? 20);
    this.scene.fog = new THREE.Fog(this.scene.background, Math.max(25, distance * 0.8), Math.max(100, distance * 3));
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

  /** Resolves a lookAtTarget ID to either a semantic anchor or an entity origin. */
  getTargetPosition(targetId: string): THREE.Vector3 | null {
    const semanticAnchor = this.semanticAnchorMarkers.get(targetId);
    if (semanticAnchor) {
      const entity = this.entityObjects.get(semanticAnchor.entityId);
      if (!entity) return null;
      entity.updateWorldMatrix(true, false);
      return semanticAnchor.localAnchor.clone().applyMatrix4(entity.matrixWorld);
    }

    const entity = this.entityObjects.get(targetId);
    if (!entity) return null;
    entity.updateWorldMatrix(true, false);
    return (this.entitySubjectCenters.get(targetId) ?? new THREE.Vector3())
      .clone()
      .applyMatrix4(entity.matrixWorld);
  }

  setEnvironment(environment: EnvironmentV1): void {
    this.assertUsable();
    if (this.trajectory && this.trajectory.environmentId !== environment.id) {
      this.setTrajectory(null);
    }
    this.clearEnvironment();
    this.environment = environment;
    this.configureLighting(environment);
    this.buildWorld(environment);

    for (const entity of environment.entities) {
      const root = new THREE.Group();
      root.name = `entity:${entity.id}`;
      root.userData.entityId = entity.id;
      const visual = createEntityVisual(entity);
      prepareVisualShadows(visual);
      root.add(visual);
      this.environmentRoot.add(root);
      this.entityObjects.set(entity.id, root);
      if (entity.layout) this.architectureEntities.set(entity.id, entity);
      if (entity.layout?.light) {
        const { color, intensity, distance, offset } = entity.layout.light;
        const light = new THREE.PointLight(color, intensity, distance, 2);
        light.position.fromArray(offset ?? [0, -0.18, 0]);
        // Practical fill is unshadowed; primary shadow map remains shared.
        root.add(light);
      }
      this.entitySubjectCenters.set(entity.id, boundsCenter(entity.bounds));
      const rig = getHumanoidRig(visual);
      if (rig) {
        this.humanoidMotions.set(entity.id, {
          visual,
          controller: createHumanoidMotion(entity, environment.clock.durationSeconds, rig),
        });
      }
      if (entity.visual.type === "model") void this.models.load(entity, root, visual);

      if (entity.bounds) {
        const bounds = createBoundsVisual(entity.bounds, 0x4aa8ff);
        root.add(bounds);
        this.boundsObjects.push(bounds);
      }
    }

    for (const semanticAnchor of environment.semanticAnchors) {
      const entity = this.entityObjects.get(semanticAnchor.entityId);
      if (!entity) continue;
      if (semanticAnchor.localBounds) {
        const bounds = createBoundsVisual(semanticAnchor.localBounds, 0xffb454);
        entity.add(bounds);
        this.boundsObjects.push(bounds);
      }

      const marker = new THREE.Group();
      marker.name = `semantic-anchor:${semanticAnchor.id}`;
      const dot = basicMesh(
        new THREE.OctahedronGeometry(0.085, 0),
        standardMaterial("#ffb454", {
          emissive: new THREE.Color("#ff8a35"),
          emissiveIntensity: 0.6,
        }),
      );
      dot.castShadow = false;
      marker.add(dot);
      if (semanticAnchor.label) {
        const label = createLabel(semanticAnchor.label);
        label.sprite.position.set(0, 0.28, 0);
        marker.add(label.sprite);
        this.labels.push(label);
      }
      this.overlayRoot.add(marker);
      this.semanticAnchorMarkers.set(semanticAnchor.id, {
        entityId: semanticAnchor.entityId,
        localAnchor: vec3(semanticAnchor.localAnchor),
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
    this.directorCamera.aspect = trajectory?.intrinsics.aspectRatio ?? this.godCamera.aspect;
    this.directorCamera.updateProjectionMatrix();
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

  setCutaway(show: boolean): void {
    this.cutaway = show;
    this.applyArchitectureVisibility();
  }

  setToggles(toggles: SceneRendererToggles): void {
    if (toggles.cutaway !== undefined) this.cutaway = toggles.cutaway;
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
        const motion = this.humanoidMotions.get(entity.id);
        if (motion?.visual.parent === object) {
          motion.controller.update(this.currentEnvironmentTime);
        } else if (motion) {
          // A loaded glTF may have replaced and disposed its humanoid fallback.
          this.humanoidMotions.delete(entity.id);
        }
      }
      this.environmentRoot.updateMatrixWorld(true);
      this.updateSemanticAnchorMarkers();
      // Follow moving subjects with a compact shadow volume; long car tracks
      // otherwise lose their shadows outside the original default 10m square.
      const moving = this.environment.entities.filter((entity) => !Array.isArray(entity.transform.position));
      const center = new THREE.Vector3();
      if (moving.length) {
        moving.forEach((entity) => center.add(this.entityObjects.get(entity.id)!.position));
        center.divideScalar(moving.length);
      } else center.fromArray(this.environment.world?.overviewCamera?.target ?? [0, 0, 0]);
      this.keyLight.target.position.copy(center);
      this.keyLight.position.copy(center).add(new THREE.Vector3(10, 18, 8));
      this.fillLight.target.position.copy(center);
      this.fillLight.position.copy(center).add(new THREE.Vector3(-12, 7, -8));
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
    this.applyArchitectureVisibility();
    const size = this.renderer.getSize(new THREE.Vector2());
    this.renderer.setViewport(0, 0, size.x, size.y);
    const aspect = this.viewMode === "director" ? this.trajectory?.intrinsics.aspectRatio : undefined;
    if (aspect !== undefined) {
      // Preserve authored framing without stretching when the panel has a
      // different shape. Clear the full canvas before drawing the fitted image.
      this.renderer.setScissorTest(false);
      this.renderer.clear();
      const width = Math.min(size.x, size.y * aspect);
      const height = width / aspect;
      const x = (size.x - width) / 2;
      const y = (size.y - height) / 2;
      this.renderer.setViewport(x, y, width, height);
      this.renderer.setScissor(x, y, width, height);
      this.renderer.setScissorTest(true);
    }
    this.renderer.render(this.scene, this.getActiveCamera());
    this.renderer.setScissorTest(false);
    this.renderer.setViewport(0, 0, size.x, size.y);
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
    this.directorCamera.aspect = this.trajectory?.intrinsics.aspectRatio ?? aspect;
    this.directorCamera.updateProjectionMatrix();
    this.helperCamera.aspect = this.directorCamera.aspect;
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
    this.models.dispose();
    this.reflectionMap.dispose();
    this.keyLight.shadow.dispose();
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
    this.environmentRoot.add(createWorldGround(environment));

    const grid = environment.world?.grid;
    if (grid) {
      const helper = new THREE.GridHelper(grid.size, grid.divisions, 0x41677a, 0x263a45);
      helper.position.y = (ground?.y ?? 0) + 0.006;
      helper.name = "world:grid";
      const materials = Array.isArray(helper.material) ? helper.material : [helper.material];
      materials.forEach((material) => {
        material.transparent = true;
        material.opacity = 0.15;
      });
      this.groundGrid.add(helper);
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

  private updateSemanticAnchorMarkers(): void {
    for (const record of this.semanticAnchorMarkers.values()) {
      const entity = this.entityObjects.get(record.entityId);
      if (!entity) continue;
      record.marker.position.copy(record.localAnchor).applyMatrix4(entity.matrixWorld);
    }
  }

  private applyArchitectureVisibility(): void {
    const camera = this.godCamera.position.toArray() as Vec3;
    const visible = new Map<string, boolean>();
    const visiting = new Set<string>();
    const visit = (id: string): boolean => {
      if (visible.has(id)) return visible.get(id)!;
      const entity = this.architectureEntities.get(id);
      const object = this.entityObjects.get(id);
      if (!entity || !object || visiting.has(id)) return true;
      visiting.add(id);
      let show = visibleInArchitectureOverview(entity, camera, object.position.toArray() as Vec3,
        this.cutaway, this.viewMode === "director");
      // Wall trim and ceiling-mounted luminaires disappear with their support,
      // not as apparently floating pieces left behind by a cutaway.
      const support = entity.layout?.support;
      if (show && support && support !== "ground") show = visit(support);
      visiting.delete(id);
      visible.set(id, show);
      object.visible = show;
      return show;
    };
    this.architectureEntities.forEach((_entity, id) => visit(id));
  }

  private applyVisibility(): void {
    this.applyArchitectureVisibility();
    const overview = this.viewMode === "god";
    this.groundGrid.visible = overview && this.showBounds;
    this.trajectoryRoot.visible = overview && this.showPath && this.trajectory !== null;
    this.boundsObjects.forEach((object) => {
      object.visible = overview && this.showBounds;
    });
    const showSemanticOverlays = this.showLabels && this.viewMode === "god";
    this.labels.forEach(({ sprite }) => {
      sprite.visible = showSemanticOverlays;
    });
    this.semanticAnchorMarkers.forEach(({ marker }) => {
      // Keep semantic anchor dots tied to the labels toggle too.
      marker.visible = showSemanticOverlays;
    });
    const showCameraOverlay = this.viewMode === "god" && this.trajectory !== null;
    this.currentCameraMarker.visible = showCameraOverlay;
    this.cameraHelper.visible = showCameraOverlay;
  }

  private clearEnvironment(): void {
    this.architectureEntities.clear();
    this.humanoidMotions.clear();
    this.models.clear();
    for (const child of [...this.groundGrid.children]) disposeObject(child);
    this.labels.length = 0;
    this.boundsObjects.length = 0;
    this.entityObjects.clear();
    this.entitySubjectCenters.clear();
    this.semanticAnchorMarkers.clear();
    for (const child of [...this.environmentRoot.children]) disposeObject(child);
    // Semantic anchor marker objects are overlay children; preserve the camera overlays.
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
