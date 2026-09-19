#!/usr/bin/env python3
"""Build the ONLY two scenes. Seeded, analytic motion; no npm/network dependency.
All root motion is baked into standard V1 channels, so Node and WebGL see the
same falls, jumps, goals and falling cargo. This is a staged animation, not a
nondeterministic rigid-body simulation. Run from any working directory.
"""
from __future__ import annotations
import copy, json, math, random, shutil, hashlib, os
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
PUBLIC=ROOT/'web/public'
DURATION=48.0
FPS=12
COORDS={'handedness':'right','upAxis':'+Y','cameraForwardAxis':'-Z','lengthUnit':'meter','rotationOrder':'quaternion-xyzw'}
C={'blue':'#168bcc','red':'#e4493d','yellow':'#ffcf40','green':'#3ca877','white':'#f1eee5','steel':'#35434f','orange':'#ed9a33'}

def smooth(a,b,t):
 u=max(0,min(1,(t-a)/(b-a)))
 return u*u*(3-2*u)
def mix(a,b,u): return [x+(y-x)*u for x,y in zip(a,b)]
def yaw(a): return [0,math.sin(a/2),0,math.cos(a/2)]
def quat(a,b):
 x,y,z,w=a; X,Y,Z,W=b
 return [w*X+x*W+y*Z-z*Y,w*Y-x*Z+y*W+z*X,w*Z+x*Y-y*X+z*W,w*W-x*X-y*Y-z*Z]
def pitch(a): return [math.sin(a/2),0,0,math.cos(a/2)]
def roll(a): return [0,0,math.sin(a/2),math.cos(a/2)]
def rnd(v):
 if isinstance(v,list): return [rnd(x) for x in v]
 return round(v,6)
def channel(fn,extra=(),interp='linear'):
 times=sorted(set([round(i/FPS,6) for i in range(int(DURATION*FPS)+1)]+list(extra)))
 values=[{'t':t,'value':rnd(fn(t))} for t in times]
 # Remove redundant held keys, keeping both ends of each plateau.
 keys=[v for i,v in enumerate(values) if i==0 or i==len(values)-1 or v['value']!=values[i-1]['value'] or v['value']!=values[i+1]['value']]
 return {'interpolation':interp,'extrapolation':'hold','keyframes':keys}
def keychannel(keys,interp='linear'):
 return {'interpolation':interp,'extrapolation':'hold','keyframes':[{'t':t,'value':rnd(v)} for t,v in keys]}
def waypoints(points,t):
 for (ta,a),(tb,b) in zip(points,points[1:]):
  if t<=ta:return a[:]
  if t<=tb:return mix(a,b,smooth(ta,tb,t))
 return points[-1][1][:]
def bounds(size,base=False):
 x,y,z=size
 return {'type':'box','min':[-x/2,0 if base else -y/2,-z/2],'max':[x/2,y if base else y/2,z/2]}
def entity(id,label,pos,visual,size=None,role='prop',support='ground',rotation=None):
 e={'id':id,'label':label,'transform':{'space':'world','position':pos},'visual':visual,'layout':{'role':role,'purpose':label}}
 if support:e['layout']['support']=support
 if rotation:e['transform']['rotation']=rotation
 if size:e['bounds']=bounds(size)
 return e
def box(id,pos,size,color,label=None,role='prop',support='ground'):
 return entity(id,label or id,pos,{'type':'primitive','shape':'box','params':{'size':size},'color':color},size,role,support)
def preset(id,label,pos,name,params,size=None,**kw):
 return entity(id,label,pos,{'type':'preset','name':name,'params':params},size,**kw)
def clip(action,start,end,blend=.2,intensity=1):
 return {'action':action,'start':start,'end':end,'blend':blend,'intensity':intensity}
def human(id,label,pos,color,role='worker',detail='hero',rotation=None,number=0):
 params={'height':1.83,'radius':.32,'shirtColor':color,'trouserColor':'#24364a','color':['#bb8260','#edc4a4','#704d39','#d49c78'][number%4],
         'outfit':'sports' if role in ('runner','football') else 'worker' if role=='worker' else 'casual','role':role,'detail':detail,'number':number,'facing':'authored'}
 e=preset(id,label,pos,'humanoid',params,rotation=rotation or yaw(0),role='subject')
 e['bounds']=bounds([.66,1.87,.6],True)
 return e
def event(id,label,time,subjects,type=None,end=None):
 e={'id':id,'label':label,'type':type or id,'time':time,'subjects':subjects}
 if end is not None:e['endTime']=end
 return e
def scene(id,prompt,profile,ground,overview):
 return {'schemaVersion':'1.0','kind':'environment','id':id,'promptExampleId':id,'prompt':prompt,
         'clock':{'durationSeconds':DURATION,'timeDomain':'playback','fpsHint':30},'coordinates':COORDS,
         'evaluation':{'distanceMetric':'boundsSurface','epsilon':.001},
         'world':{'background':'#b7d3df' if profile=='daylight' else '#aab4ba','profile':profile,'exposure':1.12,'ground':ground,'overviewCamera':overview},
         'entities':[],'semanticAnchors':[],'events':[]}
