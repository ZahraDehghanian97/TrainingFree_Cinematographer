/** Numerical starting guesses only: never compile these into authored targets. */
export const SEED_TRANSLATION_METERS = 2;
export const SEED_ORBIT_DEGREES = 45;
export const SEED_ROTATION_RADIANS = Math.PI / 6;
export const SEED_ROLL_RADIANS = Math.PI / 9;
export const SEED_ZOOM_FACTOR = 1.5;

/** Candidate choices belong to initialization, never to the compiled intent. */
export interface SeedChoices {
  azimuth?: number;
  distanceScale?: number;
  elevation?: number;
  fovYDegrees?: number;
  movementAmounts?: ReadonlyMap<string, number>;
}

export function seedMotionKey(primitive: {
  sourceActionId?: string;
  id: string;
  type: string;
  parameters: Record<string, unknown>;
}): string {
  // Fused Arc + Dolly shares an action ID but has independent angular and
  // radial amounts. Keep their units separate while joining split bands.
  const schedule = primitive.type === "radiusSchedule" ? primitive.parameters.scheduleKey : undefined;
  const identity = typeof schedule === "string" ? schedule : primitive.sourceActionId ?? primitive.id;
  return `${identity}:${primitive.type}`;
}
