import type { Action, EventTrigger, Section, TriggerSpec } from "../types/dsl";
import type { EnvironmentV1 } from "../types/environment";
import { RelativeTimeReference } from "../types/enums";
import type { TimeWarpSegment } from "../types/solver";
import { resolveEventSceneTime } from "../environment/trigger-events";
import { SCENE_PLAYBACK_RATE } from "./constants";

export interface TimedAction extends Action {
  startTime?: number;
  duration?: number;
  endTime?: number;
}

interface ScheduledAction extends TimedAction {
  windowEnd: number;
  eventDerived: boolean;
}

interface TriggerTime {
  time: number;
  windowEnd?: number;
  eventDerived: boolean;
  independent: boolean;
}

type RelativeTrigger = Extract<TriggerSpec, { type: "relativeTime" }>;

function leaves(trigger: TriggerSpec): Exclude<TriggerSpec, { triggers: unknown }>[] {
  return "triggers" in trigger ? trigger.triggers.flatMap(leaves) : [trigger];
}

function references(action: Action): RelativeTrigger[] {
  return leaves(action.trigger).filter((trigger): trigger is RelativeTrigger =>
    trigger.type === "relativeTime",
  );
}

/** Validate direct resolved-DSL callers as well as drafts from the pipeline. */
function orderActions(actions: Action[], totalDuration: number): Action[] {
  if (!Number.isFinite(totalDuration) || totalDuration <= 0) {
    throw new Error("totalDuration must be positive and finite");
  }
  const indexed = new Map<string, Action>();
  const validateTrigger = (trigger: TriggerSpec): void => {
    if ("triggers" in trigger) {
      if ((trigger.operator !== "and" && trigger.operator !== "or") || !trigger.triggers.length) {
        throw new Error("Compound triggers require and/or and at least one child");
      }
      trigger.triggers.forEach(validateTrigger);
    } else if (trigger.type === "absoluteTime") {
      if (!Number.isFinite(trigger.time) || trigger.time < 0) {
        throw new Error("Absolute trigger time must be finite and non-negative");
      }
    } else if (trigger.type === "relativeTime") {
      if (!Number.isFinite(trigger.offset)
        || !Object.values(RelativeTimeReference).includes(trigger.reference)) {
        throw new Error("Relative trigger requires a finite offset and start/end/middle reference");
      }
    } else if (trigger.type !== "distance" && trigger.type !== "velocity") {
      throw new Error("Unknown trigger type");
    }
  };
  for (const action of actions) {
    if (indexed.has(action.id)) throw new Error(`Duplicate action ID ${JSON.stringify(action.id)}`);
    indexed.set(action.id, action);
    validateTrigger(action.trigger);
    if (action.movement.duration !== undefined
      && (!Number.isFinite(action.movement.duration) || action.movement.duration <= 0)) {
      throw new Error(`Action ${JSON.stringify(action.id)} duration must be positive and finite`);
    }
  }
  const result: Action[] = [];
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const visit = (action: Action): void => {
    if (visited.has(action.id)) return;
    if (visiting.has(action.id)) throw new Error(`Relative action cycle detected at ${action.id}`);
    visiting.add(action.id);
    for (const reference of references(action)) {
      const parent = indexed.get(reference.actionId);
      if (!parent) {
        throw new Error(`Action ${JSON.stringify(action.id)} references unknown action ${JSON.stringify(reference.actionId)}`);
      }
      visit(parent);
    }
    visiting.delete(action.id);
    visited.add(action.id);
    result.push(action);
  };
  actions.forEach(visit);
  return result;
}

