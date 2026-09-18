import * as THREE from "three";
import type { SceneEntityV1 } from "../../src/types/environment";
import { createSurfaceMaterial } from "./world-appearance";

/** Detailed, data-driven architectural primitives, independent of hardcoded IDs. */
export function createArchitectureVisual(entity: SceneEntityV1): THREE.Object3D | null {
  const visual = entity.visual;
  const layout = entity.layout;
  if (!layout?.surface || visual.type !== "primitive" || visual.shape !== "box") return null;
  const size = visual.params.size;
  if (!Array.isArray(size)) return null;
  const color = visual.color ?? "#b8b2a7";
  const textured = ["wood", "concrete", "stone"].includes(layout.surface);
  const material = textured
    ? createSurfaceMaterial(layout.surface === "wood" ? "wood" : "concrete", color,
        layout.role === "floor" || layout.role === "paving" ? [size[0], size[2]] : [size[0], size[1]])
    : new THREE.MeshStandardMaterial({ color, roughness: 0.86, metalness: 0 });
  if (layout.surface === "metal") { material.metalness = 0.65; material.roughness = 0.42; }
  if (layout.surface === "glass") {
    material.transparent = true;
    material.opacity = 0.22;
    material.depthWrite = false;
    material.roughness = 0.08;
    material.metalness = 0.1;
  }
  if (layout.surface === "emissive") {
    material.emissive.set(color);
    material.emissiveIntensity = 0.7;
  }
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
  mesh.castShadow = layout.surface !== "glass" && layout.surface !== "emissive";
  mesh.receiveShadow = layout.surface !== "glass";
  if (!layout.sign || typeof document === "undefined") return mesh;
  const group = new THREE.Group();
  group.add(mesh);
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 192;
  const ctx = canvas.getContext("2d");
  if (!ctx) return group;
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#fff6dc";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "bold 86px Arial, sans-serif";
  ctx.fillText(layout.sign, 512, 100, 960);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const face = new THREE.Mesh(new THREE.PlaneGeometry(size[0] * 0.95, size[1] * 0.9),
    new THREE.MeshBasicMaterial({ map: texture }));
  face.position.z = size[2] / 2 + 0.002;
  group.add(face);
  return group;
}
