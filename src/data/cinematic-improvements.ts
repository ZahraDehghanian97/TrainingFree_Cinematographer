import type { ResolvedPromptExampleFixture } from './resolved-example-fixtures';
import type { Action, ActionConstraintConfig, TriggerSpec } from '../types/dsl';
import type { Target } from '../types/camera';
import { CameraMovementType as M, ConstraintType as C, RelativeFPS as R, ShotSize as S, SubjectInFramePosition as F } from '../types/enums';

/** Scene atmosphere is context, not a request to generate lighting/audio/actor motion.
 * Numeric camera requirements below are mirrored in executable CSL. The minimal
 * don't-care suite (24–32) is deliberately NOT embellished or given defaults. */
export const cinematicTitles = [
  'The last attack · event-driven vertical follow', 'A moment suspended · three-turn face orbit',
  'The hidden workspace · two-subject reveal', 'Midnight test drive · track, arc, optical zoom',
  'The realization · constant-scale dolly zoom', 'Suspended time · freeze, orbit, release',
  'Into the gaze · descending spiral', 'Contact · scene-time speed ramp',
  'The rendezvous · proximity-triggered over-the-shoulder cut', 'Redline · speed-triggered retreat',
  'The unlatched door · handheld push', 'Beyond the windshield · vehicle-relative escape',
  'The second corridor · restrained horror', 'The confession · held close-up finish',
  'On the beat · arc and pedestal', 'The exchange · two-shot, insert, axis crossing',
  'The sprinter · velocity-triggered slow motion', 'The tell · hand-to-eye approach',
  'The ambush · descent, truck, whip reveal', 'An opening in the park · crane reveal',
  'Closing distance · rooftop pursuit', 'The night shift · warehouse one-take',
  'Convergence · factory ensemble reveal',
];

