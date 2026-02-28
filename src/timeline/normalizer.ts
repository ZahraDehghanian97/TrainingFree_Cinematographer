import { SinglePointConstraint, IntervalConstraint, CameraConfig, LossFunction, LossFunctionType, TimelineSolverOutput, NormalizedTimeline, TimelineSegment } from "../types/CSL";

function isInterval(
  c: SinglePointConstraint | IntervalConstraint
): c is IntervalConstraint {
  return c.type === 'interval';
}

function buildCameraConfigLosses(
  config: CameraConfig
): LossFunction[] {
  const losses: LossFunction[] = [];

  if (config.type === 'subjectAware') {
    if (config.shotSize)
      losses.push({ type: LossFunctionType.ShotSize, parameters: { shotSize: config.shotSize } });
    if (config.subjectView)
      losses.push({ type: LossFunctionType.SubjectView, parameters: { view: config.subjectView } });
    if (config.subjectFraming?.position)
      losses.push({ type: LossFunctionType.FramingPosition, parameters: { position: config.subjectFraming.position } });
  }

  if (config.type === 'nonSubjectAware') {
    losses.push({ type: LossFunctionType.MinPath, parameters: { targetPose: config.extrinsics.pose } });
  }

  return losses;
}

function normalizeTimeline(inputTimeLine: TimelineSolverOutput): NormalizedTimeline {
  const allConstraints: (SinglePointConstraint | IntervalConstraint)[] = [];

  for (const section of inputTimeLine.sections) {
    allConstraints.push(...section.constraints);
    for (const keyframe of section.initKeyframes) {
      allConstraints.push(keyframe);
    }
  }

  const boundaries = new Set<number>();
  for (const c of allConstraints) {
    if (c.type === 'interval') {
      boundaries.add(c.startTime);
      boundaries.add(c.endTime);
    } else {
      boundaries.add(c.time);
    }
  }

  const sorted = Array.from(boundaries).sort((a, b) => a - b);
  const timeline: TimelineSegment[] = [];

  for (let i = 0; i < sorted.length - 1; i++) {
    const start = sorted[i]!;
    const end = sorted[i + 1]!;
    const activeLosses = allConstraints
      .filter(isInterval)
      .filter(iv => iv.startTime < end && iv.endTime > start)
      .map(iv => iv.lossFunction);

    if (activeLosses.length > 0) {
      timeline.push({ kind: 'interval', startTime: start, endTime: end, lossFunctions: activeLosses });
    }
  }

  for (const c of allConstraints) {
    if (c.type === 'singlePoint') {
      timeline.push({ kind: 'point', time: c.time, lossFunctions: buildCameraConfigLosses(c.config) });
    }
  }

  timeline.sort((a, b) => {
    const ta = a.kind === 'interval' ? a.startTime : a.time;
    const tb = b.kind === 'interval' ? b.startTime : b.time;
    if (ta !== tb) return ta - tb;
    if (a.kind === 'point' && b.kind === 'interval') return -1;
    if (a.kind === 'interval' && b.kind === 'point') return 1;
    return 0;
  });

  return timeline;
}