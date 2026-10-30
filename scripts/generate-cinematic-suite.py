#!/usr/bin/env python3
"""Ten AI-authored synthetic camera references for the two supplied worlds.

No LLM/API call and no optimizer invocation. World animation is read, never edited.
Dependencies: numpy and scipy. Run from any directory with Python 3.10+.
"""
from __future__ import annotations
import argparse, hashlib, json, math
from pathlib import Path
from functools import lru_cache
import numpy as np
from scipy.ndimage import gaussian_filter1d
from scipy.interpolate import CubicSpline, CubicHermiteSpline
from scipy.spatial.transform import Rotation, Slerp

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'examples/cinematic-suite'
PUBLIC = ROOT / 'web/public/trajectories/cinematic-suite'
DURATION, FPS, INTERNAL_FPS, ASPECT = 48., 30, 120, 16/9
GRID = np.linspace(0, DURATION, int(DURATION*INTERNAL_FPS)+1)
SAMPLE_TIMES = np.linspace(0, DURATION, int(DURATION*FPS)+1)


def load(path):
    return json.loads(Path(path).read_text(encoding='utf-8'))


def save(path, value):
    path = Path(path); path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False)+'\n', encoding='utf-8')


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def ramp(t, a, b):
    u = np.clip((np.asarray(t)-a)/(b-a), 0., 1.)
    return u*u*u*(10+u*(-15+6*u))


def curve(t, knots):
    """Piecewise quintic ease, zero first/second derivatives at each knot."""
    t=np.asarray(t); scalar=np.ndim(knots[0][1])==0
    result=np.tile(np.asarray(knots[0][1], dtype=float), (t.size, 1))
    if scalar: result=result[:,0]
    for (a,p),(b,q) in zip(knots,knots[1:]):
        w=ramp(t,a,b)
        if not scalar: w=w[:,None]
        result += w*(np.asarray(q)-np.asarray(p))
    return result


def unit(x):
    return x/np.maximum(1e-12,np.linalg.norm(x,axis=-1,keepdims=True))


class World:
    """Matches world channels and the native humanoid monotone-Hermite override."""
    def __init__(self, name):
        self.path=ROOT/'web/public/environments'/f'{name}.json'
        self.data=load(self.path); self.name=name
        self.entities={e['id']:e for e in self.data['entities']}
        self.anchors={a['id']:a for a in self.data.get('semanticAnchors',[])}
        self._smooth={}
        assert self.data['clock']['durationSeconds']==DURATION
        for e in self.entities.values():
            if e['transform'].get('space')!='world':
                raise ValueError('This suite requires world-space input transforms')

    def channel(self, value, t, default, quat=False):
        t=np.atleast_1d(np.asarray(t,dtype=float))
        if value is None: value=default
        if isinstance(value,list): return np.tile(value,(len(t),1))
        keys=value['keyframes']; kt=np.array([k['t'] for k in keys]); kv=np.array([k['value'] for k in keys])
        clipped=np.clip(t,kt[0],kt[-1])
        interpolation=value['interpolation']
        if quat:
            if interpolation!='slerp': raise ValueError(f'Unsupported rotation: {interpolation}')
            return Slerp(kt,Rotation.from_quat(kv))(clipped).as_quat()
        if interpolation!='linear': raise ValueError(f'Unsupported channel: {interpolation}')
        return np.column_stack([np.interp(clipped,kt,kv[:,i]) for i in range(kv.shape[1])])

    def locomotion_position(self, e, t):
        # src/environment/locomotion-path.ts: humanoids use smooth root travel,
        # even where the underlying position channel declares linear samples.
        visual=e.get('visual',{}); channel=e['transform'].get('position')
        if (visual.get('type')!='preset' or visual.get('name')!='humanoid'
            or visual.get('params',{}).get('motion') in ('idle','dance','float','punch')
            or not isinstance(channel,dict) or channel.get('interpolation') not in ('linear','catmullRom')
            or len(channel.get('keyframes',[]))<2):
            return None
        keys=channel['keyframes'];kt=np.array([k['t'] for k in keys]);kv=np.array([k['value'] for k in keys])
        duration=np.diff(kt);slopes=np.diff(kv,axis=0)/duration[:,None];velocity=np.zeros_like(kv,dtype=float)
        before=slopes[:-1];after=slopes[1:];w1=(2*duration[1:]+duration[:-1])[:,None];w2=(duration[1:]+2*duration[:-1])[:,None]
        use=(before!=0)&(after!=0)&(np.sign(before)==np.sign(after))
        with np.errstate(divide='ignore',invalid='ignore'):
            velocity[1:-1]=np.where(use,(w1+w2)/(w1/before+w2/after),0.)
        clipped=np.clip(np.atleast_1d(t),kt[0],kt[-1]);ix=np.clip(np.searchsorted(kt,clipped,side='right')-1,0,len(kt)-2)
        value=CubicHermiteSpline(kt,kv,velocity)(clipped)
        return np.clip(value,np.minimum(kv[ix],kv[ix+1]),np.maximum(kv[ix],kv[ix+1]))

    def transform(self, identifier, t):
        e=self.entities[identifier]; tr=e['transform']
        position=self.locomotion_position(e,t)
        if position is None:position=self.channel(tr.get('position'),t,[0,0,0])
        return (position,
                self.channel(tr.get('rotation'),t,[0,0,0,1],True),
                self.channel(tr.get('scale'),t,[1,1,1]))

    def subject(self, identifier, t):
        if identifier in self.entities:
            e=self.entities[identifier]; b=e.get('bounds')
            if b is None: local=np.zeros(3)
            elif b['type']=='box': local=(np.array(b['min'])+b['max'])/2
            else: local=np.array(b.get('center',[0,0,0]))
        else:
            a=self.anchors[identifier]; e=self.entities[a['entityId']]
            local=np.array(a['localAnchor'])
        p,q,s=self.transform(e['id'],t)
        return p+Rotation.from_quat(q).apply(s*local)

    def smooth_subject(self, identifier, sigma=.32):
        key=(identifier,sigma)
        if key not in self._smooth:
            a=self.subject(identifier,GRID)
            # Symmetric OFFLINE smoothing, not a causal tracking controller.
            a=gaussian_filter1d(a,sigma*INTERNAL_FPS,axis=0,mode='nearest',truncate=4)
            self._smooth[key]=CubicSpline(GRID,a)
        return self._smooth[key](GRID)

    def frame(self, identifier):
        # The rig follows the track tangent, not the winner's post-race turn.
        t=np.minimum(GRID,38 if identifier=='runner_01' else 44.8 if identifier=='runner_03' else 48)
        _,q,_=self.transform(identifier,t)
        f=Rotation.from_quat(q).apply(np.tile([0,0,1],(len(t),1)))
        f[:,1]=0; f=unit(gaussian_filter1d(unit(f),.42*INTERNAL_FPS,axis=0,mode='nearest'))
        o=np.column_stack([-f[:,2],np.zeros(len(t)),f[:,0]])
        return f,o


