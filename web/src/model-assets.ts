import * as THREE from "three";
import type { BoundsV1, ModelVisualV1, SceneEntityV1 } from "../../src/types/environment";

export interface LoadedModelAsset {
  scene: THREE.Object3D;
  /** Include other glTF scenes so their unused resources are also released. */
  scenes?: readonly THREE.Object3D[];
}

export interface ModelAssetManagerOptions {
  /** The default loader imports GLTFLoader only when a model is requested. */
  load?: (url: string) => Promise<LoadedModelAsset>;
  onError?: (error: unknown, entity: SceneEntityV1) => void;
}

export type ModelLoadStatus = "loaded" | "fallback" | "cancelled";

interface MountedModel {
  visualRoot: THREE.Group;
  resourceRoots: THREE.Object3D[];
}

/** Dispose owned scene resources once, including shared materials and every texture slot. */
export function disposeObject3D(root: THREE.Object3D | readonly THREE.Object3D[]): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  const skeletons = new Set<THREE.Skeleton>();
  const instances = new Set<THREE.InstancedMesh>();
  const visited = new Set<object>();
  const collectTextures = (value: unknown): void => {
    if (!value || typeof value !== "object" || visited.has(value)) return;
    visited.add(value);
    if ((value as THREE.Texture).isTexture) {
      textures.add(value as THREE.Texture);
    } else if (Array.isArray(value)) {
      value.forEach(collectTextures);
    } else if (value instanceof THREE.Uniform || Object.getPrototypeOf(value) === Object.prototype) {
      // Shader uniforms can contain nested structures and arrays of textures.
      Object.values(value).forEach(collectTextures);
    }
  };

  const roots = Array.isArray(root) ? root : [root];
  roots.forEach((object) => object.traverse((child: THREE.Object3D) => {
    const renderable = child as THREE.Mesh;
    if (renderable.geometry) geometries.add(renderable.geometry);
    if (renderable.material) {
      const entries = Array.isArray(renderable.material) ? renderable.material : [renderable.material];
      entries.forEach((material) => materials.add(material));
    }
    if (child.customDepthMaterial) materials.add(child.customDepthMaterial);
    if (child.customDistanceMaterial) materials.add(child.customDistanceMaterial);
    const skeleton = (child as THREE.SkinnedMesh).skeleton;
    if (skeleton) skeletons.add(skeleton);
    if ((child as THREE.InstancedMesh).isInstancedMesh) instances.add(child as THREE.InstancedMesh);
    if (child instanceof THREE.Scene) {
      collectTextures(child.background);
      collectTextures(child.environment);
    }
  }));
  materials.forEach((material) => Object.values(material).forEach(collectTextures));
  skeletons.forEach((skeleton) => {
    if (skeleton.boneTexture) textures.add(skeleton.boneTexture);
    // Skeleton.dispose only releases boneTexture; use our texture set to avoid
    // duplicate disposal when it is also referenced by another resource.
    skeleton.boneTexture = null;
  });
  instances.forEach((instance) => {
    // The object dispose event releases instanceMatrix/instanceColor GPU
    // buffers. Share texture cleanup with material maps and other instances.
    if (instance.morphTexture) textures.add(instance.morphTexture);
    instance.morphTexture = null;
    instance.dispose();
  });
  const images = new Set<object>();
  textures.forEach((texture) => {
    texture.dispose();
    const candidates = Array.isArray(texture.source?.data) ? texture.source.data : [texture.source?.data];
    candidates.forEach((source: unknown) => {
      if (!source || typeof source !== "object" || images.has(source)) return;
      images.add(source);
      // GLTFLoader may use ImageBitmapLoader, whose CPU storage requires close().
      if ("close" in source && typeof source.close === "function") source.close();
    });
  });
  materials.forEach((material) => material.dispose());
  geometries.forEach((geometry) => geometry.dispose());
}

async function loadGltf(url: string): Promise<LoadedModelAsset> {
  const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
  return new GLTFLoader().loadAsync(url);
}

function assetRoots(asset: LoadedModelAsset): THREE.Object3D[] {
  return [...new Set([asset.scene, ...(asset.scenes ?? [])])];
}

