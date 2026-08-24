import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";

import { resolvedPromptExampleFixtures } from "../src/data/resolved-example-fixtures";
import { sampleSubjectAggregate } from "../src/optimizer/environment";
import { compileLossPlan, optimizeCameraTrajectory } from "../src/optimizer";
import {
  cameraForward,
  clamp,
  dot3,
  length3,
  multiplyQuat,
  normalize3,
  quatFromAxisAngle,
  quaternionAngle,
  rollFromQuaternion,
  scale3,
  signedAngleAround,
  sub3,
  wrapAngle,
} from "../src/optimizer/math";
import { buildCameraTrajectory } from "../src/optimizer/trajectory";
import { solveNumerically } from "../src/optimizer/numerical-solver";
import { ObjectiveEvaluator } from "../src/optimizer/objective";
import type {
  CameraOptimizerInput,
  CameraStateSample,
  CompiledLossPlan,
} from "../src/optimizer/types";
import { flattenTimeline } from "../src/timeline/flattener";
import { solveTimeline } from "../src/timeline/solver";
import type { EnvironmentV1, Vec3 } from "../src/types/environment";
import { LossFunctionType } from "../src/types/solver";
import { automaticTrajectorySources } from "../web/src/trajectory-source";

const workspaceRoot = path.resolve(__dirname, "..");

function loadEnvironment(exampleId: string): EnvironmentV1 {
  return JSON.parse(fs.readFileSync(
    path.join(workspaceRoot, "web/public/environments", `${exampleId}.json`),
    "utf8",
  )) as EnvironmentV1;
}

test("the optimized three-turn orbit stays smooth and aimed at its subject", () => {
  const fixture = resolvedPromptExampleFixtures.find(({ id }) => id === "example-02");
  assert.ok(fixture);
  const environment = loadEnvironment(fixture.id);
  const timeline = flattenTimeline(solveTimeline(fixture.resolvedCsl));
  const result = optimizeCameraTrajectory({
    environment,
    timeline,
    options: { iterations: 30 },
  });
  const subject = sampleSubjectAggregate(environment, ["man_face"], 0);
  assert.ok(subject);

  const radii: number[] = [];
  const lookAtErrors: number[] = [];
  const speeds: number[] = [];
  const angularSteps: number[] = [];
  for (let index = 0; index < result.trajectory.samples.length; index += 1) {
    const sample = result.trajectory.samples[index]!;
    const radial = sub3(sample.position, subject.center);
    radii.push(Math.hypot(radial[0], radial[2]));
    assert.ok(sample.rotation);
    const desired = normalize3(sub3(subject.center, sample.position));
    lookAtErrors.push(Math.acos(clamp(dot3(cameraForward(sample.rotation), desired), -1, 1)));
    if (index === 0) continue;
    const previous = result.trajectory.samples[index - 1]!;
    const dt = sample.t - previous.t;
    speeds.push(Math.hypot(...sample.position.map(
      (value, component) => value - previous.position[component]!,
    )) / dt);
    angularSteps.push(signedAngleAround(
      sub3(previous.position, subject.center),
      radial,
      [0, 1, 0],
    ));
  }

  assert.ok(result.diagnostics.finalLoss <= result.diagnostics.initialLoss);
  assert.ok(result.diagnostics.optimizationSampleCount >= 73, "fast arcs must be sampled adaptively");
  assert.ok(angularSteps.every((step) => step > 0), "orbit must never reverse direction");
  assert.ok(Math.abs(angularSteps.reduce((sum, step) => sum + step, 0) - 6 * Math.PI) < 0.02);
  assert.ok(Math.max(...lookAtErrors) < 2 * Math.PI / 180, "camera must keep looking at the face");
  assert.ok(Math.min(...radii) > 1.9 && Math.max(...radii) < 2.1);
  assert.ok(Math.max(...speeds) / Math.min(...speeds) < 1.15, "orbit speed must remain stable");
});

