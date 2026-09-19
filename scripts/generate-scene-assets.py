#!/usr/bin/env python3
"""Deterministic, dependency-free glTF 2.0 prop authoring and scene dressing.
Run from any directory: python3 scripts/generate-scene-assets.py
Original procedural assets: project MIT license. No downloaded/AI-image provenance claimed.
"""
from __future__ import annotations
import json, math, struct, hashlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / 'web/public'
OUT = PUBLIC / 'models/generated'
OUT.mkdir(parents=True, exist_ok=True)

PALETTE = {
 'steel': ('#333e49', .65, .4), 'aluminum': ('#a9b8bf', .7, .32),
 'wood': ('#946547', 0, .85), 'woodlight': ('#bd9569', 0, .78),
 'leaf': ('#315b43', 0, .95), 'leaflight': ('#537a4a', 0, .95),
 'concrete': ('#9d9b8e', 0, .95), 'orange': ('#d49127', .15, .48),
 'rubber': ('#20262b', 0, .98), 'blue': ('#36657b', .18, .5),
 'light': ('#ffe2ad', .05, .35), 'water': ('#468d94', .2, .22),
 'red': ('#a94739', .05, .55), 'white': ('#d5dbd6', 0, .65),
}

def rgb(h):
 return [((int(h[i:i+2],16)/255 + .055)/1.055)**2.4 if int(h[i:i+2],16)/255>.04045 else int(h[i:i+2],16)/255/12.92 for i in (1,3,5)]

