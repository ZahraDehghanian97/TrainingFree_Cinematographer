"""Authored, metre-scale environments. No random or profile-wide prop scattering.

The base files retain the story subjects/anchors. This module owns architecture,
functional furniture, access routes and contact surfaces. Output is deterministic.
Each built element has a role and a reason; layout receipts are independently tested.
"""
from __future__ import annotations
import copy
import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
COLORS = dict(plaster='#c6beb0', concrete='#858782', wood='#8e6b4f', metal='#465256',
              glass='#bad3d1', fabric='#737168', emissive='#f6deb6', stone='#b3ad9f',
              dark='#343c3f', rail='#b89b54')


def quat_y(degrees):
    a = math.radians(degrees) / 2
    return [0, round(math.sin(a), 9), 0, round(math.cos(a), 9)]


def quat_between(a, b):
    """Rotate local +Y onto b-a (used for physically connected rails and rods)."""
    v = [b[i] - a[i] for i in range(3)]
    length = math.sqrt(sum(x*x for x in v))
    if length <= 1e-8:
        raise ValueError('Zero-length structural member')
    x, y, z = [x / length for x in v]
    q = [z, 0, -x, 1 + y] if y > -.999999 else [1, 0, 0, 0]
    n = math.sqrt(sum(v*v for v in q))
    return [round(v/n, 9) for v in q], length


def bounds(size, base=False):
    return {'type': 'box', 'min': [-size[0]/2, 0 if base else -size[1]/2, -size[2]/2],
            'max': [size[0]/2, size[1] if base else size[1]/2, size[2]/2]}


