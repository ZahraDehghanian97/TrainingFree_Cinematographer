import type {
  TimelineSolverOutput,
  FlattenedTimeline,
  TimelineSegment,
} from "../types/solver";
import { buildCameraConfigLosses } from "./solver";

export function flattenTimeline(inputTimeline: TimelineSolverOutput): FlattenedTimeline {

  const timeline: TimelineSegment[] = [];
  const cutTimes: number[] = [];

  for (let sectionIndex = 0; sectionIndex < inputTimeline.sections.length; sectionIndex += 1) {
    const section = inputTimeline.sections[sectionIndex]!;
    if (sectionIndex > 0 && section.initKeyframes.length > 0) {
      cutTimes.push(Math.min(...section.initKeyframes.map((keyframe) => keyframe.time)));
    }

    for (const c of section.constraints) {

      if (c.type === "interval") {
        timeline.push({
          kind: "interval",
          startTime: c.startTime,
          endTime: c.endTime,
          lossFunctions: [c.lossFunction],
          ...(c.weight === undefined ? {} : { weight: c.weight }),
        });
      }
      if (c.type === "singlePoint") {
        timeline.push({
          kind: "point",
          time: c.time,
          lossFunctions: buildCameraConfigLosses(c.config, c.targets),
          ...(c.weight === undefined ? {} : { weight: c.weight }),
          ...(c.easing ? { easing: c.easing } : {}),
        });
      }
      if (c.type === "lossPoint") {
        timeline.push({
          kind: "point",
          time: c.time,
          lossFunctions: c.lossFunctions,
          ...(c.weight === undefined ? {} : { weight: c.weight }),
          ...(c.easing ? { easing: c.easing } : {}),
        });
      }
    }

    for (const kf of section.initKeyframes) {
      timeline.push({
        kind: "point",
        time: kf.time,
        lossFunctions: buildCameraConfigLosses(kf.config, kf.targets),
        ...(kf.weight === undefined ? {} : { weight: kf.weight }),
        ...(kf.easing ? { easing: kf.easing } : {}),
      });
    }
  }

  timeline.sort((a, b) => {
    const ta = a.kind === "interval" ? a.startTime : a.time;
    const tb = b.kind === "interval" ? b.startTime : b.time;
    return ta - tb;
  });

    return {
        timeline,
        timeWarp: inputTimeline.timeWarp,
        ...(cutTimes.length > 0 ? { cutTimes: [...new Set(cutTimes)].sort((a, b) => a - b) } : {}),
    };
}
