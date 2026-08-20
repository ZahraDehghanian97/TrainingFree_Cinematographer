import os
import requests

from config import (
    OPENROUTER_API_URL,
    OPENROUTER_API_KEY_ENV,
    OPENROUTER_HTTP_REFERER,
    OPENROUTER_APP_TITLE,
    DEFAULT_MODEL,
    DEFAULT_TEMPERATURE,
    DEFAULT_MAX_TOKENS,
)


class OpenRouterError(RuntimeError):
    pass


def _get_api_key(api_key: str | None) -> str:
    key = api_key or os.environ.get(OPENROUTER_API_KEY_ENV)
    if not key:
        raise OpenRouterError(
            f"No OpenRouter API key found. Set the {OPENROUTER_API_KEY_ENV} "
            f"environment variable or pass --api-key."
        )
    return key


def call_openrouter(
    system_prompt: str,
    user_prompt: str,
    model: str = DEFAULT_MODEL,
    api_key: str | None = None,
    temperature: float = DEFAULT_TEMPERATURE,
    max_tokens: int = DEFAULT_MAX_TOKENS,
    response_format: dict | None = None,
    timeout: int = 180,
) -> str:
    """
    Sends a single-turn chat completion request to OpenRouter and returns the
    raw text content of the model's reply. No validation/parsing is done here
    — the caller decides what to do with the returned string.

    If `response_format` is provided (see models.camera_trajectory_response_format),
    it's passed through so OpenRouter constrains the model's output to that
    JSON Schema. Note: not every model on OpenRouter supports strict
    structured output — check the model's page for "Structured Outputs"
    support before relying on it; unsupported models may 400 on this param.
    """
    key = _get_api_key(api_key)

    headers = {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "User-Agent": "camera-trajectory-pipeline/1.0 (+https://openrouter.ai)",
    }
    if OPENROUTER_HTTP_REFERER:
        headers["HTTP-Referer"] = OPENROUTER_HTTP_REFERER
    if OPENROUTER_APP_TITLE:
        headers["X-Title"] = OPENROUTER_APP_TITLE

    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt},
        ],
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    if response_format is not None:
        payload["response_format"] = response_format

    resp = requests.post(OPENROUTER_API_URL, headers=headers, json=payload, timeout=timeout)

    if resp.status_code != 200:
        raise OpenRouterError(
            f"OpenRouter request failed [{resp.status_code}]: {resp.text[:2000]}"
        )

    data = resp.json()

    try:
        return data["choices"][0]["message"]["content"]
    except (KeyError, IndexError) as e:
        raise OpenRouterError(f"Unexpected OpenRouter response shape: {data}") from e
