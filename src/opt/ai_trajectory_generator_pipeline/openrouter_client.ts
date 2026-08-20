import {
  OPENROUTER_API_URL,
  OPENROUTER_API_KEY_ENV,
  OPENROUTER_HTTP_REFERER,
  OPENROUTER_APP_TITLE,
  DEFAULT_MODEL,
  DEFAULT_TEMPERATURE,
  DEFAULT_MAX_TOKENS,
  DEFAULT_REASONING_MAX_TOKENS,
} from "./config.js";
import { getErrorMessage } from "./errors.js";

// To Avoid HTTP403 error
import { ProxyAgent, setGlobalDispatcher } from "undici";

setGlobalDispatcher(
  new ProxyAgent("http://192.168.144.1:8080")
);


/** Raised for genuine request-level failures: auth, network, non-200 HTTP
 * status, or a response so malformed it has no `choices` at all. NOT thrown
 * for a well-formed response that simply has no content yet (e.g. a
 * reasoning model that ran out of budget) — see OpenRouterResult. */
export class OpenRouterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenRouterError";
  }
}

/** Minimal shape of an OpenAI-compatible chat completion response — just
 * enough of it to safely extract what we need without resorting to `any`. */
interface ChatCompletionResponse {
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      content?: string | null;
      reasoning?: string | null;
    };
  }>;
}

export interface OpenRouterResult {
  /** null when the model produced no output at all before stopping (most
   * often a reasoning model that used its whole token budget on
   * chain-of-thought — check finishReason, usually "length" in that case). */
  content: string | null;
  reasoning: string | null;
  finishReason: string | null;
  raw: ChatCompletionResponse;
}

function getApiKey(apiKey?: string): string {
  const key = apiKey ?? process.env[OPENROUTER_API_KEY_ENV];
  if (!key) {
    throw new OpenRouterError(
      `No OpenRouter API key found. Set the ${OPENROUTER_API_KEY_ENV} environment variable or pass --api-key.`
    );
  }
  return key;
}

export interface CallOpenRouterOptions {
  model?: string;
  apiKey?: string;
  temperature?: number;
  maxTokens?: number;
  /** Caps reasoning-phase tokens via OpenRouter's unified `reasoning` param
   * so a reasoning model can't spend the whole maxTokens budget on
   * chain-of-thought before writing any content. Pass `undefined` to omit
   * the param entirely (e.g. for a model that doesn't support it). */
  reasoningMaxTokens?: number;
  /**
   * See models.cameraTrajectoryResponseFormat(). Not every model on
   * OpenRouter supports strict structured output — check the model's page
   * for "Structured Outputs" support before relying on it; unsupported
   * models may 400 on this param.
   */
  responseFormat?: Record<string, unknown>;
  timeoutMs?: number;
}

/**
 * Sends a single-turn chat completion request to OpenRouter and returns an
 * OpenRouterResult. No JSON/schema validation is done here — the caller
 * decides what to do with `content`.
 *
 * Unlike a plain string return, this always reports what actually happened
 * (content, reasoning, finishReason, and the full raw response) even when
 * content is missing, so the caller can save that information for
 * debugging instead of losing it. OpenRouterError is reserved for
 * request-level failures (see the class docstring), not for "the model
 * didn't produce content" — that's a normal-ish outcome this function
 * reports rather than throws on.
 */
export async function callOpenRouter(
  systemPrompt: string,
  userPrompt: string,
  options: CallOpenRouterOptions = {}
): Promise<OpenRouterResult> {
  const {
    model = DEFAULT_MODEL,
    apiKey,
    temperature = DEFAULT_TEMPERATURE,
    maxTokens = DEFAULT_MAX_TOKENS,
    reasoningMaxTokens = DEFAULT_REASONING_MAX_TOKENS,
    responseFormat,
    timeoutMs = 180_000,
  } = options;

  const key = getApiKey(apiKey);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    "User-Agent": "camera-trajectory-pipeline/1.0 (+https://openrouter.ai)",
  };
  if (OPENROUTER_HTTP_REFERER) headers["HTTP-Referer"] = OPENROUTER_HTTP_REFERER;
  if (OPENROUTER_APP_TITLE) headers["X-Title"] = OPENROUTER_APP_TITLE;

  const payload: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature,
    max_tokens: maxTokens,
  };
  if (responseFormat !== undefined) {
    payload.response_format = responseFormat;
  }
  if (reasoningMaxTokens !== undefined) {
    payload.reasoning = { max_tokens: reasoningMaxTokens };
  }

  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  let resp: Response;
  try {
    resp = await fetch(OPENROUTER_API_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (e) {
    throw new OpenRouterError(`OpenRouter request failed: ${getErrorMessage(e)}`);
  } finally {
    clearTimeout(timeoutHandle);
  }

  if (!resp.ok) {
    const text = await resp.text();
    throw new OpenRouterError(`OpenRouter request failed [${resp.status}]: ${text.slice(0, 2000)}`);
  }

  let data: ChatCompletionResponse;
  try {
    data = (await resp.json()) as ChatCompletionResponse;
  } catch (e) {
    throw new OpenRouterError(`OpenRouter returned a response that wasn't valid JSON: ${getErrorMessage(e)}`);
  }

  const choice = data.choices?.[0];
  if (!choice) {
    throw new OpenRouterError(
      `Unexpected OpenRouter response shape (no choices): ${JSON.stringify(data).slice(0, 1000)}`
    );
  }

  return {
    content: choice.message?.content ?? null,
    reasoning: choice.message?.reasoning ?? null,
    finishReason: choice.finish_reason ?? null,
    raw: data,
  };
}