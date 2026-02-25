"use strict";
var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
var __spreadArray = (this && this.__spreadArray) || function (to, from, pack) {
    if (pack || arguments.length === 2) for (var i = 0, l = from.length, ar; i < l; i++) {
        if (ar || !(i in from)) {
            if (!ar) ar = Array.prototype.slice.call(from, 0, i);
            ar[i] = from[i];
        }
    }
    return to.concat(ar || Array.prototype.slice.call(from));
};
var _a;
Object.defineProperty(exports, "__esModule", { value: true });
exports.solveTimeline = solveTimeline;
var CSL_1 = require("../CSL");
var CSL_2 = require("../CSL");
var util = require("util");
var BASE_SPEED = {
    // Some default speed values taken from Chat-GPT
    dollyIn: 1.0,
    dollyOut: 1.0,
    panLeft: 0.6,
    panRight: 0.6,
    tiltUp: 0.5,
    tiltDown: 0.5,
    truckLeft: 0.9,
    truckRight: 0.9,
    pedestalUp: 0.7,
    pedestalDown: 0.7,
    arcLeft: 0.4,
    arcRight: 0.4,
    zoomIn: 0.8,
    zoomOut: 0.8,
    static: Infinity,
    follow: 1.0,
    track: 1.0,
    orbit: 0.3,
    craneUp: 0.6,
    craneDown: 0.6,
    dutchLeft: 0.4,
    dutchRight: 0.4
};
var LOSS_MAP = (_a = {},
    // Probably must change act from CameraMovementType to string 
    _a[CSL_1.CameraMovementType.DollyIn] = CSL_1.LossFunctionType.DollyMovement,
    _a[CSL_1.CameraMovementType.DollyOut] = CSL_1.LossFunctionType.DollyMovement,
    _a[CSL_1.CameraMovementType.PanLeft] = CSL_1.LossFunctionType.PanMovement,
    _a[CSL_1.CameraMovementType.PanRight] = CSL_1.LossFunctionType.PanMovement,
    _a[CSL_1.CameraMovementType.TiltUp] = CSL_1.LossFunctionType.TiltMovement,
    _a[CSL_1.CameraMovementType.TiltDown] = CSL_1.LossFunctionType.TiltMovement,
    _a[CSL_1.CameraMovementType.TruckLeft] = CSL_1.LossFunctionType.TruckMovement,
    _a[CSL_1.CameraMovementType.TruckRight] = CSL_1.LossFunctionType.TruckMovement,
    _a[CSL_1.CameraMovementType.PedestalUp] = CSL_1.LossFunctionType.PedestalMovement,
    _a[CSL_1.CameraMovementType.PedestalDown] = CSL_1.LossFunctionType.PedestalMovement,
    _a[CSL_1.CameraMovementType.ArcLeft] = CSL_1.LossFunctionType.ArcMovement,
    _a[CSL_1.CameraMovementType.ArcRight] = CSL_1.LossFunctionType.ArcMovement,
    _a[CSL_1.CameraMovementType.Follow] = CSL_1.LossFunctionType.DollyMovement,
    _a);