class Mesh:
 def __init__(self): self.parts=[]
 def box(self, p, size, material='steel'):
  x,y,z=p; a,b,c=[v/2 for v in size]; vertices=[]; normals=[]; indices=[]
  faces=[([1,0,0],[(a,-b,c),(a,-b,-c),(a,b,-c),(a,b,c)]),([-1,0,0],[(-a,-b,-c),(-a,-b,c),(-a,b,c),(-a,b,-c)]),
   ([0,1,0],[(-a,b,c),(a,b,c),(a,b,-c),(-a,b,-c)]),([0,-1,0],[(-a,-b,-c),(a,-b,-c),(a,-b,c),(-a,-b,c)]),
   ([0,0,1],[(-a,-b,c),(a,-b,c),(a,b,c),(-a,b,c)]),([0,0,-1],[(a,-b,-c),(-a,-b,-c),(-a,b,-c),(a,b,-c)])]
  for normal,vs in faces:
   k=len(vertices); vertices += [[x+vx,y+vy,z+vz] for vx,vy,vz in vs]; normals += [normal]*4; indices += [k,k+1,k+2,k,k+2,k+3]
  self.parts.append((vertices,normals,indices,material))
 def cylinder(self,p,r,h,material='steel',segments=16,top=None,axis='y'):
  top=r if top is None else top; vertices=[]; normals=[]; indices=[]
  def rotate(v): return v if axis=='y' else ([v[1],v[0],v[2]] if axis=='x' else [v[0],v[2],v[1]])
  # Axis swaps are reflections: reverse triangle winding when used.
  def vtx(v,n): vertices.append([a+b for a,b in zip(p,rotate(v))]); normals.append(rotate(n))
  slope=(r-top)/h; nn=math.sqrt(1+slope*slope)
  for i in range(segments+1):
   a=2*math.pi*i/segments; c,s=math.cos(a),math.sin(a)
   for y,rr in [(-h/2,r),(h/2,top)]: vtx([rr*c,y,rr*s],[c/nn,slope/nn,s/nn])
  for i in range(segments):
   k=i*2; indices += [k,k+1,k+2,k+2,k+1,k+3]
  for y,rr,sign in [(-h/2,r,-1),(h/2,top,1)]:
   base=len(vertices); vtx([0,y,0],[0,sign,0])
   for i in range(segments):
    a=2*math.pi*i/segments; vtx([rr*math.cos(a),y,rr*math.sin(a)],[0,sign,0])
   for i in range(segments):
    a,b=base+1+i,base+1+(i+1)%segments
    indices += [base,a,b] if sign<0 else [base,b,a]
  if axis!='y': indices=[q for i in range(0,len(indices),3) for q in [indices[i],indices[i+2],indices[i+1]]]
  self.parts.append((vertices,normals,indices,material))
 def crown(self,p,r,mat='leaf',sy=1):
  # Faceted canopy assembled from three tapering circular tiers.
  self.cylinder([p[0],p[1]-.2*sy,p[2]],r,.8*sy,mat,9,top=.82*r)
  self.cylinder([p[0],p[1]+.4*sy,p[2]],.9*r,.8*sy,mat,9,top=.25*r)
 def bounds(self):
  vs=[v for part in self.parts for v in part[0]]
  return {'type':'box','min':[round(min(v[i] for v in vs),6) for i in range(3)],'max':[round(max(v[i] for v in vs),6) for i in range(3)]}
 def export(self,name):
  blob=bytearray(); views=[]; accessors=[]; primitives=[]
  mats=list(dict.fromkeys(part[3] for part in self.parts))
  def add(values,typ,component):
   while len(blob)%4: blob.append(0)
   start=len(blob); flat=[n for v in values for n in v] if typ=='VEC3' else values
   fmt='f' if component==5126 else 'I'; blob.extend(struct.pack('<'+fmt*len(flat),*flat))
   vi=len(views); views.append({'buffer':0,'byteOffset':start,'byteLength':len(blob)-start})
   a={'bufferView':vi,'componentType':component,'count':len(values),'type':typ}
   if typ=='VEC3': a.update(min=[min(v[i] for v in values) for i in range(3)],max=[max(v[i] for v in values) for i in range(3)])
   accessors.append(a); return len(accessors)-1
  # Merge pieces by material: few draws per reusable prop, not one per bolt.
  for mat in mats:
   vs=[]; ns=[]; ix=[]
   for v,n,i,m in self.parts:
    if m==mat: ix += [x+len(vs) for x in i]; vs+=v; ns+=n
   primitives.append({'attributes':{'POSITION':add(vs,'VEC3',5126),'NORMAL':add(ns,'VEC3',5126)},'indices':add(ix,'SCALAR',5125),'material':mats.index(mat)})
  materials=[]
  for key in mats:
   col,metal,rough=PALETTE[key]; material={'name':key,'pbrMetallicRoughness':{'baseColorFactor':rgb(col)+[1],'metallicFactor':metal,'roughnessFactor':rough}}
   if key=='light': material['emissiveFactor']=[.65,.45,.2]
   materials.append(material)
  doc={'asset':{'version':'2.0','generator':'TrainingFree Cinematographer deterministic prop kit v1'},'scene':0,'scenes':[{'nodes':[0]}],'nodes':[{'mesh':0,'name':name}], 'meshes':[{'primitives':primitives}], 'materials':materials,'buffers':[{'byteLength':len(blob)}],'bufferViews':views,'accessors':accessors}
  j=json.dumps(doc,separators=(',',':')).encode(); j+=b' '*((-len(j))%4); blob+=b'\0'*((-len(blob))%4)
  data=struct.pack('<III',0x46546c67,2,12+8+len(j)+8+len(blob))+struct.pack('<II',len(j),0x4e4f534a)+j+struct.pack('<II',len(blob),0x004e4942)+blob
  file=OUT/(name+'.glb'); file.write_bytes(data)
  return {'id':name,'url':'/models/generated/'+file.name,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest(),'bounds':self.bounds(),'triangles':sum(len(p[2])//3 for p in self.parts),'provenance':'original procedural geometry','license':'MIT'}

def props():
 kit={}
 m=Mesh()
 for x in [-.8,.8]:
  m.box([x,.25,0],[.08,.5,.65]); m.box([x,.74,-.27],[.07,.95,.07])
 for z in [-.23,0,.23]: m.box([0,.5,z],[2,.07,.18],'wood')
 for y in [.7,.9]: m.box([0,y,-.27],[2,.15,.06],'woodlight')
 kit['slatted-bench']=m
 m=Mesh(); m.cylinder([0,.25,0],.65,.5,'concrete',16,top=.74); m.cylinder([0,1.45,0],.11,2.4,'wood',10,top=.065)
 m.crown([0,2.6,0],1.05,'leaf',1.1); m.crown([.5,2.45,.3],.7,'leaflight',.9); kit['planter-tree']=m
 m=Mesh(); m.cylinder([0,.06,0],.24,.12); m.cylinder([0,1.85,0],.06,3.6); m.box([.36,3.58,0],[.8,.08,.1]); m.box([.7,3.5,0],[.55,.12,.38]); m.box([.7,3.43,0],[.45,.015,.28],'light'); kit['streetlamp']=m
 m=Mesh()
 for x in [-1.45,1.45]:
  for z in [-.5,.5]: m.box([x,1.5,z],[.08,3,.08],'blue')
 for y in [.15,1,1.9,2.8]:
  m.box([0,y,0],[3,.09,1.05],'steel')
  for x in [-.95,0,.95]:
   if y<2.5: m.box([x,y+.31,0],[.76,.53,.75],'woodlight')
 kit['warehouse-shelf']=m
 m=Mesh()
 for x,y,z in [(-.5,.46,0),(.5,.46,0),(0,1.31,0)]:
  m.box([x,y,z],[.9,.82,.9],'wood')
  for xx in [-.36,.36]: m.box([x+xx,y,z+.46],[.07,.83,.03],'woodlight')
  for yy in [-.31,.31]: m.box([x,y+yy,z+.47],[.9,.07,.03],'woodlight')
 for x in [-.8,0,.8]: m.box([x,.055,0],[.16,.11,1.2],'woodlight')
 kit['crate-stack']=m
 m=Mesh(); m.box([0,.65,0],[1.4,.8,1.8],'orange'); m.box([0,1.1,.55],[1.35,.55,.6],'orange'); m.box([0,1.1,-.25],[.58,.16,.65],'rubber'); m.box([0,1.5,0],[.6,.8,.14],'rubber')
 for x in [-.62,.62]:
  for z in [-.58,.62]: m.cylinder([x,.4,z],.38,.23,'rubber',18,axis='x'); m.cylinder([x*1.11,.4,z],.18,.04,'aluminum',12,axis='x')
  m.box([x,1.85,.52],[.07,1.8,.07]); m.box([x,1.85,-.65],[.07,1.8,.07])
 m.box([0,2.73,0],[1.45,.09,1.5]);
 for x in [-.45,.45]: m.box([x,1.2,-1.08],[.09,2.1,.13]); m.box([x,.2,-1.75],[.16,.1,1.35],'aluminum')
 kit['forklift']=m
 m=Mesh(); m.box([0,.65,0],[1.8,1.3,1.3],'white'); m.box([0,1.36,0],[1.95,.12,1.42],'steel')
 for y in [.2,.35,.5,.65,.8,.95,1.1]: m.box([0,y,.66],[1.55,.07,.04],'steel')
 m.cylinder([0,1.44,0],.48,.05,'rubber',24); kit['rooftop-hvac']=m
 m=Mesh(); m.cylinder([0,.18,0],1.65,.36,'concrete',24); m.cylinder([0,.37,0],1.45,.03,'water',32); m.cylinder([0,.66,0],.3,.6,'concrete'); m.cylinder([0,1,0],.72,.12,'concrete'); m.cylinder([0,1.1,0],.06,.25,'water'); kit['courtyard-fountain']=m
 m=Mesh(); m.box([0,.25,0],[.78,.48,.18],'rubber');
 for x in [-.32,.32]: m.box([x,.25,.1],[.025,.43,.02],'aluminum')
 m.box([0,.55,0],[.24,.035,.05]);
 for x in [-.12,.12]: m.box([x,.51,0],[.035,.09,.05]); m.box([x,.46,.1],[.055,.05,.02],'aluminum')
 kit['briefcase']=m
 m=Mesh(); m.box([0,.4,0],[2,.8,.55],'concrete')
 for x in [-.7,-.35,0,.35,.7]: m.box([x,.58,.282],[.15,.23,.02],'orange')
 kit['road-barrier']=m
 m=Mesh()
 for x in [-.35,.35]: m.box([x,1.8,0],[.055,3.6,.055],'aluminum')
 for y in [.05,.65,1.25,1.85,2.45,3.1,3.55]: m.box([0,y,0],[.75,.04,.04],'aluminum')
 m.box([0,.06,0],[1.1,.12,1.1]);
 for y in [2.5,3.2]: m.cylinder([0,y,.19],.19,.32,'steel',16,axis='z'); m.cylinder([0,y,.36],.16,.01,'light',16,axis='z')
 kit['lighting-truss']=m
 m=Mesh(); m.box([0,.85,0],[1.15,1.7,.4],'blue'); m.box([0,1.08,.213],[.83,.95,.035],'rubber'); m.box([0,.37,.213],[.75,.25,.035],'steel')
 for x in [-.27,0,.27]: m.box([x,1.08,.24],[.16,.5,.025],'orange')
 m.box([.48,1.05,.24],[.07,.2,.025],'light'); kit['vending-machine']=m
 m=Mesh(); m.box([0,.74,0],[1.8,.1,.72],'woodlight')
 for x in [-.78,.78]:
  for z in [-.26,.26]: m.box([x,.35,z],[.05,.7,.05])
 m.box([-.4,.86,0],[.5,.14,.35],'red'); m.box([.4,.82,0],[.35,.08,.45],'blue'); kit['workbench']=m
 m=Mesh(); m.box([0,2.45,0],[4,.16,2.8],'steel')
 for x in [-1.85,1.85]:
  for z in [-1.25,1.25]: m.box([x,1.2,z],[.14,2.4,.14]); m.box([x,2.94,z],[.055,.85,.055],'orange')
 for z in [-1.25,1.25]: m.box([0,3.35,z],[3.8,.06,.06],'orange')
 kit['mezzanine']=m
 m=Mesh()
 for z in [-3.8,3.8]: m.box([0,3,z],[.5,6,.4],'blue')
 m.box([0,5.8,0],[.5,.4,8],'steel')
 kit['loading-bay-portal']=m
 return kit

# Geometry and dressing have separate sources of truth. Regeneration never
# reads last run's generated scene, so removed clutter cannot grow back.
from scene_layouts import extra_props

def main():
 kit = props()
 kit.update(extra_props(Mesh))
 manifest = {name:mesh.export(name) for name,mesh in kit.items()}
 (OUT/'manifest.json').write_text(json.dumps({'schemaVersion':'1.0',
     'generator':'scripts/generate-scene-assets.py','assets':list(manifest.values())},indent=2)+'\n')
 print(f'Generated {len(manifest)} original procedural GLB assets.')

if __name__ == '__main__':
 main()
