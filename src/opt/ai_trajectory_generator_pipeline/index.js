"use strict";
var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
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
exports.processEnvFile = processEnvFile;
var node_util_1 = require("node:util");
var promises_1 = require("node:fs/promises");
var node_path_1 = require("node:path");
var config_js_1 = require("./config.js");
var models_js_1 = require("./models.js");
var openrouter_client_js_1 = require("./openrouter_client.js");
var prompt_builder_js_1 = require("./prompt_builder.js");
var errors_js_1 = require("./errors.js");
// To avoid hitting rate limit
function sleep(ms) {
    return new Promise(function (resolve) { return setTimeout(resolve, ms); });
}
/** LLMs sometimes wrap JSON in ```json ... ``` even when told not to.
 * Strip that off if present; otherwise return text unchanged. */
function stripCodeFences(text) {
    var t = text.trim();
    if (t.startsWith("```")) {
        var lines = t.split("\n");
        if (lines[0].startsWith("```"))
            lines.shift();
        if (lines.length > 0 && lines[lines.length - 1].trim().startsWith("```"))
            lines.pop();
        t = lines.join("\n").trim();
    }
    return t;
}
function processEnvFile(envPath, outputDir, model, apiKey, verbose) {
    return __awaiter(this, void 0, void 0, function () {
        var rawText, rawEnv, environment, userPrompt, result, debugPath, cleaned, outPath, parsedJson, trajectory, toSave, e_1, rawOutPath;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    console.log("Processing ".concat(node_path_1.default.basename(envPath)));
                    return [4 /*yield*/, (0, promises_1.readFile)(envPath, "utf-8")];
                case 1:
                    rawText = _a.sent();
                    try {
                        rawEnv = JSON.parse(rawText);
                    }
                    catch (e) {
                        throw new Error("".concat(node_path_1.default.basename(envPath), " is not valid JSON: ").concat((0, errors_js_1.getErrorMessage)(e)));
                    }
                    environment = models_js_1.EnvironmentSchema.parse(rawEnv);
                    userPrompt = (0, prompt_builder_js_1.buildUserPrompt)(rawEnv);
                    if (verbose) {
                        console.log("  -> calling OpenRouter (model=".concat(model, ", structured output on)"));
                    }
                    return [4 /*yield*/, (0, openrouter_client_js_1.callOpenRouter)(prompt_builder_js_1.SYSTEM_PROMPT, userPrompt, {
                            model: model,
                            apiKey: apiKey,
                            responseFormat: (0, models_js_1.cameraTrajectoryResponseFormat)(),
                        })];
                case 2:
                    result = _a.sent();
                    if (!(result.content === null)) return [3 /*break*/, 4];
                    debugPath = node_path_1.default.join(outputDir, "".concat(environment.id, "_trajectory.error.raw.txt"));
                    return [4 /*yield*/, (0, promises_1.writeFile)(debugPath, JSON.stringify({ finishReason: result.finishReason, reasoning: result.reasoning, rawResponse: result.raw }, null, 2), "utf-8")];
                case 3:
                    _a.sent();
                    throw new Error("model returned no content (finishReason=".concat(result.finishReason, "); saved debug info to ").concat(node_path_1.default.basename(debugPath), " \u2014 try raising maxTokens or reasoningMaxTokens"));
                case 4:
                    cleaned = stripCodeFences(result.content);
                    outPath = node_path_1.default.join(outputDir, "".concat(environment.id, "_trajectory.json"));
                    _a.label = 5;
                case 5:
                    _a.trys.push([5, 7, , 9]);
                    parsedJson = JSON.parse(cleaned);
                    trajectory = models_js_1.CameraTrajectorySchema.parse(parsedJson);
                    toSave = __assign({}, trajectory);
                    if (toSave.playback === null) {
                        delete toSave.playback;
                    }
                    return [4 /*yield*/, (0, promises_1.writeFile)(outPath, JSON.stringify(toSave, null, 2), "utf-8")];
                case 6:
                    _a.sent();
                    console.log("  Saved ".concat(node_path_1.default.basename(outPath)));
                    return [3 /*break*/, 9];
                case 7:
                    e_1 = _a.sent();
                    rawOutPath = node_path_1.default.join(outputDir, "".concat(environment.id, "_trajectory.raw.txt"));
                    return [4 /*yield*/, (0, promises_1.writeFile)(rawOutPath, result.content, "utf-8")];
                case 8:
                    _a.sent();
                    throw new Error("response did not match CameraTrajectory schema (".concat((0, errors_js_1.getErrorMessage)(e_1), "); saved raw text to ").concat(node_path_1.default.basename(rawOutPath)));
                case 9: return [2 /*return*/];
            }
        });
    });
}
function isDirectory(p) {
    return __awaiter(this, void 0, void 0, function () {
        var s, _a;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    _b.trys.push([0, 2, , 3]);
                    return [4 /*yield*/, (0, promises_1.stat)(p)];
                case 1:
                    s = _b.sent();
                    return [2 /*return*/, s.isDirectory()];
                case 2:
                    _a = _b.sent();
                    return [2 /*return*/, false];
                case 3: return [2 /*return*/];
            }
        });
    });
}
function main() {
    return __awaiter(this, void 0, void 0, function () {
        var _a, values, positionals, envsDir, outputDir, envFiles, limit, failures, _i, envFiles_1, envPath, e_2, _b, failures_1, name_1;
        return __generator(this, function (_c) {
            switch (_c.label) {
                case 0:
                    _a = (0, node_util_1.parseArgs)({
                        args: process.argv.slice(2),
                        allowPositionals: true,
                        options: {
                            "output-dir": { type: "string", default: config_js_1.DEFAULT_OUTPUT_DIR },
                            model: { type: "string", default: config_js_1.DEFAULT_MODEL },
                            "api-key": { type: "string" },
                            limit: { type: "string" },
                            verbose: { type: "boolean", default: false },
                        },
                    }), values = _a.values, positionals = _a.positionals;
                    envsDir = positionals[0];
                    if (!envsDir) {
                        console.log("Usage: run_trajectory_pipeline <envs_dir> [--output-dir DIR] [--model MODEL] [--api-key KEY] [--limit N] [--verbose]");
                        process.exit(1);
                    }
                    return [4 /*yield*/, isDirectory(envsDir)];
                case 1:
                    if (!(_c.sent())) {
                        console.log("Not a directory: ".concat(envsDir));
                        process.exit(1);
                    }
                    outputDir = values["output-dir"];
                    return [4 /*yield*/, (0, promises_1.mkdir)(outputDir, { recursive: true })];
                case 2:
                    _c.sent();
                    return [4 /*yield*/, (0, promises_1.readdir)(envsDir)];
                case 3:
                    envFiles = (_c.sent())
                        .filter(function (f) { return f.endsWith(".json"); })
                        .sort()
                        .map(function (f) { return node_path_1.default.join(envsDir, f); });
                    limit = values.limit ? parseInt(values.limit, 10) : undefined;
                    if (limit) {
                        envFiles = envFiles.slice(0, limit);
                    }
                    if (envFiles.length === 0) {
                        console.log("No *.json files found in ".concat(envsDir));
                        process.exit(1);
                    }
                    console.log("Found ".concat(envFiles.length, " environment file(s) in ").concat(envsDir));
                    failures = [];
                    _i = 0, envFiles_1 = envFiles;
                    _c.label = 4;
                case 4:
                    if (!(_i < envFiles_1.length)) return [3 /*break*/, 11];
                    envPath = envFiles_1[_i];
                    _c.label = 5;
                case 5:
                    _c.trys.push([5, 7, , 8]);
                    return [4 /*yield*/, processEnvFile(envPath, outputDir, values.model, values["api-key"], values.verbose)];
                case 6:
                    _c.sent();
                    return [3 /*break*/, 8];
                case 7:
                    e_2 = _c.sent();
                    if (e_2 instanceof openrouter_client_js_1.OpenRouterError) {
                        console.log("  ERROR calling OpenRouter for ".concat(node_path_1.default.basename(envPath), ": ").concat(e_2.message));
                    }
                    else {
                        console.log("  ERROR processing ".concat(node_path_1.default.basename(envPath), ": ").concat((0, errors_js_1.getErrorMessage)(e_2)));
                    }
                    failures.push(node_path_1.default.basename(envPath));
                    return [3 /*break*/, 8];
                case 8: return [4 /*yield*/, sleep(2000)];
                case 9:
                    _c.sent();
                    _c.label = 10;
                case 10:
                    _i++;
                    return [3 /*break*/, 4];
                case 11:
                    console.log("\nDone. ".concat(envFiles.length - failures.length, "/").concat(envFiles.length, " succeeded."));
                    if (failures.length > 0) {
                        console.log("Failed files:");
                        for (_b = 0, failures_1 = failures; _b < failures_1.length; _b++) {
                            name_1 = failures_1[_b];
                            console.log("  - ".concat(name_1));
                        }
                    }
                    return [2 /*return*/];
            }
        });
    });
}
if (require.main === module) {
    main();
}
