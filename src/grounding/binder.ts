import type {
  CameraConfig,
  SubjectReference,
  Target,
} from "../types/camera";
import type {
  ActionConstraintConfig,
  CameraDirectionDraft,
  CompoundTrigger,
  ResolvedCameraDirectionDSL,
  TriggerSpec,
} from "../types/dsl";
import type {
  BoundCameraDirectionResult,
  CameraDirectionBindingContext,
  ResolveSubjectsRequest,
  ResolvedSubjectBinding,
  SubjectBinding,
  SubjectReferenceUsage,
  SubjectResolutionReference,
  SubjectResolver,
  SubjectUsageRole,
} from "../types/subject-binding";
import {
  sceneIdentitySchema,
  subjectResolutionResponseSchema,
} from "../types/subject-binding";
import { assertMovementSubjectReferences } from "./validation";

interface MutableResolutionReference extends SubjectResolutionReference {
  usages: SubjectReferenceUsage[];
}

interface NormalizedCardinality {
  min: number;
  max?: number;
}

function normalizedCardinality(reference: SubjectReference): NormalizedCardinality {
  const cardinality = reference.cardinality ?? { min: 1, max: 1 };
  if (
    !Number.isInteger(cardinality.min)
    || cardinality.min < 1
    || (cardinality.max !== undefined
      && (!Number.isInteger(cardinality.max) || cardinality.max < cardinality.min))
  ) {
    throw new Error(
      `Invalid cardinality for semantic subject ref ${JSON.stringify(reference.ref)}`,
    );
  }
  return cardinality;
}

function addReference(
  references: Map<string, MutableResolutionReference>,
  reference: SubjectReference,
  usage: SubjectReferenceUsage,
): void {
  const ref = reference.ref.trim();
  const description = reference.description.trim();
  if (!ref || !description || "id" in reference) {
    throw new Error(`Invalid semantic subject reference at ${usage.path}`);
  }
  const cardinality = normalizedCardinality(reference);

  const existing = references.get(ref);
  if (existing) {
    if (
      existing.description !== description
      || normalizedCardinality(existing).min !== cardinality.min
      || normalizedCardinality(existing).max !== cardinality.max
    ) {
      throw new Error(
        `Semantic subject ref ${JSON.stringify(ref)} has conflicting definitions`,
      );
    }
    existing.usages.push(usage);
    return;
  }

  references.set(ref, {
    ref,
    description,
    ...(reference.cardinality === undefined
      ? {}
      : { cardinality }),
    usages: [usage],
  });
}

function collectTargetList(
  references: Map<string, MutableResolutionReference>,
  targets: SubjectReference[] | undefined,
  path: string,
  role: SubjectUsageRole,
  actionId?: string,
): void {
  targets?.forEach((target, index) => {
    addReference(references, target, {
      path: `${path}[${index}]`,
      role,
      ...(actionId === undefined ? {} : { actionId }),
    });
  });
}

function collectConfigReferences(
  references: Map<string, MutableResolutionReference>,
  config: CameraConfig<SubjectReference>,
  path: string,
  actionId?: string,
): void {
  if (
    config.type === "nonSubjectAware"
    && Array.isArray(config.lookAt)
  ) {
    collectTargetList(references, config.lookAt, `${path}.lookAt`, "lookAt", actionId);
  }
}

function collectTriggerReferences(
  references: Map<string, MutableResolutionReference>,
  trigger: TriggerSpec<SubjectReference>,
  path: string,
  actionId: string,
): void {
  if ("triggers" in trigger) {
    trigger.triggers.forEach((child, index) => {
      collectTriggerReferences(references, child, `${path}.triggers[${index}]`, actionId);
    });
    return;
  }

  if (trigger.type === "distance") {
    collectTargetList(references, [trigger.object1], `${path}.object1`, "event", actionId);
    collectTargetList(references, [trigger.object2], `${path}.object2`, "event", actionId);
  } else if (trigger.type === "velocity") {
    collectTargetList(references, [trigger.subject], `${path}.subject`, "event", actionId);
  }
}

