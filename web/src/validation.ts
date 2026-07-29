/** A validation error whose path points at the invalid JSON value. */
export class DataValidationError extends Error {
  readonly path: string;
  readonly code: string;

  constructor(path: string, message: string, code = "invalid-value") {
    super(`${path}: ${message}`);
    this.name = "DataValidationError";
    this.path = path;
    this.code = code;
  }
}

export type JsonObject = Record<string, unknown>;

export function fail(
  path: string,
  message: string,
  code = "invalid-value",
): never {
  throw new DataValidationError(path, message, code);
}

export function expectObject(value: unknown, path: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(path, "expected an object", "invalid-type");
  }
  return value as JsonObject;
}

export function expectArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    fail(path, "expected an array", "invalid-type");
  }
  return value;
}

export function expectString(value: unknown, path: string): string {
  if (typeof value !== "string") {
    fail(path, "expected a string", "invalid-type");
  }
  return value;
}

export function expectNonEmptyString(value: unknown, path: string): string {
  const result = expectString(value, path);
  if (result.trim().length === 0) {
    fail(path, "must not be empty");
  }
  return result;
}

export function expectBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    fail(path, "expected a boolean", "invalid-type");
  }
  return value;
}

export function expectFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(path, "expected a finite number", "invalid-number");
  }
  return value;
}

export function expectPositiveNumber(value: unknown, path: string): number {
  const result = expectFiniteNumber(value, path);
  if (result <= 0) {
    fail(path, "must be greater than 0", "out-of-range");
  }
  return result;
}

export function expectNonNegativeNumber(value: unknown, path: string): number {
  const result = expectFiniteNumber(value, path);
  if (result < 0) {
    fail(path, "must be greater than or equal to 0", "out-of-range");
  }
  return result;
}

export function expectInteger(value: unknown, path: string): number {
  const result = expectFiniteNumber(value, path);
  if (!Number.isInteger(result)) {
    fail(path, "expected an integer", "invalid-number");
  }
  return result;
}

export function expectLiteral<T extends string>(
  value: unknown,
  literal: T,
  path: string,
): T {
  if (value !== literal) {
    fail(path, `expected ${JSON.stringify(literal)}`, "invalid-literal");
  }
  return literal;
}

export function expectOneOf<T extends string>(
  value: unknown,
  choices: readonly T[],
  path: string,
): T {
  if (typeof value !== "string" || !choices.includes(value as T)) {
    fail(
      path,
      `expected one of ${choices.map((choice) => JSON.stringify(choice)).join(", ")}`,
      "invalid-enum",
    );
  }
  return value as T;
}

export function parseJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new DataValidationError("$", `${label} is not valid JSON: ${detail}`, "invalid-json");
  }
}