test("the vase reveal remains a straight, stable, level dolly", () => {
  const fixture = resolvedPromptExampleFixtures.find(({ id }) => id === "example-03");
  assert.ok(fixture);
  const environment = loadEnvironment(fixture.id);
  const result = optimizeCameraTrajectory({
    environment,
    timeline: flattenTimeline(solveTimeline(fixture.resolvedCsl)),
  });
  const samples = result.trajectory.samples;
  const first = samples[0]!;
  assert.ok(first.rotation);
  const outwardAxis = scale3(cameraForward(first.rotation), -1);
  let pathLength = 0;
  let maximumDrift = 0;
  let maximumRoll = 0;
  let rollVariation = 0;
  let maximumAngularSpeed = 0;
  const speeds: Array<{ time: number; value: number }> = [];
  let previousRoll = rollFromQuaternion(first.rotation);

  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index]!;
    assert.ok(sample.rotation);
    const displacement = sub3(sample.position, first.position);
    const progress = dot3(displacement, outwardAxis);
    const drift = sub3(displacement, scale3(outwardAxis, progress));
    maximumDrift = Math.max(maximumDrift, length3(drift));
    const roll = rollFromQuaternion(sample.rotation);
    maximumRoll = Math.max(maximumRoll, Math.abs(roll));
    if (index === 0) continue;

    const previous = samples[index - 1]!;
    assert.ok(previous.rotation);
    const dt = sample.t - previous.t;
    const step = sub3(sample.position, previous.position);
    const stepProgress = dot3(step, outwardAxis);
    assert.ok(stepProgress >= -2e-4, "dolly must not visibly reverse toward the subjects");
    const speed = length3(step) / dt;
    speeds.push({ time: (previous.t + sample.t) / 2, value: speed });
    pathLength += length3(step);
    maximumAngularSpeed = Math.max(
      maximumAngularSpeed,
      quaternionAngle(previous.rotation, sample.rotation) / dt,
    );
    rollVariation += Math.abs(wrapAngle(roll - previousRoll));
    previousRoll = roll;
  }

  const finalProgress = dot3(
    sub3(samples[samples.length - 1]!.position, first.position),
    outwardAxis,
  );
  const duration = samples[samples.length - 1]!.t;
  const averageSpeed = (startTime: number, endTime: number): number => {
    const selected = speeds.filter(({ time }) => time >= startTime && time <= endTime);
    return selected.reduce((sum, { value }) => sum + value, 0) / selected.length;
  };
  const initialSpeed = averageSpeed(0, duration * 0.025);
  const easedInSpeed = averageSpeed(0, duration * 0.1);
  const cruiseSpeed = averageSpeed(duration * 0.4, duration * 0.6);
  const easedOutSpeed = averageSpeed(duration * 0.9, duration);
  const finalSpeed = averageSpeed(duration * 0.975, duration);
  const fovs = samples.map((sample) =>
    sample.fovYDegrees ?? result.trajectory.intrinsics.fovYDegrees,
  );

  assert.ok(result.diagnostics.finalLoss <= result.diagnostics.initialLoss);
  assert.ok(maximumDrift < 0.03, "straight dolly must stay within 3cm of its optical axis");
  assert.ok(pathLength / finalProgress < 1.02, "dolly path must not contain hidden wiggles");
  assert.ok(easedInSpeed < cruiseSpeed * 0.5, "dolly must ease in from rest");
  assert.ok(easedOutSpeed < cruiseSpeed * 0.5, "dolly must ease out to rest");
  assert.ok(initialSpeed < easedInSpeed * 0.25, "initial acceleration must be gradual");
  assert.ok(finalSpeed < easedOutSpeed * 0.25, "final deceleration must be gradual");
  assert.ok(maximumRoll < Math.PI / 180, "level dolly must remain within one degree of level");
  assert.ok(rollVariation < 3 * Math.PI / 180, "dolly must not accumulate Dutch-angle wobble");
  assert.ok(maximumAngularSpeed < 5 * Math.PI / 180, "reveal reframe must not snap");
  assert.ok(Math.max(...fovs) - Math.min(...fovs) < 1.5, "lens must not pump during the dolly");
});