export function collectSubjectReferences(
  draft: CameraDirectionDraft,
): SubjectResolutionReference[] {
  const references = new Map<string, MutableResolutionReference>();

  draft.sections.forEach((section, sectionIndex) => {
    const sectionPath = `sections[${sectionIndex}]`;
    collectTargetList(
      references,
      section.initCamera.targets,
      `${sectionPath}.initCamera.targets`,
      "initialFraming",
    );
    collectConfigReferences(
      references,
      section.initCamera.config,
      `${sectionPath}.initCamera.config`,
    );

    section.actions.forEach((action, actionIndex) => {
      const actionPath = `${sectionPath}.actions[${actionIndex}]`;
      collectTargetList(
        references,
        action.movement.targets,
        `${actionPath}.movement.targets`,
        "movementAxis",
        action.id,
      );
      collectTriggerReferences(
        references,
        action.trigger,
        `${actionPath}.trigger`,
        action.id,
      );
      action.constraints?.forEach((constraint, constraintIndex) => {
        const constraintPath = `${actionPath}.constraints[${constraintIndex}]`;
        collectTargetList(
          references,
          constraint.targets,
          `${constraintPath}.targets`,
          "framing",
          action.id,
        );
        if (!("kind" in constraint) || constraint.kind !== "general") {
          collectConfigReferences(
            references,
            constraint.config,
            `${constraintPath}.config`,
            action.id,
          );
        }
      });
    });
  });

  return [...references.values()];
}

function formatBindingFailure(binding: SubjectBinding): string {
  if (binding.status === "ambiguous") {
    return `ambiguous (${binding.candidateSubjectIds.join(", ")}): ${binding.reason}`;
  }
  if (binding.status === "notFound") {
    return `not found: ${binding.reason}`;
  }
  return "unresolved";
}

function validateBindings(
  references: SubjectResolutionReference[],
  rawBindings: SubjectBinding[],
): Map<string, ResolvedSubjectBinding> {
  const requestedRefs = new Set(references.map((reference) => reference.ref));
  const bindingsByRef = new Map<string, SubjectBinding>();

  for (const binding of rawBindings) {
    if (!requestedRefs.has(binding.ref)) {
      throw new Error(`Subject resolver returned unexpected ref ${JSON.stringify(binding.ref)}`);
    }
    if (bindingsByRef.has(binding.ref)) {
      throw new Error(`Subject resolver returned duplicate ref ${JSON.stringify(binding.ref)}`);
    }
    bindingsByRef.set(binding.ref, binding);
  }

  const resolved = new Map<string, ResolvedSubjectBinding>();
  for (const reference of references) {
    const binding = bindingsByRef.get(reference.ref);
    if (!binding) {
      throw new Error(`Subject resolver omitted ref ${JSON.stringify(reference.ref)}`);
    }
    if (binding.status !== "resolved") {
      throw new Error(
        `Could not bind subject ref ${JSON.stringify(reference.ref)}: ${formatBindingFailure(binding)}`,
      );
    }

    const subjectIds = [...new Set(binding.subjectIds.map((id) => id.trim()))]
      .filter(Boolean);
    const cardinality = normalizedCardinality(reference);
    if (
      subjectIds.length < cardinality.min
      || (cardinality.max !== undefined && subjectIds.length > cardinality.max)
    ) {
      const expected = cardinality.max === undefined
        ? `at least ${cardinality.min}`
        : cardinality.min === cardinality.max
          ? `exactly ${cardinality.min}`
          : `${cardinality.min}-${cardinality.max}`;
      throw new Error(
        `Subject ref ${JSON.stringify(reference.ref)} expected ${expected} subjects `
        + `but resolved to ${subjectIds.length} runtime IDs`,
      );
    }

    resolved.set(reference.ref, {
      ...binding,
      subjectIds,
    });
  }

  return resolved;
}

function bindTargetList(
  references: SubjectReference[] | undefined,
  bindings: Map<string, ResolvedSubjectBinding>,
): Target[] | undefined {
  if (references === undefined) return undefined;

  const result: Target[] = [];
  const seenIds = new Set<string>();
  for (const reference of references) {
    const ref = reference.ref.trim();
    const binding = bindings.get(ref);
    if (!binding) {
      throw new Error(`No validated binding for ref ${JSON.stringify(ref)}`);
    }
    for (const id of binding.subjectIds) {
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      result.push({ id, description: reference.description.trim() });
    }
  }
  return result;
}

function bindSingleTarget(
  reference: SubjectReference,
  bindings: Map<string, ResolvedSubjectBinding>,
): Target {
  const targets = bindTargetList([reference], bindings) ?? [];
  if (targets.length !== 1) {
    throw new Error(
      `DSL slot for ref ${JSON.stringify(reference.ref)} accepts exactly one runtime target`,
    );
  }
  return targets[0]!;
}

