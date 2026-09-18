import type { Vec3 } from '../types/environment';
export type ReferenceTime = number | { actionId: string; edge: 'start' | 'end'; offset?: number };
export interface ReferenceAnchor {
  ids?: string[];
  point?: Vec3;
  /** Sample this anchor at a fixed playback time, rather than following it. */
  freezeAt?: ReferenceTime;
  /** Follow until this playback time, then lock the anchor in world space. */
  holdAfter?: ReferenceTime;
}
export interface ReferencePose {
  rig: ReferenceAnchor;
  /** Either a Cartesian offset or unwrapped [azimuthDegrees, height, radius]. */
  offset?: Vec3;
  polar?: Vec3;
  aim: ReferenceAnchor;
  fov: number;
  screen?: [number,number];
  roll?: number;
}
export interface ReferenceKnot extends ReferencePose {
  at: ReferenceTime;
  /** Incoming interpolation. Linear is useful for constant angular pacing. */
  easing?: 'smooth' | 'linear';
  cutBefore?: boolean;
  /** Continuous rig handoff at an existing knot time; NOT a cut. */
  transitionBefore?: boolean;
}
export interface ReferencePlan {
  version: '1.0';
  exampleId: string;
  knots: ReferenceKnot[];
  aspectRatio?: number;
  /** Only explicitly requested handheld intervals receive deterministic shake. */
  handheldActionIds?: string[];
  /** Distance-compensated optical zoom, e.g. the classic dolly-zoom shot. */
  constantScaleSubject?: string;
  artisticChoices: string[];
  limitations?: string[];
}
