#!/usr/bin/env python3
"""Independent audit of the EXPORTED files, not the authoring functions.

60 Hz replay probes use the same documented quintic-Hermite and SLERP contract.
World geometry is transformed from the supplied AABBs. Not a mesh certificate.
"""
from __future__ import annotations
import argparse, importlib.util, json, math, sys
from pathlib import Path
import numpy as np
from scipy.spatial.transform import Rotation, Slerp
spec=importlib.util.spec_from_file_location('cinema_generator',Path(__file__).with_name('generate-cinematic-suite.py'))
gen=importlib.util.module_from_spec(spec); spec.loader.exec_module(gen)
ROOT=gen.ROOT; OUT=gen.OUT
AUDIT_FPS=60
T=np.linspace(0,48,48*AUDIT_FPS+1)


def replay(tr,t):
    s=tr['samples']; ts=np.array([x['t'] for x in s]); p=np.array([x['position'] for x in s]);v=np.array([x['positionVelocity'] for x in s]);a=np.array([x['positionAcceleration'] for x in s])
    ix=np.clip(np.searchsorted(ts,t,side='right')-1,0,len(s)-2); j=ix+1
    h=(ts[j]-ts[ix])[:,None];u=((t-ts[ix])/(ts[j]-ts[ix]))[:,None]
    delta=p[j]-p[ix]; v0=v[ix]*h;v1=v[j]*h;a0=a[ix]*h*h;a1=a[j]*h*h
    c3=10*delta-6*v0-4*v1-1.5*a0+.5*a1;c4=-15*delta+8*v0+7*v1+1.5*a0-a1;c5=6*delta-3*v0-3*v1-.5*a0+.5*a1
    position=p[ix]+v0*u+.5*a0*u*u+c3*u**3+c4*u**4+c5*u**5
    rotation=Slerp(ts,Rotation.from_quat([x['rotation'] for x in s]))(t)
    fov=np.interp(t,ts,[x['fovYDegrees'] for x in s])
    return position,rotation,fov


def boxes(w,t):
    result={}; occ={}
    for e in w.entities.values():
        if 'bounds' not in e:continue
        p,q,s=w.transform(e['id'],t);r=Rotation.from_quat(q).as_matrix()
        def make(b):
            if b['type']=='box':
                c=(np.array(b['min'])+b['max'])/2;half=(np.array(b['max'])-b['min'])/2
                wc=p+np.einsum('nij,nj->ni',r,s*c)
                ext=np.einsum('nij,nj->ni',np.abs(r),np.abs(s)*half)
            else:
                c=np.array(b.get('center',[0,0,0]));wc=p+np.einsum('nij,nj->ni',r,s*c)
                ext=np.sqrt(np.sum((r*(s*b['radius'])[:,None,:])**2,axis=2))
            return wc-ext,wc+ext
        result[e['id']]=make(e['bounds'])
        # Explicit post/rail proxies override enclosing object boxes for sight rays.
        obs=e.get('occlusion',{}).get('bounds')
        occ[e['id']]=[make(b) for b in obs] if obs is not None else [result[e['id']]]
    return result,occ


def corners(b):
    lo,hi=b
    return np.stack([np.column_stack([hi[:,k] if bit>>k&1 else lo[:,k] for k in range(3)]) for bit in range(8)],axis=1)


def project(points,p,r,fov):
    diff=points-p[:,None,:]; camera=np.einsum('nij,nkj->nki',r.as_matrix().transpose(0,2,1),diff)
    d=-camera[:,:,2]; tan=np.tan(np.deg2rad(fov)/2)[:,None]
    x=.5+camera[:,:,0]/(2*d*tan*16/9);y=.5-camera[:,:,1]/(2*d*tan)
    return x,y,d


def ray_hits(start,end,lo,hi):
    # Open segment: neither the camera endpoint nor target endpoint is a blocker.
    d=end-start; parallel=np.abs(d)<1e-11
    with np.errstate(divide='ignore',invalid='ignore'):
        a=(lo-start)/d;b=(hi-start)/d
    near=np.minimum(a,b);far=np.maximum(a,b)
    near=np.where(parallel,-np.inf,near);far=np.where(parallel,np.inf,far)
    outside=np.any(parallel&((start<lo)|(start>hi)),axis=1)
    entry=np.maximum(np.max(near,axis=1),1e-5);exit=np.minimum(np.min(far,axis=1),1-1e-4)
    return (~outside)&(entry<exit)