const prompts = [
  'A 10-second uninterrupted sports shot in the populated football ground. Follow the ball toward the goal, not the supporting players. When the surface-to-surface distance between ball and goal first falls below 5 metres, continue following and raise the camera by 2.5 metres relative to the ball over 3 seconds, easing into and out of the rise. Finish looking down at the ball from a high angle. Do not cut.',
  'A 15-second frozen-time portrait on the studio set. Begin in an extreme close-up of the principal man’s face. Freeze the scene from the first frame while the camera makes exactly three complete revolutions (1080 degrees) around his face. Keep the orbit radius fixed; the crew and set remain frozen. No cut and no scene-time speed-up.',
  'A 20-second product reveal in the furnished workspace. Start close on the ceramic vase. Dolly straight backward in one continuous move, gently accelerating out of rest and easing to a stop, until both the vase and the monitor are fully inside the final frame. Reveal their relationship across the desk; do not zoom or cut.',
  'A 15-second tracking shot on the dressed test road. Track the principal car for exactly 2 seconds. For the remaining 13 seconds, arc 90 degrees to the right around the moving car while simultaneously zooming optically toward the driver. Finish with the driver as the visual emphasis. No cut; camera travel is not a request to change scene speed.',
  'A 25-second realization shot against the receding studio columns. Start with a close-up of the principal actor’s face. Dolly backward continuously while increasing optical focal length so that the face retains its initial projected size throughout. Let the background perspective change, not the face size. Keep the move smooth and uncut.',
  'A 5-second suspended-time shot. Hold the camera for the first 2 seconds while the floating subject moves normally. At exactly 2 seconds freeze the scene, but orbit the camera one complete revolution (360 degrees) around the subject over the next 2 seconds. At 4 seconds hold the camera again and restore normal scene speed for the final second. No cut.',
  'A 9-second unbroken spiral toward the principal subject. Begin from a bird’s-eye view. Orbit one full turn (360 degrees) while simultaneously dollying closer and descending toward the eyes. Finish in a close-up of the eyes, not inside the head. The initial high angle is not a constraint on the entire approach. No cut.',
  'A 12-second impact study on the boxing set. Begin in an eye-level, three-quarter-right long shot of the approaching fist and follow it at 10% scene speed. At the first surface contact between fist and target, stop translating the camera, switch scene speed to 4 times normal, and zoom optically into the impact point, centring it by the end. Keep the event tied to contact, not an invented playback timestamp.',
  'A 24-second rendezvous in the populated park. Follow the two principal people in a long two-shot. When the distance between their tracked anchor centres first falls below 1 metre, make one hard cut to an eye-level, medium close-up of the second person, centred, with the first person’s shoulder in the bottom-left foreground and a level horizon. Continue following the second person. Background walkers are not the principals.',
  'A 13-second racing shot. Follow the principal race car. When its speed first exceeds 100 kilometres per hour (27.7777778 metres per second), keep following it while dollying backward with an accelerating then settling handheld retreat. Keep the car as the subject. Shake the camera, not the scene clock; do not cut.',
  'A 6-second uncut approach through the narrow corridor toward the half-open door. Move forward with restrained handheld shake while gradually rolling the camera 30 degrees to the left over the take. Keep the door as the visual destination and do not pass through it. Do not request a lighting change or a cut.',
  'An 18-second virtual-camera shot from inside the braking car. Start behind the dashboard at world position (-0.15, 1.23, 30.25), facing world -Z with a 70-degree vertical field of view. Follow the dashboard so the camera rides with the car. When the car first slows below 5 metres per second, continue riding with the car while travelling 5 metres forward relative to it through the windshield over 2.5 seconds, with a soft launch and landing; treat the mounted cabin as intentional interior occupancy, and permit body crossing only during this explicitly virtual exit. Then make one complete rightward 360-degree arc around the car, ending on its front. No cut.',
  'A 7-second alternate corridor take. Approach the half-open door in one restrained handheld dolly, gradually rolling 30 degrees to the left. Finish outside the doorway. Leave the scene clock at normal speed. The distant caretaker is background, not the framing target.',
  'A 10-second confession on the furnished studio set. Hold a medium, three-quarter-front-left view of the principal actor for 1.5 seconds. Then ease closer in a small rightward arc and dolly. Arrive at a close-up of the face on the left third by 8 seconds. Throughout the final 2 seconds hold that close-up and left-third composition while adding a very gentle optical zoom. No cut.',
  'A 10-second stage portrait of the principal dancer, not the stagehands. Start medium-long and low. During seconds 0–4 arc gently left at 50% scene speed. During seconds 4–8 make a faster leftward arc while pedestalling upward. During seconds 8–10 settle with a gentle downward pedestal, finishing with the dancer on the right third. Keep one continuous shot.',
  'A 10-second spy exchange in the populated concourse. Truck right in a straight line for the first 5 seconds, keeping both principal agents fully in the two-shot. When they first come within 1 metre of each other, use a 1-second optical punch-in on their briefcase. Immediately arc quickly right while zooming back out, crossing their eyeline so the final frame places agent A on the right and agent B on the left. No cut; bystanders are not the two agents.',
  'An 11-second athletic shot. Start full-body and low beside the principal runner, tracking with lead room. When speed first reaches 8 metres per second, reduce scene speed to 10% and arc 120 degrees left over 3 seconds, coming from the side to the front. Restore normal scene speed, follow while dollying backward, and finish with the runner on the left of frame and open space ahead. No cut.',
  'A 10-second psychological detail shot. Start close on the principal subject’s trembling hand. Tilt upward over 2.5 seconds to the eye, then hold for 0.5 seconds. From 3 to 8.5 seconds dolly toward the pupil while zooming optically, ending just outside the eye in an extreme close-up: do not enter the head or fabricate an interior-eye world. Over the final 1.5 seconds roll 10 degrees right and freeze scene time. No cut.',
  'A 10-second stairwell ambush. Begin looking vertically down at the detective. During the first 2 seconds pedestal down while tilting up to eye level. Truck left with the detective from 2 to 7 seconds. At 7 seconds pan quickly left to reveal the pursuer behind the column, widening the lens and rolling right. After the 1.2-second reveal pan, counter-pan briefly right to include both principals by the end. Use one continuous take.',
  'A 10-second park reveal. Follow the jogger for 4 seconds without letting the tree block the subject. From 4 to 7 seconds crane upward to reveal the courtyard fountain. During the final 3 seconds continue following at a fixed relative distance and angle, keeping the jogger framed. No cut and no frozen world.',
  'A 10-second rooftop pursuit among vents and maintenance workers. Track the principal runner until the pursuer first closes to 2.5 metres. Over the next 1.5 seconds arc around the runner and zoom optically to reveal the pursuer. For the remainder track both principals with a stable, level two-shot. Do not confuse maintenance staff with the pursuer, and do not freeze scene time.',
  'A 22-second warehouse one-take. Follow the principal worker through the open aisle for 6 seconds. From 6 to 10 seconds arc right while dollying closer to the worker. From 10 to 14 seconds crane upward to reveal the coworker and mezzanine. From 14 to 18 seconds follow both workers while dollying back into a shared frame. From 18 to 20 seconds crane up and zoom out to include both workers, the yellow forklift, and the mezzanine. Freeze scene time and hold the camera for the last 2 seconds. Keep motion smooth and subjects unobstructed; no cut. Use these authored beats, not a speed-below-threshold event that is already true at the start.',
  'A 20-second ensemble reveal in the populated factory. Follow worker A for the first 6 seconds. From 6 to 10 seconds arc 90 degrees right around workers A and B, bringing both fully into frame by 10 seconds. Track both from 10 to 15 seconds. From 15 to 18 seconds dolly backward while craning upward, revealing the workers, yellow forklift, steel mezzanine, and loading bay together. Freeze the scene and lock off for the final 2 seconds, holding that wide ensemble frame. Keep a level horizon, smooth motion and clear sightlines; no cut. Supporting technicians remain secondary.',
];

