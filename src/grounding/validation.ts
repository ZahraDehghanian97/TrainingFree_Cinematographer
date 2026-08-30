import type {
  CameraConfig,
  CameraTargetDescriptor,
  Target,
} from "../types/camera";
import { CameraMovementType, ConstraintType } from "../types/enums";
import type {
  CameraDirectionDSL,
  ResolvedCameraDirectionDSL,
  TriggerSpec,
} from "../types/dsl";

export const SUBJECT_ANCHORED_MOVEMENTS = new Set<CameraMovementType>([
  CameraMovementType.DollyIn,
  CameraMovementType.DollyOut,
  CameraMovementType.ArcLeft,
  CameraMovementType.ArcRight,
  CameraMovementType.Orbit,
  CameraMovementType.Follow,
  CameraMovementType.Track,
]);

export const SUBJECTLESS_TRANSLATION_MOVEMENTS = new Set<CameraMovementType>([
  CameraMovementType.TruckLeft,
  CameraMovementType.TruckRight,
  CameraMovementType.PedestalUp,
  CameraMovementType.PedestalDown,
]);

export const SUBJECT_ANCHORED_GENERAL_CONSTRAINTS = new Set<ConstraintType>([
  ConstraintType.KeepInFrame,
  ConstraintType.MaintainDistance,
  ConstraintType.MaintainAngle,
  ConstraintType.AvoidOcclusion,
]);

export function assertMovementSubjectReferences(
  dsl: CameraDirectionDSL<CameraTargetDescriptor>,
): void {
  dsl.sections.forEach((section, sectionIndex) => {
    if (
      section.initCamera.config.type === "subjectAware"
      && section.initCamera.targets.length === 0
    ) {
      throw new Error(
        `sections[${sectionIndex}].initCamera uses a subjectAware config but has no targets`,
      );
    }
    section.actions.forEach((action, actionIndex) => {
      if (
        SUBJECTLESS_TRANSLATION_MOVEMENTS.has(action.movement.act)
        && action.movement.targets?.length
      ) {
        throw new Error(
          `Action ${JSON.stringify(action.id)} uses ${action.movement.act}, which is subjectless `
          + "and must not declare movement.targets; use constraint targets for framing",
        );
      }
      if (
        SUBJECT_ANCHORED_MOVEMENTS.has(action.movement.act)
        && !action.movement.targets?.length
      ) {
        throw new Error(
          `Action ${JSON.stringify(action.id)} uses ${action.movement.act} `
          + "but movement.targets is empty; declare its semantic movement subject before binding",
        );
      }
      action.constraints?.forEach((constraint, constraintIndex) => {
        if (
          "kind" in constraint
          && constraint.kind === "general"
          && SUBJECT_ANCHORED_GENERAL_CONSTRAINTS.has(constraint.constraint)
          && !constraint.targets?.length
        ) {
          throw new Error(
            `sections[${sectionIndex}].actions[${actionIndex}].constraints[${constraintIndex}] `
            + `uses ${constraint.constraint} but has no targets`,
          );
        }
        if (
          (!("kind" in constraint) || constraint.kind !== "general")
          && constraint.config.type === "subjectAware"
          && !constraint.targets?.length
        ) {
          throw new Error(
            `sections[${sectionIndex}].actions[${actionIndex}].constraints[${constraintIndex}] `
            + "uses a subjectAware config but has no targets",
          );
        }
      });
    });
  });
}

function assertTarget(target: CameraTargetDescriptor, path: string): asserts target is Target {
  const id = "id" in target ? target.id : undefined;
  if ("ref" in target || typeof id !== "string" || !id.trim()) {
    throw new Error(
      `Unbound target at ${path}; bind semantic CSL references before solving`,
    );
  }
}

function assertTargetList(
  targets: CameraTargetDescriptor[] | undefined,
  path: string,
): void {
  targets?.forEach((target, index) => assertTarget(target, `${path}[${index}]`));
}

function assertConfig(
  config: CameraConfig<CameraTargetDescriptor>,
  path: string,
): void {
  if (config.type === "nonSubjectAware" && Array.isArray(config.lookAt)) {
    assertTargetList(config.lookAt, `${path}.lookAt`);
  }
}

function assertTrigger(
  trigger: TriggerSpec<CameraTargetDescriptor>,
  path: string,
): void {
  if ("triggers" in trigger) {
    trigger.triggers.forEach((child, index) => {
      assertTrigger(child, `${path}.triggers[${index}]`);
    });
  } else if (trigger.type === "distance") {
    assertTarget(trigger.object1, `${path}.object1`);
    assertTarget(trigger.object2, `${path}.object2`);
  } else if (trigger.type === "velocity") {
    assertTarget(trigger.subject, `${path}.subject`);
  }
}

/** Runtime boundary check for CSL loaded from JSON or other untyped sources. */
export function assertResolvedCameraDirection(
  dsl: CameraDirectionDSL<CameraTargetDescriptor>,
): asserts dsl is ResolvedCameraDirectionDSL {
  assertMovementSubjectReferences(dsl);
  dsl.sections.forEach((section, sectionIndex) => {
    const sectionPath = `sections[${sectionIndex}]`;
    assertTargetList(section.initCamera.targets, `${sectionPath}.initCamera.targets`);
    assertConfig(section.initCamera.config, `${sectionPath}.initCamera.config`);

    section.actions.forEach((action, actionIndex) => {
      const actionPath = `${sectionPath}.actions[${actionIndex}]`;
      assertTargetList(action.movement.targets, `${actionPath}.movement.targets`);
      assertTrigger(action.trigger, `${actionPath}.trigger`);
      action.constraints?.forEach((constraint, constraintIndex) => {
        const constraintPath = `${actionPath}.constraints[${constraintIndex}]`;
        assertTargetList(constraint.targets, `${constraintPath}.targets`);
        if (!("kind" in constraint) || constraint.kind !== "general") {
          assertConfig(constraint.config, `${constraintPath}.config`);
        }
      });
    });
  });
}
