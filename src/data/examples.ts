import type {
  CameraConfig,
  SubjectReference,
  Target,
} from "../types/camera";
import type {
  CameraDirectionDraft,
  CompoundTrigger,
  TriggerSpec,
} from "../types/dsl";
import type {
  ResolvedSubjectBinding,
  SubjectResolver,
} from "../types/subject-binding";
import { bindCameraDirectionDraft } from "../grounding";
import type { ResolvedPromptExampleFixture } from "./resolved-example-fixtures";

export const EXAMPLE_BINDING_MODES = ["resolved", "llm"] as const;
export type ExampleBindingMode = (typeof EXAMPLE_BINDING_MODES)[number];
export const DEFAULT_EXAMPLE_BINDING_MODE: ExampleBindingMode = "resolved";

export interface PromptExampleLlmInput {
  draftCsl: CameraDirectionDraft;
  /** Ground truth used only to score the LLM response, never to hydrate the draft. */
  expectedBindings: ResolvedSubjectBinding[];
}

export interface SubjectBindingMismatch {
  ref: string;
  expectedSubjectIds: string[];
  actualSubjectIds: string[];
}

export interface SubjectBindingEvaluation {
  exactMatch: boolean;
  matchedReferences: number;
  totalReferences: number;
  mismatches: SubjectBindingMismatch[];
}

export interface ResolvedPromptExampleRun {
  mode: ExampleBindingMode;
  csl: ResolvedPromptExampleFixture["resolvedCsl"];
  bindings?: ResolvedSubjectBinding[];
  evaluation?: SubjectBindingEvaluation;
}

interface ReferenceFactory {
  toReference(target: Target): SubjectReference;
  bindings: ResolvedSubjectBinding[];
}

function createReferenceFactory(): ReferenceFactory {
  const refsByRuntimeTarget = new Map<string, SubjectReference>();
  const bindings: ResolvedSubjectBinding[] = [];

  return {
    bindings,
    toReference(target): SubjectReference {
      const key = `${target.id}\u0000${target.description}`;
      const existing = refsByRuntimeTarget.get(key);
      if (existing) return existing;

      // Deliberately opaque and local: this value carries no environment ID.
      const reference: SubjectReference = {
        ref: `subject_ref_${refsByRuntimeTarget.size + 1}`,
        description: target.description,
      };
      refsByRuntimeTarget.set(key, reference);
      bindings.push({
        ref: reference.ref,
        status: "resolved",
        subjectIds: [target.id],
      });
      return reference;
    },
  };
}

function toDraftConfig(
  config: CameraConfig<Target>,
  toReference: (target: Target) => SubjectReference,
): CameraConfig<SubjectReference> {
  if (config.type === "subjectAware") return { ...config };

  const { lookAt, ...configWithoutLookAt } = config;
  return {
    ...configWithoutLookAt,
    ...(Array.isArray(lookAt)
      ? { lookAt: lookAt.map(toReference) }
      : lookAt === undefined
        ? {}
        : { lookAt }),
  };
}

function toDraftTrigger(
  trigger: TriggerSpec<Target>,
  toReference: (target: Target) => SubjectReference,
): TriggerSpec<SubjectReference> {
  if ("triggers" in trigger) {
    const compound: CompoundTrigger<SubjectReference> = {
      ...trigger,
      triggers: trigger.triggers.map((child) => toDraftTrigger(child, toReference)),
    };
    return compound;
  }

  if (trigger.type === "distance") {
    return {
      ...trigger,
      object1: toReference(trigger.object1),
      object2: toReference(trigger.object2),
    };
  }
  if (trigger.type === "velocity") {
    return {
      ...trigger,
      subject: toReference(trigger.subject),
    };
  }
  return { ...trigger };
}

