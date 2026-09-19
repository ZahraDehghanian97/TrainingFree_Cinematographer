import type * as THREE from "three";
import type { SceneEntityV1 } from "../../src/types/environment";
import { performanceWeight } from "../../src/environment/performance";
import type { HumanoidRig } from "./humanoid";
import type { HumanoidMotion } from "./humanoid-motion";

/** Layer authored performances over path-derived gait without changing entity transforms. */
export function withPerformance(base: HumanoidMotion, rig: HumanoidRig, entity: SceneEntityV1, duration: number): HumanoidMotion {
  return {update(time: number): void {
    base.update(time);
    const t=Math.max(0,Math.min(duration,time));
    for(const clip of entity.performance??[]){
      const weight=performanceWeight(clip,t,duration);if(weight<=0)continue;
      const local=t-clip.start,phase=local*5.4;
      const pose=(bone:THREE.Bone,x:number,y=0,z=0)=>{
        bone.rotation.x+=(x-bone.rotation.x)*weight;
        bone.rotation.y+=(y-bone.rotation.y)*weight;
        bone.rotation.z+=(z-bone.rotation.z)*weight;
      };
      const hip=(y:number)=>{rig.hips.position.y+=(y-rig.hips.position.y)*weight;};
      const arms=(left:number,right:number,bend=.7,spread=.12)=>{
        pose(rig.leftUpperArm,left,0,spread);pose(rig.rightUpperArm,right,0,-spread);
        pose(rig.leftForearm,-bend);pose(rig.rightForearm,-bend);
      };
      switch(clip.action){
        case "ready":hip(.82);pose(rig.spine,.38);pose(rig.leftThigh,-.32);pose(rig.rightThigh,.18);pose(rig.leftShin,.52);pose(rig.rightShin,.3);arms(-.35,.38,.95);break;
        case "sit":hip(.52);pose(rig.leftThigh,-Math.PI/2);pose(rig.rightThigh,-Math.PI/2);pose(rig.leftShin,Math.PI/2);pose(rig.rightShin,Math.PI/2);pose(rig.leftFoot,0);pose(rig.rightFoot,0);arms(-.35,-.35,.5);break;
        case "fall":pose(rig.spine,.07);pose(rig.head,-.3);arms(-1.4,-1.4,.18,.25);pose(rig.leftThigh,-.15);pose(rig.rightThigh,.04);pose(rig.leftShin,.35);pose(rig.rightShin,.08);pose(rig.leftFoot,0);pose(rig.rightFoot,0);break;
        case "recover":hip(.78);pose(rig.spine,.35);pose(rig.leftThigh,-.8);pose(rig.rightThigh,-.3);pose(rig.leftShin,1.1);pose(rig.rightShin,.65);arms(-.6,-.35,.5);break;
        case "celebrate":case "cheer":
          arms(-2.5-.18*Math.sin(phase),-2.5+.18*Math.sin(phase),.25,.38);pose(rig.spine,-.06,.1*Math.sin(phase*.5));pose(rig.head,-.13);
          if(clip.action==="cheer"){hip(.94);pose(rig.leftThigh,0);pose(rig.rightThigh,0);pose(rig.leftShin,0);pose(rig.rightShin,0);pose(rig.leftFoot,0);pose(rig.rightFoot,0);}break;
        case "throw":{
          const u=Math.max(0,Math.min(1,local/(clip.end-clip.start)));
          pose(rig.rightUpperArm,-2.9+2.1*u,-.2,-.2);pose(rig.rightForearm,-1.0+u*.9);pose(rig.spine,.12*u,-.2+.4*u);pose(rig.leftUpperArm,-.5,0,.35);break;
        }
        case "film":pose(rig.spine,.025,.35);pose(rig.head,0,.7);pose(rig.leftUpperArm,-1.12,.7,.1);pose(rig.rightUpperArm,-1.18,.6,-.15);pose(rig.leftForearm,-1.05);pose(rig.rightForearm,-.75);break;
        case "work":{
          const reach=.5+.5*Math.sin(phase*.7);pose(rig.spine,.12);arms(-.6-.5*reach,-1.0+.28*reach,.65,.12);pose(rig.head,.18);break;
        }
        case "argue":pose(rig.spine,.05,.09*Math.sin(phase*.5));arms(-.6-.45*Math.sin(phase),-.75+.3*Math.sin(phase),.85,.27);pose(rig.head,0,.12*Math.sin(phase*.4));break;
        case "shove":{
          const extension=Math.max(0,Math.sin(Math.PI*Math.min(1,local/1.3)));
          arms(-.8-.65*extension,-.8-.65*extension,1.0-.9*extension,.13);pose(rig.spine,.15+.18*extension);break;
        }
        case "recoil":arms(-1.0,-1.1,.7,.6);pose(rig.spine,-.15);pose(rig.head,-.17);pose(rig.leftThigh,-.24);pose(rig.rightThigh,-.1);pose(rig.leftShin,.55);pose(rig.rightShin,.32);break;
        case "kick":{
          const swing=Math.sin(Math.PI*Math.min(1,local/(clip.end-clip.start)));
          pose(rig.rightThigh,-1.1*swing);pose(rig.rightShin,.3*(1-swing));pose(rig.rightFoot,-.25);pose(rig.spine,-.1*swing);arms(-.4,.4,.3,.4);break;
        }
        case "dive":arms(-2.15,-2.2,.12,.25);pose(rig.leftThigh,.14);pose(rig.rightThigh,-.2);pose(rig.leftShin,.15);pose(rig.rightShin,.3);break;
      }
    }
  }};
}
