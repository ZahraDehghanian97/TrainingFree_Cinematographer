/** Original procedural props for the two shared environments. No external asset URLs. */
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { PresetVisualV1 } from "../../src/types/environment";

type Point = [number, number, number];
const updates = new WeakMap<THREE.Object3D, (time: number) => void>();
const material = (color: string, metalness = 0, roughness = .7) =>
  new THREE.MeshStandardMaterial({ color, metalness, roughness });
const num = (v: PresetVisualV1, key: string, fallback: number) =>
  typeof v.params?.[key] === "number" ? v.params[key] as number : fallback;
const text = (v: PresetVisualV1, key: string, fallback: string) =>
  typeof v.params?.[key] === "string" ? v.params[key] as string : fallback;

/** Batch static parts by material; roller/robot/flag animation stays separate. */
class Parts {
  private buckets = new Map<THREE.Material, THREE.BufferGeometry[]>();
  add(g: THREE.BufferGeometry, m: THREE.Material, p: Point = [0,0,0], q?: THREE.Quaternion): void {
    if (q) g.applyQuaternion(q);
    g.translate(...p);
    const flat = g.index ? g.toNonIndexed() : g;
    if (flat !== g) g.dispose();
    const bucket = this.buckets.get(m) ?? [];
    bucket.push(flat); this.buckets.set(m, bucket);
  }
  box(size: Point, p: Point, m: THREE.Material): void { this.add(new THREE.BoxGeometry(...size), m, p); }
  cylinder(r: number, length: number, p: Point, m: THREE.Material, axis: "y" | "z" = "y"): void {
    this.add(new THREE.CylinderGeometry(r,r,length,12),m,p,axis === "z" ? new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0),Math.PI/2) : undefined);
  }
  finish(group = new THREE.Group()): THREE.Group {
    for (const [m, pieces] of this.buckets) {
      const geo = mergeGeometries(pieces, false);
      if (!geo) throw new Error("Could not merge procedural prop geometry");
      const mesh = new THREE.Mesh(geo,m); mesh.castShadow = mesh.receiveShadow = true; group.add(mesh);
      pieces.forEach(p=>p.dispose());
    }
    return group;
  }
}

function track(v: PresetVisualV1): THREE.Group {
  const half = num(v,"halfStraight",46), inner = num(v,"innerRadius",33), lanes = num(v,"lanes",6), width=num(v,"laneWidth",1.22);
  const group = new THREE.Group();
  function oval(r: number): THREE.Vector3[] {
    const points: THREE.Vector3[]=[];
    for(let i=0;i<=100;i++) { const a=Math.PI/2-i*Math.PI/100; points.push(new THREE.Vector3(half+r*Math.cos(a),.012,r*Math.sin(a))); }
    for(let i=0;i<=100;i++) { const a=-Math.PI/2-i*Math.PI/100; points.push(new THREE.Vector3(-half+r*Math.cos(a),.012,r*Math.sin(a))); }
    points.push(points[0].clone()); return points;
  }
  for(let lane=0;lane<lanes;lane++) {
    const a=oval(inner+lane*width),b=oval(inner+(lane+1)*width),p:number[]=[],ix:number[]=[];
    a.forEach((point,i)=>{p.push(point.x,0,point.z,b[i].x,0,b[i].z); if(i<a.length-1){const j=i*2;ix.push(j,j+1,j+2,j+1,j+3,j+2);}});
    const g=new THREE.BufferGeometry();g.setAttribute("position",new THREE.Float32BufferAttribute(p,3));g.setIndex(ix);g.computeVertexNormals();
    const m=material(lane%2?"#b05448":"#b95c4f"); m.side=THREE.DoubleSide;
    const mesh=new THREE.Mesh(g,m);mesh.receiveShadow=true;group.add(mesh);
  }
  // Painted strips, not screen-space lines: they keep physical width at every distance.
  for(let lane=0;lane<=lanes;lane++) {
    const a=oval(inner+lane*width-.035),b=oval(inner+lane*width+.035),p:number[]=[],ix:number[]=[];
    a.forEach((pt,i)=>{p.push(pt.x,.018,pt.z,b[i].x,.018,b[i].z);if(i<a.length-1){const j=i*2;ix.push(j,j+1,j+2,j+1,j+3,j+2);}});
    const g=new THREE.BufferGeometry();g.setAttribute("position",new THREE.Float32BufferAttribute(p,3));g.setIndex(ix);g.computeVertexNormals();
    const m=material("#f4e9dc");m.side=THREE.DoubleSide;group.add(new THREE.Mesh(g,m));
  }
  return group;
}