function triggerTime(
  trigger: TriggerSpec,
  state: ReadonlyMap<string, ScheduledAction>,
  eventTimes: ReadonlyMap<EventTrigger, number>,
): TriggerTime {
  if ("triggers" in trigger) {
    const children = trigger.triggers.map((child) => triggerTime(child, state, eventTimes));
    // Events latch once reached: AND waits for all children; OR uses the first
    // reachable child. Infinity also represents an event not yet available in
    // a provisional schedule used to map the scene clock to playback.
    const time = trigger.operator === "and"
      ? Math.max(...children.map((child) => child.time))
      : Math.min(...children.map((child) => child.time));
    const selected = children.filter((child) => child.time === time);
    const independent = selected.some((child) => child.independent);
    const windows = selected.flatMap((child) => child.windowEnd === undefined ? [] : [child.windowEnd]);
    return {
      time,
      independent,
      // Tied children must not change meaning when their array order changes.
      // A simultaneous independent event starts a fresh allocation window.
      ...(!independent && windows.length ? { windowEnd: Math.max(...windows) } : {}),
      eventDerived: trigger.operator === "and"
        ? children.some((child) => child.eventDerived)
        : selected.some((child) => child.eventDerived),
    };
  }
  if (trigger.type === "absoluteTime") return { time: trigger.time, eventDerived: false, independent: true };
  if (trigger.type === "distance" || trigger.type === "velocity") {
    return { time: eventTimes.get(trigger) ?? Infinity, eventDerived: true, independent: true };
  }
  const parent = state.get(trigger.actionId);
  if (parent?.startTime === undefined || parent.endTime === undefined) {
    return { time: Infinity, eventDerived: false, independent: false };
  }
  const anchor = trigger.reference === RelativeTimeReference.Start
    ? parent.startTime
    : trigger.reference === RelativeTimeReference.End
      ? parent.endTime
      : (parent.startTime + parent.endTime) / 2;
  return {
    time: anchor + trigger.offset,
    windowEnd: parent.windowEnd,
    eventDerived: parent.eventDerived,
    independent: false,
  };
}

function sequentialDepths(
  actions: Action[],
  eventTimes: ReadonlyMap<EventTrigger, number>,
  timelineEnd: number,
): Map<string, number> {
  const depths = new Map<string, number>();
  const children = new Map<string, Set<string>>();
  const canFire = (trigger: TriggerSpec): boolean => {
    if ("triggers" in trigger) {
      return trigger.operator === "and" ? trigger.triggers.every(canFire) : trigger.triggers.some(canFire);
    }
    if (trigger.type === "relativeTime") return true;
    if (trigger.type === "absoluteTime") return trigger.time <= timelineEnd;
    return Number.isFinite(eventTimes.get(trigger));
  };
  const requiredEnds = (trigger: TriggerSpec): Set<string> => {
    if (!canFire(trigger)) return new Set();
    if (!("triggers" in trigger)) {
      return new Set(trigger.type === "relativeTime" && trigger.reference === RelativeTimeReference.End
        ? [trigger.actionId] : []);
    }
    const sets = trigger.triggers.filter(canFire).map(requiredEnds);
    return trigger.operator === "and"
      ? new Set(sets.flatMap((set) => [...set]))
      : new Set([...sets[0]!].filter((id) => sets.every((set) => set.has(id))));
  };
  for (const action of actions) {
    // Reserve duration for required sequential successors. An optional OR
    // branch must not shorten its parent before that branch actually wins.
    for (const parentId of requiredEnds(action.trigger)) {
      const dependents = children.get(parentId) ?? new Set<string>();
      dependents.add(action.id);
      children.set(parentId, dependents);
    }
  }
  const depth = (id: string): number => {
    const cached = depths.get(id);
    if (cached !== undefined) return cached;
    const result = Math.max(0, ...[...(children.get(id) ?? [])].map((child) => 1 + depth(child)));
    depths.set(id, result);
    return result;
  };
  actions.forEach((action) => depth(action.id));
  return depths;
}