test("angular smoothness detects equal-size rotations around changing axes", () => {
  const environment = loadEnvironment("example-03");
  const input: CameraOptimizerInput = {
    environment,
    timeline: { timeline: [], timeWarp: [], cutTimes: [] },
  };
  const plan: CompiledLossPlan = {
    durationSeconds: 2,
    conflicts: [],
    warnings: [],
    primitives: [{
      id: "angular-smoothness",
      type: "angularAccelerationSmoothness",
      startTime: 0,
      endTime: 2,
      weight: 1,
      tolerance: 0.3,
      channel: "regularity",
      role: "regularizer",
      sourceType: "global",
      parameters: { cutTimes: [] },
    }],
  };
  const evaluator = new ObjectiveEvaluator(input, plan, [0, 1, 2], {
    aspectRatio: 16 / 9,
    cameraRadius: 0.18,
    collisionMargin: 0.12,
    nearPlane: 0.05,
  });
  const tenDegrees = 10 * Math.PI / 180;
  const x10 = quatFromAxisAngle([1, 0, 0], tenDegrees);
  const sameAxis: CameraStateSample[] = [
    { time: 0, position: [0, 1, 5], rotation: [0, 0, 0, 1], fovYDegrees: 50 },
    { time: 1, position: [0, 1, 5], rotation: x10, fovYDegrees: 50 },
    {
      time: 2,
      position: [0, 1, 5],
      rotation: quatFromAxisAngle([1, 0, 0], 2 * tenDegrees),
      fovYDegrees: 50,
    },
  ];
  const changingAxis: CameraStateSample[] = [
    sameAxis[0]!,
    sameAxis[1]!,
    {
      time: 2,
      position: [0, 1, 5],
      rotation: multiplyQuat(quatFromAxisAngle([0, 1, 0], tenDegrees), x10),
      fovYDegrees: 50,
    },
  ];

  assert.ok(evaluator.evaluate(sameAxis).total < 1e-10);
  assert.ok(evaluator.evaluate(changingAxis).total > 0.01);
});

