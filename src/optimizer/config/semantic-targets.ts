import { FRAMING_TARGETS, SHOT_SIZE_COVERAGE } from "../compiler/constants";
import type { SemanticTargetOptions } from "../types";

function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function interval(value: unknown, path: string): asserts value is [number, number] {
  if (!Array.isArray(value) || value.length !== 2 || !value.every(Number.isFinite)
    || value[0] < 0 || value[1] > 1 || value[0] > value[1]) {
    throw new Error(`${path} must be a finite ordered [minimum, maximum] interval within 0..1`);
  }
}

/** Validate compiler entry points too, so invalid regions cannot become silent no-ops. */
export function validateSemanticTargets(value: unknown): asserts value is SemanticTargetOptions | undefined {
  if (value === undefined) return;
  const root = "options.semanticTargets";
  const options = record(value, root);
  for (const key of Object.keys(options)) {
    if (key !== "shotSizeCoverage" && key !== "framingRegions") {
      throw new Error(`${root}.${key} is not a supported semantic target setting`);
    }
  }
  if (options.shotSizeCoverage !== undefined) {
    for (const [name, range] of Object.entries(record(options.shotSizeCoverage, `${root}.shotSizeCoverage`))) {
      const path = `${root}.shotSizeCoverage.${name}`;
      if (!Object.hasOwn(SHOT_SIZE_COVERAGE, name)) throw new Error(`${path} is not a known shot-size name`);
      interval(range, path);
      if (range[1] === 0) throw new Error(`${path} must permit positive projected subject height`);
    }
  }
  if (options.framingRegions !== undefined) {
    for (const [name, value] of Object.entries(record(options.framingRegions, `${root}.framingRegions`))) {
      const path = `${root}.framingRegions.${name}`;
      if (!Object.hasOwn(FRAMING_TARGETS, name)) throw new Error(`${path} is not a known framing name`);
      const region = record(value, path);
      if (Object.keys(region).some((key) => key !== "x" && key !== "y")) {
        throw new Error(`${path} supports only x and y intervals`);
      }
      interval(region.x, `${path}.x`);
      interval(region.y, `${path}.y`);
    }
  }
}