function scheduleActions(
  ordered: Action[],
  eventTimes: ReadonlyMap<EventTrigger, number>,
  playbackEnd: number,
  timelineEnd: number,
): Map<string, ScheduledAction> {
  const depths = sequentialDepths(ordered, eventTimes, timelineEnd);
  let state = new Map<string, ScheduledAction>();
  const sortedTimes = (times: number[]): number[] => [...new Set(times)]
    .filter((time) => Number.isFinite(time) && time <= playbackEnd + 1e-9)
    .sort((a, b) => a - b);
  let rootTimes = sortedTimes(ordered.map((action) => triggerTime(action.trigger, state, eventTimes).time));

  for (let pass = 0; pass < ordered.length * 2 + 4; pass += 1) {
    state = new Map();
    const resolvedRoots: number[] = [];
    for (const action of ordered) {
      const start = triggerTime(action.trigger, state, eventTimes);
      if (!Number.isFinite(start.time) || start.time > playbackEnd + 1e-9) continue;
      if (start.independent) resolvedRoots.push(start.time);
      const windowEnd = start.windowEnd
        ?? rootTimes.find((time) => time > start.time + 1e-6)
        ?? playbackEnd;
      const requestedDuration = action.movement.duration;
      const duration = requestedDuration === undefined
        ? Math.max(0, (windowEnd - start.time) / ((depths.get(action.id) ?? 0) + 1))
        : start.eventDerived
          ? Math.min(requestedDuration, Math.max(0, timelineEnd - start.time))
          : requestedDuration;
      state.set(action.id, {
        ...action,
        startTime: start.time,
        endTime: start.time + duration,
        duration,
        windowEnd,
        eventDerived: start.eventDerived,
      });
    }
    const nextRoots = sortedTimes(resolvedRoots);
    if (nextRoots.length === rootTimes.length && nextRoots.every((time, index) => time === rootTimes[index])) {
      return state;
    }
    rootTimes = nextRoots;
  }
  throw new Error("Could not stabilize implicit action durations; specify movement.duration for the dependent actions");
}

function timeWarp(state: ReadonlyMap<string, ScheduledAction>, actions: Action[]): TimeWarpSegment[] {
  // Preserve source order for equal intervals, matching solveTimeline's stable
  // sort and the playback sampler's last-active-segment precedence.
  return actions.flatMap((action) => {
    const scheduled = state.get(action.id);
    return scheduled?.movement.relativeFPS === undefined
      || scheduled.endTime! - scheduled.startTime! <= 1e-9 ? [] : [scheduled];
  })
    .map((action) => ({
      startTimePlayback: action.startTime!,
      endTimePlayback: action.endTime!,
      rate: SCENE_PLAYBACK_RATE[action.movement.relativeFPS!],
      label: action.movement.relativeFPS!,
    }))
    .sort((a, b) => a.startTimePlayback - b.startTimePlayback || a.endTimePlayback - b.endTimePlayback);
}

function sceneTimeAtPlayback(playbackTime: number, segments: readonly TimeWarpSegment[]): number {
  const boundaries = [...new Set([
    0, playbackTime,
    ...segments.flatMap((segment) => [segment.startTimePlayback, segment.endTimePlayback]),
  ])].filter((time) => time >= 0 && time <= playbackTime).sort((a, b) => a - b);
  let sceneTime = 0;
  for (let index = 0; index + 1 < boundaries.length; index += 1) {
    const start = boundaries[index]!;
    const end = boundaries[index + 1]!;
    const midpoint = (start + end) / 2;
    const active = segments.filter((segment) =>
      segment.startTimePlayback <= midpoint && midpoint < segment.endTimePlayback,
    );
    sceneTime += (end - start) * (active.at(-1)?.rate ?? 1);
  }
  return sceneTime;
}