function indexActions(actions) {
    var map = new Map();
    for (var _i = 0, actions_1 = actions; _i < actions_1.length; _i++) {
        var action = actions_1[_i];
        if (map.has(action.id)) {
            throw new Error("Duplicate action id: ".concat(action.id));
        }
        map.set(action.id, action);
    }
    return map;
}
function tryResolveReferenceTime(action, reference) {
    switch (reference) {
        case CSL_1.RelativeTimeReference.Start:
            return action.startTime;
        case CSL_1.RelativeTimeReference.End:
            return action.endTime;
        case CSL_1.RelativeTimeReference.Middle:
            if (action.startTime !== undefined &&
                action.endTime !== undefined)
                return (action.startTime + action.endTime) / 2;
            return undefined;
    }
}
function solveTimeline(input_dsl) {
    // 1️ Resolve all actions globally
    var timedActions = resolveActionTimings(input_dsl.sections, input_dsl.totalDuration);
    // 2️ Build per-section outputs
    var sectionOutputs = [];
    var _loop_1 = function (section) {
        var initKeyframes = [];
        var constraints = [];
        initKeyframes.push(buildInitialKeyframe(section.initCamera));
        // Filter actions belonging to this section
        var sectionActions = timedActions.filter(function (a) {
            return section.actions.some(function (sa) { return sa.id === a.id; });
        });
        for (var _b = 0, sectionActions_1 = sectionActions; _b < sectionActions_1.length; _b++) {
            var action = sectionActions_1[_b];
            constraints.push.apply(constraints, buildActionConstraints(action));
        }
        sectionOutputs.push({
            initKeyframes: initKeyframes,
            constraints: constraints
        });
    };
    for (var _i = 0, _a = input_dsl.sections; _i < _a.length; _i++) {
        var section = _a[_i];
        _loop_1(section);
    }
    return { sections: sectionOutputs };
}
function isInterval(c) {
    return c.type === "interval";
}
function isIndependentTrigger(t) {
    return "type" in t && (t.type === "absoluteTime" ||
        t.type === "distance" ||
        t.type === "velocity");
}
function isRelativeTrigger(t) {
    return "type" in t && t.type === "relativeTime";
}
function resolveIndependentTrigger(t) {
    if (!("type" in t))
        return 0;
    if (t.type === "absoluteTime")
        return t.time;
    if (t.type === "distance")
        return 5;
    if (t.type === "velocity")
        return 3;
    return 0;
}
/*
function resolveTriggerTime(
  trigger: TriggerSpec,
  actionsById: Map<string, Action>,
  getOrResolve: (id: string) => TimedAction
): number {
  
  if ("type" in trigger) {
    if (trigger.type === "absoluteTime") return trigger.time;

    if (trigger.type === "relativeTime") {
      const referencedAction = getOrResolve(trigger.actionId);
      const anchorTime = resolveReferenceTime(referencedAction, trigger.reference);
      return anchorTime + trigger.offset;
    }
    if(trigger.type === "distance") return 5
    
    if(trigger.type === "velocity") return 3

    return 0;
  }

  if ("operator" in trigger) {
    const times = trigger.triggers.map(t => resolveTriggerTime(t, actionsById, getOrResolve));
    return trigger.operator === "and" ? Math.max(...times) : Math.min(...times);
  }

  return 0;
}
*/
function normalizeConstraints(constraints) {
    var boundaries = new Set();
    // Collect all time boundaries
    for (var _i = 0, constraints_1 = constraints; _i < constraints_1.length; _i++) {
        var c = constraints_1[_i];
        if (c.type === "interval") {
            boundaries.add(c.startTime);
            boundaries.add(c.endTime);
        }
        else {
            boundaries.add(c.time);
        }
    }
    var sorted = Array.from(boundaries).sort(function (a, b) { return a - b; });
    var timeline = [];
    var _loop_2 = function (i) {
        var start = sorted[i];
        var end = sorted[i + 1];
        var activeLosses = constraints
            .filter(isInterval)
            .filter(function (iv) { return iv.startTime < end && iv.endTime > start; })
            .map(function (iv) { return iv.lossFunction; });
        if (activeLosses.length > 0) {
            timeline.push({
                kind: "interval",
                startTime: start,
                endTime: end,
                lossFunctions: activeLosses
            });
        }
    };
    // Build interval segments
    for (var i = 0; i < sorted.length - 1; i++) {
        _loop_2(i);
    }
    // Insert point segments 
    for (var _a = 0, constraints_2 = constraints; _a < constraints_2.length; _a++) {
        var c = constraints_2[_a];
        if (c.type === "singlePoint") {
            timeline.push({
                kind: "point",
                time: c.time,
                lossFunctions: buildCameraConfigLosses(c.config)
            });
        }
    }
    // Final sort 
    timeline.sort(function (a, b) {
        var ta = a.kind === "interval" ? a.startTime : a.time;
        var tb = b.kind === "interval" ? b.startTime : b.time;
        if (ta !== tb)
            return ta - tb;
        // If same time → point comes first
        if (a.kind === "point" && b.kind === "interval")
            return -1;
        if (a.kind === "interval" && b.kind === "point")
            return 1;
        return 0;
    });
    return timeline;
}
function normalizeTimeline(inputTimeLine) {
    var allConstraints = [];
    for (var _i = 0, _a = inputTimeLine.sections; _i < _a.length; _i++) {
        var section = _a[_i];
        allConstraints.push.apply(allConstraints, section.constraints);
        for (var _b = 0, _c = section.initKeyframes; _b < _c.length; _b++) {
            var keyframe = _c[_b];
            allConstraints.push(keyframe);
        }
    }
    var normalized = normalizeConstraints(allConstraints);
    return normalized;
}
function resolveActionTimings(sections, totalDuration) {
    var _a;
    //---------------------------------------------
    // 1️⃣ Flatten all actions
    //---------------------------------------------
    var allActions = sections.flatMap(function (s) { return s.actions; });
    var state = new Map();
    for (var _i = 0, allActions_1 = allActions; _i < allActions_1.length; _i++) {
        var a = allActions_1[_i];
        state.set(a.id, __assign({}, a));
    }
    //---------------------------------------------
    // 2️⃣ PASS 1 — resolve independent startTimes
    //---------------------------------------------
    for (var _b = 0, _c = state.values(); _b < _c.length; _b++) {
        var a = _c[_b];
        if (isIndependentTrigger(a.trigger)) {
            a.startTime = resolveIndependentTrigger(a.trigger);
        }
    }
    var _loop_3 = function (a) {
        if (a.startTime === undefined)
            return "continue";
        var section = sections.find(function (s) {
            return s.actions.some(function (sa) { return sa.id === a.id; });
        });
        var dur = estimateDuration(section.initCamera, a);
        if (dur !== undefined) {
            a.duration = dur;
            a.endTime = a.startTime + dur;
        }
    };
    //---------------------------------------------
    // 3️⃣ PASS 2 — estimate durations if possible
    //---------------------------------------------
    for (var _d = 0, _e = state.values(); _d < _e.length; _d++) {
        var a = _e[_d];
        _loop_3(a);
    }
    //---------------------------------------------
    // 4️⃣ PASS 3 — resolve relative startTimes
    //---------------------------------------------
    var progress = true;
    while (progress) {
        progress = false;
        for (var _f = 0, _g = state.values(); _f < _g.length; _f++) {
            var a = _g[_f];
            if (a.startTime !== undefined)
                continue;
            if (!isRelativeTrigger(a.trigger))
                continue;
            var ref = state.get(a.trigger.actionId);
            if (!ref || ref.startTime === undefined)
                continue;
            var anchor = tryResolveReferenceTime(ref, a.trigger.reference);
            if (anchor === undefined)
                continue;
            a.startTime = anchor + a.trigger.offset;
            progress = true;
        }
    }
    //---------------------------------------------
    // 5️⃣ PASS 4 — Global Window Allocation
    //---------------------------------------------
    console.log("PASS 4 begins:");
    var ordered = allActions.map(function (a) { return state.get(a.id); });
    // Sort by startTime (resolved first)
    ordered.sort(function (a, b) {
        var _a, _b;
        var ta = (_a = a.startTime) !== null && _a !== void 0 ? _a : Infinity;
        var tb = (_b = b.startTime) !== null && _b !== void 0 ? _b : Infinity;
        return ta - tb;
    });
    console.log("ordered actions:", ordered);
    var _loop_4 = function (i) {
        var cur = ordered[i];
        if (!cur)
            return "continue";
        if (cur.startTime === undefined)
            return "continue";
        if (cur.duration !== undefined)
            return "continue";
        var next = ordered[i + 1];
        var windowEnd = (_a = next === null || next === void 0 ? void 0 : next.startTime) !== null && _a !== void 0 ? _a : totalDuration;
        var window_1 = windowEnd - cur.startTime;
        console.log("Window at iteration_".concat(i), window_1);
        if (window_1 <= 0)
            return "continue";
        var deps = ordered.filter(function (a) {
            return isRelativeTrigger(a.trigger) &&
                a.trigger.actionId === cur.id &&
                a.duration === undefined;
        });
        console.log("Dependecies of ".concat(cur.id, ": ").concat(deps));
        if (deps.length === 0) {
            cur.duration = window_1;
            cur.endTime = cur.startTime + window_1;
            return "continue";
        }
        var anchorOf = function (a) {
            var r = a.trigger.reference;
            if (r === CSL_1.RelativeTimeReference.Start)
                return 0;
            if (r === CSL_1.RelativeTimeReference.Middle)
                return 0.5;
            return 1;
        };
        var depsSorted = __spreadArray([], deps, true).sort(function (a, b) { return anchorOf(a) - anchorOf(b); });
        console.log("Sorted dependencies:", depsSorted);
        var points = __spreadArray([
            { t: 0, action: cur }
        ], depsSorted.map(function (d) { return ({ t: anchorOf(d), action: d }); }), true);
        console.log("Points:", points);
        for (var p = 0; p < points.length; p++) {
            var A = points[p];
            var B = points[p + 1];
            console.log("Action A:", A);
            console.log("Action B:", B);
            var seg = (B.t - A.t) * window_1;
            console.log("segmentation:", seg);
            if (A.action.duration === undefined) {
                A.action.duration = seg;
                console.log("Action A's duration:", A.action.duration);
                A.action.endTime = A.action.startTime + seg;
            }
        }
    };
    for (var i = 0; i < ordered.length; i++) {
        _loop_4(i);
    }
    //---------------------------------------------
    // 6️⃣ FINALIZE
    //---------------------------------------------
    for (var _h = 0, _j = state.values(); _h < _j.length; _h++) {
        var a = _j[_h];
        if (a.startTime === undefined)
            throw new Error("Unresolved startTime for ".concat(a.id));
        if (a.endTime === undefined) {
            a.endTime = a.startTime;
            a.duration = 0;
        }
    }
    return allActions.map(function (a) { return state.get(a.id); });
}
function degreesToDistance(deg, radius) {
    if (radius === void 0) { radius = 1; }
    // Degree to distance conversion using radian
    return (deg * Math.PI / 180) * radius;
}
function estimateDistance(m) {
    var _a, _b, _c, _d, _e;
    var p = (_a = m.parameters) !== null && _a !== void 0 ? _a : {};
    switch (m.act) {
        case CSL_1.CameraMovementType.PanLeft:
        case CSL_1.CameraMovementType.PanRight:
        case CSL_1.CameraMovementType.TiltUp:
        case CSL_1.CameraMovementType.TiltDown:
            return degreesToDistance((_b = p.rotationAngle) !== null && _b !== void 0 ? _b : 30);
        case CSL_1.CameraMovementType.DollyIn:
        case CSL_1.CameraMovementType.DollyOut:
        case CSL_1.CameraMovementType.TruckLeft:
        case CSL_1.CameraMovementType.TruckRight:
        case CSL_1.CameraMovementType.PedestalUp:
        case CSL_1.CameraMovementType.PedestalDown:
            return (_c = p.distance) !== null && _c !== void 0 ? _c : 2;
        case CSL_1.CameraMovementType.ArcLeft:
        case CSL_1.CameraMovementType.ArcRight:
            return degreesToDistance((_d = p.arcAngle) !== null && _d !== void 0 ? _d : 45, (_e = p.arcRadius) !== null && _e !== void 0 ? _e : 2);
        // Case: ZoomIn/out 
        // Case: Crane  
        default:
            return 1;
    }
}
function averageSpeedMultiplier(keyframes) {
    if (!keyframes || keyframes.length === 0)
        return 1;
    var total = 0;
    var lastT = 0;
    var sorted = __spreadArray([], keyframes, true).sort(function (a, b) { return a.normalizedTime - b.normalizedTime; });
    for (var _i = 0, sorted_1 = sorted; _i < sorted_1.length; _i++) {
        var kf = sorted_1[_i];
        var dt = kf.normalizedTime - lastT;
        total += dt * kf.speedMultiplier;
        lastT = kf.normalizedTime;
    }
    total += (1 - lastT) * sorted.at(-1).speedMultiplier;
    return total;
}
function estimateDuration(initCamera, action) {
    var _a;
    if (action.movement.duration !== undefined)
        return action.movement.duration;
    else if (action.movement.parameters) {
        // We have formula: (distance / (speed * speedMultiplier) * relativeFPS)
        var distance = estimateDistance(action.movement);
        var baseSpeed = (_a = BASE_SPEED[action.movement.act]) !== null && _a !== void 0 ? _a : 1;
        var speedMultiplier = averageSpeedMultiplier(action.movement.speedKeyframes);
        return (distance / (baseSpeed * speedMultiplier));
    }
    // We have total video duration n and k actions -> duration for each action will be n/k
    return undefined;
}
// Building Constraints
function buildInitialKeyframe(init) {
    return {
        type: "singlePoint",
        time: 0,
        config: init.config,
        weight: 1
    };
}
// This function extracts lossFunction's parameters from movementParameters 
function buildMovementLossParameters(action) {
    var _a, _b, _c, _d, _e;
    var p = (_a = action.movement.parameters) !== null && _a !== void 0 ? _a : {};
    switch (action.movement.act) {
        case CSL_1.CameraMovementType.DollyIn:
        case CSL_1.CameraMovementType.DollyOut:
            return { distance: (_b = p.distance) !== null && _b !== void 0 ? _b : 2 };
        case CSL_1.CameraMovementType.PanLeft:
        case CSL_1.CameraMovementType.PanRight:
            return { rotationAngle: (_c = p.rotationAngle) !== null && _c !== void 0 ? _c : 30 };
        case CSL_1.CameraMovementType.ArcLeft:
        case CSL_1.CameraMovementType.ArcRight:
            return {
                arcAngle: (_d = p.arcAngle) !== null && _d !== void 0 ? _d : 45,
                arcRadius: (_e = p.arcRadius) !== null && _e !== void 0 ? _e : 2
            };
        default:
            return {};
    }
}
function buildCameraConfigLosses(config) {
    var _a;
    var losses = [];
    if (config.type === "subjectAware") {
        if (config.shotSize)
            losses.push({
                type: CSL_1.LossFunctionType.ShotSize,
                parameters: { shotSize: config.shotSize }
            });
        if (config.subjectView)
            losses.push({
                type: CSL_1.LossFunctionType.SubjectView,
                parameters: { view: config.subjectView }
            });
        if ((_a = config.subjectFraming) === null || _a === void 0 ? void 0 : _a.position)
            losses.push({
                type: CSL_1.LossFunctionType.FramingPosition,
                parameters: { position: config.subjectFraming.position }
            });
    }
    if (config.type === "nonSubjectAware") {
        losses.push({
            type: CSL_1.LossFunctionType.MinPath,
            parameters: { targetPose: config.extrinsics.pose }
        });
    }
    return losses;
}
function buildConstraintConfigConstraints(cfg, action) {
    var losses = buildCameraConfigLosses(cfg.config);
    if (cfg.allFrames) {
        return losses.map(function (loss) { return ({
            type: "interval",
            startTime: action.startTime,
            endTime: action.endTime,
            lossFunction: loss,
            weight: 1
        }); });
    }
    return [{
            type: "singlePoint",
            time: action.endTime,
            config: cfg.config,
            weight: 1
        }];
}
function buildConstraintConfigs(action) {
    if (!action.constraints)
        return [];
    return action.constraints.flatMap(function (cfg) {
        return buildConstraintConfigConstraints(cfg, action);
    });
}
function buildMovementConstraint(action) {
    var lossType = LOSS_MAP[action.movement.act];
    if (!lossType)
        return [];
    return [{
            type: "interval",
            startTime: action.startTime,
            endTime: action.endTime,
            lossFunction: {
                type: lossType,
                parameters: buildMovementLossParameters(action)
            },
            weight: 1
        }];
}
function buildActionConstraints(action) {
    return __spreadArray(__spreadArray([], buildMovementConstraint(action), true), buildConstraintConfigs(action), true);
}
var res = solveTimeline(CSL_2.promptExamples[0].csl);
console.log(util.inspect(res.sections, { depth: null, colors: true }));
var finalRes = normalizeTimeline(res);
console.log(util.inspect(finalRes, { depth: null, colors: true }));
