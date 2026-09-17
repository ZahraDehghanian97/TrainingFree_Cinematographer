import fs from "node:fs";
import path from "node:path";
import { resolvedPromptExampleFixtures } from "../src/data/resolved-example-fixtures";
import { sampleEnvironmentSubject } from "../src/environment/sampler";
import { compileLossPlan } from "../src/optimizer/compiler";
import { resolveOptimizerOptions } from "../src/optimizer/config/options";
import { projectWorldBox, projectWorldPoint } from "../src/optimizer/scene/projection";
import { sampleSubjectAggregate } from "../src/optimizer/scene/subjects";
import { cameraRight, conjugateQuat, dot3, length3, normalize3, rollFromQuaternion, rotate3, scale3, sub3 } from "../src/optimizer/shared/math";
import { subjectIdsFromParameters } from "../src/optimizer/shared/parameter-values";
import { ObjectiveEvaluator } from "../src/optimizer/solver/objective";
import { createCameraPositionCurve, samplePositionSegment } from "../src/optimizer/trajectory/position-curve";
import type { CameraOptimizerInput, CameraStateSample } from "../src/optimizer/types";
import { flattenTimeline } from "../src/timeline/flattener";
import { solveTimeline } from "../src/timeline/solver";
import type { EnvironmentV1, Vec3 } from "../src/types/environment";
import type { CameraTrajectoryV1 } from "../src/types/trajectory";
import { assertCameraTrajectoryV1, environmentTimeAtPlayback, sampleCameraTrajectoryAt } from "../web/src/trajectory-loader";

/** Read-only geometric audit of the exact path and clock played by the viewer.
 * Numerical checks use explicit movement intent; aesthetic metrics are reported
 * without pretending a low optimizer loss proves a satisfactory shot.
 */
type Range = [number, number];
interface Settings { examples: number[]; output?: string; fps: number; safety: boolean; strict: boolean }
function settings(): Settings {
  const result: Settings = { examples: resolvedPromptExampleFixtures.map((_, i) => i + 1), fps: 48, safety: true, strict: false };
  for (let i = 2; i < process.argv.length; i++) {
    const option = process.argv[i]!;
    if (option === "--skip-safety") { result.safety = false; continue; }
    if (option === "--strict") { result.strict = true; continue; }
    const value = process.argv[++i];
    if (value === undefined) throw new Error(`Missing value for ${option}`);
    if (option === "--examples") result.examples = value.split(",").map(Number);
    else if (option === "--output") result.output = path.resolve(value);
    else if (option === "--fps") result.fps = Number(value);
    else throw new Error(`Unknown option ${option}`);
  }
  if (!Number.isFinite(result.fps) || result.fps < 24) throw new Error("Audit FPS must be at least 24");
  if (result.examples.some((n) => !Number.isInteger(n) || n < 1 || n > resolvedPromptExampleFixtures.length)) throw new Error("Invalid example number");
  return result;
}
const mean = (values: number[]): number => values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
const maximum = (values: number[]): number => values.length ? Math.max(...values) : 0;
function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b), average = mean(values);
  return { min: sorted[0] ?? 0, max: sorted.at(-1) ?? 0, mean: average,
    p95: sorted[Math.floor(Math.max(0, sorted.length - 1) * 0.95)] ?? 0,
    standardDeviation: Math.sqrt(mean(values.map((value) => (value - average) ** 2))) };
}
function regularTimes(range: Range, fps: number): number[] {
  return [...Array.from({ length: Math.max(0, Math.floor((range[1] - range[0]) * fps)) }, (_, i) => range[0] + i / fps), range[1]];
}
function angleDifference(a: number, b: number): number { return Math.atan2(Math.sin(a - b), Math.cos(a - b)); }
function monotonic(values: number[], direction: 1 | -1) {
  const backwards = values.slice(1).map((v, i) => Math.max(0, -direction * (v - values[i]!)));
  return { netChange: (values.at(-1) ?? 0) - (values[0] ?? 0), totalReversal: backwards.reduce((a, b) => a + b, 0), maximumReversalStep: maximum(backwards) };
}
function lineMetrics(points: Vec3[], axisOverride?: Vec3, originOverride?: Vec3) {
  const origin = originOverride ?? points[0] ?? [0, 0, 0];
  const axis = normalize3(axisOverride ?? sub3(points.at(-1) ?? origin, origin));
  const progress = points.map((point) => dot3(sub3(point, origin), axis));
  const crossTrack = points.map((point, i) => length3(sub3(sub3(point, origin), scale3(axis, progress[i]!))));
  return { axis, crossTrackMeters: stats(crossTrack), progressMeters: stats(progress), ...monotonic(progress, 1) };
}