def audit_one(e,w,bounds,occlusion):
    folder=OUT/e['id'];tr=gen.load(folder/'trajectory.json');story=gen.load(folder/'storyboard.json');csl=gen.load(folder/'csl.json')
    errors=[];warnings=[];s=tr['samples'];ts=np.array([a['t'] for a in s])
    def require(ok,msg):
        if not ok:errors.append(msg)
    require(tr['environmentId']==w.name,'environment ID mismatch')
    require(tr['coordinates']==w.data['coordinates'],'coordinates mismatch')
    require(len(s)==1441 and np.all(np.diff(ts)>0) and ts[0]==0 and ts[-1]==48,'sample/time contract')
    require(np.max(np.abs(np.diff(ts)-1/30))<1e-7,'not uniformly sampled at 30 fps')
    require(all(not x.get('cutBefore',False) for x in s),'unexpected cut')
    q=np.array([x['rotation'] for x in s]);require(np.max(abs(np.linalg.norm(q,axis=1)-1))<1e-8,'non-unit quaternion')
    require(np.min(np.sum(q[:-1]*q[1:],axis=1))>=0,'quaternion sign discontinuity')
    p,r,fov=replay(tr,T)
    require(np.isfinite(p).all() and np.isfinite(q).all(),'non-finite values')
    require(np.min(fov)>10 and np.max(fov)<85,'FOV outside authored range')
    require(csl['totalDuration']==48,'CSL/trajectory duration mismatch')
    # Signed sphere-to-AABB proxy clearance. All supplied boxes are included.
    clearance=np.full(len(T),np.inf); nearest=np.full(len(T),'',dtype=object)
    for identifier,(lo,hi) in bounds.items():
        outside=np.maximum(np.maximum(lo-p,p-hi),0);distance=np.linalg.norm(outside,axis=1)
        inside=np.all((p>=lo)&(p<=hi),axis=1)
        distance[inside]=-np.min(np.minimum(p[inside]-lo[inside],hi[inside]-p[inside]),axis=1)
        better=distance<clearance;clearance[better]=distance[better];nearest[better]=identifier
    bad=clearance<.25
    require(not np.any(bad),'camera 0.25 m sphere touches a supplied AABB proxy')
    collision={'radiusMeters':.25,'minimumCenterToBoundsMeters':float(clearance.min()),
               'minimumSphereClearanceMeters':float(clearance.min()-.25),'failingSamples':int(bad.sum()),
               'nearestEntity':str(nearest[np.argmin(clearance)]),'timeOfMinimum':float(T[np.argmin(clearance)])}
    framing=[];visibility=[]
    for phase in story['phases']:
        mask=(T>=phase['start'])&(T<=phase['end'])
        for identifier in phase['primaryTargets']:
            require(identifier in bounds,'missing primary target '+identifier)
            if identifier not in bounds:continue
            pts=corners(bounds[identifier]);x,y,d=project(pts,p,r,fov)
            margin=np.minimum.reduce([x.min(axis=1),1-x.max(axis=1),y.min(axis=1),1-y.max(axis=1)])
            front=np.all(d>.05,axis=1); inside=(margin>=-1e-6)&front
            fail=mask&~inside
            require(not np.any(fail),f'primary bounds leave frame: {identifier}, {phase["actionId"]}')
            framing.append({'actionId':phase['actionId'],'target':identifier,'samples':int(mask.sum()),
                            'fullyInFramePercent':round(float(100*inside[mask].mean()),4),
                            'minimumEdgeMargin':round(float(margin[mask].min()),5),
                            'firstFailureTime':float(T[np.argmax(fail)]) if np.any(fail) else None})
            # Ground-plane master targets are spaces occupied by other objects.
            if identifier in ('athletics_track','football_pitch'):continue
            lo,hi=bounds[identifier];center=(lo+hi)/2
            # Centre and upper-body probes. This is conservative proxy visibility.
            probes=[center,center+np.column_stack([np.zeros(len(T)),(hi[:,1]-lo[:,1])*.3,np.zeros(len(T))])]
            visible=np.ones((len(T),len(probes)),dtype=bool); blockers={}
            for blocker,obstacles in occlusion.items():
                if blocker==identifier:continue
                for blo,bhi in obstacles:
                    for k,end in enumerate(probes):
                        hit=ray_hits(p,end,blo,bhi)&mask
                        if np.any(hit):blockers[blocker]=blockers.get(blocker,0)+int(hit.sum())
                        visible[:,k]&=~hit
            usable=visible.any(axis=1)
            pct=100*usable[mask].mean()
            item={'actionId':phase['actionId'],'target':identifier,'oneOrMoreProbesVisiblePercent':round(float(pct),3),
                  'bothProbesVisiblePercent':round(float(100*visible.all(axis=1)[mask].mean()),3),
                  'fullyBlockedSamples':int((mask&~usable).sum()),
                  'firstFullyBlockedTime':float(T[np.argmax(mask&~usable)]) if np.any(mask&~usable) else None,
                  'dominantProxyBlockers':sorted(blockers.items(),key=lambda a:-a[1])[:5]}
            visibility.append(item)
            if pct<99.9:warnings.append(f'{identifier}: {pct:.2f}% of {phase["start"]}–{phase["end"]}s has at least one clear centre/upper probe')
    v=np.array([a['positionVelocity'] for a in s]);acc=np.array([a['positionAcceleration'] for a in s])
    angular=(Rotation.from_quat(q[:-1]).inv()*Rotation.from_quat(q[1:])).magnitude()/np.diff(ts)*180/np.pi
    matrix=r.as_matrix();horizon=np.rad2deg(np.arcsin(np.clip(matrix[:,1,0],-1,1)))
    static=[]
    for phase in story['phases']:
        if phase['movement']=='static':
            ix=np.where((T>=phase['start'])&(T<=phase['end']))[0]
            posdrift=np.linalg.norm(p[ix]-p[ix[0]],axis=1).max()
            rotdrift=(r[ix[0]].inv()*r[ix]).magnitude().max()*180/np.pi
            static.append({'actionId':phase['actionId'],'maxTranslationMeters':float(posdrift),'maxRotationDegrees':float(rotdrift)})
            require(posdrift<1e-3 and rotdrift<.02,'static phase drift: '+phase['actionId'])
    motion={'maxSpeedMetersPerSecond':float(np.linalg.norm(v,axis=1).max()),
            'maxAccelerationMetersPerSecondSquared':float(np.linalg.norm(acc,axis=1).max()),
            'maxAngularSpeedDegreesPerSecond':float(angular.max()),
            'maxFovRateDegreesPerSecond':float(np.max(np.abs(np.diff(fov))*AUDIT_FPS)),
            'maxAbsoluteHorizonRollDegrees':float(np.abs(horizon).max()),
            'fovYRangeDegrees':[float(fov.min()),float(fov.max())],
            'cameraHeightRangeMeters':[float(p[:,1].min()),float(p[:,1].max())]}
    require(motion['maxAbsoluteHorizonRollDegrees']<.1,'horizon roll')
    # Beat snapshots give actual viewport coverage, not promises based only on prompts.
    beats=[]
    for event in w.data['events']:
        if not any(abs(event['time']-x)<1.1 for x in gen.SPECS[[s['id'] for s in gen.SPECS].index(e['id'])]['beats']):continue
        i=int(round(event['time']*AUDIT_FPS)); eventids=[k for k in event['subjects'] if k in bounds]
        recorded=[]
        for identifier in eventids:
            point=((bounds[identifier][0]+bounds[identifier][1])/2)[i:i+1,None,:]
            ex,ey,ed=project(point,p[i:i+1],r[i:i+1],fov[i:i+1])
            recorded.append({'id':identifier,'centreInViewport':bool(ed[0,0]>0 and 0<=ex[0,0]<=1 and 0<=ey[0,0]<=1)})
        beats.append({'eventId':event['id'],'time':event['time'],'subjects':recorded})
    report={'exampleId':e['id'],'environmentId':w.name,'auditFps':AUDIT_FPS,'cameraProbes':len(T),
            'status':'pass' if not errors else 'fail','errors':errors,'visibilityReviewNotes':warnings,
            'cameraClearance':collision,'framing':framing,'visibility':visibility,'staticPhases':static,'motion':motion,'eventCoverage':beats,
            'limits':['60 Hz discrete replay checks, not continuous swept-volume certification.',
                      'Bounds are supplied conservative proxies, not rendered animated mesh/limb intersections.',
                      'Frustum inclusion does not prove pixel-level visibility.',
                      'Visibility rays test centre and upper probes; a clear probe does not imply the whole subject is unobstructed.',
                      'Artistic quality and numerical optimizer convergence are not certified by these checks.']}
    gen.save(folder/'validation.json',report)
    return report


