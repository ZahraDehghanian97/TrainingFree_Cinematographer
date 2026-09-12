import * as THREE from "three";
import type { SceneEntityV1 } from "../../src/types/environment";
import { sampleLocomotionPosition } from "../../src/environment/locomotion-path";
import { sampleQuatChannelAt, sampleVec3ChannelAt } from "./environment-loader";
import type { HumanoidRig } from "./humanoid";
import { clamp, lerp } from "./interpolation";

export interface HumanoidMotion {
  /** Samples the environment clock, including when seeking backwards or pausing. */
  update(timeSeconds: number): void;
}

type MotionStyle = "auto" | "idle" | "dance" | "float" | "punch";

interface PathSample {
  time: number;
  cycles: number;
  speed: number;
  heading: number;
}

const TAU = Math.PI * 2;
const smoothstep = (from: number, to: number, value: number): number => {
  const t = clamp((value - from) / (to - from), 0, 1);
  return t * t * (3 - 2 * t);
};
const fraction = (value: number): number => value - Math.floor(value);
const angleDifference = (from: number, to: number): number => Math.atan2(Math.sin(to - from), Math.cos(to - from));
// Very fast authored paths should read as a sprint, without rapid limb flutter.
const cycleLength = (speed: number): number => Math.max(0.78 + 0.25 * Math.min(speed, 3.2), speed / 2.5);

function identityPhase(id: string): number {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) hash = (hash * 31 + id.charCodeAt(index)) >>> 0;
  return (hash % 997) / 997 * TAU;
}

function motionStyle(entity: SceneEntityV1): MotionStyle {
  const visual = entity.visual.type === "model" ? entity.visual.fallback : entity.visual;
  const value = visual?.type === "preset" ? visual.params?.motion : undefined;
  return value === "idle" || value === "dance" || value === "float" || value === "punch" ? value : "auto";
}

/** Integrate travelled distance once; rendering never accumulates animation time. */
function buildPath(entity: SceneEntityV1, duration: number, visualScale: number): PathSample[] {
  const position = entity.transform.position;
  if (Array.isArray(position) || position.interpolation === "step" || position.keyframes.length < 2 || duration <= 0) {
    return [{ time: 0, cycles: 0, speed: 0, heading: 0 }];
  }

  // Include authored knots exactly so held stretches never accumulate false steps.
  const count = Math.min(12_000, Math.max(1, Math.ceil(duration * 60)));
  const times = new Set(position.keyframes.map((key) => clamp(key.t, 0, duration)));
  for (let index = 0; index <= count; index += 1) times.add(duration * index / count);
  const orderedTimes = [...times].sort((a, b) => a - b);
  const firstTime = position.keyframes[0].t;
  const lastTime = position.keyframes[position.keyframes.length - 1].t;
  const scaleAt = (time: number): number => {
    const scale = entity.transform.scale ? sampleVec3ChannelAt(entity.transform.scale, time)[1] : 1;
    return Math.max(0.01, Math.abs(scale * visualScale));
  };
  const pointAt = (time: number) => sampleLocomotionPosition(entity, time) ?? sampleVec3ChannelAt(position, time);
  const samples: PathSample[] = [];
  let previous = pointAt(orderedTimes[0]);
  let cycles = 0;
  let heading = 0;

  for (let index = 0; index < orderedTimes.length; index += 1) {
    const time = orderedTimes[index];
    const point = pointAt(time);
    const scale = scaleAt(time);
    if (index > 0) {
      const elapsed = time - orderedTimes[index - 1];
      const distance = Math.hypot(point[0] - previous[0], point[2] - previous[2]) / scaleAt(time - elapsed / 2);
      cycles += distance / cycleLength(distance / elapsed);
    }

    // Estimate the tangent of the same path used by the renderer and queries.
    const beforeTime = Math.max(firstTime, time - 0.01);
    const afterTime = Math.min(lastTime, time + 0.01);
    let speed = 0;
    if (time > firstTime && time < lastTime && afterTime > beforeTime) {
      const before = pointAt(beforeTime);
      const after = pointAt(afterTime);
      const dx = after[0] - before[0];
      const dz = after[2] - before[2];
      speed = Math.hypot(dx, dz) / ((afterTime - beforeTime) * scale);
      if (speed > 0.015) heading += angleDifference(heading, Math.atan2(dx, dz));
    }
    samples.push({ time, cycles, speed, heading });
    previous = point;
  }

  // Precompute turns on the scene clock: bounded angular speed, a little
  // anticipation, and a symmetric filter instead of render-frame damping.
  const firstMoving = samples.find((sample) => sample.speed > 0.015);
  if (firstMoving) {
    for (const sample of samples) {
      if (sample.time >= firstMoving.time) break;
      sample.heading = firstMoving.heading;
    }
  }
  const headings = samples.map((sample) => sample.heading);
  const turning: number[] = [headings[0]];
  let lookAhead = 0;
  for (let index = 1; index < samples.length; index += 1) {
    while (lookAhead + 1 < samples.length && samples[lookAhead + 1].time <= samples[index].time + 0.16) lookAhead += 1;
    const maximumTurn = Math.PI * 1.8 * (samples[index].time - samples[index - 1].time);
    turning.push(turning[index - 1] + clamp(headings[lookAhead] - turning[index - 1], -maximumTurn, maximumTurn));
  }
  for (let index = 0; index < samples.length; index += 1) {
    let sum = 0;
    let weights = 0;
    // At most ~13 samples on either side, even for long tracks.
    for (let neighbor = Math.max(0, index - 13); neighbor <= Math.min(samples.length - 1, index + 13); neighbor += 1) {
      const weight = Math.max(0, 1 - Math.abs(samples[neighbor].time - samples[index].time) / 0.1);
      sum += turning[neighbor] * weight;
      weights += weight;
    }
    samples[index].heading = sum / weights;
  }
  return samples;
}

