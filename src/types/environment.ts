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
  shape: "box" | "sphere" | "cylinder" | "cone" | "plane";
  params: Record<string, number | Vec3>;
  color?: string;
}

export type SceneVisualV1 = PresetVisualV1 | PrimitiveVisualV1;

export interface SceneEntityV1 {
  id: string;
  label?: string;
  transform: EntityTransformV1;
  visual: SceneVisualV1;
  bounds?: BoundsV1;
}

/**
 * A semantic camera target. Targets are kept separate from renderable entities
 * so features such as a face or shoulder can be anchored to a larger object.
 */
export interface SceneTargetV1 {
  id: string;
  entityId: string;
  label?: string;
  /** Target position in the entity's local coordinate system. */
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
    ground?: {
      y: number;
      size: [number, number];
      color?: string;
    };
    grid?: {
      size: number;
      divisions: number;
    };
  };
  entities: SceneEntityV1[];
  targets: SceneTargetV1[];
}
