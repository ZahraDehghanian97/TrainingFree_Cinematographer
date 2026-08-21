import { loadEnvFile } from "node:process";
import {
  createGateway,
  generateText,
  jsonSchema,
  Output,
  type LanguageModel,
} from "ai";
import type { EnvironmentV1 } from "../types/environment";
import {
  environmentQuerySchema,
  type EnvironmentQuery,
  type EnvironmentQueryResult,
} from "../types/environment-query";
import type { ZodTypeAny } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { executeEnvironmentQuery } from "./executor";

export const DEFAULT_ENVIRONMENT_QUERY_MODEL = "google/gemini-3.7-flash";

const environmentQueryOutput = Output.object({
  name: "environment_query",
  description: "A supported structured query against the provided environment",
  // Passing JSON Schema here avoids recursively expanding every branch of
  // the Zod union in AI SDK's generic types. The generated value is parsed
  // with environmentQuerySchema below before it leaves this module.
  schema: jsonSchema(zodToJsonSchema(
    environmentQuerySchema as unknown as ZodTypeAny,
    { $refStrategy: "none" },
  )),
});

let envLoadAttempted = false;

function loadProjectEnvOnce(): void {
  if (envLoadAttempted) return;
  envLoadAttempted = true;
  try {
    loadEnvFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export interface EnvironmentQueryOptions {
  /** Overrides LLM_MODEL from .env. */
  model?: string;
  /** Overrides the Gateway's AI_GATEWAY_API_KEY/OIDC authentication. */
  apiKey?: string;
  /** Overrides AI_GATEWAY_BASE_URL. */
  baseUrl?: string;
  /** Custom Gateway fetch implementation. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Direct model injection for deterministic tests or custom providers. */
  languageModel?: LanguageModel;
}

export function getEnvironmentQueryModel(): string {
  loadProjectEnvOnce();
  return process.env.LLM_MODEL?.trim() || DEFAULT_ENVIRONMENT_QUERY_MODEL;
}

function availableSubjectIds(env: EnvironmentV1): Set<string> {
  return new Set([
    ...env.targets.map((target) => target.id),
    ...env.entities.map((entity) => entity.id),
  ]);
}

function validateSubjectIds(env: EnvironmentV1, ids: string[]): void {
  const available = availableSubjectIds(env);
  const unknown = ids.filter((id) => !available.has(id));
  if (unknown.length > 0) {
    throw new Error(`LLM returned unknown environment subject ID(s): ${unknown.join(", ")}`);
  }
}

function referencedSubjectIds(query: EnvironmentQuery): string[] {
  switch (query.type) {
    case "subjectBoxesAtTime":
    case "subjectBoxesInRange":
      return query.subjectIds;
    case "firstWithinDistance":
    case "distanceCrossingCount":
      return [query.subjectAId, query.subjectBId];
    case "firstSpeedReached":
      return [query.subjectId];
    case "unsupported":
      return [];
  }
}

function subjectIndex(env: EnvironmentV1): string {
  const targetLines = env.targets.map((target) => {
    const entity = env.entities.find((candidate) => candidate.id === target.entityId);
    return `- target ${target.id}: ${target.label ?? target.id} (entity: ${target.entityId}${entity?.label ? `, ${entity.label}` : ""})`;
  });
  const targetEntityIds = new Set(env.targets.map((target) => target.entityId));
  const entityLines = env.entities
    .filter((entity) => !targetEntityIds.has(entity.id))
    .map((entity) => `- entity ${entity.id}: ${entity.label ?? entity.id}`);
  return [...targetLines, ...entityLines].join("\n");
}

function parserPrompt(env: EnvironmentV1, request: string): string {
  return `You parse natural-language questions about a tracked 3D environment into one supported query.
Return only the structured query; do not calculate the answer yourself.

Rules:
- Use subject IDs exactly as listed below; never invent IDs.
- Prefer semantic target IDs over entity IDs when both refer to the same subject.
- All times are seconds.
- Convert distance units to meters.
- Convert speeds to meters/second (for example 72 km/h = 20 m/s).
- "box", "bbox", "bounding box", "باکس" mean the subject's world-space 3D bounding box.
- "when A reaches/gets within X meters of B" => firstWithinDistance.
- "when A reaches speed Y" => firstSpeedReached.
- "how many times the distance between A and B became X" => distanceCrossingCount.
- A time range asking for boxes => subjectBoxesInRange. Only set sampleEverySeconds when the user explicitly requests a sampling interval.
- If the request is outside these operations, return unsupported with a concise reason.

Examples:
- "باکس توپ در ثانیه 3 کجاست؟" => subjectBoxesAtTime
- "باکس توپ و بازیکن را از ثانیه 2 تا 5 بده" => subjectBoxesInRange
- "کی بازیکن به دو متری توپ رسید؟" => firstWithinDistance
- "ماشین کی به سرعت 72 کیلومتر بر ساعت رسید؟" => firstSpeedReached with 20 m/s
- "فاصله بازیکن و دروازه چند بار 5 متر شد؟" => distanceCrossingCount

Environment: ${env.id}
Duration: ${env.clock.durationSeconds} seconds
Prompt context: ${env.prompt}
Available subjects:
${subjectIndex(env)}

User request:
${request}`;
}

export async function parseEnvironmentQuery(
  env: EnvironmentV1,
  request: string,
  options: EnvironmentQueryOptions = {},
): Promise<EnvironmentQuery> {
  loadProjectEnvOnce();
  const modelId = options.model?.trim() || getEnvironmentQueryModel();
  const apiKey = options.apiKey?.trim() || undefined;
  const baseURL = options.baseUrl?.trim()
    || process.env.AI_GATEWAY_BASE_URL?.trim()
    || undefined;
  const useCustomGateway = apiKey !== undefined
    || baseURL !== undefined
    || options.fetchImpl !== undefined;
  const model = options.languageModel ?? (useCustomGateway
    ? createGateway({
        ...(apiKey === undefined ? {} : { apiKey }),
        ...(baseURL === undefined ? {} : { baseURL: baseURL.replace(/\/$/, "") }),
        ...(options.fetchImpl === undefined ? {} : { fetch: options.fetchImpl }),
      })(modelId)
    : modelId);

  const result = await generateText({
    model,
    prompt: parserPrompt(env, request),
    temperature: 0,
    output: environmentQueryOutput,
  });

  const query = environmentQuerySchema.parse(result.output);
  validateSubjectIds(env, referencedSubjectIds(query));
  return query;
}

/**
 * LLM-powered entry point. The LLM only maps language to a typed query; all
 * geometry/time calculations are performed deterministically by the executor.
 */
export async function queryEnvironment(
  env: EnvironmentV1,
  request: string,
  options: EnvironmentQueryOptions = {},
): Promise<EnvironmentQueryResult> {
  const query = await parseEnvironmentQuery(env, request, options);
  return executeEnvironmentQuery(env, query);
}
