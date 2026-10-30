import type { Vec3 } from "./environment";

/** A world-space axis-aligned bounding box in the environment coordinate system. */
export interface WorldAabbV1 {
  coordinateSpace: "world";
  min: Vec3;
  max: Vec3;
  center: Vec3;
  size: Vec3;
}

export type EnvironmentSubjectKind = "semanticAnchor" | "entity";

export interface SubjectBoxSampleV1 {
  subjectId: string;
  subjectKind: EnvironmentSubjectKind;
  entityId: string;
  label?: string;
  center: Vec3;
  box: WorldAabbV1 | null;
}