class Scene:
    def __init__(self, source, kit):
        self.env = copy.deepcopy(source)
        self.n = int(source['promptExampleId'][-2:])
        self.kit = kit
        self.entities = self.env['entities']
        self.receipt = {'exampleId': source['promptExampleId'], 'rooms': [], 'stairs': [],
                        'openings': [], 'walkways': [], 'notes': []}
        for e in self.entities:
            e['layout'] = {'role': 'subject' if self.is_subject(e) else 'prop',
                           'purpose': e.get('label', e['id'].replace('-', ' '))}
        self.env['world']['ground'].update(continuation='none', details='authored')
        self.env['world'].pop('grid', None)

    @staticmethod
    def is_subject(e):
        return e['visual'].get('name') in ('humanoid', 'car', 'soccerBall') or e['id'] in ('fist-entity',)

    def get(self, id):
        return next(e for e in self.entities if e['id'] == id)

    def remove(self, *ids):
        self.entities[:] = [e for e in self.entities if e['id'] not in ids]
        self.env['semanticAnchors'][:] = [a for a in self.env['semanticAnchors'] if a['entityId'] not in ids]

    def keep(self, *ids):
        self.remove(*(e['id'] for e in self.entities if e['id'] not in ids))

    def add(self, e):
        if any(x['id'] == e['id'] for x in self.entities):
            raise ValueError(f'Duplicate {self.n}: {e["id"]}')
        self.entities.append(e)
        return e

    def box(self, id, pos, size, purpose, role='prop', surface='concrete', color=None,
            support=None, cutaway=None, normal=None, rotation=None, sign=None, light=None):
        assert min(size) > 0, (id, size)
        layout = dict(role=role, purpose=purpose, surface=surface)
        for k, v in [('support', support), ('cutaway', cutaway), ('outwardNormal', normal),
                     ('sign', sign), ('light', light)]:
            if v is not None:
                layout[k] = v
        e = dict(id=id, label=purpose, transform={'space': 'world', 'position': list(pos)},
                 visual={'type': 'primitive', 'shape': 'box', 'params': {'size': list(size)},
                         'color': color or COLORS.get(surface, COLORS['concrete'])},
                 bounds=bounds(size), layout=layout)
        if rotation is not None:
            e['transform']['rotation'] = rotation
        if surface == 'glass':
            e['occlusion'] = {'transparent': True}
        return self.add(e)

    def rod(self, id, a, b, radius=.025, purpose='Connected handrail', support=None, color=None, role='railing'):
        q, length = quat_between(a, b)
        e = self.box(id, [(a[i]+b[i])/2 for i in range(3)], [radius*2, length, radius*2],
                     purpose, role, 'metal', color, support, rotation=q)
        e['visual'].update(shape='cylinder', params={'radius': radius, 'height': length, 'radialSegments': 12})
        return e

    def model(self, id, asset, pos, purpose, angle=0, support='ground'):
        a = self.kit[asset]
        e = dict(id=id, label=purpose, transform={'space': 'world', 'position': list(pos)},
                 visual={'type': 'model', 'url': a['url']}, bounds=copy.deepcopy(a['bounds']),
                 layout={'role': 'furniture', 'purpose': purpose, 'support': support})
        if angle:
            e['transform']['rotation'] = quat_y(angle)
        return self.add(e)

    def person(self, id, pos, purpose, color='#526478', end=None, angle=0):
        p = list(pos) if end is None else {'interpolation': 'linear', 'extrapolation': 'hold',
             'keyframes': [{'t': 0, 'value': list(pos)}, {'t': self.env['clock']['durationSeconds'], 'value': list(end)}]}
        return self.add(dict(id=id, label=purpose, transform={'space': 'world', 'position': p, 'rotation': quat_y(angle)},
             visual={'type': 'preset', 'name': 'humanoid', 'params': {'height': 1.8, 'shirtColor': color,
                     'trouserColor': '#303438', 'color': '#b78e72', 'motion': 'auto' if end else 'idle'}},
             bounds=bounds([.65, 1.8, .5], True), layout={'role': 'subject', 'purpose': purpose, 'support': 'ground'}))

    def wall(self, id, axis, fixed, lo, hi, y, height, openings=(), normal=None, color=None):
        """Tile a wall around its openings, rather than covering openings with a box.

        Opening tuple: (id, centre along wall, width, sill, clear height, kind).
        All positions are world-space; corners share their reference planes.
        """
        thick = .22
        cut = 'wall' if normal else None
        cursor = lo
        records = []
        def piece(suffix, a, b, bottom, top):
            if b-a < 1e-7 or top-bottom < 1e-7:
                return None
            p = [(a+b)/2, (bottom+top)/2, fixed] if axis == 'x' else [fixed, (bottom+top)/2, (a+b)/2]
            size = [b-a, top-bottom, thick] if axis == 'x' else [thick, top-bottom, b-a]
            ent = self.box(f'{id}-{suffix}', p, size, 'Continuous enclosure wall', 'wall', 'plaster', color,
                           support='ground', cutaway=cut, normal=normal)
            records.append(ent['id'])
            return ent['id']
        def facing_box(suffix, along, yy, length, hh, depth, purpose, surface='wood'):
            p = [along, yy, fixed] if axis == 'x' else [fixed, yy, along]
            size = [length, hh, depth] if axis == 'x' else [depth, hh, length]
            return self.box(suffix, p, size, purpose, 'window' if surface == 'glass' else 'trim', surface,
                            support=records[0] if records else 'ground', cutaway=cut, normal=normal)
        for i, opening in enumerate(sorted(openings, key=lambda o: o[1])):
            oid, centre, width, sill, clear, kind = opening
            left, right, top = centre-width/2, centre+width/2, y+sill+clear
            if left < cursor-1e-6 or right > hi+1e-6 or top > y+height+1e-6:
                raise ValueError(f'{id}: overlapping or out-of-wall opening {oid}')
            piece(f'panel-{i}', cursor, left, y, y+height)
            piece(f'{oid}-sill-wall', left, right, y, y+sill)
            piece(f'{oid}-lintel', left, right, top, y+height)
            self.receipt['openings'].append(dict(id=oid, axis=axis, fixed=fixed, min=left, max=right,
                       bottom=y+sill, top=top, kind=kind, wall=id))
            for label, x in [('left', left-.035), ('right', right+.035)]:
                facing_box(f'{oid}-jamb-{label}', x, y+sill+clear/2, .07, clear+.12, .3,
                           f'{kind.title()} jamb seated on wall opening')
            facing_box(f'{oid}-head', centre, top+.035, width+.14, .07, .3, f'{kind.title()} lintel trim')
            if kind == 'window':
                facing_box(f'{oid}-sill', centre, y+sill+.025, width+.18, .05, .4, 'Window sill')
                facing_box(f'{oid}-glass', centre, y+sill+clear/2, width-.06, clear-.06, .015,
                           'Glazed window in a real wall opening', 'glass')
                for j in range(1, max(2, math.ceil(width/1.1))):
                    divisions = max(2, math.ceil(width/1.1))
                    facing_box(f'{oid}-mullion-{j}', left+j*width/divisions, y+sill+clear/2, .045, clear, .08,
                               'Window mullion', 'metal')
            cursor = right
        piece('end', cursor, hi, y, y+height)
        # Skirting is split around doorways too; it must not seal the threshold.
        intervals = [(lo, hi)]
        for o in openings:
            if o[3] == 0:
                a, b = o[1]-o[2]/2, o[1]+o[2]/2
                intervals = [(u, min(v,a)) for u,v in intervals if u < a] + [(max(u,b), v) for u,v in intervals if v > b]
        for i, (a,b) in enumerate(intervals):
            if b-a > .01:
                facing_box(f'{id}-skirting-{i}', (a+b)/2, y+.065, b-a, .13, .255, 'Wall base/skirting', 'wood')
        return records

    def shell(self, id, rect, height, openings=None, y=0, color=None, floor=True, roof=True):
        x0, x1, z0, z1 = rect
        openings = openings or {}
        walls = {}
        for side, axis, fixed, lo, hi, normal in [
            ('north', 'x', z0, x0-.11, x1+.11, [0,0,-1]),
            ('south', 'x', z1, x0-.11, x1+.11, [0,0,1]),
            ('west', 'z', x0, z0-.11, z1+.11, [-1,0,0]),
            ('east', 'z', x1, z0-.11, z1+.11, [1,0,0])]:
            walls[side] = self.wall(f'arch-{id}-{side}', axis, fixed, lo, hi, y, height,
                                    openings.get(side, ()), normal, color)
        if floor:
            self.box(f'arch-{id}-slab', [(x0+x1)/2,y-.12,(z0+z1)/2], [x1-x0+.22,.24,z1-z0+.22],
                     'Continuous structural floor slab', 'floor',
                     'wood' if self.env['world']['ground'].get('surface') in ('wood','stage') else 'concrete',
                     self.env['world']['ground'].get('color'), support='ground')
        if roof:
            self.box(f'arch-{id}-ceiling', [(x0+x1)/2,y+height+.13,(z0+z1)/2], [x1-x0+.22,.26,z1-z0+.22],
                     'Full ceiling and weather roof; visible in Director POV', 'ceiling', 'plaster',
                     support=walls['west'][0], cutaway='roof')
        self.env['world']['ground']['render'] = False
        self.receipt['rooms'].append(dict(id=id, rect=list(rect), floor=y, ceiling=y+height,
                    roof=f'arch-{id}-ceiling' if roof else None, walls=walls))
        self.env['world']['ground']['size'] = [max(abs(x0),abs(x1))*2+.4, max(abs(z0),abs(z1))*2+.4]
        return f'arch-{id}-ceiling'

    def ceiling_light(self, id, x, z, ceiling, ceiling_id, power=45, length=1.05):
        self.box(id+'-mount', [x,ceiling-.045,z], [length+.08,.09,.24], 'Ceiling-mounted luminaire housing',
                 'fixture', 'metal', support=ceiling_id)
        return self.box(id, [x,ceiling-.102,z], [length,.025,.16], 'Downward practical ceiling light',
                 'fixture', 'emissive', support=id+'-mount',
                 light={'color':'#ffe8c9','intensity':power,'distance':max(9,ceiling*2)})

    def path(self, id, points, width, purpose, color='#b5ac98', elevation=0):
        for i, (a,b) in enumerate(zip(points, points[1:])):
            dx,dz = b[0]-a[0], b[1]-a[1]
            length = math.hypot(dx,dz)
            self.box(f'{id}-{i}', [(a[0]+b[0])/2,-.02+elevation,(a[1]+b[1])/2], [width,.05,length+.025],
                     purpose, 'paving', 'concrete', color, 'ground', rotation=quat_y(math.degrees(math.atan2(dx,dz))))
        self.receipt['walkways'].append(dict(id=id,points=points,width=width,purpose=purpose))

    def railing(self, id, a, b, height=1.05, gap=None):
        length=math.dist(a,b)
        count=max(1,math.ceil(length/.85))
        for i in range(count+1):
            p=[a[j]+(b[j]-a[j])*i/count for j in range(3)]
            self.rod(f'{id}-post-{i}',p,[p[0],p[1]+height,p[2]],.023,'Balustrade post anchored into slab')
        for k,h in enumerate([height*.48,height]):
            self.rod(f'{id}-rail-{k}',[a[0],a[1]+h,a[2]],[b[0],b[1]+h,b[2]],.027,
                     'Continuous guardrail',color=COLORS['rail'])

    def stairs(self, id, start, direction, rise, width=1.4, going=.28, landing=1.2, target=None):
        """Solid flights with equal risers, two continuous handrails and top landing."""
        count=math.ceil(rise/.17-1e-9)
        riser=rise/count
        sx, sy, sz=start; dx,dz=direction
        assert abs(dx)+abs(dz)==1
        steps=[]
        for i in range(count):
            distance=(i+.5)*going
            size=[width,(i+1)*riser,going] if dz else [going,(i+1)*riser,width]
            eid=f'{id}-tread-{i+1:02}'
            self.box(eid,[sx+dx*distance,sy+(i+1)*riser/2,sz+dz*distance],size,
                     f'Usable stair flight, equal riser {i+1}/{count}', 'stair', support='ground')
            nosing_size=[width,.012,.035] if dz else [.035,.012,width]
            self.box(eid+'-nosing',[sx+dx*(i*going+.025),sy+(i+1)*riser+.006,sz+dz*(i*going+.025)],nosing_size,
                     'Non-slip stair nosing', 'trim', 'metal', COLORS['rail'],eid)
            steps.append(eid)
        end=[sx+dx*count*going,sy+rise,sz+dz*count*going]
        lid=f'{id}-landing'
        # One millimetre below a circular stage avoids overlapping coplanar faces.
        landing_rise=rise-(.001 if target=='stage' else 0)
        self.box(lid,[end[0]+dx*landing/2,sy+landing_rise/2,end[2]+dz*landing/2],
                 [width,landing_rise,landing] if dz else [landing,landing_rise,width],
                 'Level top landing connecting stair to occupied floor', 'landing', support='ground')
        for side in [-1,1]:
            off=[-dz*side*(width/2-.035),0,dx*side*(width/2-.035)]
            for j in range(0,count+1,3):
                dist=min((j+.35)*going,count*going)
                top=sy+min(j+1,count)*riser
                p=[sx+dx*dist+off[0],top,sz+dz*dist+off[2]]
                rail_y=sy+riser+.98+(rise-riser)*(dist-.1)/(count*going-.1)
                self.rod(f'{id}-post-{side}-{j}',p,[p[0],rail_y,p[2]],.022,
                         'Stair handrail upright anchored into tread',support=steps[min(j,count-1)])
            a=[sx+dx*.1+off[0],sy+riser+.98,sz+dz*.1+off[2]]
            b=[end[0]+off[0],end[1]+.98,end[2]+off[2]]
            self.rod(f'{id}-handrail-{side}',a,b,.03,'Continuous sloped stair handrail',color=COLORS['rail'])
            self.railing(f'{id}-landing-guard-{side}',[end[0]+off[0],end[1],end[2]+off[2]],
                         [end[0]+dx*landing+off[0],end[1],end[2]+dz*landing+off[2]],height=.98)
        self.receipt['stairs'].append(dict(id=id,start=list(start),direction=list(direction),count=count,
                    rise=rise,riser=riser,going=going,width=width,steps=steps,landing=lid,landingDepth=landing,
                    end=[end[0]+dx*landing,end[1],end[2]+dz*landing],target=target))
        return lid

    def mezzanine(self, id, cx, cz, width=6, depth=4, height=3.06, stair_x=None):
        x0,x1=cx-width/2,cx+width/2;z0,z1=cz-depth/2,cz+depth/2
        # Keep the tracked mezzanine ID on the actual deck, not a solid bounding box
        # around the empty room underneath it.
        self.box(id,[cx,height-.11,cz],[width,.22,depth], 'Occupied mezzanine deck supported by columns',
                 'landing','metal',support='ground')
        for i,(x,z) in enumerate([(x0+.15,z0+.15),(x1-.15,z0+.15),(x0+.15,z1-.15),(x1-.15,z1-.15)]):
            self.box(f'{id}-column-{i}',[x,(height-.22)/2,z],[.18,height-.22,.18],
                     'Load-bearing mezzanine column','column','metal',support='ground')
            self.box(f'{id}-base-{i}',[x,.035,z],[.38,.07,.38],'Column base plate','trim','metal',support='ground')
        for z in [z0+.12,z1-.12]:
            self.box(f'{id}-beam-{z}',[cx,height-.32,z],[width,.2,.18],
                     'Mezzanine edge beam carried on columns','beam','metal',support=f'{id}-column-0')
        for side,a,b in [('rear',[x0,height,z0],[x1,height,z0]),('left',[x0,height,z0],[x0,height,z1]),('right',[x1,height,z0],[x1,height,z1])]:
            self.railing(f'{id}-{side}',a,b)
        stair_x=stair_x if stair_x is not None else x0+.85
        # Explicit gap in front railing; never put a rail across the stair exit.
        for suffix,a,b in [('a',x0,stair_x-.7),('b',stair_x+.7,x1)]:
            if b-a>.1:self.railing(f'{id}-front-{suffix}',[a,height,z1],[b,height,z1])
        run=math.ceil(height/.17-1e-9)*.28
        self.stairs(id+'-access',[stair_x,0,z1+1.2+run],(0,-1),height,target=id)
        return id

    def finish(self):
        ids={e['id'] for e in self.entities}
        self.env['semanticAnchors']=[a for a in self.env['semanticAnchors'] if a['entityId'] in ids]
        for e in self.entities:
            # Fix absent physical envelopes on retained base props, not just visuals.
            if 'bounds' not in e and e['visual'].get('shape')=='box':
                e['bounds']=bounds(e['visual']['params']['size'])
        self.receipt['entityCount']=len(self.entities)
        self.receipt['purposeCount']=sum(bool(e.get('layout',{}).get('purpose')) for e in self.entities)
        return self.env,self.receipt


