from __future__ import annotations

import time
from datetime import datetime, timezone

from fastapi import APIRouter

from app.models.schemas import SemanticType
from app.security.config import settings

router = APIRouter(tags=["health"])

# Captured at import, so it is the moment THIS process loaded its code — the
# one fact that answers "did my restart actually take effect?".
_STARTED_AT = time.time()


@router.get("/health")
async def health() -> dict:
    """Liveness, plus enough to detect version skew against the extension.

    SemanticType is duplicated by hand here and in the extension's
    shared/types.ts, and that duplication is deliberate: it is what lets this
    tier reject anything the extension didn't classify locally. The cost is
    that a backend running older code rejects a newer extension's payload
    with a wall of enum errors that names every valid value and buries the
    cause. Publishing the list the server actually knows turns that into a
    one-line answer, and `started_at` says whether a restart happened at all.
    """
    return {
        "status": "ok",
        "provider": settings.VLM_PROVIDER,
        "started_at": datetime.fromtimestamp(_STARTED_AT, tz=timezone.utc).isoformat(),
        "semantic_types": sorted(t.value for t in SemanticType),
    }