def anchors(env):
 ids={a['id'] for a in env['semanticAnchors']}
 for e in env['entities']:
  if e['visual']['type']=='preset' and e['visual']['name']=='humanoid':
   aid=e['id']+'_face'
   if aid not in ids: env['semanticAnchors'].append({'id':aid,'entityId':e['id'],'label':e['label']+' · صورت / face','localAnchor':[0,1.7,.08],'localBounds':{'type':'sphere','center':[0,1.7,.04],'radius':.16}})

def track_point(distance,r):
 """Clockwise stadium path; two 92 m straights, two semicircles."""
 straight=92; arc=math.pi*r; length=2*straight+2*arc;s=distance%length
 if s<straight:return [-46+s,0,r],math.pi/2
 s-=straight
 if s<arc:
  a=math.pi/2-s/r
  return [46+r*math.cos(a),0,r*math.sin(a)],math.pi-a
 s-=arc
 if s<straight:return [46-s,0,-r],-math.pi/2
 s-=straight;a=-math.pi/2-s/r
 return [-46+r*math.cos(a),0,r*math.sin(a)],math.pi-a

def stadium():
 prompt='در ۴۸ ثانیه، مسابقهٔ ۶ دونده را در پیست دور زمین فوتبال دنبال کن؛ زمین‌خوردن دوندهٔ سوم را نشان بده، سپس عبور دوندهٔ اول از خط پایان، گل هم‌زمان تیم قرمز، پرش برنده و گل‌افشانی تماشاچی‌ها را ثبت کن. فیلم‌بردار کنار پیست یک شخصیت صحنه است، نه دوربین اصلی.'
 env=scene('stadium',prompt,'daylight',{'y':-.07,'size':[198,126],'color':'#395f43','surface':'grass','continuation':'none','details':'authored'}, {'position':[129,114,137],'target':[0,0,0]})
 E=env['entities']
 E.append(preset('athletics_track','پیست ۶ خط دومیدانی / six-lane athletics track',[0,0,0],'stadiumTrack',{'halfStraight':46,'innerRadius':33,'lanes':6,'laneWidth':1.22},[173,.04,81],role='paving'))
 E[-1]['bounds']['min'][1]=-.045;E[-1]['bounds']['max'][1]=-.005
 E.append(box('football_pitch',[0,-.025,0],[92,.045,52],'#397e4b','زمین فوتبال داخل پیست / infield pitch',role='paving'))
 for i in range(12): E.append(box(f'pitch-stripe-{i}',[-42.1667+i*7.6667,.0005,0],[7.6667,.002,52],'#3e8650' if i%2 else '#357647',role='marking'))
 def line(id,p,sz):E.append(box(id,p,sz,'#f1efe3',role='marking'))
 for z in [-26,26]:line(f'touchline-{z}',[0,.009,z],[92,.012,.13])
 for x in [-46,0,46]:line(f'pitch-crossline-{x}',[x,.009,0],[.13,.012,52])
 for side in [-1,1]:
  for x,z,sz in [(side*29.5,0,[.12,.012,33]),(side*37.75,-16.5,[16.5,.012,.12]),(side*37.75,16.5,[16.5,.012,.12]),(side*40.5,0,[.12,.012,18.3]),(side*43.25,-9.15,[5.5,.012,.12]),(side*43.25,9.15,[5.5,.012,.12])]:line(f'penalty-line-{len(E)}',[x,.01,z],sz)
  goal=preset('goal_east' if side==1 else 'goal_west','دروازهٔ شرقی / east goal' if side==1 else 'دروازهٔ غربی / west goal',[side*46,0,0],'soccerGoal',{'width':7.32,'height':2.44,'depth':2},rotation=yaw(-side*math.pi/2))
  goal['bounds']={'type':'box','min':[-3.73,0,-2.05],'max':[3.73,2.53,.1]}
  goal['occlusion']={'bounds':[bounds([.1,2.5,.1]),{'type':'box','min':[-3.71,0,-.05],'max':[-3.61,2.5,.05]},{'type':'box','min':[3.61,0,-.05],'max':[3.71,2.5,.05]},{'type':'box','min':[-3.66,2.39,-.05],'max':[3.66,2.49,.05]}][1:]}
  E.append(goal)
 # Flat torus circle: geometry is in XY before rotation.
 circle=entity('pitch-center-circle','دایره وسط زمین',[0,.017,0],{'type':'primitive','shape':'torus','params':{'radius':9.15,'tube':.065,'tubularSegments':100},'color':'#f1efe3'},rotation=pitch(-math.pi/2),role='marking')
 E.append(circle)
 E.append(entity('center-spot','نقطه وسط زمین',[0,.012,0],{'type':'primitive','shape':'cylinder','params':{'radius':.2,'height':.02},'color':'#f1efe3'},role='marking'))
 # Six runners, visibly different speed curves, independent of the camera.
 runners=[];sample_times=[i/FPS for i in range(int(DURATION*FPS)+1)]
 finish_times=[38,39.25,44.8,40.6,42.0,43.1]
 for i,finish in enumerate(finish_times):
  r=33+(i+.5)*1.22;start=82-200
  def speed(t,i=i,finish=finish):
   if t<=2 or t>=finish:return 0
   v=5.2+.8*math.sin(t*.63+i*1.2)+.55*math.sin(t*.24+i)+1.1*smooth(29,34,t)
   if i==2:v*=1-.96*smooth(13.6,14.3,t)*(1-smooth(16.6,18.3,t))
   return max(.05,v)*smooth(2,3.2,t)*(1-.5*smooth(finish-.6,finish,t))
  count=int(math.ceil(finish*60));times=sorted(set([2,finish]+[j/60 for j in range(count+1) if 2<j/60<finish]));acc=[0]
  for a,b in zip(times,times[1:]):acc.append(acc[-1]+(speed(a)+speed(b))*.5*(b-a))
  total=acc[-1]
  def progress(t,times=times,acc=acc,total=total,finish=finish):
   if t<=2:return 0
   if t>=finish:return 200+2.3*smooth(finish,finish+1.2,t)
   import bisect
   k=bisect.bisect_right(times,t)-1;u=(t-times[k])/(times[k+1]-times[k]);return 200*(acc[k]+u*(acc[k+1]-acc[k]))/total
  def pos(t,progress=progress,r=r,i=i):
   p,_=track_point(start+progress(t),r)
   if i==2:p[1]=.18*smooth(13.7,14.4,t)*(1-smooth(16.6,17.8,t))
   if i==0:p[1]+=.84*math.sin(math.pi*max(0,min(1,(t-39.3)/1.0))) if 39.3<t<40.3 else 0
   return p
  def rot(t,progress=progress,r=r,i=i):
   _,a=track_point(start+progress(t),r)
   tilt=1.39*smooth(13.7,14.4,t)*(1-smooth(16.6,17.8,t)) if i==2 else 0
   # Winner faces the nearby crowd after stopping.
   if i==0:a+=(0-a)*smooth(39.4,40.8,t)
   return quat(yaw(a),pitch(tilt))
  h=human(f'runner_{i+1:02d}',f'دوندهٔ {i+1}'+(' · برنده / winner' if i==0 else ' · زمین‌خورده / falls and recovers' if i==2 else ''),channel(pos,[2,13.7,14.4,16.6,17.8,finish,39.3,39.8,40.3]),[C['red'],C['blue'],C['yellow'],C['green'],'#ba70d1','#f17b43'][i],'runner',number=i+1)
  h['transform']['rotation']=channel(rot,[2,13.7,14.4,16.6,17.8,finish],interp='slerp')
  h['performance']=[clip('ready',0,2.1)]
  if i==2:h['performance'] +=[clip('fall',13.7,16.8,.18),clip('recover',16.8,18,.2)]
  if i==0:h['performance'] +=[clip('celebrate',38.9,48,.4)]
  E.append(h);runners.append((pos,rot,progress,r))
  p,a=track_point(start,r)
  mark=box(f'start-lane-{i+1}',[p[0],.025,p[2]],[1.1,.016,.15],C['white'],f'خط شروع لاین {i+1}',role='marking')
  mark['transform']['rotation']=yaw(a);E.append(mark)
  line(f'finish-lane-{i+1}',[36,.027,r],[.24,.02,1.18])
 # In-world operator has a physical shoulder camera and stays outside every racing lane.
 winner_pos,winner_rot,progress,r=runners[0]
 def camera_pos(t):
  p,a=track_point(start+progress(t),r);out=[math.sin(a-math.pi/2),0,math.cos(a-math.pi/2)]
  return [p[0]+out[0]*8.6,0,p[2]+out[2]*8.6]
 def camera_rot(t):
  _,a=track_point(start+progress(t),r);return yaw(a)
 camera_man=human('track_cameraman','فیلم‌بردار کنار پیست · دوربین اصلی نیست / independent sideline camera operator',channel(camera_pos), '#273444','cameraman',rotation=channel(camera_rot,interp='slerp'))
 camera_man['performance']=[clip('film',0,48,0)];E.append(camera_man)
 # Front and rear grandstands, 72 occupied seats. Crowd is a lightweight rig.
 spectators=[]
 for side in [-1,1]:
  for row in range(3):
   y=.36+row*.6;z=side*(45+row*1.7)
   support=f'grandstand-{side}-{row}'
   E.append(box(support,[0,y/2,z],[105,y,1.72],'#aab6be','سکوی تماشاچی‌ها / concrete grandstand',role='landing'))
   for j in range(12):
    x=-48+j*8.5
    seat=f'seat-{side}-{row}-{j}';E.append(box(seat,[x,y+.42,z],[.72,.13,.7],C['blue'] if (j+row)%2 else '#f1bb40','صندلی تماشاچی',role='furniture',support=support))
    E.append(box(seat+'-back',[x,y+.72,z+side*.31],[.72,.62,.1],C['blue'] if (j+row)%2 else '#f1bb40',role='furniture',support=seat))
    sid=f'spectator_{len(spectators)+1:03d}'
    h=human(sid,f'تماشاچی روی سکو {len(spectators)+1}',[x,y,z],['#d35345','#e7b73a','#4e88ba','#c7c5b9','#515b7b'][j%5],'spectator','crowd',rotation=yaw(math.pi if side==1 else 0),number=j+row)
    h['layout']['support']=support
    h['performance']=[clip('sit',0,38.2,.1),clip('cheer',38,48,.3)]
    E.append(h);spectators.append((h,[x,y,z]))
  # Back rails, stairs and club banners.
  for j in range(11):
   x=-52.5+j*10.5;E.append(box(f'stand-railing-post-{side}-{j}',[x,2.35,side*50.1],[.09,1.6,.09],'#596775',role='railing'))
  E.append(box(f'stand-railing-{side}',[0,3.12,side*50.1],[105,.08,.08],'#596775',role='railing'))
  for k in range(5):E.append(box(f'stand-step-{side}-{k}',[54.2,.18*(k+1)/2,side*(44+k*.7)],[2,.18*(k+1),.72],'#b9c0c3',role='stair'))
 # Visible finish arch, finish ribbon, and BOTH start and finish flag pairs.
 for z in [32.1,41.2]:E.append(box(f'finish-post-{z}',[36,2.1,z],[.13,4.2,.13],'#e7edf0'))
 E.append(box('finish-header',[36,4.23,36.65],[.22,.44,9.3],'#253e58','FINISH / خط پایان'))
 E[-1]['layout']['sign']='FINISH'
 ribbon=box('finish-ribbon',[36,1,36.7],[.028,.12,7.4],C['white'],'نوار خط پایان / finish tape')
 ribbon['transform']['scale']=keychannel([(0,[1,1,1]),(37.99,[1,1,1]),(38.2,[1,1,.025]),(48,[1,1,.025])]);E.append(ribbon)
 p,a=track_point(start,36)
 for i,(x,z,kind) in enumerate([(p[0]-2,p[2]-6,'START'),(p[0]+2,p[2]+6,'START'),(36,42.7,'FINISH'),(36,31.4,'FINISH')]):
  E.append(preset(f'race-flag-{i+1}',f'پرچم {kind}',[x,0,z],'raceFlag',{'label':kind,'color':'#50c89a' if kind=='START' else '#f5e8c9','phase':i},[1.9,3.4,.16]))
 for i in range(2):
  h=human(f'marshal_{i+1}', 'داور شروع مسابقه' if i==0 else 'داور خط پایان',[p[0]-3,0,p[2]-5] if i==0 else [36,0,42.5], '#eeeeea','marshal','support',number=i)
  h['performance']=[clip('cheer',1.7,3,.2)] if i==0 else [clip('cheer',38,41,.2)];E.append(h)
 # Precisely 24 players: 12 per team as requested (not a standard 11-a-side match).
 ball_points=[(0,[-20,.22,7]),(4,[-8,.22,12]),(8,[5,.22,16]),(12,[-3,.22,-7]),(17,[12,.22,-15]),(22,[1,.22,-3]),(27,[14,.22,8]),(31,[20,.22,16]),(34,[25,.22,7]),(36.8,[28,.22,2]),(38.2,[46.23,1.05,.7]),(38.48,[47.75,.75,.55]),(39.3,[47.22,.22,.6]),(48,[47.22,.22,.6])]
 def ballpos(t):
  for (a,p),(b,q) in zip(ball_points,ball_points[1:]):
   if a<=t<=b:
    u=(t-a)/(b-a);v=mix(p,q,u)
    if b<=36.8:v[1]+=.28*math.sin(math.pi*u)
    if a==36.8:v[1]+=1.0*math.sin(math.pi*u)
    return v
  return ball_points[-1][1]
 ball=preset('ball','توپ فوتبال؛ گل در ثانیه ۳۸٫۲ / football goal at 38.2 s',channel(ballpos,[p[0] for p in ball_points]),'soccerBall',{'radius':.22})
 ball['bounds']={'type':'sphere','center':[0,0,0],'radius':.22};ball['transform']['rotation']=channel(lambda t:quat(roll(t*3.8),yaw(t*.9)),interp='slerp');E.append(ball)
 for team in range(2):
  for j in range(12):
   side=-1 if team==0 else 1;bx=side*(38 if j==0 else 24-(j%4)*13);bz=0 if j==0 else -20+(j//4)*19+(j%2)*4
   def playerpos(t,j=j,team=team,bx=bx,bz=bz):
    if j==9 and team==0:
     return waypoints([(0,[4,0,3]),(10,[2,0,13]),(20,[12,0,-3]),(30,[21,0,10]),(36.65,[27.5,0,1.7]),(37.2,[28.4,0,1.8]),(40,[34,0,4]),(48,[35,0,4])],t)
    if j==0:
     p=[(-43 if team==0 else 43),0,1.8*math.sin(t*.39+team)]
     if team==1:
      u=smooth(37.3,38.25,t);p[2]=p[2]*(1-u)+(-2.2)*u;p[1]=.17*math.sin(math.pi*smooth(37.3,38.5,t))
     return p
    tt=min(t,38.2);return [max(-40,min(40,bx+4.5*math.sin(tt*.22+j*.8)+tt*.16*(1 if team==0 else -1))),0,max(-23,min(23,bz+2.8*math.sin(tt*.31+j*.7+team)))]
   def playerrot(t,pos=playerpos,j=j,team=team):
    p=pos(t)
    if j==0:
     return quat(yaw(math.pi/2 if team==0 else -math.pi/2),roll((1.35*smooth(37.4,38.2,t)*(1-smooth(40,42,t))) if team==1 else 0))
    if t>=38.2:return yaw(math.pi/2 if team==0 else -math.pi/2)
    q=ballpos(t) if j==9 and team==0 and t>36 else pos(t+.05)
    return yaw(math.atan2(q[0]-p[0],q[2]-p[2]))
   h=human(f'football_{"red" if team==0 else "blue"}_{j+1:02d}',f'بازیکن {j+1} تیم {"قرمز" if team==0 else "آبی"}'+(' · دروازه‌بان / goalkeeper' if j==0 else ' · گل‌زن / scorer' if j==9 and team==0 else ''),channel(playerpos,[36.65,37.2,38.2]), '#f3c446' if j==0 else C['red'] if team==0 else C['blue'],'football','hero' if j==9 and team==0 else 'support',rotation=channel(playerrot,[38.2],interp='slerp'),number=j+1)
   h['visual']['params']['team']='red' if team==0 else 'blue';h['visual']['params']['goalkeeper']=j==0
   h['performance']=[clip('celebrate',38.4,48,.5)] if team==0 else []
   if j==9 and team==0:h['performance'].insert(0,clip('kick',36.45,37.15,.1))
   if j==0 and team==1:h['performance'].append(clip('dive',37.35,41.9,.3))
   E.append(h)
 # Flowers visibly depart the front grandstand, arc toward the winning runner, land and remain.
 throwers=sorted([(h,p) for h,p in spectators if p[2]>0],key=lambda hp:abs(hp[1][0]-38)+2*(hp[1][2]-45))[:9]
 for i,(h,p) in enumerate(throwers):
  release=39.4+i*.25;h['performance'].append(clip('throw',release-.65,release+.45,.13))
  for k in range(3):
   rng=random.Random(702+i*31+k);startp=[p[0]+.15*(k-1),p[1]+1.52,p[2]-.65]
   endp=[38.0+rng.uniform(-2.2,2.2),.095,34.7+rng.uniform(-1.9,2)]
   duration=1.25+abs(p[2]-35)*.027;throwtime=release+k*.065
   def flowerpos(t,a=startp,b=endp,t0=throwtime,d=duration):
    if t<=t0:return a
    if t>=t0+d:return b
    u=(t-t0)/d;q=mix(a,b,u);q[1]+=4*2.6*u*(1-u);return q
   f=preset(f'flower_{i*3+k+1:02d}',f'گل پرتاب‌شده از {h["id"]} به سوی برنده',channel(flowerpos,[throwtime,throwtime+duration]),'flower',{'color':['#f56388','#f5da5a','#e5d8f8'][k]},[.25,.12,.4],support=None)
   f['transform']['rotation']=channel(lambda t,t0=throwtime,d=duration:quat(yaw(max(0,min(d,t-t0))*4),pitch(math.pi/2)),[throwtime,throwtime+duration],interp='slerp');E.append(f)
 for side in [-1,1]:
  E.append(preset(f'stadium-scoreboard-{side}','تابلوی نتیجه فوتبال و مسابقه',[side*73,7,0],'scoreboard',{'kind':'stadium','width':10,'height':4,'goalTime':38.2},[10,4,.3],rotation=yaw(-side*math.pi/2)))
  for z in [-3,3]:E.append(box(f'scoreboard-post-{side}-{z}',[side*73,3.5,z],[.2,7,.2],C['steel']))
 for x in [-62,62]:
  for z in [-53,53]:
   E.append(box(f'light-pole-{x}-{z}',[x,11,z],[.25,22,.25],C['steel']))
   for n in range(3):E.append(box(f'floodlight-{x}-{z}-{n}',[x+(n-1)*.9,22,z],[.8,.5,.35],'#f4e8c4'))
 env['events']=[event('race_start','شروع مسابقه',2,[f'runner_{i+1:02d}' for i in range(6)]),event('runner_fall','زمین‌خوردن دوندهٔ سوم',13.7,['runner_03'],end=16.8),event('runner_recovery','بلندشدن و ادامهٔ مسابقه',16.8,['runner_03'],end=18),event('winner_finish','عبور برنده از خط پایان',38,['runner_01','finish-ribbon']),event('football_goal','گل تیم قرمز، هم‌زمان با پایان دو',38.2,['ball','goal_east','football_red_10']),event('winner_jump','پرش شادی برنده',39.3,['runner_01'],end=40.3),event('flower_shower','پرتاب گل از روی سکوها',39.4,['runner_01']+[h['id'] for h,_ in throwers],end=44.5)]
 anchors(env);return env,runners

def factory():
 base=json.loads((ROOT/'scripts/scene-layouts/factory-shell.json').read_text())
 prompt='در ۴۸ ثانیه کارخانهٔ فعال را معرفی کن، حرکت قطعات روی ریل تولید و کار کارگران را دنبال کن، سپس مشاجرهٔ دو کارگر و هل‌دادن یکی به خط تولید در ثانیهٔ ۲۱ را نشان بده؛ ریزش وسایل، توقف اضطراری و واکنش همکاران را ثبت کن.'
 env=scene('factory',prompt,'industrial',base['world']['ground'],{'position':[37,30,40],'target':[0,1.2,1]})
 # Retain the existing factory shell, shelving, mezzanine and access stairs.
 keep=[]
 for e in base['entities']:
  visual=e['visual'];is_human=visual['type']=='preset' and visual.get('name')=='humanoid'
  if is_human or e['id'] in ('central_machine',):continue
  if not isinstance(e['transform']['position'],list):continue
  keep.append(copy.deepcopy(e))
 env['entities']=keep;ids={e['id'] for e in keep}
 env['semanticAnchors']=[copy.deepcopy(a) for a in base['semanticAnchors'] if a['entityId'] in ids]
 E=env['entities']
 # Free central work aisle. Existing perimeter dressing is kept outside the production envelope.
 E[:]=[e for e in E if not (e['id'].startswith('set-') and e.get('layout',{}).get('role') in ('prop','furniture') and abs(e['transform']['position'][0])<14 and -4<e['transform']['position'][2]<5)]
 ids={e['id'] for e in E};env['semanticAnchors']=[a for a in env['semanticAnchors'] if a['entityId'] in ids]
 # Any support of a removed decorative object is restored to the structural floor.
 for e in E:
  if e.get('layout',{}).get('support') not in ids|{'ground',None}:e['layout']['support']='ground'
 line=preset('production_line','ریل خط تولید فعال / active production conveyor',[0,0,0],'productionLine',{'length':28,'width':1.8,'height':1.05,'speed':.55,'stopTime':21.7},[28,1.2,2],support='arch-warehouse-slab')
 line['bounds']={'type':'box','min':[-14,0,-1],'max':[14,1.22,1]};E.append(line)
 for x in [-14.1,14.1]:
  E.append(box(f'machine-housing-{x}',[x,1.35,0],[2.6,2.7,3.4], '#617f89','پرس ورودی / بسته‌بندی خروجی',support='arch-warehouse-slab'))
  E.append(box(f'machine-window-{x}',[x,1.65,1.715],[1.35,.55,.035],'#173341','پنجرهٔ ماشین'))
  E.append(box(f'machine-sign-{x}',[x,2.4,1.73],[1.8,.22,.04],'#efce45','تابلوی ایستگاه'))
  E[-1]['layout']['sign']='IN / PRESS' if x<0 else 'OUT / PACK'
 for i,x in enumerate([-8,0,8]):
  robot=preset(f'robot_{i+1}','بازوی مونتاژ خودکار / assembly robot',[x,0,-2.9],'industrialRobot',{'phase':i*1.4,'stopTime':21.7},[2.7,3.7,3.8],support='arch-warehouse-slab');E.append(robot)
  E.append(box(f'robot-safety-pad-{i}',[x,.009,-2.9],[4,.012,3.4],'#94772f','محدوده ایمنی بازوی مونتاژ',role='marking'))
 for side in [-1,1]:
  for i in range(14):E.append(box(f'floor-safety-stripe-{side}-{i}',[-13+i*2,.016,side*4.8],[1.1,.015,.13],'#e9b83d','خط راهروی ایمن',role='marking'))
 E.append(box('control_station',[5,1,3.9],[.8,2,.55],'#3b647b','کنترل تولید / emergency stop station',support='arch-warehouse-slab'))
 E.append(preset('line-status','تابلوی وضعیت خط تولید',[0,5,-8],'scoreboard',{'kind':'factory','width':7,'height':2.2,'stopTime':21.7},[7,2.2,.25]))
 # Named pair approaches in the clear south aisle, argues, shoves, then contacts the south rail.
 pa=[(0,[-7,0,3.1]),(8,[-2.6,0,3.1]),(13,[-.5,0,3]),(18,[-.15,0,2.9]),(20,[.15,0,2.85]),(21,[.9,0,2.3]),(23,[1.25,0,2.7]),(30,[2.3,0,3.15]),(48,[2.3,0,3.15])]
 pb=[(0,[7,0,3.3]),(9,[3.1,0,3.3]),(13,[1.15,0,3.0]),(18,[1,0,2.75]),(20,[1.1,0,2.55]),(21,[1.65,.12,1.17]),(21.8,[2.15,.12,1.12]),(24,[2.45,0,2.4]),(30,[3.2,0,3.1]),(48,[3.2,0,3.1])]
 for name,points,col in [('a',pa,'#e8a539'),('b',pb,'#3d8fac')]:
  def pos(t,points=points):return waypoints(points,t)
  def rot(t,points=points,name=name):
   p=pos(t,points);q=waypoints(pb if name=='a' else pa,t)
   a=math.atan2(q[0]-p[0],q[2]-p[2]);tilt=-.72*smooth(20,21,t)*(1-smooth(22.5,24,t)) if name=='b' else 0
   return quat(yaw(a),pitch(tilt))
  h=human('worker_'+name,'کارگر الف / worker A — initiates shove' if name=='a' else 'کارگر ب / worker B — collides with production line',channel(pos,[t for t,_ in points]),col,rotation=channel(rot,[20,21,21.8,24],interp='slerp'),number=1 if name=='a' else 2)
  h['performance']=[clip('work',0,5,.3),clip('argue',12.2,20.25,.3),clip('shove' if name=='a' else 'recoil',20,22.8,.18),clip('recover',22.8,25,.4)]
  E.append(h)
 for i,(x,z) in enumerate([(-9,2.4),(-4,-4.8),(6,2.5),(10,-4.8),(-11,6.8),(12,7.2)]):
  def wpos(t,i=i,x=x,z=z):
   if i==2:return waypoints([(0,[x,0,z]),(20.8,[x,0,z]),(21.7,[5.1,0,3.2]),(24,[5.1,0,3.2]),(28,[4.2,0,3.4]),(48,[4.2,0,3.4])],t)
   if i==4:return waypoints([(0,[x,0,z]),(21.5,[x,0,z]),(28,[-1.5,0,4.2]),(48,[-1.5,0,4.2])],t)
   return [x,0,z]
  h=human(f'worker_{i+3:02d}',f'کارگر خط تولید {i+3}'+(' · توقف اضطراری / emergency stop' if i==2 else ''),channel(wpos,[21.7]),'#db943a' if i%2 else '#4683a0',rotation=yaw(math.pi if z>0 else 0),number=i+3)
  h['performance']=[clip('work',0,21.7,.1),clip('argue',22,27,.4,intensity=.4),clip('work',29,48,.8,intensity=.35)]
  E.append(h)
 def belt_distance(t):
  if t<=21.7:return .55*t
  d=min(1,t-21.7);return .55*21.7+.55*(d-.5*d*d)
 # Twelve independently addressable cargo pieces, six of which spill causally on impact.
 for i in range(12):
  x0=-12.3+i*1.92;impact=21+i*.06
  spill=i in range(6);impactx=x0+belt_distance(impact)
  # items 0..5 are clustered at the contact station by impact; all start on the belt.
  if spill:x0=-11.1+i*.8;impactx=x0+belt_distance(impact)
  size=[.6,.52,.54] if i%3!=1 else [.46,.7,.46];floor=size[1]/2
  def cargopos(t,x0=x0,spill=spill,i=i,impact=impact,impactx=impactx,floor=floor):
   if not spill or t<impact:
    # Non-spill articles remain on the stopped rail; no teleports at its ends.
    return [x0+belt_distance(t),1.05+floor,(-.26 if i%2 else .25)]
   d=t-impact;u=max(0,min(1,d/1.05));endx=impactx+.8+(.22*i);endz=2.5+.32*(i%3)
   if d<1.05:return [impactx+(endx-impactx)*u, (1.05+floor)*(1-u)+floor*u+2.0*math.sin(math.pi*u),(-.26 if i%2 else .25)+(endz-(-.26 if i%2 else .25))*u]
   bounce=.26*math.exp(-4*(d-1.05))*abs(math.sin(11*(d-1.05))) if d<2.8 else 0
   return [endx+.22*(1-math.exp(-3*(d-1.05))),floor+bounce,endz+.23*(1-math.exp(-3*(d-1.05)))]
  if i%3==1:
   v={'type':'primitive','shape':'cylinder','params':{'radius':.23,'height':.7},'color':'#99b2bc'}
  else:v={'type':'primitive','shape':'box','params':{'size':size},'color':['#d28e35','#8aabb7','#438b9c'][i%3]}
  e=entity(f'cargo_{i+1:02d}',f'قطعهٔ تولید {i+1}'+(' · سقوط از خط / spills on impact' if spill else ''),channel(cargopos,[impact,impact+1.05,impact+2.8,21.7,22.7]),v,size,support=None if spill else 'production_line')
  def cargo_rot(t,t0=impact,spill=spill,i=i):
   d=max(0,t-t0);u=min(1,d/1.05)
   return quat(yaw((i*.35+u*2) if spill else i*.35),roll(math.sin(math.pi*u)*2.3 if spill else 0))
  e['transform']['rotation']=channel(cargo_rot,[impact,impact+1.05],interp='slerp')
  if not spill:
   # Articles disappear only inside the opaque output housing, without teleporting.
   e['transform']['scale']=channel(lambda t,x0=x0:[max(.001,1-smooth(12.55,13.2,x0+belt_distance(t)))]*3,[21.7,22.7])
  E.append(e)
 env['events']=[event('production_running','تولید و کار کارگران',0,['production_line','robot_1','cargo_01'],end=12),event('workers_argument','مشاجرهٔ دو کارگر',12.2,['worker_a','worker_b'],end=20),event('worker_shove','هل‌دادن کارگر ب',20,['worker_a','worker_b'],end=21),event('line_collision','برخورد به ریل خط تولید',21,['worker_b','production_line']),event('cargo_spill','ریزش قطعات روی زمین',21,['cargo_%02d'%(i+1) for i in range(6)],end=24.1),event('emergency_stop','توقف اضطراری خط',21.7,['production_line','worker_05','control_station'],end=22.7),event('workers_response','واکنش و رسیدگی همکاران',25,['worker_a','worker_b','worker_07'],end=48)]
 anchors(env);return env

def trajectory(env,runners=None):
 # Authored references use explicit cuts; scene time is never reset between shots.
 factory_points=[(0,[16,7.5,17],[0,1,0],55),(6,[-9,4,8],[-8,1.1,0],52),(11,[-3,3.5,8],[-1,1.2,2.8],53),
   (17,[1,3.1,8.1],[.4,1.3,2.8],52),(20,[4.7,3.0,7.3],[1,1.2,2.5],57),
   (21.4,[5.2,3.1,6.6],[2.2,1.3,1.4],60),(24,[6,3.6,7.7],[3,1,2],59),
   (29,[8,5.5,10],[3,1,2],55),(40,[10,7,13],[1,1.2,0],56),(48,[15,8,17],[0,1,0],56)]
 def sample(t):
  cut=False
  if runners:
   winner=runners[0][0](t);fallen=runners[2][0](t)
   fall_weight=smooth(12.3,13.7,t)*(1-smooth(17,19.3,t))
   focus=mix(winner,fallen,fall_weight)
   # The outward normal follows the same oval as the runners. No rig handoff jumps.
   rotation=runners[0][1](min(t,38.5));angle=2*math.atan2(rotation[1],rotation[3])
   outward=[math.sin(angle-math.pi/2),0,math.cos(angle-math.pi/2)]
   tangent=[math.sin(angle),0,math.cos(angle)]
   follow=[focus[k]+outward[k]*11-tangent[k]*5 for k in range(3)];follow[1]=5.2
   aim=[focus[0],focus[1]+1.0,focus[2]]
   intro=smooth(0,4,t);pos=mix([40,62,94],follow,intro);look=mix([0,0,0],aim,intro);fov=57-4*intro
   settle=smooth(33,36.8,t);pos=mix(pos,[43,6.3,46],settle)
   if 38.1<=t<39.1:
    pos=[35,7,14];look=[46,1,0];fov=45;cut=abs(t-38.1)<1e-6
   elif t>=39.1:
    u=smooth(39.1,43,t);pos=mix([43,4,41],[33,4.6,42],u);look=[winner[0],winner[1]+1.1,winner[2]];fov=55
    pull=smooth(43,48,t);pos=mix(pos,[52,22,64],pull);look=mix(look,[35,1,27],pull)
    cut=abs(t-39.1)<1e-6
  else:
   for a,b in zip(factory_points,factory_points[1:]):
    if a[0]<=t<=b[0]:
     u=smooth(a[0],b[0],t);pos=mix(a[1],b[1],u);look=mix(a[2],b[2],u);fov=a[3]+(b[3]-a[3])*u;break
   else:raise ValueError(t)
  result={'t':round(t,6),'position':rnd(pos),'lookAt':rnd(look),'fovYDegrees':round(fov,4)}
  if cut:result['cutBefore']=True
  return result
 return {'schemaVersion':'1.0','kind':'cameraTrajectory','environmentId':env['id'],'clock':{'durationSeconds':DURATION,'timeUnit':'second'},'coordinates':COORDS,'intrinsics':{'projection':'perspective','fovYDegrees':55,'aspectRatio':16/9,'near':.05,'far':500},'orientation':{'mode':'perSampleLookAt','up':[0,1,0]},'samples':[sample(i/30) for i in range(int(DURATION*30)+1)]}

def write(path,data):
 path.parent.mkdir(parents=True,exist_ok=True)
 temporary=path.with_name('.'+path.name+f'.{os.getpid()}.tmp')
 try:
  temporary.write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
  os.replace(temporary,path)
 finally:
  if temporary.exists():temporary.unlink()
def main():
 env1,runners=stadium();env2=factory();entries=[]
 for dirname in ['environments','trajectories/ai-generated','trajectories/reference-metadata']:
  directory=PUBLIC/dirname;directory.mkdir(parents=True,exist_ok=True)
  retained=({'stadium.json','factory.json','manifest.json'} if dirname=='environments' else
            {'stadium-camera.json','factory-camera.json'} if dirname=='trajectories/ai-generated' else {'stadium.json','factory.json'})
  for f in directory.glob('*.json'):
   if f.name not in retained:f.unlink()
 # Drop stale camera paths for deleted environments, never replay them as fallbacks.
 opt=PUBLIC/'trajectories/optimized'
 if opt.exists():
  for f in opt.glob('example-*.json'):f.unlink()
 for env,rs in [(env1,runners),(env2,None)]:
  eid=env['id'];write(PUBLIC/f'environments/{eid}.json',env);traj=trajectory(env,rs);write(PUBLIC/f'trajectories/ai-generated/{eid}-camera.json',traj)
  write(PUBLIC/f'trajectories/reference-metadata/{eid}.json',{'schemaVersion':'1.0','kind':'authoredReferenceMetadata','environmentId':eid,'environmentSha256':hashlib.sha256((PUBLIC/f'environments/{eid}.json').read_bytes()).hexdigest(),'trajectorySha256':hashlib.sha256((PUBLIC/f'trajectories/ai-generated/{eid}-camera.json').read_bytes()).hexdigest(),'source':'Deterministic authored storyboard, not optimized output or measured ground truth','events':env['events'],'limitations':['Camera reference requires visual review; camera optimizer is available separately.','Authored root motion and pose overlays are not a real-time physics simulation.']})
  entries.append({'id':eid,'promptExampleId':eid,'title':'ورزشگاه · دو و فوتبال' if eid=='stadium' else 'کارخانه · خط تولید فعال','prompt':env['prompt'],'durationSeconds':DURATION,'url':f'/environments/{eid}.json','referenceTrajectoryUrl':f'/trajectories/ai-generated/{eid}-camera.json','referenceMetadataUrl':f'/trajectories/reference-metadata/{eid}.json','optimizedTrajectoryUrl':f'/trajectories/optimized/{eid}-camera.json','optimizedTrajectoryStale':True})
  print(f'{eid}: {len(env["entities"])} entities, {len(env["semanticAnchors"])} anchors, {len(env["events"])} events')
 write(PUBLIC/'environments/manifest.json',{'schemaVersion':'1.0','kind':'environmentManifest','environments':entries})
 write(ROOT/'docs/scene-events.json',{'stadium':env1['events'],'factory':env2['events']})
if __name__=='__main__':main()