export function resolveActionTimings(
  sections: Section[],
  totalDuration: number,
  environment?: EnvironmentV1,
): TimedAction[] {
  const actions = sections.flatMap((section) => section.actions);
  const ordered = orderActions(actions, totalDuration);
  const eventTimes = new Map<EventTrigger, number>();
  const events: Array<{ trigger: EventTrigger; sceneTime: number }> = [];
  for (const action of actions) {
    for (const trigger of leaves(action.trigger)) {
      if (trigger.type !== "distance" && trigger.type !== "velocity") continue;
      if (!environment) {
        throw new Error(`Action ${JSON.stringify(action.id)} has an environment event trigger; pass the environment to solveTimeline()`);
      }
      if (eventTimes.has(trigger)) continue;
      eventTimes.set(trigger, Infinity);
      const sceneTime = resolveEventSceneTime(trigger, environment);
      if (sceneTime !== null) events.push({ trigger, sceneTime });
    }
  }
  events.sort((a, b) => a.sceneTime - b.sceneTime);
  let settled = events.length === 0;
  for (let pass = 0; pass < 64 && !settled; pass += 1) {
    settled = true;
    for (const event of events) {
      const previous = eventTimes.get(event.trigger)!;
      if (event.sceneTime === 0) {
        eventTimes.set(event.trigger, 0);
        if (previous !== 0) settled = false;
        continue;
      }
      const sceneTimeForCandidate = (time: number): number => {
        // Include this event at the candidate time while allocating durations.
        // Otherwise OR may use a later fallback to change the very scene clock
        // being used to determine whether its earlier event has happened.
        eventTimes.set(event.trigger, time);
        return sceneTimeAtPlayback(time,
          timeWarp(scheduleActions(ordered, eventTimes, totalDuration, totalDuration), actions),
        );
      };
      // An unreachable event may be an unused branch of OR. Defer failure until
      // the full expression has been evaluated instead of rejecting the leaf.
      if (sceneTimeForCandidate(totalDuration) < event.sceneTime) {
        eventTimes.set(event.trigger, Infinity);
        if (previous !== Infinity) settled = false;
        continue;
      }
      let left = 0;
      let right = totalDuration;
      for (let iteration = 0; iteration < 80 && right - left > 1e-13; iteration += 1) {
        const middle = (left + right) / 2;
        if (middle === left || middle === right) break;
        if (sceneTimeForCandidate(middle) >= event.sceneTime) right = middle;
        else left = middle;
      }
      const fps = Math.max(1, environment?.clock.fpsHint ?? 24);
      const playbackTime = Math.min(totalDuration, Math.ceil(right * fps - 1e-10) / fps);
      eventTimes.set(event.trigger, playbackTime);
      if (previous !== playbackTime) settled = false;
    }
  }
  if (!settled) throw new Error("Could not stabilize event timing with the scene playback rates; specify movement.duration for the dependent actions");

  const state = scheduleActions(ordered, eventTimes, totalDuration, totalDuration);
  const unresolved = actions.filter((action) => !state.has(action.id));
  if (unresolved.length) {
    throw new Error(`Could not resolve timing for action(s): ${unresolved.map((action) => action.id).join(", ")}; trigger was never reached within the playback timeline or its dependencies are unavailable`);
  }
  const outside = [...state.values()].filter((action) =>
    action.startTime! < 0 || action.endTime! < action.startTime!
    || action.endTime! > totalDuration + 1e-9,
  );
  if (outside.length) {
    throw new Error(`Action timing lies outside 0..${totalDuration}s: ${outside.map((action) => action.id).join(", ")}`);
  }
  // The optimizer accepts one non-overlapping scene-rate schedule. Reject
  // ambiguous clocks here rather than returning event times based on a rate
  // schedule that the next stage cannot execute.
  const rates = timeWarp(state, actions);
  for (let index = 1; index < rates.length; index += 1) {
    if (rates[index]!.startTimePlayback < rates[index - 1]!.endTimePlayback - 1e-9) {
      throw new Error("Actions with relativeFPS must not overlap; the scene playback clock requires non-overlapping rate intervals");
    }
  }
  return actions.map((action) => {
    const { windowEnd: _, eventDerived: __, ...timed } = state.get(action.id)!;
    return timed;
  });
}
