import { assertMovementSubjectReferences } from "../grounding/validation";
import { validatePointConstraintEasing } from "../timeline/easing";
import type { SubjectReference } from "../types/camera";
import type {
  Action,
  CameraDirectionDraft,
  TriggerSpec,
} from "../types/dsl";
import {
  ComparisonOperator,
  RelativeTimeReference,
} from "../types/enums";
import { cameraDirectionDraftSchema } from "./dsl-schema";

const TIME_EPSILON_SECONDS = 1e-9;

interface IndexedAction {
  action: Action<SubjectReference>;
  path: string;
}

interface RelativeReference {
  actionId: string;
  path: string;
}

interface PartiallyResolvedTiming {
  startTime?: number;
  endTime?: number;
}

function visitTrigger(
  trigger: TriggerSpec<SubjectReference>,
  path: string,
  visitor: (
    trigger: Exclude<TriggerSpec<SubjectReference>, { triggers: unknown }>,
    path: string,
  ) => void,
): void {
  if ("triggers" in trigger) {
    trigger.triggers.forEach((child, index) => {
      visitTrigger(child, `${path}.triggers[${index}]`, visitor);
    });
    return;
  }
  visitor(trigger, path);
}

function indexActions(draft: CameraDirectionDraft): Map<string, IndexedAction> {
  const actions = new Map<string, IndexedAction>();
  draft.sections.forEach((section, sectionIndex) => {
    section.actions.forEach((action, actionIndex) => {
      const path = `sections[${sectionIndex}].actions[${actionIndex}]`;
      const existing = actions.get(action.id);
      if (existing) {
        throw new Error(
          `Duplicate action ID ${JSON.stringify(action.id)} at ${path}; `
          + `first declared at ${existing.path}`,
        );
      }
      actions.set(action.id, { action, path });
    });
  });
  return actions;
}

function validateTriggerSemantics(
  indexed: IndexedAction,
  totalDuration: number,
): RelativeReference[] {
  const relativeReferences: RelativeReference[] = [];
  visitTrigger(indexed.action.trigger, `${indexed.path}.trigger`, (trigger, path) => {
    switch (trigger.type) {
      case "absoluteTime":
        if (trigger.time > totalDuration + TIME_EPSILON_SECONDS) {
          throw new Error(
            `${path}.time=${trigger.time} exceeds totalDuration=${totalDuration}`,
          );
        }
        break;
      case "relativeTime":
        if (Math.abs(trigger.offset) > totalDuration + TIME_EPSILON_SECONDS) {
          throw new Error(
            `${path}.offset must lie within -totalDuration..totalDuration`,
          );
        }
        relativeReferences.push({
          actionId: trigger.actionId,
          path: `${path}.actionId`,
        });
        break;
      case "distance":
        if (
          trigger.operator !== ComparisonOperator.LessThan
          && trigger.operator !== ComparisonOperator.LessThanOrEqual
        ) {
          throw new Error(
            `${path}.operator must be lessThan or lessThanOrEqual for a distance trigger`,
          );
        }
        break;
      case "velocity":
        if (
          trigger.operator !== ComparisonOperator.GreaterThan
          && trigger.operator !== ComparisonOperator.GreaterThanOrEqual
        ) {
          throw new Error(
            `${path}.operator must be greaterThan or greaterThanOrEqual for a velocity trigger`,
          );
        }
        if (trigger.direction !== undefined) {
          throw new Error(`${path}.direction is not supported by the timeline solver`);
        }
        break;
    }
  });
  return relativeReferences;
}

function validateRelativeReferenceGraph(
  actions: Map<string, IndexedAction>,
  edges: Map<string, RelativeReference[]>,
): void {
  for (const [sourceActionId, references] of edges) {
    for (const reference of references) {
      if (!actions.has(reference.actionId)) {
        throw new Error(
          `${reference.path} on action ${JSON.stringify(sourceActionId)} references `
          + `unknown action ${JSON.stringify(reference.actionId)}`,
        );
      }
    }
  }

  const state = new Map<string, "visiting" | "visited">();
  const stack: string[] = [];
  const visit = (actionId: string): void => {
    if (state.get(actionId) === "visited") return;
    if (state.get(actionId) === "visiting") {
      const cycleStart = stack.indexOf(actionId);
      const cycle = [...stack.slice(cycleStart), actionId];
      throw new Error(`Relative action cycle detected: ${cycle.join(" -> ")}`);
    }

    state.set(actionId, "visiting");
    stack.push(actionId);
    for (const reference of edges.get(actionId) ?? []) visit(reference.actionId);
    stack.pop();
    state.set(actionId, "visited");
  };

  for (const actionId of actions.keys()) visit(actionId);
}

function validateActionDurations(
  actions: Map<string, IndexedAction>,
  totalDuration: number,
): void {
  for (const { action, path } of actions.values()) {
    if (
      action.movement.duration !== undefined
      && action.movement.duration > totalDuration + TIME_EPSILON_SECONDS
    ) {
      throw new Error(
        `${path}.movement.duration=${action.movement.duration} exceeds `
        + `totalDuration=${totalDuration}`,
      );
    }

    const speedKeyframes = action.movement.speedKeyframes ?? [];
    for (let index = 1; index < speedKeyframes.length; index += 1) {
      if (
        speedKeyframes[index]!.normalizedTime
        <= speedKeyframes[index - 1]!.normalizedTime
      ) {
        throw new Error(
          `${path}.movement.speedKeyframes must be strictly ordered by normalizedTime`,
        );
      }
    }
  }
}