function fitModelToBounds(model: THREE.Object3D, bounds: BoundsV1): THREE.Group {
  const fitRoot = new THREE.Group();
  // Compute geometry bounds before parenting to the animated entity. The entity
  // matrix must never influence a visual-local fit or be modified by one.
  model.updateWorldMatrix(true, true);
  const source = new THREE.Box3().setFromObject(model);
  if (source.isEmpty()) throw new Error("The imported model has no renderable bounds");
  const sourceCenter = source.getCenter(new THREE.Vector3());
  const targetCenter = new THREE.Vector3();
  let factor: number;
  if (bounds.type === "sphere") {
    targetCenter.fromArray(bounds.center);
    factor = bounds.radius / source.getBoundingSphere(new THREE.Sphere()).radius;
  } else {
    const target = new THREE.Box3(new THREE.Vector3(...bounds.min), new THREE.Vector3(...bounds.max));
    target.getCenter(targetCenter);
    const size = source.getSize(new THREE.Vector3()).toArray();
    const targetSize = target.getSize(new THREE.Vector3()).toArray();
    const ratios = size.flatMap((component, axis) => component > 1e-12 ? [targetSize[axis] / component] : []);
    factor = Math.min(...ratios);
  }
  if (!Number.isFinite(factor) || factor <= 0) throw new Error("Model bounds cannot be fitted to the entity bounds");
  fitRoot.scale.setScalar(factor);
  fitRoot.position.copy(targetCenter).addScaledVector(sourceCenter, -factor);
  fitRoot.add(model);
  return fitRoot;
}

/**
 * Give textured shadow casters owned shadow materials. Three's shared depth
 * materials can retain sampler uniforms after a visual is removed, resurrecting
 * disposed GPU textures or trying to upload an already closed ImageBitmap.
 * Call after constructing a visual and configuring its castShadow flags.
 */
export function prepareVisualShadows(root: THREE.Object3D): void {
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh || !mesh.castShadow) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const hasShadowTexture = materials.some((material) => {
      const mapped = material as THREE.MeshStandardMaterial;
      return Boolean(mapped.map || mapped.alphaMap || mapped.displacementMap);
    });
    if (!hasShadowTexture) return;
    mesh.customDepthMaterial ??= new THREE.MeshDepthMaterial();
    mesh.customDistanceMaterial ??= new THREE.MeshDistanceMaterial();
  });
}

function placeModel(asset: LoadedModelAsset, visual: ModelVisualV1, bounds?: BoundsV1): THREE.Group {
  const root = new THREE.Group();
  root.name = `model:${visual.url}`;
  root.position.fromArray(visual.position ?? [0, 0, 0]);
  root.quaternion.fromArray(visual.rotation ?? [0, 0, 0, 1]).normalize();
  root.scale.fromArray(visual.scale ?? [1, 1, 1]);
  if (visual.fitToBounds && !bounds) throw new Error("fitToBounds requires entity bounds");
  root.add(visual.fitToBounds ? fitModelToBounds(asset.scene, bounds!) : asset.scene);
  root.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });
  prepareVisualShadows(root);
  return root;
}

/**
 * Owns imported visuals, while the renderer owns each entity root and fallback.
 * Call clear() before clearing an environment and dispose() during teardown.
 * Pending downloads need not be abortable: obsolete results are disposed without
 * touching the new environment. A loader must return separately owned resources
 * for each request (as the default GLTFLoader does).
 */
export class ModelAssetManager {
  private readonly options: ModelAssetManagerOptions;
  private readonly pending = new Map<THREE.Object3D, symbol>();
  private readonly mounted = new Map<THREE.Object3D, MountedModel>();
  private disposed = false;

  constructor(options: ModelAssetManagerOptions = {}) {
    this.options = options;
  }

  async load(entity: SceneEntityV1, parent: THREE.Object3D, fallback: THREE.Object3D): Promise<ModelLoadStatus> {
    if (this.disposed || entity.visual.type !== "model") return "cancelled";
    const token = Symbol(entity.id);
    this.pending.set(parent, token);
    this.removeMounted(parent);
    let asset: LoadedModelAsset | undefined;
    try {
      asset = await (this.options.load ?? loadGltf)(entity.visual.url);
      if (this.disposed || this.pending.get(parent) !== token) {
        disposeObject3D(assetRoots(asset));
        return "cancelled";
      }
      const visualRoot = placeModel(asset, entity.visual, entity.bounds);
      const resourceRoots = assetRoots(asset);
      parent.add(visualRoot);
      this.mounted.set(parent, { visualRoot, resourceRoots });
      fallback.removeFromParent();
      disposeObject3D(fallback);
      return "loaded";
    } catch (error) {
      if (asset) disposeObject3D(assetRoots(asset));
      if (this.disposed || this.pending.get(parent) !== token) return "cancelled";
      // Rendering continues with the fallback, including when a consumer's
      // diagnostic callback throws.
      try { this.options.onError?.(error, entity); } catch { /* keep the fallback */ }
      return "fallback";
    } finally {
      if (this.pending.get(parent) === token) this.pending.delete(parent);
    }
  }

  clear(): void {
    this.pending.clear();
    for (const parent of this.mounted.keys()) this.removeMounted(parent);
  }

  dispose(): void {
    this.clear();
    this.disposed = true;
  }

  private removeMounted(parent: THREE.Object3D): void {
    const model = this.mounted.get(parent);
    if (!model) return;
    model.visualRoot.removeFromParent();
    disposeObject3D(model.resourceRoots);
    this.mounted.delete(parent);
  }
}