def extra_props(Mesh):
    """Small original, dimensioned furniture kit; all assets are rooted on contact Y=0."""
    kit={}
    m=Mesh()
    for x in [-1.05,1.05]:
        for z in [-.34,.34]:m.box([x,.11,z],[.08,.22,.08],'wood')
    m.box([0,.27,0],[2.35,.18,.9],'wood')
    m.box([0,.66,-.36],[2.35,.72,.2],'blue')
    for x in [-1.12,1.12]:m.box([x,.54,0],[.2,.6,.95],'blue')
    for x in [-.51,.51]:
        m.box([x,.44,.04],[.99,.22,.69],'white');m.box([x,.73,-.21],[.99,.43,.17],'white')
    kit['lounge-sofa']=m
    m=Mesh()
    for x in [-.28,.28]:
        for z in [-.26,.26]:m.box([x,.24,z],[.055,.48,.055],'wood')
    m.box([0,.48,0],[.7,.1,.68],'woodlight');m.box([0,.81,-.28],[.7,.66,.1],'wood')
    m.box([0,.55,.02],[.6,.06,.54],'blue');kit['chair']=m
    m=Mesh()
    for x in [-.32,.32]:
        for z in [-.23,.23]:m.box([x,.26,z],[.045,.52,.045],'steel')
    m.box([0,.54,0],[.8,.06,.6],'woodlight');kit['side-table']=m
    m=Mesh();m.cylinder([0,.035,0],.26,.07,'steel',24);m.cylinder([0,.9,0],.023,1.8,'steel',16)
    m.cylinder([0,1.75,0],.32,.4,'white',32,top=.2)
    m.cylinder([0,1.551,0],.29,.016,'light',32);kit['floor-lamp']=m
    m=Mesh()
    for x in [-.73,.73]:m.box([x,1.05,0],[.055,2.1,.36],'wood')
    m.box([0,1.05,-.17],[1.46,2.1,.025],'wood')
    for y in [.07,.58,1.08,1.58,2.07]:m.box([0,y,0],[1.52,.055,.38],'woodlight')
    for level in range(4):
        for i in range(8):
            h=.26+(i%3)*.05
            m.box([-.59+i*.155,.10+level*.5+h/2,-.015],[.115,h,.24],['blue','white','woodlight','red'][i%4])
    kit['bookcase']=m
    m=Mesh();m.box([0,.027,0],[.46,.054,.16],'steel')
    for row in range(4):
        for col in range(12):m.box([-.207+col*.038,.058,-.059+row*.038],[.03,.012,.028],'white')
    kit['keyboard']=m
    m=Mesh();m.box([0,.06,0],[1.1,.12,1.1],'steel')
    for x in [-.46,.46]:m.box([x,1.2,0],[.075,2.3,.075],'steel')
    m.box([0,2.3,0],[1,.08,.08],'steel')
    for x in [-.3,-.1,.1,.3]:
        m.box([x,1.99,.05],[.035,.4,.035],'aluminum');m.cylinder([x,1.78,.05],.09,.14,'rubber',12)
    kit['gym-equipment-rack']=m
    return kit


def closed_door(s, id, x, z, y=0, width=1.15, height=2.25, angle=0):
    e=s.box(id,[x,y+height/2,z],[width,height,.065], 'Door leaf in a framed opening', 'door','wood',support='ground',rotation=quat_y(angle))
    dx,dz=math.cos(math.radians(angle)), -math.sin(math.radians(angle))
    s.box(id+'-handle',[x+dx*width*.35,y+1.05,z+dz*width*.35+.055],[.16,.035,.045],
          'Door lever fixed to leaf','trim','metal',support=id,rotation=quat_y(angle))
    return e


