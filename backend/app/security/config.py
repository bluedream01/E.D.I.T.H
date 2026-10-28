"""Central configuration. Dev defaults are intentionally obvious/insecure so
they are never mistaken for production values."""
from __future__ import annotations

import os

from dotenv import load_dotenv

# Loads backend/.env if present (gitignored — see .env.example for the
# template). Without this, anything set via `$env:X = ...` / `export X=...`
# only lives in that one shell session and silently reverts (e.g. back to
# VLM_PROVIDER=mock) the next time the server is started in a different
# terminal or by a different process. A .env file makes config survive
# restarts without needing to be retyped every time.
load_dotenv()


class Settings:
    API_KEY: str = os.environ.get("AGENT_API_KEY", "dev-local-only-key")
    TOKEN_SECRET: str = os.environ.get("AGENT_TOKEN_SECRET", "dev-local-only-secret-change-me")
    ACTION_TOKEN_TTL_SECONDS: int = int(os.environ.get("ACTION_TOKEN_TTL_SECONDS", "120"))
    # NOTE (dev-only relaxation): a freshly-loaded unpacked extension gets a
    # random chrome-extension:// origin, so we can't pin it ahead of time here.
    # "*" is acceptable because allow_credentials=False (no cookies/auth via
    # CORS; auth is via the X-API-Key header instead). Before packing/shipping
    # the extension, set ALLOWED_ORIGINS to the extension's real, fixed
    # chrome-extension://<id> origin. See docs/security.md.
    ALLOWED_ORIGINS: list[str] = [
        o.strip()
        for o in os.environ.get("ALLOWED_ORIGINS", "*").split(",")
        if o.strip()
    ]
    VLM_PROVIDER: str = os.environ.get("VLM_PROVIDER", "mock")
    # Only required when VLM_PROVIDER=qwen (real hosted Qwen2.5-VL via
    # OpenRouter). Never logged — see privacy/validators.py's redact_for_log
    # and main.py's RedactingLogFilter, which this is also covered by since
    # it's never placed in a log message in the first place (only in an
    # Authorization header on the outbound OpenRouter request).
    OPENROUTER_API_KEY: str = os.environ.get("OPENROUTER_API_KEY", "")


settings = Settings()
