import { loadEnvFile } from "node:process";
import {
  APICallError,
  createGateway,
  RetryError,
  type LanguageModel,
} from "ai";

/** Project-wide default for every production LLM call through Vercel AI Gateway. */
export const DEFAULT_GATEWAY_MODEL = "zai/glm-5.3-flash";

/** @deprecated Prefer DEFAULT_GATEWAY_MODEL; kept as a compatibility alias. */
export const DEFAULT_PIPELINE_MODEL = DEFAULT_GATEWAY_MODEL;

let envLoadAttempted = false;

export function loadProjectEnvOnce(): void {
  if (envLoadAttempted) return;
  envLoadAttempted = true;
  try {
    loadEnvFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function configuredModel(variable: string): string {
  loadProjectEnvOnce();
  return process.env[variable]?.trim()
    || process.env.LLM_MODEL?.trim()
    || DEFAULT_GATEWAY_MODEL;
}

export function getDirectorModelId(): string {
  return configuredModel("LLM_CSL_MODEL");
}

export function getGroundingModelId(): string {
  return configuredModel("LLM_GROUNDING_MODEL");
}

export function getRepairModelId(): string {
  loadProjectEnvOnce();
  return process.env.LLM_REPAIR_MODEL?.trim() || getDirectorModelId();
}

export function getPipelineLlmTimeoutMs(): number {
  loadProjectEnvOnce();
  const configured = Number(process.env.LLM_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0
    ? Math.min(configured, 10 * 60_000)
    : 180_000;
}

export function getPipelineTransportRetries(): number {
  loadProjectEnvOnce();
  const configured = Number(process.env.LLM_MAX_TRANSPORT_RETRIES);
  return Number.isInteger(configured) && configured >= 0
    ? Math.min(configured, 5)
    : 2;
}

function retryableModelError(error: unknown): boolean {
  if (APICallError.isInstance(error)) return error.isRetryable;
  if (RetryError.isInstance(error)) return retryableModelError(error.lastError);
  // AI Gateway's typed GatewayError lives in the provider package and is not
  // re-exported by `ai`; every GatewayError exposes this safe retryability bit.
  if (
    typeof error === "object"
    && error !== null
    && "isRetryable" in error
    && typeof error.isRetryable === "boolean"
  ) return error.isRetryable;
  return false;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

async function waitForRetry(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw abortReason(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(abortReason(signal));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export class PipelineModelTimeoutError extends Error {
  readonly timeoutMs: number;
  readonly attempts: number;
  readonly modelId: string;

  constructor(options: {
    timeoutMs: number;
    attempts: number;
    modelId: string;
    cause: unknown;
  }) {
    super(`The model request timed out after ${options.timeoutMs} ms.`, {
      cause: options.cause,
    });
    this.name = "PipelineModelTimeoutError";
    this.timeoutMs = options.timeoutMs;
    this.attempts = options.attempts;
    this.modelId = options.modelId;
  }
}

export interface PipelineModelCallOptions {
  modelId: string;
  timeoutMs: number;
  abortSignal?: AbortSignal;
  maxRetries?: number;
  /** Test-only override; production uses a two-second exponential backoff. */
  initialRetryDelayMs?: number;
}

/**
 * Runs one model operation with a total deadline and transport retries.
 *
 * AI SDK's internal retry delay throws a generic `Delay was aborted` when its
 * total deadline wins the race, which hides the provider error that caused the
 * retry. Keeping retries at this boundary lets the pipeline retain that cause
 * for safe, correlated server logging.
 */
export async function runPipelineModelCall<T>(
  operation: (abortSignal: AbortSignal) => Promise<T>,
  options: PipelineModelCallOptions,
): Promise<T> {
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs);
  const signal = options.abortSignal
    ? AbortSignal.any([options.abortSignal, timeoutSignal])
    : timeoutSignal;
  const maxRetries = Math.max(0, Math.min(5, options.maxRetries ?? getPipelineTransportRetries()));
  const initialRetryDelayMs = Math.max(0, options.initialRetryDelayMs ?? 2_000);
  let attempts = 0;
  let lastProviderError: unknown;

  while (attempts <= maxRetries) {
    attempts += 1;
    try {
      return await operation(signal);
    } catch (error) {
      if (options.abortSignal?.aborted) throw error;
      if (timeoutSignal.aborted) {
        throw new PipelineModelTimeoutError({
          timeoutMs: options.timeoutMs,
          attempts,
          modelId: options.modelId,
          cause: lastProviderError ?? error,
        });
      }
      lastProviderError = error;
      if (!retryableModelError(error) || attempts > maxRetries) throw error;
    }

    try {
      await waitForRetry(initialRetryDelayMs * (2 ** (attempts - 1)), signal);
    } catch (error) {
      if (options.abortSignal?.aborted) throw error;
      throw new PipelineModelTimeoutError({
        timeoutMs: options.timeoutMs,
        attempts,
        modelId: options.modelId,
        cause: lastProviderError ?? error,
      });
    }
  }

  // The loop always returns or throws; this guards against future edits that
  // accidentally make the retry bounds fall through.
  throw lastProviderError;
}

export interface PipelineModelOptions {
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  languageModel?: LanguageModel;
}

export interface ResolvedPipelineModel {
  id: string;
  model: LanguageModel | string;
}

/** Resolves a server-side AI Gateway model without exposing credentials to the web app. */
export function resolvePipelineModel(
  fallbackModel: () => string,
  options: PipelineModelOptions = {},
): ResolvedPipelineModel {
  loadProjectEnvOnce();
  const id = options.model?.trim() || fallbackModel();
  if (options.languageModel) return { id, model: options.languageModel };

  const apiKey = options.apiKey?.trim() || undefined;
  const baseURL = options.baseUrl?.trim()
    || process.env.AI_GATEWAY_BASE_URL?.trim()
    || undefined;
  const useCustomGateway = apiKey !== undefined
    || baseURL !== undefined
    || options.fetchImpl !== undefined;

  // AI SDK string model IDs intentionally resolve through its global provider,
  // which is Vercel AI Gateway by default. A custom Gateway instance is only
  // needed when credentials, endpoint, or fetch are overridden explicitly.
  if (!useCustomGateway) return { id, model: id };
  return {
    id,
    model: createGateway({
      ...(apiKey === undefined ? {} : { apiKey }),
      ...(baseURL === undefined ? {} : { baseURL: baseURL.replace(/\/$/, "") }),
      ...(options.fetchImpl === undefined ? {} : { fetch: options.fetchImpl }),
    })(id),
  };
}