def corridor(s):
    n=s.n; v2=n==13; did='half-open-door-v2-entity' if v2 else 'half-open-door-entity'
    s.keep(did)
    door=s.get(did);p=door['visual']['params']; w=p['width'];h=p['height']
    cx=.35 if v2 else 0; dz=-9 if v2 else -8; roomz=dz-3.5;half=2.45 if v2 else 2.2; ceiling=3.4 if v2 else 3.2
    # The root is the stationary hinge, not the leaf centre. The full opening is
    # in the partition, with a real dark room beyond it rather than a black box.
    p.update(hingeOrigin=True,depth=.075)
    door['transform']['position']=[cx-w/2,.02,dz]
    door['bounds']={'type':'box','min':[0,0,-.1],'max':[w,h,.1]}
    door['layout']=dict(role='door',purpose='Hinged half-open destination door, attached to jamb',support='ground')
    for anchor in s.env['semanticAnchors']:
        if anchor['entityId']==did:
            anchor['localAnchor'][0]+=w/2
            b=anchor.get('localBounds')
            if b:
                if b['type']=='sphere':b['center'][0]+=w/2
                else:b['min'][0]+=w/2;b['max'][0]+=w/2
    roof=s.shell('corridor',[-half,half,roomz,8],ceiling,{'south':[('hall-entry',0,1.35,0,2.3,'door')],
              'north':[('utility-window',cx,1.1,1.25,1.05,'window')]},color='#6d756d')
    s.wall('arch-door-partition','x',dz,-half,half,0,ceiling,
           [('destination-opening',cx,w+.06,0,h+.06,'door')],color='#858577')
    for i,z in enumerate([5,-1,-5.4]):s.ceiling_light(f'arch-hall-light-{i}',0,z,ceiling,roof,24,.62)
    s.box('arch-service-room-shelf',[half-.34,1.1,roomz+1.1],[.36,2.2,.95],
          'Utility cupboard against service-room wall','furniture','wood',support='ground')
    s.box('arch-hall-exit-sign',[0,2.62,7.85],[.66,.24,.08],'Exit sign mounted over hall entrance',
          'fixture','emissive','#52725d',support='hall-entry-head',sign='EXIT')
    # A radiator is genuinely against a wall and outside the 1.35m clear route.
    for j in range(9):s.box(f'arch-radiator-fin-{j}',[-half+.19,.6,2+j*.075],[.12,.58,.052],
                           'Wall-mounted radiator','fixture','metal','#abb0aa',support='arch-corridor-west-end')
    if v2:s.person('set-caretaker',[half-.85,0,roomz+1.3],'Caretaker in utility room, not behind an exterior wall','#465448')
    s.path('arch-hall-runner',[(0,7.8),(0,dz+.45)],1.35,'Continuous unobstructed corridor circulation','#756c60')
    s.receipt['notes'].append('Closed outer shell, continuous ceiling, genuine doorway and room behind the moving hinged leaf.')
    s.env['world']['overviewCamera']={'position':[9,9,13],'target':[0,1,-2]}


def studio(s):
    n=s.n
    actors=[e['id'] for e in s.entities if s.is_subject(e)]
    s.keep(*actors)
    if n==5:
        rect=[-7,7,-17,8];h=6.6
        roof=s.shell('colonnade',rect,h,{'south':[('studio-entry',4.8,1.4,0,2.5,'door')],
                   'north':[('clerestory',0,5.5,4.4,1.45,'window')]})
        for j,z in enumerate([-5,-10,-15]):
            for side in [-1,1]:
                s.box(f'arch-colonnade-column-{side}-{j}',[side*3.8,h/2,z],[.5,h,.5],
                      'Repeated load-bearing column in perspective colonnade','column','stone',support='ground')
            s.box(f'arch-colonnade-beam-{j}',[0,h-.23,z],[14,.46,.52],
                  'Roof beam borne by aligned column pairs','beam','wood',support=f'arch-colonnade-column--1-{j}',cutaway='roof')
        for i,z in enumerate([1,-7,-13]):s.ceiling_light(f'arch-colonnade-light-{i}',0,z,h-.5,roof,70,1.8)
        s.env['world']['overviewCamera']={'position':[17,14,19],'target':[0,1,-5]}
    else:
        h=10.2 if n==7 else 5.5 if n==6 else 4.2
        rect=[-7.5,7.5,-8,8] if n in [6,7] else [-6,6,-7,7]
        roof=s.shell('studio',rect,h,{'south':[('studio-entry',4.3,1.3,0,2.4,'door')],
              'north':[('studio-window',-2.8,3.0,h-1.65,1.15,'window')]},color='#aea99d')
        # A working studio has an unobstructed shooting floor and a single
        # equipment station, rather than identical trusses in every corner.
        s.model('set-control-desk','workbench',[-4.7,0,-5.6],'Studio camera/lighting control workbench')
        s.model('set-control-chair','chair',[-4.7,0,-4.65],'Chair at control workbench',180)
        s.model('set-equipment-case','crate-stack',[4.8,0,-6],'Packed studio equipment kept in storage bay')
        s.person('set-studio-technician',[3.3,0,-4.8],'Lighting technician beside equipment store','#596b72',angle=175)
        for j,z in enumerate([-4,3]):
            s.box(f'arch-studio-rig-{j}',[0,h-.5,z],[rect[1]-rect[0],.16,.16],
                  'Overhead lighting rail fixed to opposing walls','beam','metal',support=roof,cutaway='roof')
            for i,x in enumerate([-3,3]):s.ceiling_light(f'arch-studio-light-{j}-{i}',x,z,h-.58,f'arch-studio-rig-{j}',90 if n==7 else 45)
        if n==6:s.receipt['notes'].append('The floating principal is intentional story action, not an unsupported set prop. Debug orbit ring removed.')
        if n==7:s.receipt['notes'].append('Double-height studio/fly space accommodates the authored bird-eye camera without piercing the ceiling.')
        s.env['world']['overviewCamera']={'position':[15,13,18],'target':[0,1,0]}


def workspace(s):
    s.keep('desk-entity','vase-entity','monitor-entity')
    # Contact height is shared: no 15mm gap between the tabletop and its props.
    desk=s.get('desk-entity');desk['transform']['position'][1]=.565
    desk['layout'].update(role='furniture',purpose='Long worktable supporting the vase and computer',support='ground')
    # The desk renderer builds to bounds, not merely the thin box visual.
    desk['bounds']['min'][1]=-.565
    for id in ['vase-entity','monitor-entity']:s.get(id)['layout'].update(support='desk-entity',purpose='Worktable '+id.split('-')[0])
    roof=s.shell('workspace',[-5.5,5.5,-4,8],3.4,{'west':[('workspace-window',-1.2,2.6,.9,1.85,'window')],
                    'south':[('workspace-entry',3.8,1.2,0,2.3,'door')]})
    s.model('set-desk-chair','chair',[1.1,0,-1.35],'Working chair behind monitor')
    s.model('set-keyboard','keyboard',[1.1,.64,.47],'Keyboard on the desk',support='desk-entity')
    s.model('set-reference-library','bookcase',[3.7,0,-3.65],'Reference books stored against rear wall')
    s.model('set-window-planter','planter-tree',[-4.15,0,-2.2],'Plant positioned beside workspace window')
    for i,z in enumerate([-1,3.6]):s.ceiling_light(f'arch-workspace-light-{i}',0,z,3.4,roof,40)
    s.box('set-desk-notebook',[-.05,.655,.22],[.3,.03,.42],'Notebook resting on the worktable','prop','fabric','#8c775a','desk-entity')
    s.env['world']['overviewCamera']={'position':[11,8,13],'target':[0,1,1]}


