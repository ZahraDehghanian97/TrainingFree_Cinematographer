"""Original procedural asset kit. Scene construction lives in generate-two-environments.py.
The previous 32 scene factories were removed; no hidden alternate catalogue remains.
"""
from pathlib import Path

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


def build_scenes(_manifest=None):
    import runpy
    runpy.run_path(str(Path(__file__).with_name('generate-two-environments.py')), run_name='__main__')
