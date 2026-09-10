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

export interface SceneEntityV1 {
  id: string;
  label?: string;
  transform: EntityTransformV1;
  visual: SceneVisualV1;
  bounds?: BoundsV1;
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
    };
    grid?: {
      size: number;
      divisions: number;
    };
  };
  entities: SceneEntityV1[];
  semanticAnchors: SceneSemanticAnchorV1[];
}