def living_room(s):
    n=s.n;s.keep('actor-entity' if n==14 else 'subject-entity')
    roof=s.shell('living',[-5.5,5.5,-4.2,7],3.5,{
       'north':[('living-window',-2.7,2.5,.9,1.9,'window')],
       'east':[('living-entry',4.8,1.25,0,2.3,'door')]},color='#b9b0a2' if n==14 else '#979589')
    s.model('set-sofa','lounge-sofa',[-.5,0,-3.25],'Sofa against rear living-room wall')
    s.model('set-reading-table','side-table',[-2.45,0,-2.8],'Side table beside sofa')
    s.model('set-reading-lamp','floor-lamp',[2.15,0,-2.8],'Floor-supported reading lamp beside sofa')
    s.get('set-reading-lamp')['layout']['light']={'color':'#ffd7a1','intensity':16,'distance':6,'offset':[0,1.49,0]}
    s.model('set-bookcase','bookcase',[4.3,0,-3.7],'Bookcase with reachable shelves against wall')
    s.box('set-reading-book',[-2.45,.585,-2.8],[.26,.03,.35],'Book placed on side table','prop','fabric','#7b443d','set-reading-table')
    s.ceiling_light('arch-living-light',0,2.4,3.5,roof,38,.8)
    s.env['world']['overviewCamera']={'position':[12,9,13],'target':[0,1,.5]}
    if n==18:s.receipt['notes'].append('Removed the unattached pupil-reflection sphere and floating coloured practicals; facial anchors and actor motion retained.')


def boxing_gym(s):
    s.keep('puncher-entity','fist-entity','impact-target-entity')
    roof=s.shell('gym',[-7,7,-7,8],4.6,{'west':[('gym-window',-2,3,2.7,1.3,'window')],
              'south':[('gym-entry',-4.5,1.4,0,2.4,'door')]},color='#a3a79e')
    s.box('arch-training-mat',[0,-.015,1.4],[7,.03,7.5],'Flush non-slip training surface','paving','fabric','#626b67','ground')
    s.box('set-target-base',[0,.055,-1.5],[1.15,.11,1.15],'Stable weighted base for impact target','furniture','metal',support='ground')
    s.rod('set-target-post',[0,.11,-1.5],[0,1.1,-1.5],.11,'Impact-pad support fixed to weighted base','set-target-base')
    s.get('impact-target-entity')['layout'].update(support='set-target-post',purpose='Mounted training impact pad')
    s.model('set-gym-rack','gym-equipment-rack',[-5.5,0,-5.4],'Training equipment stored in rear rack')
    s.model('set-gym-bench','slatted-bench',[4.8,0,-5.8],'Recovery bench outside training area')
    s.person('set-coach',[-4.6,0,1],'Coach observing from outside punching clearance','#6c7277')
    for i,x in enumerate([-3,3]):s.ceiling_light(f'arch-gym-light-{i}',x,0,4.6,roof,55,1.7)
    s.env['world']['overviewCamera']={'position':[14,11,17],'target':[0,1,0]}


def stage(s):
    s.keep('dancer-entity','stage')
    stage=s.get('stage');stage['transform']['position']=[0,.225,0]
    stage['visual']['params']['height']=.45
    stage['bounds']=bounds([6.4,.45,6.4]);stage['layout'].update(role='landing',purpose='Raised circular performance stage',support='ground')
    for k in s.get('dancer-entity')['transform']['position']['keyframes']:k['value'][1]=.45
    roof=s.shell('theatre',[-10.5,10.5,-10,12],7.2,{'west':[('stage-service-door',-7.7,1.5,0,2.5,'door')],
               'south':[('audience-entry',0,2.4,0,2.6,'door')]},color='#5d6064')
    s.stairs('arch-stage-access',[0,0,-4.16],(0,1),.45,width=1.35,going=.32,landing=.55,target='stage')
    # Lighting is mounted to a real rig, not represented by floating bright balls.
    for j,z in enumerate([-4.8,4]):
        beam=f'arch-stage-lightbar-{j}'
        s.box(beam,[0,6,z],[13,.16,.16],'Suspended stage lighting bar','beam','metal',support=roof,cutaway='roof')
        for side in [-1,1]:s.rod(f'{beam}-hanger-{side}',[side*5.5,6,z],[side*5.5,7.2,z],.035,'Ceiling hanger for lighting bar',roof,role='beam')
        for i,x in enumerate([-4,0,4]):s.ceiling_light(f'arch-stage-fixture-{j}-{i}',x,z,5.92,beam,48,.55)
    # Two short seating rows leave the central and side exit aisles clear.
    for row in range(2):
        for side in [-1,1]:s.model(f'set-audience-bench-{row}-{side}','slatted-bench',[side*3.2,0,8+row*1.6],
                                  'Audience bench facing performance stage',180)
    s.model('set-sound-console','workbench',[8.2,0,8.6],'Sound control workstation at rear of theatre',180)
    s.person('set-stage-technician',[8.2,0,7.4],'Sound technician at the control workstation','#5e6170',angle=180)
    if s.n==15:s.person('set-stagehand',[-8.7,0,-6.8],'Stagehand at service entrance','#6f6455')
    s.env['world']['overviewCamera']={'position':[19,14,22],'target':[0,1,1]}


def concourse(s):
    s.keep('actor-a-entity','actor-b-entity','briefcase-entity')
    roof=s.shell('concourse',[-15,15,-12,12],5.6,{
        'north':[('concourse-north-entry',0,3.0,0,3.0,'door'),('north-glazing',-8,6,1,3.6,'window')],
        'south':[('concourse-south-entry',0,3.0,0,3.0,'door'),('south-glazing',8,6,1,3.6,'window')],
        'west':[('west-glazing',0,8,1,3.6,'window')],
        'east':[('east-glazing',0,8,1,3.6,'window')]},color='#b5b9ac')
    for j,z in enumerate([-7,0,7]):
        for side in [-1,1]:s.box(f'arch-concourse-column-{j}-{side}',[side*11.2,2.65,z],[.48,5.3,.48],
                           'Concourse roof column outside main circulation','column','stone',support='ground')
        s.box(f'arch-concourse-beam-{j}',[0,5.43,z],[30,.34,.6],
              'Roof beam connecting column line','beam','wood',support=f'arch-concourse-column-{j}--1',cutaway='roof')
        for i,x in enumerate([-7,0,7]):s.ceiling_light(f'arch-concourse-light-{j}-{i}',x,z,5.22,roof,55,1.65)
    for side in [-1,1]:
        s.model(f'set-waiting-bench-{side}','slatted-bench',[side*12.8,0,-3.4],'Waiting bench outside central concourse',-side*90)
        s.model(f'set-concourse-planter-{side}','planter-tree',[side*12.8,0,5.4],'Plant in window-side waiting area')
    s.model('set-ticket-machine','vending-machine',[-13.9,0,-8.5],'Ticket vending machine against concourse wall',90)
    s.box('arch-wayfinding',[0,3.65,-9.5],[2.3,.38,.1],'Suspended wayfinding sign facing arrivals',
          'fixture','metal','#426361',support=roof,sign='EXIT  /  PLATFORMS')
    for x in [-.85,.85]:s.rod(f'arch-sign-hanger-{x}',[x,3.84,-9.5],[x,5.6,-9.5],.018,'Wayfinding ceiling suspension',roof,role='fixture')
    s.person('set-commuter-a',[-9,0,5],'Commuter in side circulation lane','#756652',[-9,0,-4])
    s.person('set-commuter-b',[9,0,-5],'Commuter approaching waiting area','#5c7181',[9,0,4])
    s.env['world']['exposure']=1.1
    s.env['world']['overviewCamera']={'position':[24,18,27],'target':[0,1,0]}