function flag(v: PresetVisualV1): THREE.Group {
  const group = new THREE.Group(),parts = new Parts(),steel=material("#becbd1",.65,.32);
  parts.cylinder(.045,3.4,[0,1.7,0],steel);parts.box([.38,.08,.38],[0,.04,0],steel);parts.finish(group);
  const canvas=document.createElement("canvas");canvas.width=512;canvas.height=256;
  const ctx=canvas.getContext("2d")!;ctx.fillStyle=text(v,"color","#f1e8cd");ctx.fillRect(0,0,512,256);
  if(text(v,"label","")==="FINISH") {
    for(let y=0;y<4;y++)for(let x=0;x<8;x++)if((x+y)%2===0){ctx.fillStyle="#243440";ctx.fillRect(x*64,y*64,64,64);}
  } else {ctx.fillStyle="#12364a";ctx.textAlign="center";ctx.font="bold 80px sans-serif";ctx.fillText("START",256,157);}
  const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;
  const geo=new THREE.PlaneGeometry(1.6,.8,18,8);geo.translate(.82,2.78,0);
  const mesh=new THREE.Mesh(geo,new THREE.MeshStandardMaterial({map:texture,side:THREE.DoubleSide,roughness:.94}));group.add(mesh);
  const positions=geo.getAttribute("position"),rest=Float32Array.from(positions.array),phase=num(v,"phase",0);
  updates.set(group,t=>{for(let i=0;i<positions.count;i++){const x=rest[i*3];positions.setZ(i,.12*Math.sin(x*5-t*4+phase)*Math.min(1,x));}positions.needsUpdate=true;geo.computeVertexNormals();});
  return group;
}

function flower(v: PresetVisualV1): THREE.Group {
  const p=new Parts(),green=material("#438250"),petal=material(text(v,"color","#f27b9a"));
  p.cylinder(.012,.4,[0,0,0],green);
  for(let i=0;i<5;i++){const a=i*Math.PI*2/5;const g=new THREE.SphereGeometry(1,8,5);g.scale(.055,.025,.085);p.add(g,petal,[Math.cos(a)*.044,.2,Math.sin(a)*.044]);}
  p.add(new THREE.SphereGeometry(.027,8,5),material("#ffc752"),[0,.21,0]);
  const leaf=new THREE.SphereGeometry(1,8,5);leaf.scale(.07,.01,.035);p.add(leaf,green,[.043,.015,0]);
  return p.finish();
}