def pose(p,aim,fov,screen=(.5,.5)):
    n=len(GRID)
    p=np.asarray(p,dtype=float); aim=np.asarray(aim,dtype=float)
    if p.ndim==1:p=np.tile(p,(n,1))
    if aim.ndim==1:aim=np.tile(aim,(n,1))
    if np.ndim(fov)==0:fov=np.full(n,fov)
    if np.ndim(screen)==1:screen=np.tile(screen,(n,1))
    return dict(p=p,aim=aim,fov=np.asarray(fov),screen=np.asarray(screen))


def blend(a,b,w):
    w=np.asarray(w); v=w[:,None]
    # Optical interpolation is in focal-length-equivalent units.
    cot=(1-w)/np.tan(np.deg2rad(a['fov'])/2)+w/np.tan(np.deg2rad(b['fov'])/2)
    return pose(a['p']*(1-v)+b['p']*v,a['aim']*(1-v)+b['aim']*v,
                np.rad2deg(2*np.arctan(1/cot)),a['screen']*(1-v)+b['screen']*v)


def track(w,identifier,radius,height,lead=0,fov=42,screen=(.5,.5)):
    c=w.smooth_subject(identifier); f,o=w.frame(identifier)
    r=np.broadcast_to(radius,(len(GRID),)); l=np.broadcast_to(lead,(len(GRID),))
    p=c+o*r[:,None]+f*l[:,None]; p[:,1]=height
    return pose(p,c,fov,screen)


def xyz_follow(w,identifier,offset,height,fov=42,sigma=.32):
    c=w.smooth_subject(identifier,sigma); p=c+np.array(offset); p[:,1]=height
    return pose(p,c,fov)


def fixed_knots(knots):
    return pose(curve(GRID,[(t,p) for t,p,a,f in knots]),
                curve(GRID,[(t,a) for t,p,a,f in knots]),
                curve(GRID,[(t,f) for t,p,a,f in knots]))


