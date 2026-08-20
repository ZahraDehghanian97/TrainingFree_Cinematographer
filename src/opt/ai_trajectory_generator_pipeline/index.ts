import { parseArgs } from "node:util";
import { readdir, mkdir, readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";

import { DEFAULT_MODEL, DEFAULT_OUTPUT_DIR } from "./config.js";
import { EnvironmentSchema, CameraTrajectorySchema, cameraTrajectoryResponseFormat } from "./models.js";
import { callOpenRouter, OpenRouterError } from "./openrouter_client.js";
import { SYSTEM_PROMPT, buildUserPrompt } from "./prompt_builder.js";
import { getErrorMessage } from "./errors.js";


// To avoid hitting rate limit
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}


/** LLMs sometimes wrap JSON in ```json ... ``` even when told not to.
 * Strip that off if present; otherwise return text unchanged. */
function stripCodeFences(text: string): string {
  let t = text.trim();
  if (t.startsWith("```")) {
    const lines = t.split("\n");
    if (lines[0].startsWith("```")) lines.shift();
    if (lines.length > 0 && lines[lines.length - 1].trim().startsWith("```")) lines.pop();
    t = lines.join("\n").trim();
  }
  return t;
}

export async function processEnvFile(
  envPath: string,
  outputDir: string,
  model: string,
  apiKey: string | undefined,
  verbose: boolean
): Promise<void> {
  console.log(`Processing ${path.basename(envPath)}`);

  const rawText = await readFile(envPath, "utf-8");

  let rawEnv: unknown;
  try {
    rawEnv = JSON.parse(rawText);
  } catch (e) {
    throw new Error(`${path.basename(envPath)} is not valid JSON: ${getErrorMessage(e)}`);
  }

  // Not wrapped in try/catch here, matching the Python version: an
  // Environment that doesn't match the schema fails this file loudly
  // (caught by main()'s loop) before any OpenRouter call is made.
  const environment = EnvironmentSchema.parse(rawEnv);
  const userPrompt = buildUserPrompt(rawEnv as Record<string, unknown>);

  if (verbose) {
    console.log(`  -> calling OpenRouter (model=${model}, structured output on)`);
  }

  const result = await callOpenRouter(SYSTEM_PROMPT, userPrompt, {
    model,
    apiKey,
    responseFormat: cameraTrajectoryResponseFormat(),
  });

  if (result.content === null) {
    // The model produced no content at all before stopping — most often a
    // reasoning model (like deepseek-v4-flash) that spent its whole token
    // budget on chain-of-thought before ever writing output. Save
    // everything we do have (reasoning + full raw response) for debugging
    // rather than losing it, but keep the terminal output to one line —
    // the full detail lives in the file, not stdout.
    const debugPath =  path.join(outputDir, `${environment.id}_trajectory.error.raw.txt`);
    await writeFile(
      debugPath,
      JSON.stringify({ finishReason: result.finishReason, reasoning: result.reasoning, rawResponse: result.raw }, null, 2),
      "utf-8"
    );
    throw new Error(
      `model returned no content (finishReason=${result.finishReason}); saved debug info to ${path.basename(debugPath)} — try raising maxTokens or reasoningMaxTokens`
    );
  }

  const cleaned = stripCodeFences(result.content);
  const outPath = path.join(outputDir, `${environment.id}_trajectory.json`);

  try {
    const parsedJson = JSON.parse(cleaned);
    const trajectory = CameraTrajectorySchema.parse(parsedJson);

    // "playback" is required-but-nullable in the LLM-facing schema (needed
    // for OpenRouter/Anthropic strict structured-output mode, which
    // requires every property to appear in "required"), but that's an API
    // contract detail, not something the saved file should carry — strip
    // it here so "playback" is truly absent from disk unless the shot
    // actually uses a time effect.
    const toSave: Record<string, unknown> = { ...trajectory };
    if (toSave.playback === null) {
      delete toSave.playback;
    }

    await writeFile(outPath, JSON.stringify(toSave, null, 2), "utf-8");
    console.log(`  Saved ${path.basename(outPath)}`);
  } catch (e) {
    // Structured output mode should make this rare (and only occurs on
    // models that don't actually support strict json_schema), but keep a
    // fallback so one bad response doesn't kill the whole batch. Re-throw
    // (with a short message) so main()'s failure accounting and one-line
    // terminal report both pick this up correctly instead of silently
    // counting a raw-text fallback as a "success".
    const rawOutPath = path.join(outputDir, `${environment.id}_trajectory.raw.txt`);
    await writeFile(rawOutPath, result.content, "utf-8");
    throw new Error(
      `response did not match CameraTrajectory schema (${getErrorMessage(e)}); saved raw text to ${path.basename(rawOutPath)}`
    );
  }
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      "output-dir": { type: "string", default: DEFAULT_OUTPUT_DIR },
      model: { type: "string", default: DEFAULT_MODEL },
      "api-key": { type: "string" },
      limit: { type: "string" },
      verbose: { type: "boolean", default: false },
    } as const,
  });

  const envsDir = positionals[0];
  if (!envsDir) {
    console.log(
      "Usage: run_trajectory_pipeline <envs_dir> [--output-dir DIR] [--model MODEL] [--api-key KEY] [--limit N] [--verbose]"
    );
    process.exit(1);
  }

  if (!(await isDirectory(envsDir))) {
    console.log(`Not a directory: ${envsDir}`);
    process.exit(1);
  }

  const outputDir = values["output-dir"] as string;
  await mkdir(outputDir, { recursive: true });

  let envFiles = (await readdir(envsDir))
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => path.join(envsDir, f));

  const limit = values.limit ? parseInt(values.limit as string, 10) : undefined;
  if (limit) {
    envFiles = envFiles.slice(0, limit);
  }

  if (envFiles.length === 0) {
    console.log(`No *.json files found in ${envsDir}`);
    process.exit(1);
  }

  console.log(`Found ${envFiles.length} environment file(s) in ${envsDir}`);

  const failures: string[] = [];
  for (const envPath of envFiles) {
    try {
      await processEnvFile(
        envPath,
        outputDir,
        values.model as string,
        values["api-key"] as string | undefined,
        values.verbose as boolean
      );
    } catch (e) {
      if (e instanceof OpenRouterError) {
        console.log(`  ERROR calling OpenRouter for ${path.basename(envPath)}: ${e.message}`);
      } else {
        console.log(`  ERROR processing ${path.basename(envPath)}: ${getErrorMessage(e)}`);
      }
      failures.push(path.basename(envPath));
    }
    
    await sleep(2000);
  }

  console.log(`\nDone. ${envFiles.length - failures.length}/${envFiles.length} succeeded.`);
  if (failures.length > 0) {
    console.log("Failed files:");
    for (const name of failures) {
      console.log(`  - ${name}`);
    }
  }
}

if (require.main === module) {
    main();
}