export function createPromptExampleLlmInput(
  fixture: ResolvedPromptExampleFixture,
): PromptExampleLlmInput {
  const referenceFactory = createReferenceFactory();
  const toReference = referenceFactory.toReference;
  const draftCsl: CameraDirectionDraft = {
    ...fixture.resolvedCsl,
    sections: fixture.resolvedCsl.sections.map((section) => ({
      ...section,
      initCamera: {
        ...section.initCamera,
        targets: section.initCamera.targets.map(toReference),
        config: toDraftConfig(section.initCamera.config, toReference),
      },
      actions: section.actions.map((action) => {
        const { constraints, ...actionWithoutConstraints } = action;
        const { targets: movementTargets, ...movement } = action.movement;
        return {
          ...actionWithoutConstraints,
          trigger: toDraftTrigger(action.trigger, toReference),
          movement: {
            ...movement,
            ...(movementTargets === undefined
              ? {}
              : { targets: movementTargets.map(toReference) }),
          },
          ...(constraints === undefined
            ? {}
            : {
              constraints: constraints.map((constraint) => {
                const {
                  targets: constraintTargets,
                  ...constraintWithoutTargets
                } = constraint;
                return {
                  ...constraintWithoutTargets,
                  ...(constraintTargets === undefined
                    ? {}
                    : { targets: constraintTargets.map(toReference) }),
                  config: toDraftConfig(constraint.config, toReference),
                };
              }),
            }),
        };
      }),
    })),
  };

  return { draftCsl, expectedBindings: referenceFactory.bindings };
}

function canonicalSubjectIds(ids: string[]): string[] {
  return [...new Set(ids.map((id) => id.trim()).filter(Boolean))].sort();
}

export function evaluateSubjectBindings(
  expected: ResolvedSubjectBinding[],
  actual: ResolvedSubjectBinding[],
): SubjectBindingEvaluation {
  const expectedByRef = new Map(
    expected.map((binding) => [binding.ref, canonicalSubjectIds(binding.subjectIds)]),
  );
  const actualByRef = new Map(
    actual.map((binding) => [binding.ref, canonicalSubjectIds(binding.subjectIds)]),
  );
  const refs = [...new Set([...expectedByRef.keys(), ...actualByRef.keys()])].sort();
  const mismatches = refs.flatMap((ref): SubjectBindingMismatch[] => {
    const expectedSubjectIds = expectedByRef.get(ref) ?? [];
    const actualSubjectIds = actualByRef.get(ref) ?? [];
    return expectedSubjectIds.length === actualSubjectIds.length
      && expectedSubjectIds.every((id, index) => id === actualSubjectIds[index])
      ? []
      : [{ ref, expectedSubjectIds, actualSubjectIds }];
  });

  return {
    exactMatch: mismatches.length === 0,
    matchedReferences: refs.length - mismatches.length,
    totalReferences: refs.length,
    mismatches,
  };
}

export function parseExampleBindingMode(value?: string): ExampleBindingMode {
  const normalized = value?.trim().toLowerCase() || DEFAULT_EXAMPLE_BINDING_MODE;
  if ((EXAMPLE_BINDING_MODES as readonly string[]).includes(normalized)) {
    return normalized as ExampleBindingMode;
  }
  throw new Error(
    `Invalid example binding mode ${JSON.stringify(value)}; expected one of: `
    + EXAMPLE_BINDING_MODES.join(", "),
  );
}

export async function resolvePromptExampleForRun(
  fixture: ResolvedPromptExampleFixture,
  mode: ExampleBindingMode,
  resolver?: SubjectResolver,
): Promise<ResolvedPromptExampleRun> {
  if (mode === "resolved") {
    return { mode, csl: fixture.resolvedCsl };
  }
  if (!resolver) {
    throw new Error("LLM example binding mode requires a subject resolver");
  }

  const { draftCsl, expectedBindings } = createPromptExampleLlmInput(fixture);
  const result = await bindCameraDirectionDraft(
    draftCsl,
    {
      directorPrompt: fixture.prompt,
      scene: { id: fixture.environmentId },
    },
    resolver,
  );

  return {
    mode,
    csl: result.csl,
    bindings: result.bindings,
    evaluation: evaluateSubjectBindings(expectedBindings, result.bindings),
  };
}