def authored_camera(identifier,w):
    t=GRID
    if identifier=='stadium-01-winners-run':
        p=track(w,'runner_01',curve(t,[(0,12),(8,9.8),(31,9.8),(37,11),(41,11),(48,18)]),
                curve(t,[(0,8),(8,6.7),(31,6.7),(37,7.7),(41,7.7),(48,13)]),
                lead=curve(t,[(0,-3),(8,-2.8),(31,-2.8),(37,8),(48,8)]),
                fov=curve(t,[(0,45),(8,37),(33,37),(37,45),(42,45),(48,50)]),screen=(.44,.52))
        return p
    if identifier=='stadium-02-fall-and-resolve':
        return track(w,'runner_03',curve(t,[(0,10),(10,9),(13.5,13.5),(18.5,13.5),(24,10),(41,10),(48,15)]),
                     curve(t,[(0,5.2),(10,4.5),(13.5,6),(18.5,6),(24,4.8),(41,4.8),(48,8)]),
                     lead=-1.5,fov=curve(t,[(0,39),(10,37),(13.5,45),(18.5,45),(24,38),(41,38),(48,46)]))
    if identifier=='stadium-03-decisive-play':
        a=xyz_follow(w,'ball',[0,0,19],8.5,43,sigma=.6)
        b=pose([33,8.5,23],[37.5,.9,1.0],48)
        a=blend(a,b,ramp(t,29,35))
        angle=curve(t,[(0,-30),(40,-30),(48,-23)])
        goal=w.smooth_subject('goal_east')
        p=goal+np.column_stack([26*np.sin(np.deg2rad(angle)),np.zeros(len(t)),26*np.cos(np.deg2rad(angle))]);p[:,1]=8.5
        c=pose(p,goal,44)
        return blend(a,c,ramp(t,40,48))
    if identifier=='stadium-04-behind-the-lens':
        return track(w,'track_cameraman',curve(t,[(0,8.5),(9,7.5),(32,7.5),(36,4),(40,4),(48,14)]),
                     curve(t,[(0,6.3),(9,5.8),(32,5.8),(36,7.2),(40,7.2),(48,10)]),
                     lead=curve(t,[(0,-2),(12,-2),(32,6),(36,8),(40,8),(48,8)]),
                     fov=curve(t,[(0,40),(9,36),(34,36),(40,44),(48,49)]))
    if identifier=='stadium-05-stadium-breathes':
        a=np.deg2rad(25+60*t/48); h=curve(t,[(0,67),(12,58),(36,58),(48,73)])
        return pose(np.column_stack([170*np.sin(a),h,170*np.cos(a)]),[0,.1,0],58)
    if identifier=='factory-01-production-to-stillness':
        a=xyz_follow(w,'cargo_01',[1.0,0,3.7],3.4,32)
        b=fixed_knots([(0,[-2.5,3.1,9],[0,1.15,2.9],47),
                       (16,[4.8,4.7,9],[2.8,1.3,1.8],53),
                       (24,[4.8,4.7,9],[2.8,1.3,1.8],53),
                       (36,[8,6.5,13],[2,1.1,1.7],51),
                       (48,[10,7.6,17],[1.5,1.2,.5],55)])
        return blend(a,b,ramp(t,8,16))
    if identifier=='factory-02-aisle-two-shot':
        c=(w.smooth_subject('worker_a')+w.smooth_subject('worker_b'))/2
        z=curve(t,[(0,2.8),(6,2.8),(12,4.8),(17,4.8),(20,7.1),(25,7.1),(36,9),(48,9)])
        p=c+np.column_stack([np.full(len(t),.5),np.zeros(len(t)),z])
        p[:,1]=curve(t,[(0,7.1),(8,5.5),(12,2.5),(17,2.5),(20,4),(25,4),(36,3.5),(48,3.5)])
        fov=curve(t,[(0,78),(8,64),(12,40),(17,40),(20,51),(25,51),(36,43),(48,43)])
        aim=c.copy(); aim[:,1]+=curve(t,[(0,0),(17,0),(20,.5),(25,.5),(30,0),(48,0)])
        return pose(p,aim,fov)
    if identifier=='factory-03-chain-reaction':
        return fixed_knots([(0,[0,8.1,12],[0,1,0],68),
                            (14,[2,8.1,6.5],[2,1.35,1.35],56),
                            (26,[2,8.1,6.5],[2,1.35,1.35],56),
                            (48,[4,8.2,11],[1.5,1.15,1],61)])
    if identifier=='factory-04-emergency-operator':
        return fixed_knots([(0,[12,4,5.5],[5.9,1.1,2.9],39),
                            (16,[10.3,3.3,7.8],[5.65,1.2,3],36),
                            (24,[10.3,3.3,7.8],[5.65,1.2,3],36),
                            (35,[6.8,6.1,12],[3.3,1.15,2.4],48),
                            (48,[3.8,6.1,12],[3.1,1.1,2.5],48)])
    if identifier=='factory-05-one-piece':
        a=xyz_follow(w,'cargo_06',[.8,0,4.4],curve(t,[(0,3.4),(15,3.4),(20,5.8),(25,5.8),(32,3.7),(48,3.7)]),
                     curve(t,[(0,29),(15,29),(20,44),(25,44),(32,36),(48,36)]),sigma=.3)
        # Widen before the spill, then hand off to a stationary aftermath insert.
        a['p'][:,2]+=curve(t,[(0,0),(15,0),(20,2),(25,2),(32,0),(48,0)])
        end=w.subject('cargo_06',[48])[0]
        b=pose(end+[-2.7,1.8,3.7],end,31)
        return blend(a,b,ramp(t,26,34))
    raise KeyError(identifier)