def stairwell(s):
    s.keep('detective-entity','pursuer-entity','ambush-column')
    roof=s.shell('stairwell',[-9,10,-8,7],8.8,{
       'south':[('stairwell-entry',-6,1.4,0,2.4,'door')],
       'north':[('lower-exit',-1.8,1.2,0,2.3,'door'),('upper-exit',7.3,1.2,3.06,2.3,'door'),
                 ('stairwell-window',-5.7,2,4.6,2.1,'window')]},color='#949e98')
    column=s.get('ambush-column');column['transform']['position'][1]=4.2
    column['visual']['params']['size'][1]=8.4;column['bounds']=bounds([.72,8.4,.72])
    column['layout'].update(role='column',purpose='Ambush column supporting transverse roof beam',support='ground')
    s.box('arch-stairwell-crossbeam',[.5,8.6,-.45],[19,.4,.72],
          'Roof beam borne by ambush column and perimeter walls','beam','concrete',support='ambush-column',cutaway='roof')
    # Back gallery is a real first floor. The camera's vertical move stays in the
    # double-height void in front of it, never passing through an upper slab.
    s.box('arch-upper-gallery',[.5,2.94,-6.1],[18.8,.24,3.58],
          'First-floor circulation gallery connected to stair landing','landing','concrete',support='ground')
    for x in [-8.3,.5,9.3]:s.box(f'arch-gallery-column-{x}',[x,1.41,-4.65],[.22,2.82,.22],
                         'Upper gallery support column','column','concrete',support='ground')
    sx=7.3;front=-4.31;run=18*.28
    s.stairs('arch-main-stair',[sx,0,front+1.2+run],(0,-1),3.06,target='arch-upper-gallery')
    s.railing('arch-gallery-front',[-8.9,3.06,front],[sx-.7,3.06,front])
    s.railing('arch-gallery-front-right',[sx+.7,3.06,front],[9.9,3.06,front])
    closed_door(s,'arch-upper-exit-leaf',7.3,-8,3.075,1.12,2.25)
    closed_door(s,'arch-lower-exit-leaf',-1.8,-8,.015,1.12,2.25)
    s.box('arch-lower-exit-sign',[-1.8,2.65,-7.82],[.65,.25,.075],
          'Exit sign above functioning ground-floor doorway','fixture','emissive','#54745d','lower-exit-head',sign='EXIT')
    for i,(x,z) in enumerate([(-5,2),(5,2),(0,-6)]):s.ceiling_light(f'arch-stairwell-light-{i}',x,z,8.8,roof,90,1.4)
    s.env['world']['overviewCamera']={'position':[19,16,19],'target':[0,2,-1]}
    s.receipt['notes'].append('18 equal 170mm risers, 280mm treads, paired handrails and 1.2m landing meet the first-floor gallery. No disconnected blocks.')


def warehouse(s):
    n=s.n
    ids=['worker-entity','coworker-entity','shelving-entity','crate-stack-entity'] if n==22 else ['worker_a','worker_b','central_machine','shelf_left','shelf_right','loading_bay_frame']
    s.keep(*ids)
    rect=[-13,13,-14,19] if n==22 else [-23,23,-18,22]
    h=8.5 if n==22 else 9.5
    openings={'south':[('warehouse-personnel-entry',-8,1.5,0,2.5,'door')],
              'north':[('warehouse-clerestory',3,8,5.5,1.5,'window')]}
    if n==23:openings['north']=[('warehouse-clerestory',-4,6,5.5,1.5,'window'),('loading-bay-opening',10,7.6,0,5.6,'door')]
    else:openings['east']=[('warehouse-goods-entry',12,4.4,0,4.5,'door')]
    roof=s.shell('warehouse',rect,h,openings,color='#acb0a5')
    for j,z in enumerate([-11,-3,5,13]):
        for side in [-1,1]:
            x=rect[0]+.4 if side<0 else rect[1]-.4
            s.box(f'arch-warehouse-column-{j}-{side}',[x,(h-.4)/2,z],[.3,h-.4,.3],
                  'Perimeter steel roof column','column','metal',support='ground')
        s.box(f'arch-warehouse-roof-beam-{j}',[0,h-.25,z],[rect[1]-rect[0],.5,.28],
              'Roof girder carried by perimeter column pair','beam','metal',support=f'arch-warehouse-column-{j}--1',cutaway='roof')
        for i,x in enumerate([-8,0,8]):s.ceiling_light(f'arch-warehouse-light-{j}-{i}',x,z,h-.55,roof,100,1.8)
    if n==22:
        shelf=s.get('shelving-entity');shelf['transform']['position']=[-11.8,0,7.5];shelf['transform']['rotation']=quat_y(90)
        s.get('crate-stack-entity')['transform']['position']=[10.2,0,4.8]
        s.mezzanine('set-mezzanine',-8,-11,6,4,stair_x=-10.15)
        for j,z in enumerate([-.5,10]):s.model(f'set-stock-rack-{j}','warehouse-shelf',[11.8,0,z],'Stock rack at perimeter, facing picking aisle',90)
        forklift_start=[7.5,0,-6.6];forklift_end=[-3.8,0,-6.6]
    else:
        s.get('shelf_left')['transform'].update(position=[-20.8,0,2.5],rotation=quat_y(90))
        s.get('shelf_right')['transform'].update(position=[20.8,0,-3],rotation=quat_y(90))
        s.get('central_machine')['transform']['position']=[0,2,-12.8]
        s.mezzanine('set-mezzanine',-12,-14,8,5,stair_x=-14.5)
        bay=s.get('loading_bay_frame');bay['transform']['position']=[10,0,-18];bay['transform']['rotation']=quat_y(90)
        bay['bounds']=copy.deepcopy(s.kit['loading-bay-portal']['bounds'])
        bay['layout'].update(role='door',purpose='Loading-bay portal integrated into exterior wall',support='ground')
        for j,z in enumerate([-8,7,15]):s.model(f'set-stock-rack-{j}','warehouse-shelf',[-20.8,0,z],'Stock stored along west warehouse wall',90)
        # The bay is an opening in the east wall, with a connected external apron.
        s.box('arch-loading-apron',[10,-.15,-21],[8,.3,6],'Level exterior loading apron connected to bay threshold','floor','concrete',support='ground')
        forklift_start=[9,0,-7.7];forklift_end=[-5,0,-7.7]
    fork=s.model('set-forklift','forklift',forklift_start,'Forklift in marked rear goods lane',-90)
    duration=s.env['clock']['durationSeconds']
    fork['transform']['position']={'interpolation':'linear','extrapolation':'hold','keyframes':[
          {'t':0,'value':forklift_start},{'t':duration*.35,'value':forklift_start},
          {'t':duration*.75,'value':forklift_end},{'t':duration,'value':forklift_end}]}
    for side in [-1,1]:s.path(f'arch-goods-lane-{side}',[(forklift_end[0]-2,forklift_start[2]+side*1.85),
            (forklift_start[0]+2,forklift_start[2]+side*1.85)],.055,'Paint marking forklift operating lane','#c5a454')
    s.model('set-maintenance-bench','workbench',[rect[1]-2,0,-12],'Machine-maintenance bench in service zone',-90)
    s.person('set-maintenance-technician',[rect[1]-3.2,0,-12],'Technician working at service bench','#b48a46',angle=90)
    # Paired principal workers remain on their authored ground-floor paths.
    for e in s.entities:
        if e['id'] in ['worker-entity','worker_a']:
            for k in e['transform']['position']['keyframes']:k['value'][1]=0
    s.env['world']['overviewCamera']={'position':[rect[1]+12,24,rect[3]+13],'target':[0,2,-1]}
    s.receipt['notes'].append('Central worker circulation, rear forklift lane and perimeter storage are separate; mezzanine has an open stair entrance and fully supported floor.')


