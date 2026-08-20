"use strict";
var __extends = (this && this.__extends) || (function () {
    var extendStatics = function (d, b) {
        extendStatics = Object.setPrototypeOf ||
            ({ __proto__: [] } instanceof Array && function (d, b) { d.__proto__ = b; }) ||
            function (d, b) { for (var p in b) if (Object.prototype.hasOwnProperty.call(b, p)) d[p] = b[p]; };
        return extendStatics(d, b);
    };
    return function (d, b) {
        if (typeof b !== "function" && b !== null)
            throw new TypeError("Class extends value " + String(b) + " is not a constructor or null");
        extendStatics(d, b);
        function __() { this.constructor = d; }
        d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
    };
})();
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.OpenRouterError = void 0;
exports.callOpenRouter = callOpenRouter;
var config_js_1 = require("./config.js");
var errors_js_1 = require("./errors.js");
var undici_1 = require("undici");
(0, undici_1.setGlobalDispatcher)(new undici_1.ProxyAgent("http://192.168.144.1:8080"));
/** Raised for genuine request-level failures: auth, network, non-200 HTTP
 * status, or a response so malformed it has no `choices` at all. NOT thrown
 * for a well-formed response that simply has no content yet (e.g. a
 * reasoning model that ran out of budget) — see OpenRouterResult. */
var OpenRouterError = /** @class */ (function (_super) {
    __extends(OpenRouterError, _super);
    function OpenRouterError(message) {
        var _this = _super.call(this, message) || this;
        _this.name = "OpenRouterError";
        return _this;
    }
    return OpenRouterError;
}(Error));
exports.OpenRouterError = OpenRouterError;
function getApiKey(apiKey) {
    var key = apiKey !== null && apiKey !== void 0 ? apiKey : process.env[config_js_1.OPENROUTER_API_KEY_ENV];
    if (!key) {
        throw new OpenRouterError("No OpenRouter API key found. Set the ".concat(config_js_1.OPENROUTER_API_KEY_ENV, " environment variable or pass --api-key."));
    }
    return key;
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
function callOpenRouter(systemPrompt_1, userPrompt_1) {
    return __awaiter(this, arguments, void 0, function (systemPrompt, userPrompt, options) {
        var _a, model, apiKey, _b, temperature, _c, maxTokens, _d, reasoningMaxTokens, responseFormat, _e, timeoutMs, key, headers, payload, controller, timeoutHandle, resp, e_1, text, data, e_2, choice;
        var _f, _g, _h, _j, _k, _l;
        if (options === void 0) { options = {}; }
        return __generator(this, function (_m) {
            switch (_m.label) {
                case 0:
                    _a = options.model, model = _a === void 0 ? config_js_1.DEFAULT_MODEL : _a, apiKey = options.apiKey, _b = options.temperature, temperature = _b === void 0 ? config_js_1.DEFAULT_TEMPERATURE : _b, _c = options.maxTokens, maxTokens = _c === void 0 ? config_js_1.DEFAULT_MAX_TOKENS : _c, _d = options.reasoningMaxTokens, reasoningMaxTokens = _d === void 0 ? config_js_1.DEFAULT_REASONING_MAX_TOKENS : _d, responseFormat = options.responseFormat, _e = options.timeoutMs, timeoutMs = _e === void 0 ? 180000 : _e;
                    key = getApiKey(apiKey);
                    headers = {
                        Authorization: "Bearer ".concat(key),
                        "Content-Type": "application/json",
                        "User-Agent": "camera-trajectory-pipeline/1.0 (+https://openrouter.ai)",
                    };
                    if (config_js_1.OPENROUTER_HTTP_REFERER)
                        headers["HTTP-Referer"] = config_js_1.OPENROUTER_HTTP_REFERER;
                    if (config_js_1.OPENROUTER_APP_TITLE)
                        headers["X-Title"] = config_js_1.OPENROUTER_APP_TITLE;
                    payload = {
                        model: model,
                        messages: [
                            { role: "system", content: systemPrompt },
                            { role: "user", content: userPrompt },
                        ],
                        temperature: temperature,
                        max_tokens: maxTokens,
                    };
                    if (responseFormat !== undefined) {
                        payload.response_format = responseFormat;
                    }
                    if (reasoningMaxTokens !== undefined) {
                        payload.reasoning = { max_tokens: reasoningMaxTokens };
                    }
                    controller = new AbortController();
                    timeoutHandle = setTimeout(function () { return controller.abort(); }, timeoutMs);
                    _m.label = 1;
                case 1:
                    _m.trys.push([1, 3, 4, 5]);
                    return [4 /*yield*/, fetch(config_js_1.OPENROUTER_API_URL, {
                            method: "POST",
                            headers: headers,
                            body: JSON.stringify(payload),
                            signal: controller.signal,
                        })];
                case 2:
                    resp = _m.sent();
                    return [3 /*break*/, 5];
                case 3:
                    e_1 = _m.sent();
                    throw new OpenRouterError("OpenRouter request failed: ".concat((0, errors_js_1.getErrorMessage)(e_1)));
                case 4:
                    clearTimeout(timeoutHandle);
                    return [7 /*endfinally*/];
                case 5:
                    if (!!resp.ok) return [3 /*break*/, 7];
                    return [4 /*yield*/, resp.text()];
                case 6:
                    text = _m.sent();
                    throw new OpenRouterError("OpenRouter request failed [".concat(resp.status, "]: ").concat(text.slice(0, 2000)));
                case 7:
                    _m.trys.push([7, 9, , 10]);
                    return [4 /*yield*/, resp.json()];
                case 8:
                    data = (_m.sent());
                    return [3 /*break*/, 10];
                case 9:
                    e_2 = _m.sent();
                    throw new OpenRouterError("OpenRouter returned a response that wasn't valid JSON: ".concat((0, errors_js_1.getErrorMessage)(e_2)));
                case 10:
                    choice = (_f = data.choices) === null || _f === void 0 ? void 0 : _f[0];
                    if (!choice) {
                        throw new OpenRouterError("Unexpected OpenRouter response shape (no choices): ".concat(JSON.stringify(data).slice(0, 1000)));
                    }
                    return [2 /*return*/, {
                            content: (_h = (_g = choice.message) === null || _g === void 0 ? void 0 : _g.content) !== null && _h !== void 0 ? _h : null,
                            reasoning: (_k = (_j = choice.message) === null || _j === void 0 ? void 0 : _j.reasoning) !== null && _k !== void 0 ? _k : null,
                            finishReason: (_l = choice.finish_reason) !== null && _l !== void 0 ? _l : null,
                            raw: data,
                        }];
            }
        });
    });
}