# Phase definitions are time-exact narrative supervision, not edits to scene events.
SPECS=[
 dict(id='stadium-01-winners-run',environment='stadium',title="The Winner's Run",tag='Hero tracking / finish / crane reveal',
      prompt="Create one uninterrupted 48-second sports-hero shot in the stadium, at normal scene speed. Follow runner 01, the red-shirted eventual winner, from the outside of the athletics track; this is the main filming camera, not the visible sideline cameraman. Begin with a generous elevated three-quarter view and descend into a smooth, slightly trailing track by 8 seconds. Keep the runner just left of centre with breathing room rather than chasing every footfall. Maintain the outward-side route around the bend. From 33 to 37 seconds widen and rise gently so the finish ribbon is readable. Stay on this runner through the finish at 38 seconds and the celebratory jump at 39.3–40.3 seconds. From 41 to 48 seconds crane up and pull back to include the nearby flower shower and spectators, while retaining the winner as the visual anchor. Use a level horizon, restrained lens changes, and no cuts, shake, slow motion, or teleports.",
      phases=[(0,8,'follow','Establish and descend',['runner_01']),(8,33,'follow','Outside-track hero follow',['runner_01']),(33,41,'follow','Finish and celebration',['runner_01']),(41,48,'craneUp','Winner-to-crowd reveal',['runner_01'])],beats=[2,38,39.8,42],previews=[5,25,39.8,45]),
 dict(id='stadium-02-fall-and-resolve',environment='stadium',title='Fall and Resolve',tag='Recovery story / anticipatory widening',
      prompt="Film a continuous 48-second recovery story centred on runner 03, the yellow-shirted runner, in the stadium. Start in a stable elevated side-follow outside the racing lanes. Track this runner, not the race leader. Between 10 and 13.5 seconds move outward and slightly upward, widening before the fall begins at 13.7 seconds. Keep the entire falling body and the patch of track visible through the fall and recovery at 16.8–18 seconds; do not make an abrupt camera dip. Between 18.5 and 24 seconds ease back into the following distance as the runner resumes the race. Continue with this same runner through their later finish around 44.8 seconds. End with a gentle elevated pullback that gives the recovered runner room in the frame. Retain natural scene timing, smooth acceleration and a level horizon; use no cuts, dramatic roll, or freeze frames.",
      phases=[(0,10,'follow','Track the recovering protagonist',['runner_03']),(10,18.5,'follow','Anticipate and cover the fall',['runner_03']),(18.5,24,'follow','Rejoin the run',['runner_03']),(24,41,'follow','Recovery tracking',['runner_03']),(41,48,'craneUp','Late finish and release',['runner_03'])],beats=[13.7,15,17.5,44.8],previews=[8,15,23,44.8]),
 dict(id='stadium-03-decisive-play',environment='stadium',title='The Decisive Play',tag='Ball tracking / settled goal coverage',
      prompt="Make a 48-second, single-take football sequence inside the stadium. Follow the ball from an elevated touchline-style camera on the positive-Z side of the pitch, keeping enough field in view to understand the passing play. Smooth the camera path across changes in ball direction instead of copying the ball's sharp turns. From 29 to 35 seconds leave the moving follow rig and settle into a wider fixed view containing the approaching ball and the east goal. Hold this shot through the kick, the goal at 38.2 seconds, and the ball settling in the net; do not cut away to the simultaneous running-race finish. After 40 seconds drift gently toward a more frontal view of the east goal and finish on the result of the play. Use normal playback, a level horizon, a moderately wide lens, and no handheld shake or snap pans.",
      phases=[(0,29,'track','Ball-led field coverage',['ball']),(29,35,'track','Settle for the attack',['ball']),(35,40,'static','Hold the ball and east goal',['ball','goal_east']),(40,48,'arcRight','Goal aftermath drift',['ball','goal_east'])],beats=[34,36.8,38.2,39.3],previews=[8,24,37.6,43]),
 dict(id='stadium-04-behind-the-lens',environment='stadium',title='Behind the Sideline Lens',tag='Character study / parallel tracking',
      prompt="Create a 48-second behind-the-scenes portrait of the independent sideline cameraman in the stadium. The visible track_cameraman is the subject, carrying the physical shoulder camera; do not mistake him for the filming viewpoint. Track from farther outside the oval, above the spectator sightline, starting slightly behind him. Move with his run in a stable medium-long composition and let the racing action appear as context behind him. From 12 to 32 seconds make a very gradual transition toward a side/front-quarter relationship without orbiting through the track or stands. Continue through the race finish, then widen and rise from 34 to 48 seconds to show the operator within the event he is filming. Keep his full body and equipment readable, respect the grandstands, maintain a level horizon, and use one uninterrupted take at normal speed.",
      phases=[(0,12,'follow','Follow the operator',['track_cameraman']),(12,32,'follow','Gradual parallel lead change',['track_cameraman']),(32,40,'follow','Finish-line context',['track_cameraman']),(40,48,'craneUp','Operator within the event',['track_cameraman'])],beats=[12,30,38,42],previews=[5,21,35,45]),
 dict(id='stadium-05-stadium-breathes',environment='stadium',title='The Stadium Breathes',tag='60-degree aerial arc / geographic master',
      prompt="Make a 48-second architectural aerial master of the stadium, not a close-up sports shot. Keep the athletics oval, infield football pitch, and stands readable together. Move through a steady 60-degree rightward arc around the centre at an approximately 170-metre horizontal radius. Begin at 67 metres height, descend smoothly to 58 metres over the first 12 seconds, hold that height until 36 seconds, then rise smoothly to 73 metres by the end. Use a fixed 58-degree vertical field of view and a level horizon. The ongoing race and football match should remain environmental activity inside the composition; do not promise facial or ball detail from this distance. Preserve the full normal-speed scene clock and use no cuts, zooms, shake, or sudden changes of angular pace.",
      phases=[(0,12,'arcRight','Descending aerial arc',['athletics_track','football_pitch']),(12,36,'arcRight','Geographic master',['athletics_track','football_pitch']),(36,48,'arcRight','Ascending final arc',['athletics_track','football_pitch'])],beats=[2,38,39.8,44],previews=[0,16,32,48]),
 dict(id='factory-01-production-to-stillness',environment='factory',title='Production to Stillness',tag='Product-led opening / dramatic reveal',
      prompt="Create one continuous 48-second factory sequence that changes from ordered production to quiet aftermath. Start by tracking cargo 01 along the conveyor in a composed product-led view, with the assembly line as background. Between 8 and 16 seconds smoothly leave the product tracking rig and reveal workers A and B in the south aisle; widen the lens gradually during the handoff. Be settled by 16 seconds in a stable elevated view that contains the argument, the shove at 20 seconds, the collision at 21 seconds, and the first falling pieces of cargo. Hold the physical camera still from 16 to 24 seconds so the cause and effect remain easy to read. From 24 to 48 seconds slowly pull back and rise, including the workers' reaction and the stopped production line. Stay inside the factory below its ceiling, preserve the normal scene clock, and use no cuts or camera shake.",
      phases=[(0,8,'track','Conveyor product tracking',['cargo_01']),(8,16,'track','Product-to-workers handoff',[]),(16,24,'static','Locked causal master',['worker_a','worker_b','cargo_06']),(24,48,'craneUp','Pull back into stillness',['worker_a','worker_b'])],beats=[12.2,20,21.5,25],previews=[4,16,21.5,43]),
 dict(id='factory-02-aisle-two-shot',environment='factory',title='The Aisle Two-Shot',tag='Intimate two-shot / anticipatory retreat',
      prompt="Film workers A and B in a restrained, uninterrupted 48-second two-shot in the factory's south aisle. Start in an elevated wide shot that contains both separated workers and looks over the control cabinet. Descend and tighten gradually as they converge, reaching a near-eye-level full two-shot by 12 seconds. Hold a respectful distance through the argument at 12.2–17 seconds. Between 17 and 20 seconds retreat, rise, and widen before the shove: the audience must see both bodies and the space between them. Maintain that more generous view through the impact at 21 seconds and the cargo spill, without whipping the camera toward individual falling items. After 25 seconds drift back into a quiet, wider two-shot of the workers and their immediate surroundings. Keep screen geography consistent from the same side of the aisle, use normal playback, and avoid cuts, shake, and extreme lens distortion.",
      phases=[(0,12,'track','Converging two-shot',['worker_a','worker_b']),(12,17,'follow','Argument at respectful distance',['worker_a','worker_b']),(17,25,'follow','Retreat before the shove',['worker_a','worker_b']),(25,36,'follow','Release into aftermath',['worker_a','worker_b']),(36,48,'static','Quiet final two-shot',['worker_a','worker_b'])],beats=[12.2,19,21,27],previews=[5,15,21,38]),
 dict(id='factory-03-chain-reaction',environment='factory',title='The Chain Reaction',tag='High-angle master / spatial causality',
      prompt="Create a 48-second high-angle, single-take factory master that explains the chain reaction spatially. Begin with a broad interior view of the conveyor and its two end stations. Over the first 14 seconds move closer to an elevated view of the central south-side work area, remaining around 8.1 metres high and below the ceiling and beams. From 14 to 26 seconds lock both camera position and aim. In that frame, show workers A and B, the shove at 20 seconds, the impact and clustered cargo spill at 21 seconds, and the emergency operator near the control station at 21.7 seconds. Prioritize clear spatial relationships over close-ups. After 26 seconds slowly withdraw and drift to the right to reveal the stopped line and the wider response. Use a level horizon, normal speed, gentle lens changes, and no cuts or shake.",
      phases=[(0,14,'dollyIn','Interior geography to causal master',[]),(14,26,'static','Locked high-angle chain reaction',['worker_a','worker_b','cargo_06','worker_05']),(26,48,'dollyOut','Reveal the stopped system',['worker_a','worker_b','worker_05'])],beats=[20,21,21.7,25],previews=[0,15,21.7,42]),
 dict(id='factory-04-emergency-operator',environment='factory',title='The Emergency Operator',tag='Supporting character / response coverage',
      prompt="Make a 48-second factory sequence centred on worker 05, the emergency-stop operator, rather than the arguing pair. Begin from the south-east in a calm three-quarter composition that includes worker 05 and the control station. Push in very gently until 16 seconds, then lock the camera through 24 seconds. Keep a clear oblique view when the worker reaches the station around 21.7 seconds and the production line ramps down by 22.7 seconds; do not invent a close-up button-press animation that the scene does not contain. From 24 to 35 seconds rise and pull back, shifting the composition toward the affected workers and the operator together. Finish with a slow lateral drift through 48 seconds that connects the emergency response to the aftermath. Remain inside the room, avoid hiding the operator behind the control cabinet, preserve normal playback, and use no cuts or shake.",
      phases=[(0,16,'dollyIn','Approach the operator',['worker_05','control_station']),(16,24,'static','Emergency-stop coverage',['worker_05','control_station']),(24,35,'craneUp','Connect operator and aftermath',[]),(35,48,'truckLeft','Response tableau',['worker_a','worker_b','worker_05'])],beats=[20.8,21.7,22.7,28],previews=[8,21.7,29,44]),
 dict(id='factory-05-one-piece',environment='factory',title='One Piece, Many Consequences',tag='Cargo-led story / floor-level aftermath',
      prompt="Tell a 48-second factory story through cargo 06, the sixth piece that spills from the production line. For the first 15 seconds smoothly track this piece with a relatively tight product-led composition; show enough conveyor to establish its movement. Between 15 and 20 seconds rise, move farther out, and widen before the impact. Track the piece through its airborne motion beginning at 21.3 seconds and its bounce and settling, smoothing the camera rather than copying the object's vertical jolt. Keep the production line and fragments of the workers' action as context. Between 26 and 34 seconds make a deliberate smooth handoff to a low oblique, stationary view of the resting piece on the floor. Hold that quiet insert from 34 to 48 seconds while the factory aftermath continues behind it. Use a level horizon, normal scene speed, no cuts, no focus-pull claims, and no camera intersections with the floor, workers, or machinery.",
      phases=[(0,15,'track','Product-led tracking',['cargo_06']),(15,20,'track','Anticipatory lift and widen',['cargo_06']),(20,26,'track','Spill, bounce, and settling',['cargo_06']),(26,34,'track','Handoff to low aftermath insert',['cargo_06']),(34,48,'static','Resting piece, living background',['cargo_06'])],beats=[20,21.7,22.6,34],previews=[5,21.7,23,40]),
]