const target = (id: string, description = id.replaceAll('_', ' ')): Target => ({ id, description });
const subjects = (...ids: string[]): Target[] => ids.map(id => target(id));
const keep = (ids: string[], allFrames = true): ActionConstraintConfig => ({ kind: 'general', constraint: C.KeepInFrame, targets: subjects(...ids), allFrames });
const safe = (ids: string[]): ActionConstraintConfig[] => [
  { kind: 'general', constraint: C.NoShake, allFrames: true },
  { kind: 'general', constraint: C.AvoidOcclusion, targets: subjects(...ids), allFrames: true },
];
function beat(id: string, act: M, start: number, duration: number, ids: string[] = [], constraints: ActionConstraintConfig[] = []): Action {
  return { id, trigger: { type: 'absoluteTime', time: start }, movement: { act, duration, ...(ids.length ? { targets: subjects(...ids) } : {}) }, constraints };
}

export function improveCinematicFixtures(fixtures: ResolvedPromptExampleFixture[]): ResolvedPromptExampleFixture[] {
  return fixtures.map((original, i) => {
    if (i >= prompts.length) return original; // Do not fill unspecified controls in the ablation suite.
    const f = structuredClone(original); f.prompt = prompts[i]!;
    const actions = f.resolvedCsl.sections.flatMap(s => s.actions);
    const action = (id: string): Action => {
      const found = actions.find(a => a.id === id); if (!found) throw new Error(`Missing ${f.id}/${id}`); return found;
    };
    if (i === 3) action('arc_right_car').movement.parameters = { arcAngle: 90 };
    if (i === 6) {
      // No constant-spatial-speed claim, and approach ends OUTSIDE the eyes.
      for (const a of actions) if (a.movement.parameters) delete a.movement.parameters.constantSpeed;
    }
    if (i === 9) {
      // The retreat is subject-relative, not a stationary-world abandonment of the car.
      const retreat = action('dolly_out_shake');
      f.resolvedCsl.sections[0]!.actions.push({ id: 'follow_during_retreat', trigger: structuredClone(retreat.trigger), movement: { act: M.Follow, targets: subjects('race_car') } });
    }
    if (i === 11) {
      action('dashboard_static').movement.act = M.Track;
      action('dashboard_static').movement.parameters = { allowSubjectIntersection: true }; // Mounted cabin, not an accidental collision.
      const escape=action('exit_through_windshield');
      f.resolvedCsl.sections[0]!.actions.push({id:'ride_through_escape',trigger:structuredClone(escape.trigger),movement:{act:M.Track,targets:subjects('car'),duration:2.5}});
    }
    if (i === 13) {
      // Arrive before the requested final hold; do not keep pushing for all 8.5 s.
      action('confession_push_in').movement.duration = 6.5;
      action('confession_arc_right').movement.duration = 6.5;
      action('last_breath_zoom').trigger = { type: 'absoluteTime', time: 8 };
      action('confession_push_in').constraints = [{ targets: subjects('actor_face'), config: { type: 'subjectAware', shotSize: S.CloseUp, subjectFraming: { position: F.Left } }, allFrames: false }];
    }
    if (i === 14) {
      action('slow_arc_intro').movement.relativeFPS = R.Slow;
      action('beat_arc_accelerate').movement.relativeFPS = R.Normal;
      // The right-third requirement is a finish, not an instant jump at second 8.
      for (const c of action('hero_pose_settle').constraints ?? []) {
        if (c.kind !== 'general') c.allFrames = false;
      }
    }
    if (i === 17) {
      const push = action('pupil_dolly_in'); delete push.movement.parameters?.allowSubjectIntersection;
      push.constraints = [{ targets: subjects('pupil'), config: { type: 'subjectAware', shotSize: S.ExtremeCloseUp }, allFrames: false }];
    }
    if (i === 19) { const finish = action('held_finish'); finish.movement = { ...finish.movement, act: M.Follow, targets: subjects('jogger') }; }
    if (i === 20) { const finish = action('tense_hold'); finish.movement = { ...finish.movement, act: M.Track, targets: subjects('runner', 'pursuer') }; }
    if (i === 21) {
      const pair=['worker','coworker'], ensemble=[...pair,'set-forklift','set-mezzanine'];
      f.resolvedCsl.sections = [{ actions: [
        beat('follow_worker', M.Follow, 0, 6, ['worker'], safe(['worker'])),
        beat('arc_dolly_crates', M.ArcRight, 6, 4, ['worker'], safe(['worker'])),
        beat('dolly_in_crates', M.DollyIn, 6, 4, ['worker']),
        beat('climb_mezzanine', M.CraneUp, 10, 4, [], [keep([...pair, 'set-mezzanine'], false)]),
        beat('reveal_both', M.Follow, 14, 4, pair, safe(pair)),
        beat('dolly_out_reveal', M.DollyOut, 14, 4, pair, [keep(pair, false)]),
        beat('crane_reveal', M.CraneUp, 18, 2, [], [keep(ensemble, false)]),
        beat('zoom_out_reveal', M.ZoomOut, 18, 2),
        { ...beat('finale_hold', M.Static, 20, 2, [], [keep(ensemble), ...safe(pair)]), movement: { act: M.Static, duration: 2, relativeFPS: R.Frozen } },
      ] }];
    }
    if (i === 22) {
      const pair=['worker_a','worker_b'], ensemble=[...pair,'set-forklift','set-mezzanine','loading_bay_frame'];
      const orbit=beat('arc_reveal_worker_b', M.ArcRight, 6, 4, pair, [keep(pair, false),...safe(pair)]); orbit.movement.parameters={arcAngle:90};
      f.resolvedCsl.sections = [{ actions: [
        beat('follow_worker_a', M.Follow, 0, 6, ['worker_a'], safe(['worker_a'])), orbit,
        beat('track_both', M.Track, 10, 5, pair, [keep(pair),...safe(pair)]),
        beat('pull_back_reveal_all', M.DollyOut, 15, 3, pair, [keep(ensemble,false),...safe(pair)]),
        beat('crane_ensemble', M.CraneUp, 15, 3),
        { ...beat('locked_off_freeze', M.Static, 18, 2, [], [keep(ensemble),...safe(pair)]), movement: {act:M.Static,duration:2,relativeFPS:R.Frozen} },
      ] }];
    }
    return f;
  });
}
