import { SinglePointConstraint, IntervalConstraint, TimelineSolverOutput, FlattenedTimeline, TimelineSegment } from "../types/solver";
import { buildCameraConfigLosses } from "./solver";

function isInterval(
  c: SinglePointConstraint | IntervalConstraint
): c is IntervalConstraint {
  return c.type === 'interval';
}

export function flattenTimeline(inputTimeline: TimelineSolverOutput): FlattenedTimeline {

  const timeline: TimelineSegment[] = [];

  for (const section of inputTimeline.sections) {

    for (const c of section.constraints) {

      if (c.type === "interval") {
        timeline.push({
          kind: "interval",
          startTime: c.startTime,
          endTime: c.endTime,
          lossFunctions: [c.lossFunction]
        });
      }
      if (c.type === "singlePoint") {
        timeline.push({
          kind: "point",
          time: c.time,
          lossFunctions: buildCameraConfigLosses(c.config)
        });
      }
    }

    for (const kf of section.initKeyframes) {
      timeline.push({
        kind: "point",
        time: kf.time,
        lossFunctions: buildCameraConfigLosses(kf.config)
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
        timeWarp: inputTimeline.timeWarp
    };
}