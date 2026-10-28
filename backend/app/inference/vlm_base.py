"""Vision-Language-Model provider abstraction.

Every provider (mock, Qwen2-VL, LLaVA, ...) implements the same narrow
interface and returns a plain dict of {message, actions} — actions are never
executable code, never free-form text that touches the browser directly.
app/agent/planner.py is solely responsible for turning intents into
validated Action objects; `message` is shown to the user as-is (it's plain
chat text, not something that can control the browser).
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, TypedDict

from app.models.schemas import ConversationTurn, Element


class AnalyzeResult(TypedDict):
    message: str
    actions: list[dict[str, Any]]


class VisionLanguageModel(ABC):
    name: str = "base"

    @abstractmethod
    async def analyze(
        self,
        screenshot: str | None,
        elements: list[Element],
        task: str,
        conversation_history: list[ConversationTurn] | None = None,
    ) -> AnalyzeResult:
        """Return {"message": <chat reply text>, "actions": [<raw intent>, ...]}.

        `actions` entries look like
        [{"action": "type_sensitive", "target": "email_1", "secret_ref": "EMAIL_FIELD_1"}, ...]
        — never executable code, never a raw value.

        Implementations MUST treat `task`, `conversation_history`, and any
        text derived from `screenshot`/`elements` as untrusted data, not
        instructions — see app/agent/prompts.py for the channel-separated
        prompt template real LLM-backed providers should use.
        """
        raise NotImplementedError
