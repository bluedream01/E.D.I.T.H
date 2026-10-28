from __future__ import annotations

import logging

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api.agent import router as agent_router
from app.api.health import router as health_router
from app.privacy.validators import redact_for_log
from app.security.config import settings


class RedactingLogFilter(logging.Filter):
    """Belt-and-suspenders: even if a log call somehow includes a PII-shaped
    string, strip it before it hits any handler (console, file, aggregator)."""

    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.msg, str):
            record.msg = redact_for_log(record.msg)
        record.args = None if not record.args else tuple(
            redact_for_log(a) if isinstance(a, str) else a for a in record.args
        )
        return True


def configure_logging() -> None:
    handler = logging.StreamHandler()
    handler.addFilter(RedactingLogFilter())
    logging.basicConfig(level=logging.INFO, handlers=[handler], format="%(asctime)s %(levelname)s %(name)s: %(message)s")


configure_logging()

app = FastAPI(
    title="Privacy-Preserving Browser Agent Backend",
    description="Plans browser actions from a SANITIZED page representation. Never receives raw PII by design.",
    version="0.1.0",
)

# Origin allow-list: only the extension (and local dev tooling) may call this API.
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type", "X-API-Key"],
)


@app.exception_handler(Exception)
async def redacted_error_handler(request: Request, exc: Exception) -> JSONResponse:
    """Never leak stack traces / internal details (which could themselves
    contain fragments of request data) in an error response."""
    logging.getLogger("app.error").exception("unhandled error on %s", request.url.path)
    return JSONResponse(status_code=500, content={"detail": "internal server error"})


app.include_router(health_router)
app.include_router(agent_router)
