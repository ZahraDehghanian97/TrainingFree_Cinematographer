import os

# OpenRouter chat completions endpoint (OpenAI-compatible).
OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions"

# API key is read from the environment, never hardcoded.
# Set with: export OPENROUTER_API_KEY="sk-or-..."
OPENROUTER_API_KEY_ENV = "OPENROUTER_API_KEY"

# Default model, overridable via --model CLI flag or OPENROUTER_MODEL env var.
# Haiku is Anthropic's cheap/fast tier (~3x cheaper than Sonnet) and is a good
# default for this task since the output is structured JSON, not open-ended
# writing. Other cheap options worth trying: "openai/gpt-4o-mini",
# "google/gemini-2.5-flash" — swap via OPENROUTER_MODEL if you want to compare.
DEFAULT_MODEL = os.environ.get("OPENROUTER_MODEL", "deepseek/deepseek-v4-flash")

# Optional but recommended by OpenRouter for attribution/rate-limit tracking.
# https://openrouter.ai/docs -> set these to your own app info if you have them.
OPENROUTER_HTTP_REFERER = os.environ.get("OPENROUTER_HTTP_REFERER", "")
OPENROUTER_APP_TITLE = os.environ.get("OPENROUTER_APP_TITLE", "camera-trajectory-pipeline")

DEFAULT_TEMPERATURE = 0.2
DEFAULT_MAX_TOKENS = 8000

DEFAULT_OUTPUT_DIR = "../shared/trajectories"
