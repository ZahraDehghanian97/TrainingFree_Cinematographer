/** Small independent camera math kernel: no optimizer/compiler/seed imports. */
import type { Quat, Vec3 } from '../types/environment';
export const add = (a: Vec3, b: Vec3): Vec3 => a.map((v,i)=>v+b[i]!) as Vec3;
export const sub = (a: Vec3, b: Vec3): Vec3 => a.map((v,i)=>v-b[i]!) as Vec3;
export const mul = (a: Vec3, k: number): Vec3 => a.map(v=>v*k) as Vec3;
export const dot = (a: Vec3,b: Vec3): number => a.reduce((s,v,i)=>s+v*b[i]!,0);
export const cross = (a: Vec3,b: Vec3): Vec3 => [a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
export const norm = (a: Vec3): Vec3 => { const n=Math.hypot(...a); if(n<1e-12) throw new Error('Zero direction'); return mul(a,1/n); };
export const mix = (a: number,b: number,t: number): number => a+(b-a)*t;
export const mix3 = (a: Vec3,b: Vec3,t: number): Vec3 => a.map((v,i)=>mix(v,b[i]!,t)) as Vec3;
export const rad = (x: number): number => x*Math.PI/180;
export const deg = (x: number): number => x*180/Math.PI;
export const clamp01 = (x: number): number => Math.max(0,Math.min(1,x));
export const smooth = (x: number): number => { const t=clamp01(x); return t*t*t*(10+t*(-15+6*t)); };
export function qnorm(q: Quat): Quat { const n=Math.hypot(...q); if(n<1e-12) throw new Error('Zero quaternion'); return q.map(v=>v/n) as Quat; }
export function qmul(a: Quat,b: Quat): Quat {
 const [x,y,z,w]=a,[u,v,s,t]=b;
 return qnorm([w*u+x*t+y*s-z*v,w*v-x*s+y*t+z*u,w*s+x*v-y*u+z*t,w*t-x*u-y*v-z*s]);
}
export function rotate(v: Vec3,q: Quat): Vec3 {
 const u: Vec3=[q[0],q[1],q[2]], t=mul(cross(u,v),2);
 return add(v,add(mul(t,q[3]),cross(u,t)));
}
export function lookRotation(position: Vec3,look: Vec3): Quat {
 const z=norm(sub(position,look));
 const x=norm(cross(Math.abs(z[1])>.999 ? [0,0,-1] : [0,1,0],z)),y=cross(z,x);
 const m00=x[0],m01=y[0],m02=z[0],m10=x[1],m11=y[1],m12=z[1],m20=x[2],m21=y[2],m22=z[2];
 const trace=m00+m11+m22; let q: Quat;
 if(trace>0){const s=Math.sqrt(trace+1)*2; q=[(m21-m12)/s,(m02-m20)/s,(m10-m01)/s,s/4];}
 else if(m00>m11&&m00>m22){const s=Math.sqrt(1+m00-m11-m22)*2;q=[s/4,(m01+m10)/s,(m02+m20)/s,(m21-m12)/s];}
 else if(m11>m22){const s=Math.sqrt(1+m11-m00-m22)*2;q=[(m01+m10)/s,s/4,(m12+m21)/s,(m02-m20)/s];}
 else {const s=Math.sqrt(1+m22-m00-m11)*2;q=[(m02+m20)/s,(m12+m21)/s,s/4,(m10-m01)/s];}
 return qnorm(q);
}
export function composeCamera(position: Vec3,aim: Vec3,fov: number,aspect: number,screen: [number,number],roll: number): Quat {
 const base=lookRotation(position,aim), a=rad(roll)/2;
 const rolled=qmul(base,[0,0,Math.sin(a),Math.cos(a)]);
 const tangent=Math.tan(rad(fov)/2), desired=norm([(2*screen[0]-1)*tangent*aspect,(1-2*screen[1])*tangent,-1]);
 const forward: Vec3=[0,0,-1],axis=cross(desired,forward);
 // Q maps the requested screen ray onto the original forward vector.
 const offset=qnorm([...axis,1+dot(desired,forward)] as Quat);
 return qmul(rolled,offset);
}
export function project(point: Vec3,position: Vec3,rotation: Quat,fov: number,aspect: number): {x:number;y:number;depth:number} {
 const p=rotate(sub(point,position),[-rotation[0],-rotation[1],-rotation[2],rotation[3]]);
 const depth=-p[2], tangent=Math.tan(rad(fov)/2);
 return { x:.5+p[0]/(2*depth*tangent*aspect),y:.5-p[1]/(2*depth*tangent),depth };
}
/** Optical zoom multiplies cot(FOV/2), never the FOV angle itself. */
export const zoomFov = (fov: number,factor: number): number => deg(2*Math.atan(Math.tan(rad(fov)/2)/factor));