def compose_rotations(p,aim,fov,screen):
    # Solve world-up yaw/pitch directly: camera-right stays exactly horizontal.
    direction=unit(aim-p)
    tan=np.tan(np.deg2rad(fov)/2)
    ray=unit(np.column_stack([(2*screen[:,0]-1)*tan*ASPECT,(1-2*screen[:,1])*tan,-np.ones(len(p))]))
    amplitude=np.hypot(ray[:,1],ray[:,2])
    pitch=np.arcsin(np.clip(direction[:,1]/amplitude,-1,1))-np.arctan2(ray[:,1],-ray[:,2])
    vz=ray[:,1]*np.sin(pitch)+ray[:,2]*np.cos(pitch)
    yaw=np.arctan2(direction[:,0],direction[:,2])-np.arctan2(ray[:,0],vz)
    zeros=np.zeros(len(p))
    ry=Rotation.from_rotvec(np.column_stack([zeros,yaw,zeros]))
    rx=Rotation.from_rotvec(np.column_stack([pitch,zeros,zeros]))
    q=(ry*rx).as_quat()
    for i in range(1,len(q)):
        if np.dot(q[i-1],q[i])<0:q[i]*=-1
    return q


def rounded(a,n=7):
    return np.round(a,n).tolist()


def target(w,identifier):
    return {'id':identifier,'description':w.entities.get(identifier,w.anchors.get(identifier,{})).get('label',identifier)}


