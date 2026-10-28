"""Tests for the real (OpenRouter-backed) Qwen2.5-VL provider.

Every test uses httpx.MockTransport, injected through Qwen2VLProvider's
`transport` constructor param — that means these tests exercise the REAL
`analyze()` implementation end to end (payload building + request + response
parsing), they just never let httpx open a real network connection. CI never
calls the real OpenRouter API and never needs an API key.
"""
from __future__ import annotations

import json

import httpx
import pytest

from app.actions.validator import ActionValidationError, validate_intents
from app.inference.qwen_provider import Qwen2VLProvider
from app.models.schemas import Element


def make_element(**overrides):
    base = {
        "id": "email_1",
        "type": "input",
        "semantic_type": "email",
        "bbox": {"x": 10, "y": 10, "width": 100, "height": 20},
        "state": "empty",
        "editable": True,
        "label_token": "[EMAIL_FIELD_1]",
    }
    base.update(overrides)
    return Element(**base)


def _json_content_response(payload: dict) -> httpx.Response:
    content = json.dumps(payload)
    return httpx.Response(200, json={"choices": [{"message": {"content": content}}]})


def test_missing_api_key_raises_immediately():
    with pytest.raises(ValueError, match="OPENROUTER_API_KEY"):
        Qwen2VLProvider(api_key="")


def test_build_payload_includes_system_task_elements_and_image():
    provider = Qwen2VLProvider(api_key="test-key")
    elements = [make_element()]
    payload = provider._build_payload("data:image/png;base64,abc123", elements, "Fill the form")

    assert payload["model"] == "qwen/qwen3-vl-8b-instruct"
    assert payload["response_format"] == {"type": "json_object"}

    system_msg, user_msg = payload["messages"]
    assert system_msg["role"] == "system"
    assert "untrusted" in system_msg["content"].lower()

    assert user_msg["role"] == "user"
    text_part = next(p for p in user_msg["content"] if p["type"] == "text")
    assert "Fill the form" in text_part["text"]
    assert "email_1" in text_part["text"]

    image_parts = [p for p in user_msg["content"] if p["type"] == "image_url"]
    assert image_parts and image_parts[0]["image_url"]["url"] == "data:image/png;base64,abc123"


def test_build_payload_omits_image_when_no_screenshot():
    provider = Qwen2VLProvider(api_key="test-key")
    payload = provider._build_payload(None, [make_element()], "Fill the form")
    user_msg = payload["messages"][1]
    assert all(p["type"] != "image_url" for p in user_msg["content"])


@pytest.mark.asyncio
async def test_api_key_sent_as_header_not_query_param():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["auth_header"] = request.headers.get("authorization")
        captured["url"] = str(request.url)
        return _json_content_response({"message": "ok", "actions": []})

    provider = Qwen2VLProvider(api_key="test-openrouter-key", transport=httpx.MockTransport(handler))
    await provider.analyze(None, [make_element()], "Fill the form")

    assert captured["auth_header"] == "Bearer test-openrouter-key"
    assert "test-openrouter-key" not in captured["url"]


@pytest.mark.asyncio
async def test_sanitized_screenshot_is_the_only_image_data_sent():
    captured = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["body"] = json.loads(request.content)
        return _json_content_response({"message": "ok", "actions": []})

    provider = Qwen2VLProvider(api_key="test-key", transport=httpx.MockTransport(handler))
    sanitized_screenshot = "data:image/png;base64,ZmFrZS1zYW5pdGl6ZWQtcG5nLWJ5dGVz"
    await provider.analyze(sanitized_screenshot, [make_element()], "Fill the form")

    user_msg = captured["body"]["messages"][1]
    image_parts = [p for p in user_msg["content"] if p["type"] == "image_url"]
    assert len(image_parts) == 1
    assert image_parts[0]["image_url"]["url"] == sanitized_screenshot


@pytest.mark.asyncio
async def test_well_formed_response_parsed_into_message_and_actions():
    def handler(request: httpx.Request) -> httpx.Response:
        return _json_content_response({
            "message": "Filling in your email.",
            "actions": [
                {"action": "type_sensitive", "target": "email_1", "secret_ref": "EMAIL_FIELD_1", "reason": "fill email"}
            ],
        })

    provider = Qwen2VLProvider(api_key="test-key", transport=httpx.MockTransport(handler))
    result = await provider.analyze(None, [make_element()], "Fill the form")

    assert result["message"] == "Filling in your email."
    assert result["actions"] == [
        {"action": "type_sensitive", "target": "email_1", "secret_ref": "EMAIL_FIELD_1", "reason": "fill email"}
    ]


@pytest.mark.asyncio
async def test_malformed_json_content_raises_value_error():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"choices": [{"message": {"content": "not valid json"}}]})

    provider = Qwen2VLProvider(api_key="test-key", transport=httpx.MockTransport(handler))
    with pytest.raises(ValueError):
        await provider.analyze(None, [make_element()], "Fill the form")


@pytest.mark.asyncio
async def test_missing_actions_key_raises_value_error():
    def handler(request: httpx.Request) -> httpx.Response:
        return _json_content_response({"message": "ok", "not_actions": []})

    provider = Qwen2VLProvider(api_key="test-key", transport=httpx.MockTransport(handler))
    with pytest.raises(ValueError):
        await provider.analyze(None, [make_element()], "Fill the form")


@pytest.mark.asyncio
async def test_actions_not_a_list_raises_value_error():
    def handler(request: httpx.Request) -> httpx.Response:
        return _json_content_response({"message": "ok", "actions": "not-a-list"})

    provider = Qwen2VLProvider(api_key="test-key", transport=httpx.MockTransport(handler))
    with pytest.raises(ValueError):
        await provider.analyze(None, [make_element()], "Fill the form")


@pytest.mark.asyncio
async def test_non_string_message_raises_value_error():
    def handler(request: httpx.Request) -> httpx.Response:
        return _json_content_response({"message": 12345, "actions": []})

    provider = Qwen2VLProvider(api_key="test-key", transport=httpx.MockTransport(handler))
    with pytest.raises(ValueError):
        await provider.analyze(None, [make_element()], "Fill the form")


@pytest.mark.asyncio
async def test_non_200_response_raises_value_error():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json={"error": "internal"})

    provider = Qwen2VLProvider(api_key="test-key", transport=httpx.MockTransport(handler))
    with pytest.raises(ValueError):
        await provider.analyze(None, [make_element()], "Fill the form")


def test_output_still_goes_through_the_shared_action_validator():
    """The whole point of the seam: a real provider's output gets exactly the
    same validation as the mock provider's — including rejecting an unknown
    target id, which a real LLM could plausibly hallucinate."""
    hallucinated_intents = [
        {"action": "click", "target": "element_that_does_not_exist", "reason": "hallucinated"}
    ]
    with pytest.raises(ActionValidationError):
        validate_intents(hallucinated_intents, [make_element()])
