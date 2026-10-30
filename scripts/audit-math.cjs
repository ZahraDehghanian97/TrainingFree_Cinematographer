// Probe the current code alongside the historical examples in the math audit.
// From the repository root: node -r ts-node/register scripts/audit-math.cjs
// This reports selected quantities; it is not a full optimizer benchmark.
const path = require("node:path");
const source = (name) => require(path.join(__dirname, "../src/optimizer", name));
const { createCameraPositionSampler } = source("trajectory");
const { createSobolevFilter } = source("solver/sobolev-filter");
const { temporalQuadratureWeights } = source("solver/residual-integration");
const { applyOpticalZoom, fovDegreesToLogFocal } = source("shared/lens");

const states = [0, 1, 2, 3].map((t) => ({
  time: t, position: [t * t, 0, 0], rotation: [0, 0, 0, 1], fovYDegrees: 50,
}));
const at = createCameraPositionSampler(states, []);
const h = 1e-4;
const acceleration = (t) => (at(t + h)[0] - 2 * at(t)[0] + at(t - h)[0]) / (h * h);

const times = [0, 0.2, 1];
const positions = times.map((t) => t ** 3);
// The following finite differences are algebraic examples, not calls to the
// ObjectiveEvaluator. Optional relative regularity uses these stencils;
// default world regularity now integrates the actual position polynomial.
const accelerationStencil = 2 * (
  (positions[2] - positions[1]) / (times[2] - times[1])
  - (positions[1] - positions[0]) / (times[1] - times[0])
) / (times[2] - times[0]);
const discreteJerk = states[3].position[0] - 3 * states[2].position[0]
  + 3 * states[1].position[0] - states[0].position[0]; // Uniform dt = 1.

const smoothingSeconds = 0.25;
const z = createSobolevFilter(times, [0, 1, 2], [], smoothingSeconds)(Float64Array.from([1, -2, 3]));
const mass = [0.1, 0.5, 0.4];
const stiffness = [smoothingSeconds ** 2 / 0.2, smoothingSeconds ** 2 / 0.8];
const filterResidual = [
  mass[0] * (z[0] - 1) + stiffness[0] * (z[0] - z[1]),
  mass[1] * (z[1] + 2) + stiffness[0] * (z[1] - z[0]) + stiffness[1] * (z[1] - z[2]),
  mass[2] * (z[2] - 3) + stiffness[1] * (z[2] - z[1]),
];
const zoom = applyOpticalZoom(50, 2, "in");
const inlierFraction = 0.04;
const trials = 350;
const confidence = 0.99;

console.log(JSON.stringify({
  quadrature: temporalQuadratureWeights([0, 0.2, 0.2, 1], 0, 1),
  filterLinearSystemResidual: Math.max(...filterResidual.map(Math.abs)),
  opticalZoomFocalRatio: Math.exp(fovDegreesToLogFocal(zoom) - fovDegreesToLogFocal(50)),
  legacyDividedDifferenceExample: {
    stencil: accelerationStencil,
    atLegacyAssignedTime: 6 * times[1],
    atBarycenter: 6 * (times.reduce((sum, time) => sum + time, 0) / times.length),
  },
  quadraticKnotTrajectory: {
    discreteJerk,
    leftOutputAcceleration: acceleration(1 - 0.001),
    rightOutputAcceleration: acceleration(1 + 0.001),
  },
  ransacIndependentSamplingModel: {
    allInlierTripletProbability: -Math.expm1(trials * Math.log1p(-(inlierFraction ** 3))),
    trialsFor99Percent: Math.ceil(Math.log1p(-confidence) / Math.log1p(-(inlierFraction ** 3))),
  },
}, null, 2));