def config(sample):
    return {'type':'nonSubjectAware',
            'extrinsics':{'pose':{'position':dict(zip('xyz',sample['position'])),
                                 'rotation':dict(zip('xyzw',sample['rotation']))}},
            'intrinsics':{'fov':sample['fovYDegrees'],'aspectRatio':ASPECT}}


def csl_for(spec,w,samples):
    actions=[]; storyboard=[]
    for i,(start,end,movement,title,ids) in enumerate(spec['phases']):
        identifier=f"{spec['id']}-shot-{i+1:02d}"
        targets=[target(w,k) for k in ids]
        m={'act':movement,'duration':round(end-start,6),'relativeFPS':'normal'}
        anchored={'track','follow','dollyIn','dollyOut','arcLeft','arcRight','orbit'}
        subjectless={'truckLeft','truckRight','pedestalUp','pedestalDown'}
        movement_ids=ids or (['production_line'] if w.name=='factory' else ['athletics_track'])
        if movement in anchored:m['targets']=[target(w,k) for k in movement_ids]
        elif targets and movement not in subjectless:m['targets']=targets
        if movement!='static': m['parameters']={'path':'spline','handheld':False}
        trigger={'type':'absoluteTime','time':start} if i==0 else {'type':'relativeTime','actionId':actions[-1]['id'],'reference':'end','offset':0}
        constraints=[{'kind':'general','constraint':'noShake','allFrames':True}]
        if ids: constraints.append({'kind':'general','constraint':'keepInFrame','targets':targets,'allFrames':True})
        constraints.append({'config':config(samples[round(end*FPS)]),'allFrames':False,
                            'easing':{'inDuration':min(1.0,(end-start)/4),'curve':'easeInOut'}})
        actions.append({'id':identifier,'name':title,'trigger':trigger,'movement':m,'constraints':constraints})
        storyboard.append({'actionId':identifier,'start':start,'end':end,'title':title,'movement':movement,'primaryTargets':ids})
    first_ids=next((ids for *_,ids in spec['phases'] if ids),[])
    csl={'totalDuration':DURATION,'sections':[{'initCamera':{'targets':[target(w,k) for k in first_ids],'config':config(samples[0])},'actions':actions}]}
    # Explicitly represent concurrent vertical/optical adjustments. No fake "cut" enum.
    overlays=[]
    if spec['id']=='stadium-05-stadium-breathes':
        for action,phase in zip(actions,spec['phases']):
            action['movement']['parameters']={'arcRadius':170,'arcAngle':60*(phase[1]-phase[0])/48,'constantSpeed':True}
        overlays=[(0,12,'craneDown',{'heightChange':9}),(36,48,'craneUp',{'heightChange':15})]
    elif spec['id']=='stadium-01-winners-run':
        overlays=[(0,8,'craneDown',{}),(33,37,'zoomOut',{}),(41,48,'dollyOut',{})]
    elif spec['id']=='stadium-02-fall-and-resolve':
        overlays=[(10,13.5,'dollyOut',{}),(10,13.5,'craneUp',{}),(18.5,24,'dollyIn',{})]
    elif spec['id']=='stadium-04-behind-the-lens':
        overlays=[(34,40,'zoomOut',{})]
    elif spec['id']=='factory-01-production-to-stillness':
        overlays=[(8,16,'zoomOut',{}),(24,48,'dollyOut',{})]
    elif spec['id']=='factory-02-aisle-two-shot':
        overlays=[(0,12,'craneDown',{}),(0,12,'zoomIn',{}),(17,20,'dollyOut',{}),(17,20,'craneUp',{}),(17,20,'zoomOut',{})]
    elif spec['id']=='factory-04-emergency-operator':
        overlays=[(24,35,'dollyOut',{})]
    elif spec['id']=='factory-05-one-piece':
        overlays=[(15,20,'craneUp',{}),(15,20,'zoomOut',{})]
    for j,(start,end,act,params) in enumerate(overlays):
        if act in ('zoomIn','zoomOut'):
            f0=samples[round(start*FPS)]['fovYDegrees']; f1=samples[round(end*FPS)]['fovYDegrees']
            factor=math.tan(math.radians(f1)/2)/math.tan(math.radians(f0)/2)
            params={**params,'zoomFactor':factor if act=='zoomOut' else 1/factor}
        overlay_move={'act':act,'duration':end-start,'parameters':params}
        if act in {'dollyIn','dollyOut','arcLeft','arcRight','orbit','follow','track'}:
            phase_ids=next((ids for a,b,m,n,ids in spec['phases'] if a<=start<b and ids),first_ids)
            overlay_move['targets']=[target(w,k) for k in phase_ids]
        actions.append({'id':f"{spec['id']}-overlay-{j+1:02d}",
                        'name':'Concurrent '+act,'trigger':{'type':'absoluteTime','time':start},
                        'movement':overlay_move})
    return csl,storyboard