def main():
    dataset=gen.load(OUT/'dataset.json');reports=[]
    provenance=gen.load(OUT/'source-provenance.json')
    source_hash_checks={name:gen.sha(ROOT/value['path'])==value['sha256'] for name,value in provenance['worldFiles'].items()}
    runtime=gen.load(OUT/'runtime-validation.json')
    runtime_by_id={item['exampleId']:item for item in runtime['examples']}
    agreement=[]
    integrity=[]
    for name in ('stadium','factory'):
        w=gen.World(name);b,o=boxes(w,T)
        for example in dataset['examples']:
            if example['environmentId']!=name:continue
            r=audit_one(example,w,b,o)
            rt=runtime_by_id[example['id']]
            max_error=0.; checks=0
            for subject in rt['subjectChecks']:
                times=[sample['t'] for sample in subject['samples']]
                expected=np.array([sample['center'] for sample in subject['samples']])
                actual=w.subject(subject['id'],times)
                max_error=max(max_error,float(np.max(np.abs(actual-expected))));checks+=len(times)
            agreed=max_error<1e-6
            agreement.append({'exampleId':example['id'],'subjectSamples':checks,'maxAbsoluteCoordinateErrorMeters':max_error,'pass':agreed})
            meta=gen.load(OUT/example['id']/'metadata.json')
            folder=OUT/example['id']
            file_checks={'sourceEnvironmentSha256':gen.sha(w.path),'sourceGeneratorSha256':gen.sha(Path(gen.__file__)),
                         'promptSha256':gen.sha(folder/'prompt.txt'),'cslSha256':gen.sha(folder/'csl.json'),
                         'trajectorySha256':gen.sha(folder/'trajectory.json')}
            hashes_match=all(meta[key]==value for key,value in file_checks.items())
            mirrors_match=(folder/'trajectory.json').read_bytes()==(gen.PUBLIC/(example['id']+'-camera.json')).read_bytes() and (folder/'csl.json').read_bytes()==(gen.PUBLIC/(example['id']+'-csl.json')).read_bytes()
            integrity.append({'exampleId':example['id'],'metadataHashesMatch':hashes_match,'publicMirrorsMatch':mirrors_match})
            if not agreed:r['errors'].append('Python/native world sampler disagreement')
            if not hashes_match or not mirrors_match:r['errors'].append('Metadata hashes or public mirrors disagree')
            if not all(source_hash_checks.values()):r['errors'].append('Source environment changed')
            r['status']='pass' if not r['errors'] else 'fail'
            gen.save(folder/'validation.json',r)
            reports.append(r)
            print(r['exampleId'],r['status'],'errors:',r['errors'],flush=True)
            print('  clearance',r['cameraClearance'],'motion',r['motion'],flush=True)
            if r['visibilityReviewNotes']:print('  visibility:',r['visibilityReviewNotes'],flush=True)
    summary={'schemaVersion':'1.0','kind':'cinematicSuiteValidation','auditFps':AUDIT_FPS,
             'examples':len(reports),'passed':sum(r['status']=='pass' for r in reports),'totalCameraProbes':sum(r['cameraProbes'] for r in reports),
             'allWorldFilesUnmodified':all(source_hash_checks.values()),'sourceHashChecks':source_hash_checks,
             'nativeWorldSamplerAgreement':agreement,'artifactIntegrity':integrity,'reports':reports}
    gen.save(OUT/'validation-report.json',summary)
    return 0 if summary['passed']==10 else 1

if __name__=='__main__':sys.exit(main())