export function createHumanoidMotion(
  entity: SceneEntityV1,
  durationSeconds: number,
  rig: HumanoidRig,
): HumanoidMotion {
  const duration = Math.max(0, durationSeconds);
  const style = motionStyle(entity);
  const path = buildPath(entity, duration, rig.root.scale.y);
  const phaseOffset = identityPhase(entity.id);
  const restHip = rig.hips.position.clone();
  const restRotation = rig.root.quaternion.clone();
  // Tiny authored shifts in a standing performance should remain idle.
  const followsPath = style === "auto" && path.some((sample) => sample.speed >= 0.12);
  const parentRotation = new THREE.Quaternion();
  const facingRotation = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  const upperLeg = Math.abs(rig.leftShin.position.y);
  const lowerLeg = Math.abs(rig.leftFoot.position.y);
  const ankleHeight = restHip.y + rig.leftThigh.position.y - upperLeg - lowerLeg;
  const hipJointOffset = rig.leftThigh.position.y;
  const reach = (upperLeg + lowerLeg) * 0.985;
  let sampledCycles = 0;
  let sampledSpeed = 0;
  let sampledHeading = 0;

  function samplePath(time: number): void {
    let low = 0;
    let high = path.length - 1;
    while (low + 1 < high) {
      const middle = (low + high) >>> 1;
      if (path[middle].time <= time) low = middle;
      else high = middle;
    }
    const a = path[low];
    const b = path[high];
    const alpha = a === b ? 0 : clamp((time - a.time) / (b.time - a.time), 0, 1);
    sampledCycles = lerp(a.cycles, b.cycles, alpha);
    sampledSpeed = lerp(a.speed, b.speed, alpha);
    sampledHeading = a.heading + angleDifference(a.heading, b.heading) * alpha;
  }

  function leg(side: "left" | "right", ankleZ: number, ankleY: number, footPitch = 0): void {
    const thigh = side === "left" ? rig.leftThigh : rig.rightThigh;
    const shin = side === "left" ? rig.leftShin : rig.rightShin;
    const foot = side === "left" ? rig.leftFoot : rig.rightFoot;
    const down = rig.hips.position.y + hipJointOffset - ankleY;
    const distanceSquared = down * down + ankleZ * ankleZ;
    const knee = Math.acos(clamp((distanceSquared - upperLeg * upperLeg - lowerLeg * lowerLeg) / (2 * upperLeg * lowerLeg), -1, 1));
    const hip = Math.atan2(-ankleZ, down) - Math.atan2(lowerLeg * Math.sin(knee), upperLeg + lowerLeg * Math.cos(knee));
    thigh.rotation.set(hip, 0, 0);
    shin.rotation.set(knee, 0, 0);
    foot.rotation.set(-hip - knee + footPitch, 0, 0);
  }

  function groundedLegs(leftZ: number, leftLift: number, rightZ: number, rightLift: number, hipHeight: number): void {
    const leftHeight = ankleHeight + leftLift;
    const rightHeight = ankleHeight + rightLift;
    rig.hips.position.y = Math.min(
      hipHeight,
      leftHeight + Math.sqrt(Math.max(0, reach * reach - leftZ * leftZ)) - hipJointOffset,
      rightHeight + Math.sqrt(Math.max(0, reach * reach - rightZ * rightZ)) - hipJointOffset,
    );
    leg("left", leftZ, leftHeight);
    leg("right", rightZ, rightHeight);
  }

  function walkingFoot(cycle: number, stance: number, stride: number, lift: number): [number, number] {
    const phase = fraction(cycle);
    if (phase < stance) return [stride * (0.5 - phase / stance), 0];
    const swing = (phase - stance) / (1 - stance);
    const eased = swing ** 3 * (10 - 15 * swing + 6 * swing * swing);
    // Match the planted foot's backwards velocity at toe-off and touchdown.
    // Keep this correction near contact so a sprint cannot overextend a leg.
    const contact = Math.min(0.2, 0.35 * stance / (1 - stance));
    const release = (t: number): number => t < contact ? t * (1 - t / contact) ** 3 : 0;
    const travel = eased - (1 - stance) / stance * (release(swing) - release(1 - swing));
    return [stride * (travel - 0.5), lift * Math.sin(Math.PI * swing) ** 2];
  }

  return {
    update(timeSeconds: number): void {
      const time = clamp(Number.isFinite(timeSeconds) ? timeSeconds : 0, 0, duration);
      samplePath(time);
      const breath = Math.sin(time * 1.65 + phaseOffset);
      const slowSway = Math.sin(time * 0.72 + phaseOffset);

      rig.hips.position.copy(restHip);
      rig.hips.rotation.set(0, 0, 0);
      rig.spine.rotation.set(0.008 * breath, 0.018 * slowSway, 0.008 * slowSway);
      rig.head.rotation.set(-0.012 * breath, 0.045 * Math.sin(time * 0.46 + phaseOffset), -0.009 * slowSway);
      rig.leftUpperArm.rotation.set(0.018 * slowSway, 0, 0.045 + 0.01 * breath);
      rig.rightUpperArm.rotation.set(-0.018 * slowSway, 0, -0.045 - 0.01 * breath);
      rig.leftForearm.rotation.set(-0.13 - 0.014 * breath, 0, 0);
      rig.rightForearm.rotation.set(-0.13 + 0.014 * breath, 0, 0);
      rig.leftHand.rotation.set(0.018 * breath, 0, 0.025);
      rig.rightHand.rotation.set(-0.018 * breath, 0, -0.025);

      rig.root.quaternion.copy(restRotation);
      if (followsPath) {
        // Entity rotations live on the parent. Compensate there so +Z of the
        // walking body follows world travel, including coarse authored yaws.
        parentRotation.fromArray(entity.transform.rotation
          ? sampleQuatChannelAt(entity.transform.rotation, time)
          : [0, 0, 0, 1]);
        facingRotation.setFromAxisAngle(up, sampledHeading);
        rig.root.quaternion.copy(parentRotation).invert().multiply(facingRotation).multiply(restRotation);
      }

      if (style === "float") {
        rig.hips.position.y += 0.035 * Math.sin(time * 1.2 + phaseOffset);
        rig.spine.rotation.z = 0.035 * slowSway;
        rig.leftUpperArm.rotation.set(-0.12 + 0.10 * breath, 0, 0.22 + 0.055 * slowSway);
        rig.rightUpperArm.rotation.set(-0.17 - 0.10 * breath, 0, -0.24 - 0.055 * slowSway);
        rig.leftForearm.rotation.x = -0.35 - 0.08 * breath;
        rig.rightForearm.rotation.x = -0.31 + 0.08 * breath;
        rig.leftThigh.rotation.set(-0.16 + 0.07 * slowSway, 0, 0.025);
        rig.rightThigh.rotation.set(-0.23 - 0.07 * slowSway, 0, -0.025);
        rig.leftShin.rotation.set(0.32 + 0.07 * breath, 0, 0);
        rig.rightShin.rotation.set(0.41 - 0.07 * breath, 0, 0);
        rig.leftFoot.rotation.set(-0.09, 0, 0);
        rig.rightFoot.rotation.set(-0.12, 0, 0);
        return;
      }

      if (style === "dance") {
        const beat = time * 2.8 + phaseOffset;
        const sway = Math.sin(beat);
        groundedLegs(0.075 * sway, 0.065 * Math.max(0, sway) ** 2, -0.075 * sway, 0.065 * Math.max(0, -sway) ** 2, restHip.y - 0.055 - 0.035 * (1 + Math.cos(beat * 2)));
        rig.spine.rotation.set(0.035 * Math.cos(beat), 0.16 * sway, 0.07 * sway);
        rig.head.rotation.set(-0.025 * Math.cos(beat), -0.09 * sway, -0.035 * sway);
        rig.leftUpperArm.rotation.set(-0.4 + 0.50 * sway, 0.10 * sway, 0.48 + 0.25 * Math.cos(beat * 0.5));
        rig.rightUpperArm.rotation.set(-0.4 - 0.50 * sway, -0.10 * sway, -0.48 - 0.25 * Math.sin(beat * 0.5));
        rig.leftForearm.rotation.x = -0.75 + 0.28 * Math.cos(beat);
        rig.rightForearm.rotation.x = -0.75 - 0.28 * Math.cos(beat);
        return;
      }

      if (style === "punch") {
        // Match the authored opening jab/impact beat; a held endpoint stays held.
        const jab = smoothstep(0.18, 0.70, time) * (1 - smoothstep(0.83, 1.85, time));
        groundedLegs(0.09, 0, -0.09, 0, restHip.y - 0.035 - 0.045 * jab);
        rig.spine.rotation.set(0.045 * jab, -0.18 * jab, 0.018 * slowSway);
        rig.head.rotation.y *= 0.35;
        rig.leftUpperArm.rotation.set(-0.56, 0.08, 0.14);
        rig.leftForearm.rotation.set(-1.55, 0, 0);
        rig.rightUpperArm.rotation.set(lerp(-0.58, -1.48, jab), -0.08, -0.08);
        rig.rightForearm.rotation.set(lerp(-1.55, -0.12, jab), 0, 0);
        return;
      }

      const walking = followsPath ? smoothstep(0.015, 0.22, sampledSpeed) : 0;
      if (walking <= 0) {
        groundedLegs(0, 0, 0, 0, restHip.y - 0.013 + 0.003 * breath);
        return;
      }

      const running = smoothstep(1.65, 3.3, sampledSpeed);
      const length = cycleLength(sampledSpeed);
      // Shorter ground contact at a sprint preserves planted feet and limb reach.
      const stance = Math.min(lerp(0.63, 0.43, running), (upperLeg + lowerLeg) * 0.96 / length);
      const cycle = sampledCycles + phaseOffset / TAU;
      const phase = cycle * TAU;
      const stride = length * stance * walking;
      const lift = lerp(0.11, 0.23, running) * walking;
      const left = walkingFoot(cycle, stance, stride, lift);
      const right = walkingFoot(cycle + 0.5, stance, stride, lift);
      groundedLegs(left[0], left[1], right[0], right[1], restHip.y - 0.013 + 0.012 * running * Math.cos(phase * 2));
      const swing = left[0] * 2 / stride * walking;
      rig.spine.rotation.x = lerp(rig.spine.rotation.x, 0.025 + 0.085 * running, walking);
      rig.spine.rotation.y = lerp(rig.spine.rotation.y, -0.055 * Math.sin(phase), walking);
      rig.spine.rotation.z = lerp(rig.spine.rotation.z, 0.022 * Math.sin(phase), walking);
      rig.head.rotation.x -= (0.025 + 0.055 * running) * walking;
      rig.leftUpperArm.rotation.x = lerp(rig.leftUpperArm.rotation.x, lerp(0.34, 0.62, running) * swing, walking);
      rig.rightUpperArm.rotation.x = lerp(rig.rightUpperArm.rotation.x, -lerp(0.34, 0.62, running) * swing, walking);
      rig.leftForearm.rotation.x = lerp(rig.leftForearm.rotation.x, -0.24 - 0.72 * running - 0.10 * Math.max(0, -swing), walking);
      rig.rightForearm.rotation.x = lerp(rig.rightForearm.rotation.x, -0.24 - 0.72 * running - 0.10 * Math.max(0, swing), walking);
    },
  };
}