def draft_and_binding(csl):
    bindings={}
    def visit(x):
        if isinstance(x,list):return [visit(a) for a in x]
        if isinstance(x,dict):
            if set(x)=={'id','description'}:
                ref='subject_'+x['id'].replace('-','_')
                bindings[ref]=x
                return {'ref':ref,'description':x['description']}
            return {k:visit(v) for k,v in x.items()}
        return x
    return visit(csl),{'schemaVersion':'1.0','bindings':bindings}


def generate(spec,w):
    authored=authored_camera(spec['id'],w)
    splines={k:CubicSpline(GRID,v) for k,v in authored.items()}
    p=splines['p'](SAMPLE_TIMES); aim=splines['aim'](SAMPLE_TIMES); fov=splines['fov'](SAMPLE_TIMES); screen=splines['screen'](SAMPLE_TIMES)
    rotations=compose_rotations(p,aim,fov,screen)
    velocity=splines['p'](SAMPLE_TIMES,1); acceleration=splines['p'](SAMPLE_TIMES,2)
    samples=[]
    for i,t in enumerate(SAMPLE_TIMES):
        phase=next((j for j,(a,b,*_) in enumerate(spec['phases']) if a<=t<b),len(spec['phases'])-1)
        samples.append({'t':round(float(t),8),'position':rounded(p[i]),'positionVelocity':rounded(velocity[i]),
                        'positionAcceleration':rounded(acceleration[i]),'rotation':rounded(rotations[i],10),
                        'lookAt':rounded(aim[i]),'fovYDegrees':round(float(fov[i]),7),
                        'actionId':f"{spec['id']}-shot-{phase+1:02d}"})
    trajectory={'schemaVersion':'1.0','kind':'cameraTrajectory','environmentId':w.name,
                'clock':{'durationSeconds':DURATION,'timeUnit':'second'},'coordinates':w.data['coordinates'],
                'intrinsics':{'projection':'perspective','fovYDegrees':float(fov[0]),'aspectRatio':ASPECT,'near':.05,'far':600},
                'orientation':{'mode':'quaternion'},'interpolation':{'position':'quinticHermite'},
                'playback':{'rateSegments':[{'startTime':0,'endTime':DURATION,'rate':1,'label':'normal'}]},'samples':samples}
    csl,storyboard=csl_for(spec,w,samples); draft,binding=draft_and_binding(csl)
    folder=OUT/spec['id']; folder.mkdir(parents=True,exist_ok=True)
    (folder/'prompt.txt').write_text(spec['prompt']+'\n',encoding='utf-8')
    save(folder/'csl.json',csl);save(folder/'draft-csl.json',draft);save(folder/'binding.json',binding)
    save(PUBLIC/(spec['id']+'-csl.json'),csl)
    save(folder/'trajectory.json',trajectory);save(PUBLIC/(spec['id']+'-camera.json'),trajectory)
    keytimes=sorted(set([0,DURATION,*spec['beats'],*[x[0] for x in spec['phases']],*[x[1] for x in spec['phases']]]))
    save(folder/'keyframes.json',{'note':'Human-readable subset; trajectory.json is the complete replay reference.',
                                 'samples':[samples[round(t*FPS)] for t in keytimes]})
    save(folder/'storyboard.json',{'title':spec['title'],'phases':storyboard,'sceneBeats':spec['beats'],'previewTimes':spec['previews']})
    meta={'schemaVersion':'1.0','kind':'syntheticCameraReferenceMetadata','exampleId':spec['id'],'title':spec['title'],
          'environmentId':w.name,'referenceType':'ai-authored-synthetic-ground-truth',
          'authoringMethod':'AI shot design + deterministic scene-aware camera synthesis; no optimizer or live model API call',
          'measuredGroundTruth':False,'uniqueOrOptimalSolution':False,'durationSeconds':DURATION,'sampleFps':FPS,
          'samples':len(samples),'cutCount':0,'coordinateConvention':w.data['coordinates'],
          'timeConvention':'playback seconds == scene seconds; starts at 0; no retiming',
          'smoothing':'offline symmetric Gaussian target smoothing; 120 Hz cubic construction; 30 Hz camera samples with C2 position jets',
          'sourceEnvironmentSha256':sha(w.path),'sourceGeneratorSha256':sha(__file__),
          'promptSha256':sha(folder/'prompt.txt'),'cslSha256':sha(folder/'csl.json'),'trajectorySha256':sha(folder/'trajectory.json'),
          'evaluationBoundary':'Primary-target framing and geometry are tested separately. Numerical validation is not a pixel-level visibility or artistic-optimality certificate.'}
    save(folder/'metadata.json',meta)
    return {'id':spec['id'],'environmentId':w.name,'title':spec['title'],'style':spec['tag'],'prompt':spec['prompt'],
            'resolvedCsl':csl,'trajectoryUrl':f"/trajectories/cinematic-suite/{spec['id']}-camera.json",
            'durationSeconds':DURATION,'sampleFps':FPS,'sampleCount':len(samples),
            'files':{k:f"{spec['id']}/{v}" for k,v in {'prompt':'prompt.txt','csl':'csl.json','draftCsl':'draft-csl.json','binding':'binding.json','trajectory':'trajectory.json','keyframes':'keyframes.json','storyboard':'storyboard.json','metadata':'metadata.json'}.items()}}