/** Mechanical distance after a one-second ramp down. Same equation as baked cargo. */
export function conveyorTravel(time: number, speed: number, stopTime: number): number {
  const t=Math.max(0,time);
  if(t<=stopTime)return t*speed;
  const d=Math.min(1,t-stopTime);return speed*stopTime+speed*(d-d*d/2);
}
function conveyor(v: PresetVisualV1): THREE.Group {
  const group=new THREE.Group(),p=new Parts(),steel=material("#516775",.65,.36),dark=material("#202b35",.3),yellow=material("#dfad35",.15);
  const length=num(v,"length",28),width=num(v,"width",1.8),height=num(v,"height",1.05),speed=num(v,"speed",.55),stop=num(v,"stopTime",21.7);
  for(const z of [-1,1]) {
    p.box([length,.22,.12],[0,height-.2,z*width/2],steel);
    p.box([length,.07,.055],[0,height+.09,z*(width/2+.035)],yellow);
    for(let x=-length/2+.8;x<length/2;x+=2.4){p.box([.11,height-.2,.11],[x,(height-.2)/2,z*.68],steel);p.box([.3,.06,.32],[x,.03,z*.68],steel);}
  }
  p.box([length,.09,width-.15],[0,height-.075,0],dark);
  for(let x=-length/2+.2;x<length/2;x+=.45)p.cylinder(.09,width-.16,[x,height-.1,0],steel,"z");
  p.finish(group);
  // A single instanced mesh for moving belt slats, never one draw call per slat.
  const count=Math.ceil(length/.32),slats=new THREE.InstancedMesh(new THREE.BoxGeometry(.035,.01,width-.18),material("#73838b",.55),count);
  group.add(slats);const m=new THREE.Matrix4();
  updates.set(group,t=>{const d=conveyorTravel(t,speed,stop);for(let i=0;i<count;i++){const x=((i*length/count+d)%length)-length/2;m.makeTranslation(x,height-.013,0);slats.setMatrixAt(i,m);}slats.instanceMatrix.needsUpdate=true;});
  // Stable conservative bound also covers the positions after wrapping.
  slats.boundingSphere=new THREE.Sphere(new THREE.Vector3(0,height,0),length/2+width);
  return group;
}
function robot(v: PresetVisualV1): THREE.Group {
  const group=new THREE.Group(),base=new Parts(),orange=material("#d89336",.35,.44),steel=material("#42515b",.65,.35);
  base.cylinder(.62,.3,[0,.15,0],steel);base.box([.6,.85,.6],[0,.7,0],orange);base.finish(group);
  const shoulder=new THREE.Group();shoulder.position.y=1.1;group.add(shoulder);
  const arm=new Parts();arm.cylinder(.25,.5,[0,0,0],steel,"z");arm.box([.28,1.35,.36],[0,.68,0],orange);arm.finish(shoulder);
  const elbow=new THREE.Group();elbow.position.y=1.35;shoulder.add(elbow);
  const forearm=new Parts();forearm.cylinder(.22,.5,[0,0,0],steel,"z");forearm.box([.23,1.15,.28],[0,.58,0],orange);forearm.finish(elbow);
  const wrist=new THREE.Group();wrist.position.y=1.16;elbow.add(wrist);const claw=new Parts();
  claw.box([.34,.23,.3],[0,.11,0],steel);for(const sign of [-1,1])claw.box([.07,.3,.08],[sign*.15,.34,0],steel);claw.finish(wrist);
  updates.set(group,t=>{const clock=conveyorTravel(t,1,num(v,"stopTime",21.7)),p=clock*1.4+num(v,"phase",0);shoulder.rotation.x=.53+.20*Math.sin(p);shoulder.rotation.y=.2*Math.sin(p*.7);elbow.rotation.x=.95+.24*Math.cos(p);wrist.rotation.x=.4*Math.sin(p+1);});
  return group;
}
export function createBroadcastCamera(): THREE.Group {
  const p=new Parts(),dark=material("#1b2530",.32,.42),metal=material("#87969d",.65,.32),glass=material("#193c50",.5,.12);
  p.box([.26,.23,.48],[0,0,0],dark);p.cylinder(.093,.19,[0,0,.33],dark,"z");p.cylinder(.078,.014,[0,0,.431],glass,"z");
  p.box([.10,.05,.32],[0,.18,-.04],metal);p.box([.055,.15,.055],[0,.09,-.18],metal);p.box([.11,.09,.16],[-.15,.09,-.12],dark);
  p.box([.035,.17,.23],[.17,.07,-.06],dark);p.box([.037,.12,.16],[.18,.07,-.06],glass);
  p.add(new THREE.SphereGeometry(.013,8,5),material("#f34345"),[.12,.09,.244]);
  return p.finish();
}
function scoreboard(v: PresetVisualV1): THREE.Group {
  const group=new THREE.Group(),width=num(v,"width",8),height=num(v,"height",3);
  const housing=new THREE.Mesh(new THREE.BoxGeometry(width+.2,height+.2,.25),material("#223b48",.4));group.add(housing);
  const canvas=document.createElement("canvas");canvas.width=1024;canvas.height=384;const ctx=canvas.getContext("2d")!;
  const texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;
  const screen=new THREE.Mesh(new THREE.PlaneGeometry(width,height),new THREE.MeshBasicMaterial({map:texture}));screen.position.z=.132;group.add(screen);
  let last="";updates.set(group,t=>{
    const sports=text(v,"kind","stadium")==="stadium",goal=t>=num(v,"goalTime",38.2),stop=t>=num(v,"stopTime",21.7);
    const key=`${Math.floor(t)}-${goal}-${stop}`;if(key===last)return;last=key;
    ctx.fillStyle="#10252d";ctx.fillRect(0,0,1024,384);ctx.textAlign="center";
    ctx.fillStyle="#77cfba";ctx.font="bold 36px sans-serif";ctx.fillText(sports?"ATHLETICS  /  FOOTBALL":"ASSEMBLY LINE  01",512,67);
    ctx.fillStyle=sports?"#f8efcf":stop?"#ff9879":"#79ddb8";ctx.font="bold 100px sans-serif";
    ctx.fillText(sports?(goal?"RED   1 : 0   BLUE":"RED   0 : 0   BLUE"):(stop?"STOPPED":"RUNNING"),512,218,940);
    ctx.font="32px sans-serif";ctx.fillStyle="#e1ece7";ctx.fillText(sports?(goal?"GOAL!  /  RUNNER 01 WINS":`RACE ${Math.max(0,t-2).toFixed(0)} s`):(stop?"SAFETY STOP  /  CREW RESPONSE":"PRESS  >  ASSEMBLE  >  INSPECT  >  PACK"),512,328);
    texture.needsUpdate=true;
  });return group;
}
export function createScenarioPreset(v: PresetVisualV1): THREE.Object3D | null {
  switch(v.name){case "stadiumTrack":return track(v);case "raceFlag":return flag(v);case "flower":return flower(v);case "productionLine":return conveyor(v);case "industrialRobot":return robot(v);case "broadcastCamera":return createBroadcastCamera();case "scoreboard":return scoreboard(v);default:return null;}
}
export function updateScenarioProp(object: THREE.Object3D,time: number): void { updates.get(object)?.(time); }
