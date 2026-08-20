import argparse
import json
import sys
from pathlib import Path

from pydantic import ValidationError

from config import DEFAULT_MODEL, DEFAULT_OUTPUT_DIR
from models import Environment, CameraTrajectory, camera_trajectory_response_format
from openrouter_client import call_openrouter, OpenRouterError
from prompt_builder import SYSTEM_PROMPT, build_user_prompt


def _strip_code_fences(text: str) -> str:
    """LLMs sometimes wrap JSON in ```json ... ``` even when told not to.
    Strip that off if present; otherwise return text unchanged."""
    t = text.strip()
    if t.startswith("```"):
        lines = t.splitlines()
        if lines[0].startswith("```"):
            lines = lines[1:]
        if lines and lines[-1].strip().startswith("```"):
            lines = lines[:-1]
        t = "\n".join(lines).strip()
    return t


def process_env_file(env_path: Path, output_dir: Path, model: str, api_key: str | None, verbose: bool):
    print(f"Processing {env_path.name}")

    with open(env_path, "r", encoding="utf-8") as f:
        raw_env = json.load(f)

    environment = Environment.model_validate(raw_env)
    user_prompt = build_user_prompt(raw_env)

    if verbose:
        print(f"  -> calling OpenRouter (model={model}, structured output on)")

    raw = call_openrouter(
        system_prompt=SYSTEM_PROMPT,
        user_prompt=user_prompt,
        model=model,
        api_key=api_key,
        response_format=camera_trajectory_response_format(),
    )

    cleaned = _strip_code_fences(raw)
    out_path = output_dir / f"{environment.id}_trajectory.json"

    try:
        trajectory = CameraTrajectory.model_validate_json(cleaned)
        with open(out_path, "w", encoding="utf-8") as f:
            f.write(trajectory.model_dump_json(indent=2))
        print(f"  Saved {out_path.name}")
    except (json.JSONDecodeError, ValidationError) as e:
        # Structured output mode should make this rare (and only occurs on
        # models that don't actually support strict json_schema), but keep
        # a fallback so one bad response doesn't kill the whole batch.
        raw_out_path = output_dir / f"{environment.id}_trajectory.raw.txt"
        with open(raw_out_path, "w", encoding="utf-8") as f:
            f.write(raw)
        print(f"  WARNING: response did not match CameraTrajectory schema ({e}); saved raw text to {raw_out_path.name}")


def main():
    parser = argparse.ArgumentParser(description="Generate camera trajectories for a directory of environment JSON files.")
    parser.add_argument("envs_dir", type=str, help="Directory containing environment *.json files")
    parser.add_argument("--output-dir", type=str, default=DEFAULT_OUTPUT_DIR, help="Where to write trajectory JSON files")
    parser.add_argument("--model", type=str, default=DEFAULT_MODEL, help="OpenRouter model id")
    parser.add_argument("--api-key", type=str, default=None, help="OpenRouter API key (else read from OPENROUTER_API_KEY env var)")
    parser.add_argument("--limit", type=int, default=None, help="Only process the first N env files (for testing)")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    envs_dir = Path(args.envs_dir)
    if not envs_dir.is_dir():
        print(f"Not a directory: {envs_dir}")
        sys.exit(1)

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    env_files = sorted(envs_dir.glob("*.json"))
    if args.limit:
        env_files = env_files[: args.limit]

    if not env_files:
        print(f"No *.json files found in {envs_dir}")
        sys.exit(1)

    print(f"Found {len(env_files)} environment file(s) in {envs_dir}")

    failures = []
    for env_path in env_files:
        try:
            process_env_file(env_path, output_dir, args.model, args.api_key, args.verbose)
        except OpenRouterError as e:
            print(f"  ERROR calling OpenRouter for {env_path.name}: {e}")
            failures.append(env_path.name)
        except Exception as e:
            print(f"  ERROR processing {env_path.name}: {e}")
            failures.append(env_path.name)

    print(f"\nDone. {len(env_files) - len(failures)}/{len(env_files)} succeeded.")
    if failures:
        print("Failed files:")
        for name in failures:
            print(f"  - {name}")


if __name__ == "__main__":
    main()