def rooftop(s):
    s.keep('runner-entity','pursuer-entity','ac-unit-entity','vent-pipe-entity')
    g=s.env['world']['ground'];g.update(render=False,size=[17,29],continuation='none')
    # Building facade below roof datum: a rooftop must not continue as an infinite
    # ground-level concrete plane. Interior stair descends to the floor below.
    s.shell('building',[-8.5,8.5,-14.5,14.5],9,{
         'south':[('facade-window',0,8,2.1,2.0,'window')],
         'east':[('east-facade-window',1,10,2.1,2,'window')]},y=-9,roof=False,color='#96988d')
    for ent in s.entities:
        if ent['id'].startswith('arch-building-'):
            ent['layout'].pop('cutaway',None);ent['layout'].pop('outwardNormal',None)
    g['render']=False;g['size']=[17,29]
    # Three slab strips tile the roof around a genuine stair opening.
    hx0,hx1,hz0,hz1=-6.75,-5.25,-12.15,-6.96
    for id,rect in [('west',[-8.5,hx0,-14.5,14.5]),('east',[hx1,8.5,-14.5,14.5]),
                    ('back',[hx0,hx1,-14.5,hz0]),('front',[hx0,hx1,hz1,14.5])]:
        x0,x1,z0,z1=rect
        s.box('arch-roof-slab-'+id,[(x0+x1)/2,-.14,(z0+z1)/2],[x1-x0,.28,z1-z0],
              'Weatherproof roof slab around real stairwell opening','floor','concrete',support='ground')
    for side,axis,fixed,lo,hi in [('north','x',-14.5,-8.5,8.5),('south','x',14.5,-8.5,8.5),
                                 ('west','z',-8.5,-14.5,14.5),('east','z',8.5,-14.5,14.5)]:
        p=[(lo+hi)/2,.52,fixed] if axis=='x' else [fixed,.52,(lo+hi)/2]
        size=[hi-lo,1.04,.22] if axis=='x' else [.22,1.04,hi-lo]
        s.box('arch-parapet-'+side,p,size,'Continuous roof-edge safety parapet','wall','concrete',support='ground')
        p[1]=1.075;size[1]=.07
        if axis=='x':size[2]=.3
        else:size[0]=.3
        s.box('arch-parapet-cap-'+side,p,size,'Weather coping on parapet','trim','metal',support='arch-parapet-'+side)
    roof=s.shell('roof-access',[-7.8,-4.2,-12.35,-5.56],2.65,{'south':[('roof-exit',-6,1.45,0,2.3,'door')]},floor=False,color='#b0b1a6')
    g['size']=[17,29];g['render']=False
    # Extend the shaft walls below the roof, around (not through) the stair flight.
    for side,x in [('west',-7.8),('east',-4.2)]:s.box('arch-access-shaft-'+side,[x,-1.53,-8.95],[.22,3.06,6.8],
                  'Stairwell side wall continuing to floor below','wall','concrete',support='ground')
    s.box('arch-floor-below',[0,-3.18,0],[16.78,.24,28.78],'Continuous occupied floor below roof, with clear bottom stair approach','floor','concrete',support='ground')
    s.stairs('arch-roof-stair',[-6,-3.06,-12],(0,1),3.06,target='arch-roof-slab-front')
    s.ceiling_light('arch-access-light',-6,-6.3,2.65,roof,18,.4)
    s.get('ac-unit-entity')['transform']['position']=[-3.2,.16,2]
    s.get('ac-unit-entity')['layout'].update(support='arch-ac-plinth',purpose='Roof HVAC unit on vibration-isolated plinth')
    s.box('arch-ac-plinth',[-3.2,.08,2],[2.15,.16,1.6],'HVAC mounting plinth','floor','concrete',support='ground')
    s.get('vent-pipe-entity')['transform']['position']=[1.8,1,-2.5]
    s.get('vent-pipe-entity')['layout'].update(support='ground',purpose='Vent stack rooted at roof surface, not buried through it')
    for i,(x,z) in enumerate([(5.7,-10),(-3.0,10.8)]):
        pad=s.box(f'arch-hvac-pad-{i}',[x,.08,z],[2.15,.16,1.6],'Plant service mounting pad','floor','concrete',support='ground')
        s.model(f'set-rooftop-hvac-{i}','rooftop-hvac',[x,.16,z],'HVAC aligned in roof services zone',support=pad['id'])
    s.path('arch-roof-walkway',[(-6,-4.8),(-6,4),(-4.5,4)],1.0,'Roof-maintenance route from access door','#aba89a')
    s.person('set-roof-technician',[-4.7,0,2],'Maintenance technician servicing HVAC','#8c754d',angle=90)
    s.person('set-roof-technician-2',[5.7,0,-8.4],'Second technician inspecting rear HVAC','#526775',angle=180)
    s.env['world']['overviewCamera']={'position':[22,17,26],'target':[0,-1,0]}
    s.receipt['notes'].append('Roof datum remains Y=0. Building extends nine metres below; roof access contains a stair to Y=-3.06 and a real aperture in the roof slab.')


def park(s):
    n=s.n
    s.keep(*(['person1-entity','person2-entity'] if n==9 else ['jogger-entity','tree-entity','fountain-entity','lamppost-entity']))
    s.env['world']['ground'].update(size=[30,36] if n==9 else [26,30],continuation='terrain')
    if n==9:
        s.path('arch-approach-west',[(-9,12),(-4,2),(0,-4)],2.3,'West approach joining rendezvous promenade')
        s.path('arch-approach-east',[(9,12),(4,2),(0,-4)],2.3,'East approach joining rendezvous promenade')
        s.path('arch-promenade',[(0,-3),(0,-15)],3.0,'Shared promenade after rendezvous')
        trees=[(-10,-9),(10,-9),(-11,8),(11,8)]
        benches=[(-4.4,-7.5,90),(4.4,-7.5,-90)]
        s.person('set-park-walker',[-.75,0,-15],'Distant walker on the promenade','#66795c',[-.75,0,-12])
    else:
        # The jogger used to finish inside the fountain's basin. Keep the route
        # and event timing; move the fountain onto its own connected forecourt.
        s.get('tree-entity')['transform']['position']=[-3.4,0,4]
        s.get('fountain-entity')['transform']['position']=[.5,0,-4.6]
        s.get('lamppost-entity')['transform']['position']=[3.1,0,.5]
        s.path('arch-jogger-path',[(0,13),(0,-2.5)],2.6,'Jogger promenade ending before fountain basin')
        s.box('arch-fountain-court',[.5,-.018,-4.6],[7,.04,7],
              'Paved fountain forecourt connected to promenade','paving','stone',support='ground')
        s.path('arch-garden-branch',[(-8,-4.6),(9,-4.6)],1.8,'Cross path serving fountain seating')
        trees=[(-8,-9),(8,-9),(7,8)]
        benches=[(-4.3,-4.6,90),(5.3,-4.6,-90)]
        s.person('set-gardener',[-9.5,0,-8.5],'Gardener beside planted edge','#61724e')
    for i,(x,z) in enumerate(trees):s.model(f'set-garden-tree-{i}','planter-tree',[x,0,z],'Tree in planted edge, outside circulation')
    for i,(x,z,angle) in enumerate(benches):
        s.box(f'arch-bench-pad-{i}',[x,-.025,z],[2.8,.05,2.8],
              'Level seating pad connected to park paving','paving','stone',support='ground')
        s.model(f'set-park-bench-{i}','slatted-bench',[x,0,z],'Park bench facing promenade/fountain',angle)
        s.model(f'set-park-lamp-{i}','streetlamp',[x+(-1.2 if x<0 else 1.2),0,z-1.9],
                'Walkway light outside seating and walking clearance',180 if x>0 else 0)
    s.env['world']['overviewCamera']={'position':[22,18,25],'target':[0,1,0]}