test("the dashboard exit stays attached to the braking car before a bounded reveal arc", () => {
  const fixture = resolvedPromptExampleFixtures.find(({ id }) => id === "example-12");
  assert.ok(fixture);
  const environment = loadEnvironment(fixture.id);
  const timeline = flattenTimeline(solveTimeline(fixture.resolvedCsl));
  const intervals = timeline.timeline.filter((segment) => segment.kind === "interval");
  assert.deepEqual(
    intervals.map((segment) => [segment.startTime, segment.endTime]),
    [[0, 8], [8, 10.5], [10.5, 18]],
  );

  const seeded = optimizeCameraTrajectory({
    environment,
    timeline,
    options: { iterations: 0 },
  });
  const sampleAt = (time: number) => {
    const sample = seeded.trajectory.samples.find(({ t }) => Math.abs(t - time) <= 1e-8);
    assert.ok(sample);
    return sample;
  };
  const subjectOffset = (time: number, subjectId: string): Vec3 => {
    const subject = sampleSubjectAggregate(environment, [subjectId], time);
    assert.ok(subject);
    return sub3(sampleAt(time).position, subject.center);
  };

  const staticDrift = sub3(subjectOffset(8, "dashboard"), subjectOffset(0, "dashboard"));
  assert.ok(Math.hypot(...staticDrift) < 1e-6, "mounted static must inherit car translation");
  const dollyDisplacement = sub3(subjectOffset(10.5, "car"), subjectOffset(8, "car"));
  const dollyAxis = cameraForward(sampleAt(8).rotation!);
  const dollyProgress = dot3(dollyDisplacement, dollyAxis);
  const dollyOrthogonal = sub3(dollyDisplacement, scale3(dollyAxis, dollyProgress));
  assert.ok(
    Math.abs(dollyProgress - 5.5) < 1e-6 && Math.hypot(...dollyOrthogonal) < 1e-6,
    "dolly distance must be measured in the moving car's frame",
  );
  assert.equal(
    seeded.diagnostics.lossBreakdown.find(({ type }) => type === "collisionClearance")?.weightedLoss,
    0,
    "the explicitly allowed windshield exit must not collide with its car target",
  );

  const result = optimizeCameraTrajectory({
    environment,
    timeline,
    options: { iterations: 30 },
  });
  const optimizedSampleAt = (time: number) => {
    const sample = result.trajectory.samples.find(({ t }) => Math.abs(t - time) <= 1e-8);
    assert.ok(sample);
    return sample;
  };
  const optimizedOffset = (time: number, subjectId: string): Vec3 => {
    const subject = sampleSubjectAggregate(environment, [subjectId], time);
    assert.ok(subject);
    return sub3(optimizedSampleAt(time).position, subject.center);
  };
  const optimizedStaticDrift = sub3(
    optimizedOffset(8, "dashboard"),
    optimizedOffset(0, "dashboard"),
  );
  const initialOptimizedOffset = optimizedOffset(0, "dashboard");
  const maximumStaticDrift = Math.max(...result.trajectory.samples
    .filter(({ t }) => t <= 8 + 1e-9)
    .map((sample) => {
      const dashboard = sampleSubjectAggregate(environment, ["dashboard"], sample.t);
      assert.ok(dashboard);
      return Math.hypot(...sub3(
        sub3(sample.position, dashboard.center),
        initialOptimizedOffset,
      ));
    }));
  const optimizedDollyDisplacement = sub3(
    optimizedOffset(10.5, "car"),
    optimizedOffset(8, "car"),
  );
  const optimizedDollyAxis = cameraForward(optimizedSampleAt(8).rotation!);
  const optimizedDollyProgress = dot3(optimizedDollyDisplacement, optimizedDollyAxis);
  const optimizedDollyOrthogonal = sub3(
    optimizedDollyDisplacement,
    scale3(optimizedDollyAxis, optimizedDollyProgress),
  );
  const arcSamples = result.trajectory.samples.filter(({ t }) => t >= 10.5 - 1e-9);
  const radii = arcSamples.map((sample) => {
    const car = sampleSubjectAggregate(environment, ["car"], sample.t);
    assert.ok(car);
    return Math.hypot(
      sample.position[0] - car.center[0],
      sample.position[2] - car.center[2],
    );
  });
  let arcAngle = 0;
  for (let index = 1; index < arcSamples.length; index += 1) {
    const previous = arcSamples[index - 1]!;
    const current = arcSamples[index]!;
    const previousCar = sampleSubjectAggregate(environment, ["car"], previous.t);
    const currentCar = sampleSubjectAggregate(environment, ["car"], current.t);
    assert.ok(previousCar && currentCar);
    arcAngle += signedAngleAround(
      sub3(previous.position, previousCar.center),
      sub3(current.position, currentCar.center),
      [0, 1, 0],
    );
  }

  assert.ok(result.diagnostics.finalLoss <= result.diagnostics.initialLoss);
  assert.ok(
    Math.hypot(...optimizedStaticDrift) < 1 && maximumStaticDrift < 1,
    "optimized dashboard shot must remain mounted to the moving car",
  );
  assert.ok(
    Math.abs(optimizedDollyProgress - 5.5) < 1
      && Math.hypot(...optimizedDollyOrthogonal) < 2,
    "optimized dolly must retain forward subject-relative travel",
  );
  assert.ok(Math.max(...radii) < 8, "reveal arc must not inherit a runaway radius");
  assert.ok(Math.abs(arcAngle + Math.PI) < 0.25, "reveal must complete its right half-orbit");
});

