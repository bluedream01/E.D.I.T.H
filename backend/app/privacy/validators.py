"""
Server-side privacy boundary.

The extension is responsible for redacting PII before it ever leaves the
device, but the backend must not *trust* that blindly (a compromised or
buggy client could still send raw values). This module is the last line of
defense: it scans every inbound request for anything that looks like a raw
sensitive value and rejects the request outright.

It also provides `redact_for_log`, used everywhere the backend logs anything,
so raw PII can never end up in application logs even by accident.
"""
from __future__ import annotations

import re
from typing import Any, Iterable, List, Tuple

# Patterns mirror (a subset of) extension/src/privacy/pii-detector.ts so both
# tiers agree on what "looks sensitive" means. Kept intentionally conservative
# to minimize false positives on legitimate semantic tokens like [EMAIL_FIELD_1].
_PATTERNS: List[Tuple[str, re.Pattern]] = [
    ("email", re.compile(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}")),
    ("phone", re.compile(r"(?<!\w)(\+?\d[\d\- ]{8,14}\d)(?!\w)")),
    ("credit_card", re.compile(r"(?<!\w)(?:\d[ -]?){13,19}(?!\w)")),
    ("aadhaar", re.compile(r"(?<!\w)\d{4}\s?\d{4}\s?\d{4}(?!\w)")),
    ("pan", re.compile(r"(?<!\w)[A-Z]{5}\d{4}[A-Z](?!\w)")),
    ("api_key", re.compile(r"(?<!\w)(sk|pk|ghp|xox[baprs])-?[A-Za-z0-9_]{16,}(?!\w)")),
    (
        "password_like",
        re.compile(r"(?i)(?<!\w)(password|passwd|pwd)\s*[:=]\s*\S{4,}"),
    ),
]

# Semantic placeholder tokens (e.g. "[EMAIL_FIELD_1]") are exactly what we
# WANT the backend to see — never flag these as violations.
_TOKEN_ALLOWLIST = re.compile(r"^\[[A-Z0-9_]+\]$")


class RawPiiDetected(Exception):
    def __init__(self, category: str, field_path: str):
        self.category = category
        self.field_path = field_path
        super().__init__(f"raw PII-like value detected in field '{field_path}' (category={category})")


def _iter_strings(value: Any, path: str = "$") -> Iterable[Tuple[str, str]]:
    if isinstance(value, str):
        yield path, value
    elif isinstance(value, dict):
        for k, v in value.items():
            yield from _iter_strings(v, f"{path}.{k}")
    elif isinstance(value, (list, tuple)):
        for i, v in enumerate(value):
            yield from _iter_strings(v, f"{path}[{i}]")


def scan_for_raw_pii(payload: Any) -> None:
    """Raise RawPiiDetected if anything in payload looks like a raw sensitive value.

    Never logs or includes the matched value itself in the exception — only
    the category and the field path, so the audit trail stays clean.
    """
    for path, text in _iter_strings(payload):
        if _TOKEN_ALLOWLIST.match(text.strip()):
            continue
        for category, pattern in _PATTERNS:
            if pattern.search(text):
                raise RawPiiDetected(category, path)


_LOG_REDACT_PATTERNS = [p for _, p in _PATTERNS]


def redact_for_log(text: str) -> str:
    """Best-effort redaction for anything about to be written to a log line."""
    out = text
    for pattern in _LOG_REDACT_PATTERNS:
        out = pattern.sub("[REDACTED]", out)
    return out
