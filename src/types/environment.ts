/** A three-dimensional vector encoded as a JSON array. */
export type Vec3 = [number, number, number];

/** A quaternion encoded in x, y, z, w order. */
export type Quat = [number, number, number, number];

export interface Keyframe<T> {
  /** Playback time in seconds. */
  t: number;
  value: T;
}

export interface KeyframedChannel<T> {
  interpolation: "step" | "linear" | "catmullRom" | "slerp";
  extrapolation?: "hold";
  keyframes: Keyframe<T>[];
}

/** A constant value or a value animated over playback time. */
export type Channel<T> = T | KeyframedChannel<T>;

export interface CoordinateSystemV1 {
  handedness: "right";
  upAxis: "+Y";
  cameraForwardAxis: "-Z";
  lengthUnit: "meter";
  rotationOrder: "quaternion-xyzw";
  /** Reconstruction provenance. Omitted for authored scenes already in meters. */
  metricScale?: {
    status: "calibrated" | "relative";
    /** Meters per exported coordinate unit; canonical calibrated scenes use 1. */
    metersPerUnit?: number;
  };
}

export interface SphereBoundsV1 {
  type: "sphere";
  center: Vec3;
  radius: number;
}

export interface BoxBoundsV1 {
  type: "box";
  min: Vec3;
  max: Vec3;
}

export type BoundsV1 = SphereBoundsV1 | BoxBoundsV1;

export interface EntityTransformV1 {
  /** Environment v1 stores all entity transforms in world space. */
  space: "world";
  position: Channel<Vec3>;
  rotation?: Channel<Quat>;
  scale?: Channel<Vec3>;
}

export type PresetVisualNameV1 =
  | "soccerBall"
  | "soccerGoal"
  | "humanoid"
  | "car"
  | "door"
  | "vase"
  | "monitor"
  | "genericObject";

export interface PresetVisualV1 {
  type: "preset";
  name: PresetVisualNameV1;
  params?: Record<string, number | string | boolean>;
}

export interface PrimitiveVisualV1 {
  type: "primitive";
  shape: "box" | "sphere" | "cylinder" | "cone" | "plane" | "torus";
  params: Record<string, number | Vec3>;
  color?: string;
}

export interface ModelVisualV1 {
  type: "model";
  /** A .glb or .gltf URL, resolved relative to the visualizer page. */
  url: string;
  /** Local placement affects only the visual, never entity or semantic anchors. */
  position?: Vec3;
  rotation?: Quat;
  scale?: Vec3;
  /** Uniformly contain the model in entity bounds before applying local placement. */
  fitToBounds?: boolean;
  /** Displayed while loading and retained when the asset cannot be loaded. */
  fallback?: PresetVisualV1 | PrimitiveVisualV1;
}

export type SceneVisualV1 = PresetVisualV1 | PrimitiveVisualV1 | ModelVisualV1;

export type WorldProfileV1 =
  | "studio"
  | "daylight"
  | "road"
  | "park"
  | "industrial"
  | "corridor"
  | "stage"
  | "rooftop";

export type GroundSurfaceV1 = "concrete" | "wood" | "asphalt" | "grass" | "stage";

/** Visibility geometry, independent of collision and semantic subject bounds. */
export interface EntityOcclusionV1 {
  /** Transparent entities never block sight rays. Does not disable collision. */
  transparent?: boolean;
  /** Opaque pieces in entity-local coordinates; omitted pieces transmit sight rays.
   * Defaults to the entity's bounds. Use a nonempty list for hollow objects.
   */
  bounds?: BoundsV1[];
}

/** Optional authoring metadata. Geometry stays in normal entity bounds; a
 * cutaway changes only the editor overview, never the optimizer or Director POV. */
export interface SceneEntityLayoutV1 {
  role: "subject" | "prop" | "furniture" | "wall" | "window" | "trim" | "floor"
    | "ceiling" | "fixture" | "paving" | "marking" | "railing" | "stair"
    | "landing" | "column" | "beam" | "door";
  purpose: string;
  /** Entity ID carrying the object, or the special value "ground". */
  support?: string;
  cutaway?: "roof" | "wall";
  /** World-space outward normal for a wall's optional overview cutaway. */
  outwardNormal?: Vec3;
  surface?: "plaster" | "concrete" | "wood" | "metal" | "glass" | "fabric" | "emissive" | "stone";
  sign?: string;
  light?: { color: string; intensity: number; distance: number; /** Entity-local emitter position. */ offset?: Vec3 };
}

export interface SceneEntityV1 {
  id: string;
  label?: string;
  /** Modeled front in entity-local coordinates. Defaults to -Z for cars/driving poses, +Z otherwise. */
  forwardAxis?: "+X" | "-X" | "+Z" | "-Z";
  transform: EntityTransformV1;
  visual: SceneVisualV1;
  bounds?: BoundsV1;
  occlusion?: EntityOcclusionV1;
  layout?: SceneEntityLayoutV1;
}

/**
 * An optional semantic point or region anchored to a renderable entity, such
 * as a face or shoulder. Whole entities are addressable without defining one.
 */
export interface SceneSemanticAnchorV1 {
  id: string;
  entityId: string;
  label?: string;
  /** Anchor position in the entity's local coordinate system. */
  localAnchor: Vec3;
  localBounds?: BoundsV1;
}

export interface EnvironmentV1 {
  schemaVersion: "1.0";
  kind: "environment";
  id: string;
  promptExampleId: string;
  prompt: string;
  clock: {
    durationSeconds: number;
    timeDomain: "playback";
    fpsHint?: number;
  };
  coordinates: CoordinateSystemV1;
  evaluation?: {
    distanceMetric: "boundsSurface" | "anchorCenter";
    epsilon?: number;
  };
  world?: {
    background?: string;
    /** Lighting and atmosphere preset; omitted environments retain automatic styling. */
    profile?: WorldProfileV1;
    /** Optional positive tone-mapping exposure override. */
    exposure?: number;
    /** Preferred starting pose for the orbitable environment overview. */
    overviewCamera?: {
      position: Vec3;
      target: Vec3;
    };
    ground?: {
      y: number;
      size: [number, number];
      color?: string;
      surface?: GroundSurfaceV1;
      /** False when explicit floor slabs contain architectural openings. */
      render?: boolean;
      /** Exterior terrain, no continuation, or legacy profile-based behavior. */
      continuation?: "automatic" | "none" | "terrain";
      /** Authored paths/markings replace renderer-generated profile decoration. */
      details?: "automatic" | "authored";
    };
    grid?: {
      size: number;
      divisions: number;
    };
  };
  entities: SceneEntityV1[];
  semanticAnchors: SceneSemanticAnchorV1[];
}
