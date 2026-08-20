import { z } from "zod";

/**
 * TypeScript types caught exceptions as `unknown` (not `Error`) under
 * strict mode, since JS allows throwing any value. This safely extracts a
 * readable message without an unchecked `as Error` cast: Zod validation
 * errors get their own readable formatting, real Errors use `.message`,
 * and anything else falls back to a best-effort string conversion.
 */
export function getErrorMessage(e: unknown): string {
  if (e instanceof z.ZodError) {
    return e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
  }
  if (e instanceof Error) {
    return e.message;
  }
  return String(e);
}