function audit(number: number, config: Settings) {
  const fixture = resolvedPromptExampleFixtures[number - 1]!;
  const trajectoryPath = path.resolve("web/public/trajectories/optimized", `${fixture.id}-camera.json`);
  const trajectory = JSON.parse(fs.readFileSync(trajectoryPath, "utf8")) as CameraTrajectoryV1;
  assertCameraTrajectoryV1(trajectory);
  const environment = JSON.parse(fs.readFileSync(path.resolve("web/public/environments", `${fixture.id}.json`), "utf8")) as EnvironmentV1;
  const timeline = flattenTimeline(solveTimeline(fixture.resolvedCsl, environment));
  const input: CameraOptimizerInput = { environment, timeline };
  const options = resolveOptimizerOptions(input), plan = compileLossPlan(input);
  const duration = trajectory.clock.durationSeconds;
  const cuts = trajectory.samples.filter((sample) => sample.cutBefore).map((sample) => sample.t);
  const states: CameraStateSample[] = trajectory.samples.map((sample) => ({
    time: sample.t, position: sample.position, rotation: sample.rotation!,
    fovYDegrees: sample.fovYDegrees ?? trajectory.intrinsics.fovYDegrees,
    positionVelocity: sample.positionVelocity, positionAcceleration: sample.positionAcceleration,
  }));
  const curve = createCameraPositionCurve(states, cuts);
  const at = (time: number) => sampleCameraTrajectoryAt(trajectory, time);
  const subject = (id: string, time: number) => sampleEnvironmentSubject(environment, id, environmentTimeAtPlayback(trajectory, time));
  const relative = (id: string, time: number): Vec3 => sub3(at(time).position, subject(id, time).center);
  const frontAngleDegrees = (id: string, time: number): number => {
    const target = sampleSubjectAggregate(environment, [id], environmentTimeAtPlayback(trajectory, time))!;
    const offset = rotate3(sub3(at(time).position, target.center), conjugateQuat(target.rotation));
    return Math.abs(Math.atan2(offset[0], offset[2])) * 180 / Math.PI;
  };
  const actionRange = (id: string): Range => {
    const segments = timeline.timeline.filter((segment) => segment.kind === "interval")
      .filter((segment) => segment.lossFunctions.some((loss) => loss.sourceActionId === id));
    if (!segments.length) throw new Error(`No action interval for ${id}`);
    return [Math.min(...segments.map((segment) => segment.startTime)), Math.max(...segments.map((segment) => segment.endTime))];
  };
  const times = regularTimes([0, duration], config.fps);
  const issues: string[] = [];
  const requireAtMost = (label: string, value: number, tolerance: number) => {
    if (value > tolerance) issues.push(`${label}: ${value.toPrecision(5)} > ${tolerance}`);
  };
  const orbitMetrics = (id: string | string[], range: Range) => {
    const points = regularTimes(range, config.fps).map((time) => Array.isArray(id)
      ? sub3(at(time).position, sampleSubjectAggregate(environment, id, environmentTimeAtPlayback(trajectory, time))!.center)
      : relative(id, time));
    const radii = points.map((point) => Math.hypot(point[0], point[2]));
    const angles = points.map((point) => Math.atan2(point[0], point[2]));
    const increments = angles.slice(1).map((angle, i) => angleDifference(angle, angles[i]!));
    const total = increments.reduce((a, b) => a + b, 0);
    const backwards = increments.filter((value) => value * total < 0).reduce((a, b) => a + Math.abs(b), 0);
    return { interval: range, radiusMeters: stats(radii), radiusRangeMeters: maximum(radii) - Math.min(...radii),
      radiusRangeFraction: (maximum(radii) - Math.min(...radii)) / Math.max(1e-8, mean(radii)),
      totalAngleDegrees: total * 180 / Math.PI, reverseAngleDegrees: backwards * 180 / Math.PI,
      relativeHeightMeters: stats(points.map((point) => point[1])) };
  };
  const followMetrics = (id: string, range: Range) => {
    const points = regularTimes(range, config.fps).map((time) => relative(id, time));
    return { interval: range, distanceMeters: stats(points.map(length3)),
      maximumRelativeOffsetDriftMeters: maximum(points.map((point) => length3(sub3(point, points[0]!)))) };
  };
  const orientationDriftDegrees = (range: Range): number => {
    const origin = at(range[0]).rotation!;
    return maximum(regularTimes(range, config.fps).map((time) => {
      const rotation = at(time).rotation!;
      const dot = Math.abs(rotation.reduce((sum, component, axis) => sum + component * origin[axis]!, 0));
      return 2 * Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI;
    }));
  };
  const line = (range: Range, id?: string, axis?: Vec3, origin?: Vec3) => lineMetrics(
    regularTimes(range, config.fps).map((time) => id ? relative(id, time) : at(time).position), axis, origin,
  );
  const optical = (range: Range) => {
    const clock = regularTimes(range, config.fps), fovs = clock.map((time) => at(time).fovYDegrees ?? trajectory.intrinsics.fovYDegrees);
    const logFocal = fovs.map((fov) => Math.log(1 / Math.tan(fov * Math.PI / 360)));
    const rates = logFocal.slice(1).map((focal, i) => (focal - logFocal[i]!) / (clock[i + 1]! - clock[i]!));
    return { interval: range, fovDegrees: stats(fovs), focalLengthMultiplier: Math.exp(logFocal.at(-1)! - logFocal[0]!),
      logFocalSpeedPerSecond: stats(rates), startRate: rates[0] ?? 0, endRate: rates.at(-1) ?? 0,
      ...monotonic(logFocal, 1) };
  };

  const derivativeJumps = curve.segments.slice(1).flatMap((segment, i) => {
    const previous = curve.segments[i]!;
    if (previous.hold || segment.hold || cuts.some((cut) => Math.abs(cut - segment.startTime) < 1e-8)) return [];
    const before = samplePositionSegment(previous, previous.endTime), after = samplePositionSegment(segment, segment.startTime);
    return [{ time: segment.startTime, velocity: length3(sub3(after.velocity, before.velocity)), acceleration: length3(sub3(after.acceleration, before.acceleration)) }];
  });
  const expectedCuts = timeline.cutTimes ?? [];
  if (cuts.length !== expectedCuts.length || expectedCuts.some((cut, i) => Math.abs(cut - cuts[i]!) > 1e-7)) issues.push("exported cuts differ from current timeline");
  if (Math.abs(duration - fixture.resolvedCsl.totalDuration) > 1e-8) issues.push("exported duration differs from current fixture");
  const exportedRates = trajectory.playback?.rateSegments ?? [];
  for (const warp of timeline.timeWarp ?? []) {
    if (!exportedRates.some((segment) => Math.abs(segment.startTime - warp.startTimePlayback) < 1e-8
      && Math.abs(segment.endTime - warp.endTimePlayback) < 1e-8 && segment.rate === warp.rate)) issues.push(`stale exported scene clock at ${warp.startTimePlayback}`);
  }
  const metrics: Record<string, unknown> = {
    positionFinite: states.every((state) => state.position.every(Number.isFinite)),
    sampleCount: trajectory.samples.length, durationSeconds: duration, cutTimes: cuts,
    cameraHeightMeters: stats(times.map((time) => at(time).position[1])),
    speedMetersPerSecond: stats(times.map((time) => length3(curve.sample(time).velocity))),
    accelerationMetersPerSecondSquared: stats(times.map((time) => length3(curve.sample(time).acceleration))),
    jerkMetersPerSecondCubed: stats(times.map((time) => length3(curve.sample(time).jerk))),
    maximumVelocityDiscontinuityMetersPerSecond: maximum(derivativeJumps.map((jump) => jump.velocity)),
    maximumAccelerationDiscontinuityMetersPerSecondSquared: maximum(derivativeJumps.map((jump) => jump.acceleration)),
  };
  requireAtMost("position velocity discontinuity", maximum(derivativeJumps.map((jump) => jump.velocity)), 1e-5);
  requireAtMost("position acceleration discontinuity", maximum(derivativeJumps.map((jump) => jump.acceleration)), 1e-4);

  const visibility = new Map<string, { count: number; visible: number; coverage: number[]; maxOverflow: number }>();
  for (const time of regularTimes([0, duration], 12)) {
    const active = plan.primitives.filter((primitive) => primitive.startTime <= time + 1e-8 && primitive.endTime >= time - 1e-8
      && (primitive.type === "subjectVisibility" || primitive.type === "bboxInFrame"));
    for (const id of new Set(active.flatMap((primitive) => subjectIdsFromParameters(primitive.parameters)))) {
      const row = visibility.get(id) ?? { count: 0, visible: 0, coverage: [], maxOverflow: 0 };
      const target = subject(id, time), camera = at(time), fov = camera.fovYDegrees ?? trajectory.intrinsics.fovYDegrees;
      const projected = projectWorldPoint(target.center, camera.position, camera.rotation!, fov, trajectory.intrinsics.aspectRatio ?? 16 / 9);
      row.count += 1;
      if (projected.visible && projected.x >= 0 && projected.x <= 1 && projected.y >= 0 && projected.y <= 1) row.visible += 1;
      if (target.box) {
        const box = projectWorldBox(target.box, camera.position, camera.rotation!, fov, trajectory.intrinsics.aspectRatio ?? 16 / 9, trajectory.intrinsics.near);
        row.coverage.push(box.height);
        if (active.some((primitive) => primitive.type === "bboxInFrame" && subjectIdsFromParameters(primitive.parameters).includes(id))) {
          row.maxOverflow = Math.max(row.maxOverflow, -box.minX, box.maxX - 1, -box.minY, box.maxY - 1, box.behindCamera ? 1 : 0);
        }
      }
      visibility.set(id, row);
    }
  }
  metrics.subjectCoverage = Object.fromEntries([...visibility].map(([id, row]) => [id, {
    sampledFrames: row.count, centerVisibleFraction: row.visible / row.count,
    projectedHeight: stats(row.coverage), maximumKeepInFrameOverflow: row.maxOverflow,
  }]));
  if (config.safety) {
    const violation = new ObjectiveEvaluator(input, plan, states.map((state) => state.time), options).safetyViolation(states);
    metrics.maximumSweptSafetyViolationMeters = violation;
    requireAtMost("swept camera safety violation", violation, 1e-5);
  }

  switch (number) {
    case 1: {
      const range = actionRange("pedestal_up"), rise = at(range[1]).position[1] - at(range[0]).position[1];
      const relativeRise = relative("ball", range[1])[1] - relative("ball", range[0])[1];
      metrics.pedestalRise = { interval: range, worldRiseMeters: rise, relativeRiseMeters: relativeRise };
      // The concurrent Follow contributes the ball's vertical motion. The
      // authored pedestal distance is measured after removing that component.
      requireAtMost("authored pedestal distance error", Math.abs(relativeRise - 2.5), 0.02);
      if (rise <= 0) issues.push(`pedestal does not rise in world space: ${rise.toFixed(4)}m`);
      break;
    }
    case 2: {
      const result = orbitMetrics("man_face", actionRange("orbit_stop_motion")); metrics.orbit = result;
      requireAtMost("fixed orbit radius range", result.radiusRangeMeters, 0.01);
      requireAtMost("three-turn orbit angle error", Math.abs(Math.abs(result.totalAngleDegrees) - 1080), 1);
      break;
    }
    case 3: {
      const range = actionRange("dolly_out_reveal"), whole = line(range), last = line([duration - 2, duration], undefined, whole.axis, at(range[0]).position);
      metrics.straightDolly = whole; metrics.finalTwoSeconds = last;
      requireAtMost("final straight-path cross-track", last.crossTrackMeters.max, 0.02);
      requireAtMost("backward dolly reversal", whole.totalReversal, 0.01);
      break;
    }
    case 4: {
      const range = actionRange("zoom_in_driver"), camera = at(range[1]), driver = subject("driver", range[1]);
      const box = projectWorldBox(driver.box!, camera.position, camera.rotation!, camera.fovYDegrees!, trajectory.intrinsics.aspectRatio ?? 16 / 9, trajectory.intrinsics.near);
      const maximumHeightError = maximum(regularTimes(range, config.fps).map((time) => Math.abs(relative("driver", time)[1])));
      metrics.driverZoom = { ...optical(range), finalDriverFrameHeight: box.height, finalDriverDistanceMeters: length3(relative("driver", range[1])),
        finalFrameBounds: box, maximumDriverHeightErrorMeters: maximumHeightError };
      requireAtMost("driver final close-up coverage error", Math.abs(box.height - 0.7), 0.1);
      requireAtMost("driver eye-level height error", maximumHeightError, 0.1);
      break;
    }
    case 6: {
      metrics.frozenOrbit = orbitMetrics("subject", actionRange("frozen_orbit_360"));
      const before = followMetrics("subject", actionRange("follow_before_freeze")), after = followMetrics("subject", actionRange("resume_normal_speed"));
      metrics.beforeFreeze = before; metrics.afterFreeze = after;
      const beforeRotation = orientationDriftDegrees(actionRange("follow_before_freeze"));
      const afterRotation = orientationDriftDegrees(actionRange("resume_normal_speed"));
      metrics.rotationOutsideFreezeDegrees = { before: beforeRotation, after: afterRotation };
      requireAtMost("pre-freeze relative camera drift", before.maximumRelativeOffsetDriftMeters, 0.02);
      requireAtMost("post-freeze relative camera drift", after.maximumRelativeOffsetDriftMeters, 0.02);
      requireAtMost("pre-freeze unrequested rotation", beforeRotation, 0.5);
      requireAtMost("post-freeze unrequested rotation", afterRotation, 0.5);
      const height = maximum(times.map((time) => Math.abs(relative("subject", time)[1]))); metrics.maximumHeightAboveSubjectMeters = height;
      requireAtMost("eye-level camera height error", height, 0.05);
      break;
    }
    case 7: {
      const radius = regularTimes([0, duration], config.fps).map((time) => length3(relative("subject_eyes", time)));
      const speedSamplingFps = Math.max(config.fps, 120);
      const speed = stats(regularTimes([0, duration], speedSamplingFps).map((time) => length3(curve.sample(time).velocity)));
      const zoom = optical([0, duration]);
      const maximumSpeedDeviationFraction = Math.max(speed.mean - speed.min, speed.max - speed.mean) / Math.max(1e-8, speed.mean);
      metrics.spiral = { radiusMeters: stats(radius), inwardProgress: monotonic(radius, -1), speed,
        speedSamplingFps, speedCoefficientOfVariation: speed.standardDeviation / Math.max(1e-8, speed.mean), maximumSpeedDeviationFraction };
      metrics.optical = zoom;
      const camera = at(duration), eyes = subject("subject_eyes", duration);
      const finalCenter = projectWorldPoint(eyes.center, camera.position, camera.rotation!, camera.fovYDegrees!, trajectory.intrinsics.aspectRatio ?? 16 / 9);
      const finalBounds = projectWorldBox(eyes.box!, camera.position, camera.rotation!, camera.fovYDegrees!, trajectory.intrinsics.aspectRatio ?? 16 / 9, trajectory.intrinsics.near);
      const centerError = Math.hypot(finalCenter.x - 0.5, finalCenter.y - 0.5);
      const frontAngle = frontAngleDegrees("subject_eyes", duration);
      metrics.finalEyeCloseUp = { center: finalCenter, frameBounds: finalBounds, centerError, frameHeight: finalBounds.height, frontAngleDegrees: frontAngle };
      if (!finalCenter.visible || finalBounds.behindCamera) issues.push("final eyes are behind the camera");
      requireAtMost("final eye frame-position error", centerError, 0.08);
      requireAtMost("final eye close-up coverage error", Math.abs(finalBounds.height - 0.7), 0.1);
      requireAtMost("final eye front-view angle error", frontAngle, 5);
      requireAtMost("unrequested lens variation", zoom.fovDegrees.max - zoom.fovDegrees.min, 0.1);
      requireAtMost("spiral radial reversal", monotonic(radius, -1).totalReversal, 0.01);
      requireAtMost("constant path-speed maximum deviation fraction", maximumSpeedDeviationFraction, 0.01);
      break;
    }
    case 8: {
      const result = followMetrics("fist", actionRange("slow_motion_punch")); metrics.fistTracking = result;
      requireAtMost("fist tracking offset drift", result.maximumRelativeOffsetDriftMeters, 0.02);
      const camera = at(duration), impact = subject("impact_point", duration);
      const projected = projectWorldPoint(impact.center, camera.position, camera.rotation!, camera.fovYDegrees!, trajectory.intrinsics.aspectRatio ?? 16 / 9);
      const centerError = Math.hypot(projected.x - 0.5, projected.y - 0.5);
      const side = relative("impact_point", duration)[2];
      metrics.impact = { finalCenter: projected, centerError, finalCameraInFrontOfPadMeters: side,
        initialFistEyeHeightErrorMeters: Math.abs(relative("fist", 0)[1]) };
      requireAtMost("impact frame-position error", centerError, 0.08);
      requireAtMost("initial fist eye-height error", Math.abs(relative("fist", 0)[1]), 0.05);
      if (!projected.visible || side <= 0) issues.push("camera does not view the struck front side of the pad");
      break;
    }
    case 9: {
      const range = actionRange("ots_cut"), clock = regularTimes(range, config.fps);
      const offsets = clock.map((time) => relative("person1_shoulder", time));
      const framing = plan.primitives.filter((primitive) => primitive.type === "screenPosition" && primitive.sourceActionId === "ots_cut");
      const screenErrors = framing.map((primitive) => {
        const id = subjectIdsFromParameters(primitive.parameters)[0]!, desired = primitive.parameters.target as [number, number];
        const positions = clock.map((time) => {
          const camera = at(time), center = subject(id, time).center;
          return projectWorldPoint(center, camera.position, camera.rotation!, camera.fovYDegrees!, trajectory.intrinsics.aspectRatio ?? 16 / 9);
        });
        const errors = positions.map((position) => Math.hypot(position.x - desired[0], position.y - desired[1]));
        return { subjectId: id, requested: desired, x: stats(positions.map((position) => position.x)), y: stats(positions.map((position) => position.y)), screenError: stats(errors) };
      });
      const rollDegrees = stats(clock.map((time) => Math.abs(rollFromQuaternion(at(time).rotation!) * 180 / Math.PI)));
      const result = { interval: range, shoulderHeightErrorMeters: stats(offsets.map((offset) => Math.abs(offset[1]))),
        faceEyeHeightErrorMeters: stats(clock.map((time) => Math.abs(relative("person2_face", time)[1]))),
        cameraBehindShoulderWorldZ: stats(offsets.map((offset) => offset[2])),
        track: followMetrics("person2", range), screenComposition: screenErrors, absoluteRollDegrees: rollDegrees };
      metrics.overShoulder = result;
      requireAtMost("post-cut face-eye-height error", result.faceEyeHeightErrorMeters.max, 0.05);
      if (result.cameraBehindShoulderWorldZ.min <= 0) issues.push("post-cut camera is in front of the foreground shoulder");
      requireAtMost("post-cut follow offset drift", result.track.maximumRelativeOffsetDriftMeters, 0.02);
      for (const screen of screenErrors) requireAtMost(`post-cut ${screen.subjectId} frame-position error`, screen.screenError.max, 0.08);
      requireAtMost("post-cut unrequested camera roll", rollDegrees.max, 2);
      break;
    }
    case 11:
    case 13: {
      const range = actionRange("handheld_dolly_in"), clock = regularTimes(range, config.fps);
      const points = clock.map((time) => at(time).position), axis = normalize3(sub3(points.at(-1)!, points[0]!));
      const residuals = clock.filter((time) => time > range[0] + 0.12 && time < range[1] - 0.12).map((time) => {
        const middle = at(time).position, smoothed = scale3(at(time - 0.12).position.map((value, i) => value + at(time + 0.12).position[i]!) as Vec3, 0.5);
        const residual = sub3(middle, smoothed); return length3(sub3(residual, scale3(axis, dot3(residual, axis))));
      });
      const rms = Math.sqrt(mean(residuals.map((value) => value * value)));
      metrics.handheld = { interval: range, transverseHighPassRmsMeters: rms, transverseHighPassMeters: stats(residuals), localWindowSeconds: 0.24 };
      if (rms < 0.003) issues.push(`handheld tremor absent or too small: transverse RMS=${rms.toPrecision(4)}m`);
      break;
    }
    case 12: {
      const exitRange = actionRange("exit_through_windshield");
      const exitStart = relative("car", exitRange[0]), exitEnd = relative("car", exitRange[1]);
      metrics.windshieldExit = { interval: exitRange, startOffsetMeters: exitStart, endOffsetMeters: exitEnd,
        sidewaysDriftMeters: exitEnd[0] - exitStart[0], verticalDriftMeters: exitEnd[1] - exitStart[1], forwardTravelMeters: exitStart[2] - exitEnd[2] };
      requireAtMost("windshield-exit sideways drift", Math.abs(exitEnd[0] - exitStart[0]), 0.02);
      requireAtMost("windshield-exit vertical drift", Math.abs(exitEnd[1] - exitStart[1]), 0.02);
      requireAtMost("windshield-exit authored distance error", Math.abs(exitStart[2] - exitEnd[2] - 5), 0.02);
      const result = orbitMetrics("car", actionRange("arc_front_reveal")); metrics.carOrbit = result;
      requireAtMost("car orbit fixed-radius range", result.radiusRangeMeters, 0.02);
      requireAtMost("car full-reveal angle error", Math.abs(Math.abs(result.totalAngleDegrees) - 360), 1);
      const frontAngle = frontAngleDegrees("car", duration);
      metrics.finalCarFrontAngleDegrees = frontAngle;
      requireAtMost("car final physical-front angle error", frontAngle, 5);
      break;
    }
    case 14: {
      const result = optical(actionRange("last_breath_zoom")); metrics.finalZoom = result;
      const peak = Math.max(1e-8, result.logFocalSpeedPerSecond.max);
      metrics.finalZoomEndpointRateFractions = { start: Math.abs(result.startRate) / peak, end: Math.abs(result.endRate) / peak };
      requireAtMost("zoom backward optical reversal", result.totalReversal, 0.001);
      requireAtMost("soft zoom initial rate / peak", Math.abs(result.startRate) / peak, 0.2);
      requireAtMost("soft zoom final rate / peak", Math.abs(result.endRate) / peak, 0.2);
      break;
    }
    case 15: metrics.firstThreeSeconds = {
      accelerationMetersPerSecondSquared: stats(regularTimes([0, 3], config.fps).map((time) => length3(curve.sample(time).acceleration))),
      jerkMetersPerSecondCubed: stats(regularTimes([0, 3], config.fps).map((time) => length3(curve.sample(time).jerk))),
    }; break;
    case 16: {
      const range = actionRange("truck_right_exchange_setup"), origin = at(range[0]).position;
      const result = line(range, undefined, cameraRight(at(range[0]).rotation!), origin); metrics.truck = result;
      requireAtMost("truck sideways-path cross-track", result.crossTrackMeters.max, 0.02);
      const orbit = orbitMetrics(["actor_a", "actor_b"], actionRange("axis_flip_arc_right")); metrics.arcAroundActors = orbit;
      requireAtMost("two-actor arc fixed-radius range", orbit.radiusRangeMeters, 0.02);
      requireAtMost("two-actor arc reverse rotation", orbit.reverseAngleDegrees, 0.5);
      break;
    }
    case 17: {
      const range = actionRange("release_dolly_out"), clock = regularTimes(range, config.fps);
      const whole = line(range, "runner"), radii = clock.map((time) => length3(relative("runner", time)));
      const forwardLead = clock.map((time) => {
        const before = subject("runner", Math.max(0, time - 0.02)).center, after = subject("runner", Math.min(duration, time + 0.02)).center;
        return dot3(relative("runner", time), normalize3(sub3(after, before)));
      });
      metrics.release = { interval: range, relativePath: whole, distanceMeters: stats(radii), distanceProgress: monotonic(radii, 1), forwardLeadMeters: stats(forwardLead) };
      requireAtMost("release relative-path cross-track / follow lag", whole.crossTrackMeters.max, 0.03);
      requireAtMost("release dolly radial reversal", monotonic(radii, 1).totalReversal, 0.02);
      if (Math.min(...forwardLead) < 0) issues.push(`camera falls behind runner after slow motion: lead=${Math.min(...forwardLead).toFixed(4)}m`);
      break;
    }
  }
  return { example: number, exampleId: fixture.id, trajectoryModifiedAt: fs.statSync(trajectoryPath).mtime.toISOString(), metrics, issues };
}

