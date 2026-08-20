"use strict";
var _a, _b, _c;
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_OUTPUT_DIR = exports.DEFAULT_REASONING_MAX_TOKENS = exports.DEFAULT_MAX_TOKENS = exports.DEFAULT_TEMPERATURE = exports.OPENROUTER_APP_TITLE = exports.OPENROUTER_HTTP_REFERER = exports.DEFAULT_MODEL = exports.OPENROUTER_API_KEY_ENV = exports.OPENROUTER_API_URL = void 0;
// OpenRouter chat completions endpoint (OpenAI-compatible).
exports.OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";
// API key is read from the environment, never hardcoded.
// Set with: export OPENROUTER_API_KEY="sk-or-..."
exports.OPENROUTER_API_KEY_ENV = "OPENROUTER_API_KEY";
// Default model, overridable via --model CLI flag or OPENROUTER_MODEL env var.
// deepseek/deepseek-v4-flash supports OpenRouter structured outputs and is
// significantly cheaper than Claude Haiku/Sonnet for this JSON-generation
// task. Swap via OPENROUTER_MODEL if you want to compare other models.
exports.DEFAULT_MODEL = (_a = process.env.OPENROUTER_MODEL) !== null && _a !== void 0 ? _a : "deepseek/deepseek-v4-flash";
// Optional but recommended by OpenRouter for attribution/rate-limit tracking.
// https://openrouter.ai/docs -> set these to your own app info if you have them.
exports.OPENROUTER_HTTP_REFERER = (_b = process.env.OPENROUTER_HTTP_REFERER) !== null && _b !== void 0 ? _b : "";
exports.OPENROUTER_APP_TITLE = (_c = process.env.OPENROUTER_APP_TITLE) !== null && _c !== void 0 ? _c : "camera-trajectory-pipeline";
exports.DEFAULT_TEMPERATURE = 0.2;
// Reasoning models (deepseek-v4-flash included) spend tokens on internal
// chain-of-thought BEFORE writing the actual JSON content. If max_tokens is
// too small, the model can burn the entire budget on reasoning and return
// content=null with finish_reason="length" — nothing ever gets written.
// DEFAULT_MAX_TOKENS is sized generously to make room for both; DEFAULT_
// REASONING_MAX_TOKENS caps the reasoning phase itself (via OpenRouter's
// unified `reasoning` request param) so a fixed amount of the budget is
// always reserved for actual content. Set to `undefined` to omit the param
// entirely (e.g. for a model that doesn't support it).
exports.DEFAULT_MAX_TOKENS = 20000;
exports.DEFAULT_REASONING_MAX_TOKENS = 6000;
exports.DEFAULT_OUTPUT_DIR = "shared/trajectories/ai_generated";