function validatePointConstraintSemantics(actions: Map<string, IndexedAction>): void {
  for (const { action, path } of actions.values()) {
    action.constraints?.forEach((constraint, constraintIndex) => {
      const constraintPath = `${path}.constraints[${constraintIndex}]`;
      validatePointConstraintEasing(constraint.easing);
      if (constraint.allFrames && constraint.easing !== undefined) {
        throw new Error(
          `${constraintPath}.easing can only be used when allFrames is false`,
        );
      }
    });
  }
}

function triggerStartTime(
  trigger: TriggerSpec<SubjectReference>,
  actions: Map<string, IndexedAction>,
  cache: Map<string, PartiallyResolvedTiming>,
): number | undefined {
  if ("triggers" in trigger) {
    const childTimes = trigger.triggers.map((child) =>
      triggerStartTime(child, actions, cache),
    );
    if (childTimes.some((time) => time === undefined)) return undefined;
    const resolvedTimes = childTimes as number[];
    return trigger.operator === "and"
      ? Math.max(...resolvedTimes)
      : Math.min(...resolvedTimes);
  }
  if (trigger.type === "absoluteTime") return trigger.time;
  if (trigger.type === "relativeTime") {
    const referenced = resolveActionTiming(trigger.actionId, actions, cache);
    let anchor: number | undefined;
    switch (trigger.reference) {
      case RelativeTimeReference.Start:
        anchor = referenced.startTime;
        break;
      case RelativeTimeReference.End:
        anchor = referenced.endTime;
        break;
      case RelativeTimeReference.Middle:
        anchor = referenced.startTime === undefined || referenced.endTime === undefined
          ? undefined
          : (referenced.startTime + referenced.endTime) / 2;
        break;
    }
    return anchor === undefined ? undefined : anchor + trigger.offset;
  }
  return undefined;
}

function resolveActionTiming(
  actionId: string,
  actions: Map<string, IndexedAction>,
  cache: Map<string, PartiallyResolvedTiming>,
): PartiallyResolvedTiming {
  const cached = cache.get(actionId);
  if (cached) return cached;

  const action = actions.get(actionId)!.action;
  const startTime = triggerStartTime(action.trigger, actions, cache);

  const endTime = startTime === undefined || action.movement.duration === undefined
    ? undefined
    : startTime + action.movement.duration;
  const result = {
    ...(startTime === undefined ? {} : { startTime }),
    ...(endTime === undefined ? {} : { endTime }),
  };
  cache.set(actionId, result);
  return result;
}

/**
 * Validates relationships that cannot be represented by the structural Zod
 * schema alone. The function is also exported for already-typed draft values.
 */
export function validateCameraDirectionDraftSemantics(
  draft: CameraDirectionDraft,
  expectedDurationSeconds?: number,
): void {
  if (
    expectedDurationSeconds !== undefined
    && (!Number.isFinite(expectedDurationSeconds) || expectedDurationSeconds <= 0)
  ) {
    throw new Error("expectedDurationSeconds must be positive and finite");
  }
  if (
    expectedDurationSeconds !== undefined
    && Math.abs(draft.totalDuration - expectedDurationSeconds) > TIME_EPSILON_SECONDS
  ) {
    throw new Error(
      `Draft totalDuration=${draft.totalDuration} does not match `
      + `expectedDurationSeconds=${expectedDurationSeconds}`,
    );
  }

  assertMovementSubjectReferences(draft);
  const actions = indexActions(draft);
  const relativeEdges = new Map<string, RelativeReference[]>();
  for (const [actionId, indexed] of actions) {
    relativeEdges.set(
      actionId,
      validateTriggerSemantics(indexed, draft.totalDuration),
    );
  }
  validateRelativeReferenceGraph(actions, relativeEdges);
  validateActionDurations(actions, draft.totalDuration);
  validatePointConstraintSemantics(actions);

  const timingCache = new Map<string, PartiallyResolvedTiming>();
  for (const [actionId, { path }] of actions) {
    const timing = resolveActionTiming(actionId, actions, timingCache);
    if (
      timing.startTime !== undefined
      && (
        timing.startTime < -TIME_EPSILON_SECONDS
        || timing.startTime > draft.totalDuration + TIME_EPSILON_SECONDS
      )
    ) {
      throw new Error(
        `${path} resolves to startTime=${timing.startTime}, outside `
        + `0..${draft.totalDuration}`,
      );
    }
    if (
      timing.endTime !== undefined
      && timing.endTime > draft.totalDuration + TIME_EPSILON_SECONDS
    ) {
      throw new Error(
        `${path} resolves to endTime=${timing.endTime}, beyond `
        + `totalDuration=${draft.totalDuration}`,
      );
    }
  }
}

/** Parses untrusted model output and returns only a validated semantic draft. */
export function parseCameraDirectionDraft(
  value: unknown,
  expectedDurationSeconds?: number,
): CameraDirectionDraft {
  const draft = cameraDirectionDraftSchema.parse(value) as CameraDirectionDraft;
  validateCameraDirectionDraftSemantics(draft, expectedDurationSeconds);
  return draft;
}