def road(s):
    s.keep(*(e['id'] for e in s.entities if s.is_subject(e)))
    n=s.n;depth=660 if n==10 else 110 if n==12 else 86
    s.env['world']['ground'].update(size=[28,depth],continuation='terrain')
    # Authored lanes are independent of the overall scene extent. Increasing
    # the support terrain must not spread lane markings apart.
    for side in [-1,1]:
        s.path(f'arch-road-edge-{side}',[(side*4.5,-depth/2),(side*4.5,depth/2)],.11,'Continuous road edge line','#eee9d8')
        s.path(f'arch-road-shoulder-{side}',[(side*8.5,-depth/2),(side*8.5,depth/2)],7.6,'Paved service shoulder','#787a73')
        s.box(f'arch-guardrail-{side}',[side*12.3,.82,0],[.13,.28,depth],
              'Continuous roadside crash barrier on fixed posts','railing','metal',support='ground')
        for i in range(math.ceil(depth/12)+1):
            z=-depth/2+i*depth/math.ceil(depth/12)
            s.box(f'arch-guardrail-post-{side}-{i}',[side*12.3,.43,z],[.12,.86,.12],
                  'Crash-barrier support post','column','metal',support='ground')
        # Lamps belong to the road edge, not to scattered islands on the asphalt.
        for i in range(math.ceil(depth/(70 if n==10 else 30))):
            z=-depth*.42+i*depth/math.ceil(depth/(70 if n==10 else 30))
            s.model(f'set-road-lamp-{side}-{i}','streetlamp',[side*13.3,0,z],
                    'Road-edge luminaire with base and inward-facing arm',180 if side>0 else 0)
    for i in range(math.ceil(depth/7)):
        z=-depth/2+(i+.5)*depth/math.ceil(depth/7)
        s.box(f'arch-centre-line-{i}',[0,.003,z],[.1,.006,2.7],
              'Dashed centre-line road marking','marking','stone','#ebe7d6','ground')
    s.env['world']['overviewCamera']=({'position':[30,20,110],'target':[0,1,72]} if n==10 else
                                      {'position':[27,18,30],'target':[0,1,0]})


def athletics(s):
    s.keep('runner-entity','hurdle-a','hurdle-b','hurdle-c','finish-left','finish-right','finish-banner')
    s.env['world']['ground'].update(size=[180,46],continuation='terrain')
    # Cover the complete authored run, including the last 17 metres that used
    # to extend beyond the visible ground rectangle.
    a=(-25,-3.25);b=(85,9.5)
    s.path('arch-running-track',[a,b],8.2,'Continuous athletics straight aligned with full runner route','#986b57')
    for lane in range(-3,4):
        offset=lane*1.15
        s.path(f'arch-lane-mark-{lane}',[(a[0],a[1]+offset),(b[0],b[1]+offset)],.045,
               'Athletics lane marking','#e9e1ce',elevation=.008)
    for i,x in enumerate([-10,38,65]):
        z=-9 if i<2 else 17
        s.model(f'set-athletics-bench-{i}','slatted-bench',[x,0,z],'Rest bench outside running track',0 if z<0 else 180)
    for id in ['hurdle-a','hurdle-b','hurdle-c']:s.get(id)['layout'].update(purpose='Training cone marking inside track boundary',support='ground')
    s.person('set-track-official',[59.5,0,11.7],'Finish-line official standing clear of running lane','#826c47',angle=180)
    s.env['world']['overviewCamera']={'position':[42,33,52],'target':[25,0,3]}


def football(s):
    s.keep('ball-entity','goal-entity')
    s.env['world']['ground'].update(size=[30,38],continuation='terrain')
    # Mark the actual goal mouth at z=-8, not an unrelated pitch scaled from
    # the background rectangle. This is a compact practice ground.
    for side in [-1,1]:
        s.path(f'arch-touchline-{side}',[(side*8,-8),(side*8,14)],.075,'Practice-field touchline','#eeeee0')
        s.model(f'set-team-bench-{side}','slatted-bench',[side*11.5,0,2],'Team bench outside touchline',-side*90)
        for z in [-1,2,5]:s.person(f'set-spectator-{side}-{z}',[side*12.5,0,z],
                                 'Spectator at team bench outside playing area','#596e80',angle=-side*90)
    for name,z in [('goal',-8),('opposite',14),('halfway',3)]:s.path('arch-line-'+name,[(-8,z),(8,z)],.075,'Practice-field transverse marking','#eeeee0')
    for side in [-1,1]:s.path(f'arch-goal-area-{side}',[(side*5,-8),(side*5,-3),(0,-3)],.075,'Goal-area line aligned with goal','#eeeee0')
    s.person('set-goalkeeper',[-2.2,0,-7.3],'Goalkeeper protecting practice goal','#bb9856')
    s.person('set-defender',[-3.8,0,6],'Defender tracking back outside ball path','#80624d',[-3,0,-5])
    s.person('set-striker',[3.8,0,6],'Supporting striker in right channel','#455f77',[3.2,0,-5])
    for side in [-1,1]:
        for j,y in enumerate([.48,1.05,1.4]):
            s.box(f'arch-pitch-fence-{side}-{j}',[side*14,y,3],[.065,.045,30],
                  'Open perimeter boundary rail outside spectator area','railing','metal',support='ground')
        for i,z in enumerate([-12,-6,0,6,12,18]):s.box(f'arch-fence-post-{side}-{i}',[side*14,.7,z],[.085,1.4,.085],
                    'Perimeter fence support','column','metal',support='ground')
    s.env['world']['overviewCamera']={'position':[21,17,25],'target':[0,1,2]}


def build_scenes(kit):
    out=ROOT/'web/public/environments';receipts=[]
    for path in sorted((ROOT/'scripts/scene-layouts/base').glob('example-*.json')):
        s=Scene(json.loads(path.read_text()),kit);n=s.n
        if n==1:football(s)
        elif n in [2,5,6,7]:studio(s)
        elif n==3:workspace(s)
        elif n in [4,10,12]:road(s)
        elif n==8:boxing_gym(s)
        elif n in [9,20]:park(s)
        elif n in [11,13]:corridor(s)
        elif n in [14,18]:living_room(s)
        elif n in [15,24,25,26,27,28,32]:stage(s)
        elif n in [16,30,31]:concourse(s)
        elif n in [17,29]:athletics(s)
        elif n==19:stairwell(s)
        elif n==21:rooftop(s)
        elif n in [22,23]:warehouse(s)
        else:raise ValueError(f'No authored layout for {n}')
        env,receipt=s.finish()
        (out/path.name).write_text(json.dumps(env,ensure_ascii=False,indent=2)+'\n')
        receipts.append(receipt)
    docs=ROOT/'docs';docs.mkdir(exist_ok=True)
    (docs/'environment-layouts.json').write_text(json.dumps({'schemaVersion':'1.0','method':'authored functional layouts',
                        'scenes':receipts},indent=2)+'\n')
    (docs/'scene-inventory.json').write_text(json.dumps({'generatedAssetCount':len(kit),'scenes':[
        {'exampleId':r['exampleId'],'entities':r['entityCount'],'rooms':len(r['rooms']),
         'stairFlights':len(r['stairs']),'purposeDocumented':r['purposeCount']} for r in receipts]},indent=2)+'\n')
    print(f'Built {len(receipts)} authored environments, {sum(len(r["stairs"]) for r in receipts)} connected stair flights.')
