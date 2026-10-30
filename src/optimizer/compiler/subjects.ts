import { subjectIdsFromParameters } from "../shared/parameter-values";
import type { CameraOptimizerInput } from "../types";

export function subjectParameters(
  parameters: Record<string, unknown>,
): Record<string, unknown> {
  const subjectIds = subjectIdsFromParameters(parameters);
  return subjectIds.length > 0 ? { subjectIds } : {};
}

export function subjectEntityKey(
  input: CameraOptimizerInput,
  subjectIds: readonly string[],
): string {
  return [...new Set(subjectIds.map((subjectId) =>
    input.environment.semanticAnchors.find((anchor) => anchor.id === subjectId)?.entityId
      ?? subjectId,
  ))].sort().join("|");
}
