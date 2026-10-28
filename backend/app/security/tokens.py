"""Short-lived, single-use action tokens.

Every action the backend returns is signed with an HMAC over
(plan_id, action_index, action_type, target, expiry). The extension is
expected to present this token back via /api/agent/verify-action before
executing any HIGH-RISK action (submit, payment, password fields, etc).
This bounds the window in which a captured/replayed plan can be abused and
gives the backend a place to enforce "each action executes at most once".
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time
from dataclasses import dataclass

from app.security.config import settings


class InvalidActionToken(Exception):
    pass


@dataclass(frozen=True)
class ActionTokenPayload:
    plan_id: str
    index: int
    action_type: str
    target: str | None
    exp: float


def _sign(payload: dict) -> str:
    body = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
    sig = hmac.new(settings.TOKEN_SECRET.encode(), body, hashlib.sha256).digest()
    return base64.urlsafe_b64encode(body).decode() + "." + base64.urlsafe_b64encode(sig).decode()


def issue_action_token(plan_id: str, index: int, action_type: str, target: str | None) -> str:
    payload = {
        "plan_id": plan_id,
        "index": index,
        "action_type": action_type,
        "target": target,
        "exp": time.time() + settings.ACTION_TOKEN_TTL_SECONDS,
    }
    return _sign(payload)


def verify_action_token(token: str) -> ActionTokenPayload:
    try:
        body_b64, sig_b64 = token.split(".", 1)
        body = base64.urlsafe_b64decode(body_b64.encode())
        sig = base64.urlsafe_b64decode(sig_b64.encode())
    except Exception as exc:  # noqa: BLE001 - any parse failure is an invalid token
        raise InvalidActionToken("malformed token") from exc

    expected_sig = hmac.new(settings.TOKEN_SECRET.encode(), body, hashlib.sha256).digest()
    if not hmac.compare_digest(sig, expected_sig):
        raise InvalidActionToken("signature mismatch")

    payload = json.loads(body)
    if payload["exp"] < time.time():
        raise InvalidActionToken("token expired")

    return ActionTokenPayload(**payload)
