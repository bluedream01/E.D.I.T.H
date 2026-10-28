"""Heuristic prompt-injection detector.

Webpage content (element labels, screenshot-derived text) is UNTRUSTED INPUT,
never an instruction channel. This module flags content that looks like it's
trying to impersonate a system/developer message so it can be logged for the
audit trail and stripped from any prompt template — see
app/agent/prompts.py for how the three channels (SYSTEM POLICY / USER TASK /
WEBPAGE CONTENT) are kept separated when building prompts for real VLM
providers.
"""
from __future__ import annotations

import re

_INJECTION_PATTERNS = [
    re.compile(r"(?i)ignore (all |the )?(previous|prior|above) instructions"),
    re.compile(r"(?i)system\s*(message|prompt|:)"),
    re.compile(r"(?i)you are now"),
    re.compile(r"(?i)disregard (your|the) (policy|rules|guidelines)"),
    re.compile(r"(?i)send (all )?(user )?data to"),
    re.compile(r"(?i)act as (an? )?(admin|root|developer)"),
    re.compile(r"(?i)</?(system|assistant|developer)>"),
]


def contains_injection_attempt(text: str) -> bool:
    return any(p.search(text) for p in _INJECTION_PATTERNS)


def scan_elements_for_injection(texts: list[str]) -> list[str]:
    """Returns the subset of `texts` that look like injection attempts, for
    audit logging only. Never used to change agent behavior."""
    return [t for t in texts if contains_injection_attempt(t)]