const config = settings();
const results: ReturnType<typeof audit>[] = [], errors: Array<{ example: number; error: string }> = [];
const startedAt = new Date().toISOString();
function persist() {
  if (!config.output) return;
  fs.mkdirSync(path.dirname(config.output), { recursive: true });
  fs.writeFileSync(config.output, JSON.stringify({ startedAt, updatedAt: new Date().toISOString(), settings: config,
    notes: ["Exact viewer position interpolation and exported scene clock are used.", "Coverage is sampled at 12 FPS; geometric movement at configured FPS; safety is swept polynomial clearance.", "Derivative continuity is separate from acceleration and jerk magnitude.", "Failures retain fixed tolerances and are not adjusted to match generated output."], results, errors }, null, 2) + "\n");
}
for (const number of config.examples) {
  try {
    const result = audit(number, config); results.push(result);
    console.log(`${result.exampleId}: ${result.issues.length ? result.issues.join("; ") : "geometric checks passed"}`);
  } catch (error) {
    errors.push({ example: number, error: error instanceof Error ? error.stack ?? error.message : String(error) });
    console.error(`example-${String(number).padStart(2, "0")}: ${errors.at(-1)!.error}`);
  }
  persist();
}
if (errors.length || (config.strict && results.some((result) => result.issues.length))) process.exitCode = 1;