function bindConfig(
  config: CameraConfig<SubjectReference>,
  bindings: Map<string, ResolvedSubjectBinding>,
): CameraConfig<Target> {
  if (config.type === "subjectAware") return { ...config };
  const { lookAt, ...rest } = config;
  return {
    ...rest,
    ...(Array.isArray(lookAt)
      ? { lookAt: bindTargetList(lookAt, bindings) ?? [] }
      : lookAt === undefined
        ? {}
        : { lookAt }),
  };
}

function bindTrigger(
  trigger: TriggerSpec<SubjectReference>,
  bindings: Map<string, ResolvedSubjectBinding>,
): TriggerSpec<Target> {
  if ("triggers" in trigger) {
    const compound: CompoundTrigger<Target> = {
      ...trigger,
      triggers: trigger.triggers.map((child) => bindTrigger(child, bindings)),
    };
    return compound;
  }

  if (trigger.type === "distance") {
    return {
      ...trigger,
      object1: bindSingleTarget(trigger.object1, bindings),
      object2: bindSingleTarget(trigger.object2, bindings),
    };
  }
  if (trigger.type === "velocity") {
    return {
      ...trigger,
      subject: bindSingleTarget(trigger.subject, bindings),
    };
  }
  return { ...trigger };
}

function bindConstraint(
  constraint: ActionConstraintConfig<SubjectReference>,
  bindings: Map<string, ResolvedSubjectBinding>,
): ActionConstraintConfig<Target> {
  if ("kind" in constraint && constraint.kind === "general") {
    const { targets, ...rest } = constraint;
    return {
      ...rest,
      ...(targets === undefined
        ? {}
        : { targets: bindTargetList(targets, bindings) }),
    };
  }
  const { targets, ...rest } = constraint;
  return {
    ...rest,
    ...(targets === undefined
      ? {}
      : { targets: bindTargetList(targets, bindings) }),
    config: bindConfig(constraint.config, bindings),
  };
}

function hydrateDraft(
  draft: CameraDirectionDraft,
  bindings: Map<string, ResolvedSubjectBinding>,
): ResolvedCameraDirectionDSL {
  return {
    ...draft,
    sections: draft.sections.map((section) => ({
      ...section,
      initCamera: {
        ...section.initCamera,
        targets: bindTargetList(section.initCamera.targets, bindings) ?? [],
        config: bindConfig(section.initCamera.config, bindings),
      },
      actions: section.actions.map((action) => {
        const { constraints, ...actionWithoutConstraints } = action;
        const { targets: movementReferences, ...movement } = action.movement;
        return {
          ...actionWithoutConstraints,
          trigger: bindTrigger(action.trigger, bindings),
          movement: {
            ...movement,
            ...(movementReferences === undefined
              ? {}
              : { targets: bindTargetList(movementReferences, bindings) }),
          },
          ...(constraints === undefined
            ? {}
            : {
                constraints: constraints.map((constraint) =>
                  bindConstraint(constraint, bindings),
                ),
              }),
        };
      }),
    })),
  };
}

export async function bindCameraDirectionDraft(
  draft: CameraDirectionDraft,
  context: CameraDirectionBindingContext,
  resolver: SubjectResolver,
): Promise<BoundCameraDirectionResult> {
  assertMovementSubjectReferences(draft);
  const references = collectSubjectReferences(draft);
  const scene = sceneIdentitySchema.parse(context.scene);
  const request: ResolveSubjectsRequest = { ...context, scene, references };
  const rawResponse = references.length === 0
    ? { scene, bindings: [] }
    : await resolver.resolveSubjects(request);
  const response = subjectResolutionResponseSchema.parse(rawResponse);
  if (
    response.scene.id !== scene.id
    || (scene.revision !== undefined
      && response.scene.revision !== scene.revision)
  ) {
    throw new Error(
      `Subject resolver returned bindings for scene ${JSON.stringify(response.scene)} `
      + `instead of ${JSON.stringify(scene)}`,
    );
  }
  const bindings = validateBindings(references, response.bindings);

  return {
    csl: hydrateDraft(draft, bindings),
    scene: response.scene,
    bindings: [...bindings.values()],
  };
}