test("the briefcase axis flip enters and holds its requested orbit radius", () => {
  const fixture = resolvedPromptExampleFixtures.find(({ id }) => id === "example-16");
  assert.ok(fixture);
  const environment = loadEnvironment(fixture.id);
  const timeline = flattenTimeline(solveTimeline(fixture.resolvedCsl));
  const seeded = optimizeCameraTrajectory({
    environment,
    timeline,
    options: { iterations: 0 },
  });
  const arcSamples = seeded.trajectory.samples.filter(({ t }) =>
    t >= 5 + 1 / 3 - 1e-8 && Math.abs(t * 3 - Math.round(t * 3)) < 1e-8,
  );
  const radii = arcSamples.map((sample) => {
    const actors = sampleSubjectAggregate(environment, ["actor_a", "actor_b"], sample.t);
    assert.ok(actors);
    return Math.hypot(
      sample.position[0] - actors.center[0],
      sample.position[2] - actors.center[2],
    );
  });

  assert.ok(
    radii.every((radius) => Math.abs(radius - 4.2) < 1e-6),
    "a radius hold must not inherit the preceding truck shot's radius",
  );
});

test("a translation releases a simultaneous subject-mounted static hold", () => {
  const environment = loadEnvironment("example-12");
  const plan = compileLossPlan({
    environment,
    timeline: {
      timeline: [{
        kind: "interval",
        startTime: 0,
        endTime: 2,
        lossFunctions: [
          {
            type: LossFunctionType.Static,
            parameters: { subjectId: "dashboard" },
            sourceActionId: "mounted",
          },
          {
            type: LossFunctionType.DollyInMovement,
            parameters: { subjectId: "dashboard", distance: 1 },
            sourceActionId: "move",
          },
        ],
      }],
      timeWarp: [],
      cutTimes: [],
    },
  });

  assert.equal(
    plan.primitives.some((primitive) =>
      primitive.type === "relativeOffsetHold"
      && primitive.sourceType === LossFunctionType.Static,
    ),
    false,
  );
  assert.ok(plan.conflicts.some(({ rule }) => rule === "translation-removes-position-hold"));
});

test("dense trajectory interpolation never moves toward a post-cut pose", () => {
  const environment = loadEnvironment("example-02");
  const input: CameraOptimizerInput = {
    environment,
    timeline: { timeline: [], timeWarp: [], cutTimes: [1] },
  };
  const plan: CompiledLossPlan = {
    durationSeconds: environment.clock.durationSeconds,
    primitives: [],
    conflicts: [],
    warnings: [],
  };
  const state = (time: number, position: Vec3): CameraStateSample => ({
    time,
    position,
    rotation: [0, 0, 0, 1],
    fovYDegrees: 50,
  });
  const trajectory = buildCameraTrajectory(
    input,
    plan,
    [
      state(0, [0, 0, 0]),
      state(0.5, [1, 0, 0]),
      state(1, [100, 0, 0]),
      state(2, [101, 0, 0]),
    ],
    [0.75, 1],
    0.05,
    1000,
  );

  assert.deepEqual(trajectory.samples[0]!.position, [1, 0, 0]);
  assert.deepEqual(trajectory.samples[1]!.position, [100, 0, 0]);
  assert.equal(trajectory.samples[1]!.cutBefore, true);
});

test("rejected optimizer steps are reported as stalled, not converged", () => {
  const evaluator = {
    evaluate: () => ({ total: 1, breakdown: [] }),
  } as unknown as ObjectiveEvaluator;
  const solved = solveNumerically(
    [{
      time: 0,
      position: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      fovYDegrees: 50,
    }],
    [],
    evaluator,
    { iterations: 30, randomSeed: 1 },
  );

  assert.equal(solved.terminationReason, "stalled");
  assert.equal(solved.converged, false);
});

test("the environment manifest loads generated optimizer output before demos", () => {
  const manifest = JSON.parse(fs.readFileSync(
    path.join(workspaceRoot, "web/public/environments/manifest.json"),
    "utf8",
  )) as {
    environments: Array<{
      promptExampleId: string;
      optimizedTrajectoryUrl?: string;
      sampleTrajectoryUrl?: string;
    }>;
  };

  for (const entry of manifest.environments) {
    const sources = automaticTrajectorySources(entry);
    assert.equal(sources[0]?.kind, "optimized");
    assert.equal(
      sources[0]?.url,
      `/trajectories/optimized/${entry.promptExampleId}-camera.json`,
    );
    assert.equal(sources[1]?.kind, "sample");
  }
});
