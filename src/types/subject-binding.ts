import type { SubjectReference } from "./camera";
import type { ResolvedCameraDirectionDSL } from "./dsl";
import { z } from "zod";

export type SubjectUsageRole =
  | "initialFraming"
  | "movementAxis"
  | "framing"
  | "event"
  | "lookAt";

export interface SubjectReferenceUsage {
  path: string;
  role: SubjectUsageRole;
  actionId?: string;
}

export interface SubjectResolutionReference extends SubjectReference {
  usages: SubjectReferenceUsage[];
}

export const sceneIdentitySchema = z.strictObject({
  id: z.string().trim().min(1),
  revision: z.string().trim().min(1).optional(),
});

export type SceneIdentity = z.infer<typeof sceneIdentitySchema>;

export interface ResolveSubjectsRequest {
  scene: SceneIdentity;
  directorPrompt: string;
  references: SubjectResolutionReference[];
}

export type CameraDirectionBindingContext = Omit<
  ResolveSubjectsRequest,
  "references"
>;

const runtimeSubjectIdSchema = z.string().trim().min(1);

export const subjectBindingSchema = z.discriminatedUnion("status", [
  z.strictObject({
    ref: z.string().trim().min(1),
    status: z.literal("resolved"),
    /** Optimizer-addressable runtime IDs supplied by the 4D module. */
    subjectIds: z.array(runtimeSubjectIdSchema).min(1),
    confidence: z.number().finite().min(0).max(1).optional(),
  }),
  z.strictObject({
    ref: z.string().trim().min(1),
    status: z.literal("ambiguous"),
    candidateSubjectIds: z.array(runtimeSubjectIdSchema).min(1),
    reason: z.string().trim().min(1),
  }),
  z.strictObject({
    ref: z.string().trim().min(1),
    status: z.literal("notFound"),
    reason: z.string().trim().min(1),
  }),
]);

export const subjectResolutionResponseSchema = z.strictObject({
  scene: sceneIdentitySchema,
  bindings: z.array(subjectBindingSchema),
});

export type SubjectBinding = z.infer<typeof subjectBindingSchema>;
export type ResolvedSubjectBinding = Extract<SubjectBinding, { status: "resolved" }>;
export type SubjectResolutionResponse = z.infer<typeof subjectResolutionResponseSchema>;

/** Implemented by the EnvironmentV1 simulator now and the real 4D module later. */
export interface SubjectResolver {
  /** External implementations return untrusted JSON validated by the binder. */
  resolveSubjects(request: ResolveSubjectsRequest): Promise<unknown>;
}

export interface BoundCameraDirectionResult {
  csl: ResolvedCameraDirectionDSL;
  scene: SceneIdentity;
  /** Kept as provenance for debugging and reproducibility. */
  bindings: ResolvedSubjectBinding[];
}
