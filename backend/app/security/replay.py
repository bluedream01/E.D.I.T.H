"""In-memory replay protection.

Two layers:
  1. Plan-request nonces: each /api/agent/plan call must carry a fresh client
     nonce; reusing one is rejected.
  2. Action-token consumption: each action_token from /api/agent/verify-action
     can be consumed exactly once.

An in-memory store is sufficient for the MVP (single backend instance). A real
deployment should back this with Redis so it survives restarts and works
across replicas — noted in docs/security.md.
"""
from __future__ import annotations

import time
from threading import Lock


class ReplayGuard:
    def __init__(self, ttl_seconds: int = 600):
        self._ttl = ttl_seconds
        self._seen: dict[str, float] = {}
        self._lock = Lock()

    def _sweep(self) -> None:
        now = time.time()
        expired = [k for k, exp in self._seen.items() if exp < now]
        for k in expired:
            del self._seen[k]

    def check_and_record(self, key: str) -> bool:
        """Returns True if `key` is fresh (not seen before / expired), and
        records it. Returns False if it's a replay."""
        with self._lock:
            self._sweep()
            if key in self._seen:
                return False
            self._seen[key] = time.time() + self._ttl
            return True


nonce_guard = ReplayGuard(ttl_seconds=600)
action_token_guard = ReplayGuard(ttl_seconds=300)
