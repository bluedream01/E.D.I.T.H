"""API-key auth dependency. Simple bearer/API-key scheme suitable for an MVP;
swap for OAuth2/mTLS before any real deployment (see docs/security.md)."""
from __future__ import annotations

import hmac

from fastapi import Header, HTTPException, status

from app.security.config import settings


async def require_api_key(x_api_key: str = Header(default="")) -> None:
    if not x_api_key or not hmac.compare_digest(x_api_key, settings.API_KEY):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid or missing API key")
