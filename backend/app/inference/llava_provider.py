"""LLaVA provider — STUB. See qwen_provider.py for the integration plan;
the same notes apply here (local/self-hosted LLaVA checkpoint via
transformers or vLLM, channel-separated prompt, validated output only)."""
from __future__ import annotations

from typing import Any

from app.models.schemas import Element
from app.inference.vlm_base import VisionLanguageModel


class LLaVAProvider(VisionLanguageModel):
    name = "llava"

    def __init__(self, model_path: str | None = None):
        self.model_path = model_path

    async def analyze(
        self, screenshot: str | None, elements: list[Element], task: str
    ) -> list[dict[str, Any]]:
        raise NotImplementedError(
            "LLaVA provider requires a configured local model checkpoint. "
            "Set VLM_PROVIDER=mock for the MVP, or implement this provider "
            "against a running LLaVA deployment."
        )
