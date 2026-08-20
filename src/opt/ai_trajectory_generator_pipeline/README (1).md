# camera-trajectory-pipeline (TypeScript)

Direct TypeScript port of the Python pipeline. Same files, same logic,
same behavior — just `zod` instead of `pydantic`, and native `fetch`
instead of `requests`.

## Setup

```bash
npm install
export OPENROUTER_API_KEY="sk-or-v1-..."
```

## Run

```bash
npm start -- /path/to/envs_dir --output-dir ../shared/trajectories
```

or after `npm run build`:

```bash
node dist/run_trajectory_pipeline.js /path/to/envs_dir --output-dir ../shared/trajectories
```

Flags mirror the Python CLI exactly: `--output-dir`, `--model`, `--api-key`,
`--limit`, `--verbose`.

## File-by-file mapping

| Python                     | TypeScript                   |
|-----------------------------|-------------------------------|
| `config.py`                 | `config.ts`                   |
| `models.py` (Pydantic)       | `models.ts` (zod)              |
| `openrouter_client.py`       | `openrouter_client.ts`         |
| `prompt_builder.py`          | `prompt_builder.ts`            |
| `run_trajectory_pipeline.py` | `run_trajectory_pipeline.ts`   |

## Notes / things that had to change shape (not behavior)

- **Pydantic `model_json_schema()` → `zodToJsonSchema()`.** Same purpose
  (derive the OpenRouter `response_format` JSON Schema straight from the
  type), same `$refStrategy: "none"` choice to fully inline the schema
  (equivalent to how the Python side used Pydantic's default `$defs`
  inlining behavior for non-recursive models).
- **`Field(min_length=3, max_length=3)` → `.refine(v => v.length === 3)`.**
  This mirrors the fix already applied on the Python side: Anthropic's
  strict structured-output validator rejects `minItems`/`maxItems` values
  other than 0 or 1, so the 3-element vector constraint for
  `position`/`lookAt`/`up` is enforced only at parse time (via `.refine()`,
  which — like Pydantic's `field_validator` — does not get embedded into
  the generated JSON Schema), not advertised to the API.
- **`argparse` → `node:util`'s built-in `parseArgs`.** No extra CLI
  dependency needed; flag names and defaults are identical.
- **Model default changed to `deepseek/deepseek-v4-flash`** in `config.ts`
  per your last request (this also applies going forward to the Python
  version if you want to keep both in sync — let me know if you'd like that
  changed there too).

## I could not fully test this here

This sandbox has no network access to `npm install zod zod-to-json-schema`,
so this was written carefully and checked with `tsc` against a stub type
declaration for structural/syntax correctness — but it has **not** been run
against the real `zod` types or a live OpenRouter call. Please run:

```bash
npm install
npm run typecheck
npm start -- /path/to/one_env_dir --limit 1 --verbose
```

on one file before trusting it for a full batch, and paste me any errors —
I'll fix them immediately.
