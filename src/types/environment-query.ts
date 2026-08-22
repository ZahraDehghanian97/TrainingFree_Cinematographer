import { z } from "zod";
import type { Vec3 } from "./environment";
import {
  subjectBindingSchema,
  type SubjectBinding,
} from "./subject-binding";

/** A world-space axis-aligned bounding box in the environment coordinate system. */
export interface WorldAabbV1 {
  coordinateSpace: "world";
  min: Vec3;
  max: Vec3;
  center: Vec3;
  size: Vec3;
}

export type EnvironmentSubjectKind = "target" | "entity";

export interface SubjectBoxSampleV1 {
  subjectId: string;
  subjectKind: EnvironmentSubjectKind;
  entityId: string;
  label?: string;
  center: Vec3;
  box: WorldAabbV1 | null;
}

const subjectIdSchema = z
  .string()
  .trim()
  .min(1)
  .describe("An exact subject ID from the supplied environment subject list");

const nonNegativeNumberSchema = z.number().finite().nonnegative();

/**
 * Structured response contract for the LLM query parser. Keep environment-
 * dependent checks, such as whether a subject ID exists, outside this schema.
 */
export const environmentQuerySchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("resolveSubjectReferences"),
    bindings: z.array(subjectBindingSchema).min(1)
      .describe("Bindings from CSL-local semantic refs to runtime environment target IDs"),
  }),
  z.strictObject({
    type: z.literal("subjectBoxesAtTime"),
    subjectIds: z.array(subjectIdSchema).min(1),
    timeSeconds: nonNegativeNumberSchema.describe("Playback time in seconds"),
  }),
  z.strictObject({
    type: z.literal("subjectBoxesInRange"),
    subjectIds: z.array(subjectIdSchema).min(1),
    startTimeSeconds: nonNegativeNumberSchema.describe("Inclusive range start in seconds"),
    endTimeSeconds: nonNegativeNumberSchema.describe("Inclusive range end in seconds"),
    /** Optional explicit sampling interval. Defaults to the environment FPS hint. */
    sampleEverySeconds: z.number().finite().positive().optional()
      .describe("Sampling interval in seconds; omit unless explicitly requested"),
  }),
  z.strictObject({
    type: z.literal("firstWithinDistance"),
    subjectAId: subjectIdSchema,
    subjectBId: subjectIdSchema,
    distanceMeters: nonNegativeNumberSchema.describe("Distance threshold in meters"),
  }),
  z.strictObject({
    type: z.literal("firstSpeedReached"),
    subjectId: subjectIdSchema,
    speedMetersPerSecond: nonNegativeNumberSchema.describe("Speed threshold in meters per second"),
  }),
  z.strictObject({
    type: z.literal("distanceCrossingCount"),
    subjectAId: subjectIdSchema,
    subjectBId: subjectIdSchema,
    distanceMeters: nonNegativeNumberSchema.describe("Distance threshold in meters"),
  }),
  z.strictObject({
    type: z.literal("unsupported"),
    reason: z.string().trim().min(1).describe("A concise reason the request is unsupported"),
  }),
]);

export type EnvironmentQuery = z.infer<typeof environmentQuerySchema>;

export type EnvironmentDistanceMetric = "boundsSurface" | "anchorCenter";

export type EnvironmentQueryResult =
  | {
      type: "resolveSubjectReferences";
      environmentId: string;
      bindings: SubjectBinding[];
    }
  | {
      type: "subjectBoxesAtTime";
      environmentId: string;
      timeSeconds: number;
      subjects: SubjectBoxSampleV1[];
    }
  | {
      type: "subjectBoxesInRange";
      environmentId: string;
      startTimeSeconds: number;
      endTimeSeconds: number;
      sampleEverySeconds: number;
      samples: Array<{
        timeSeconds: number;
        subjects: SubjectBoxSampleV1[];
      }>;
    }
  | {
      type: "firstWithinDistance";
      environmentId: string;
      subjectAId: string;
      subjectBId: string;
      distanceMeters: number;
      distanceMetric: EnvironmentDistanceMetric;
      timeSeconds: number | null;
      distanceAtMatchMeters: number | null;
    }
  | {
      type: "firstSpeedReached";
      environmentId: string;
      subjectId: string;
      speedMetersPerSecond: number;
      timeSeconds: number | null;
      speedAtMatchMetersPerSecond: number | null;
    }
  | {
      type: "distanceCrossingCount";
      environmentId: string;
      subjectAId: string;
      subjectBId: string;
      distanceMeters: number;
      distanceMetric: EnvironmentDistanceMetric;
      count: number;
      timesSeconds: number[];
    }
  | {
      type: "unsupported";
      environmentId: string;
      reason: string;
    };
