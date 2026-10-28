from __future__ import annotations

from app.inference.vlm_base import VisionLanguageModel
from app.inference.mock_provider import MockVLMProvider
from app.inference.qwen_provider import Qwen2VLProvider
from app.inference.llava_provider import LLaVAProvider

_PROVIDERS = {
    "mock": MockVLMProvider,
    "qwen": Qwen2VLProvider,
    "qwen2-vl": Qwen2VLProvider,
    "llava": LLaVAProvider,
}


def get_provider(name: str) -> VisionLanguageModel:
    cls = _PROVIDERS.get(name.lower())
    if cls is None:
        raise ValueError(f"unknown VLM provider '{name}'. Available: {sorted(_PROVIDERS)}")
    return cls()