def main():
    worlds={n:World(n) for n in ('stadium','factory')}
    examples=[]
    for spec in SPECS:
        examples.append(generate(spec,worlds[spec['environment']]))
        print('Generated',spec['id'],flush=True)
    save(OUT/'dataset.json',{'schemaVersion':'1.0','kind':'cinematicExampleDataset','referenceType':'synthetic-not-measured',
                            'environmentIds':['stadium','factory'],'examples':examples})
    save(PUBLIC/'catalogue.json',{'examples':[{k:e[k] for k in ('id','title','environmentId','prompt','trajectoryUrl','durationSeconds')} for e in examples]})
    ts='''/** Ten scene-grounded films; environment IDs remain stadium/factory. */\nimport type { ResolvedPromptExampleFixture } from './resolved-example-fixtures';\nimport dataset from '../../examples/cinematic-suite/dataset.json';\nexport const cinematicPromptExampleFixtures = dataset.examples.map(({ id, environmentId, prompt, resolvedCsl }) => ({ id, environmentId, prompt, resolvedCsl })) as ResolvedPromptExampleFixture[];\n'''
    (ROOT/'src/data/cinematic-examples.ts').write_text(ts)
    print('Wrote 10 prompt/CSL/reference pairs; 14,410 samples.',flush=True)


if __name__=='__main__': main()
