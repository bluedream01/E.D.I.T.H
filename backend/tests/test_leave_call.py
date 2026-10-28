"""Leaving a call: the intent, and the gate that stands in front of it."""
import pytest

from app.actions.validator import validate_intents
from app.inference.mock_provider import MockVLMProvider
from app.models.schemas import Element, SemanticType

from tests.conftest import make_element


def button(**overrides):
    base = dict(
        id="pba-1",
        type="button",
        semantic_type="button",
        state="empty",
        label_token=None,
    )
    base.update(overrides)
    return Element(**make_element(**base))


HANGUP = button(id="pba-52", semantic_type="call_end", label_hint="call_end")
MIC = button(id="pba-58", label_hint="mic")


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "task",
    [
        "close the meeting",
        "leave the meeting",
        "end the call",
        "hang up",
        "exit the call",
        "please leave this meeting for me",
    ],
)
async def test_phrasings_that_should_hang_up(task):
    result = await MockVLMProvider().analyze(None, [HANGUP, MIC], task)
    assert [a["target"] for a in result["actions"]] == ["pba-52"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "task",
    [
        "close the dialog",
        "end the form",
        "fill the form",
        "search for headphones",
        # "pause" must still reach the media handler, not the hang-up one.
        "pause",
    ],
)
async def test_phrasings_that_must_not_hang_up(task):
    result = await MockVLMProvider().analyze(None, [HANGUP, MIC], task)
    assert all(a["target"] != "pba-52" for a in result["actions"])


@pytest.mark.asyncio
async def test_says_so_plainly_when_there_is_no_hangup_control():
    result = await MockVLMProvider().analyze(None, [MIC], "leave the meeting")
    assert result["actions"] == []
    assert "can't find" in result["message"]


@pytest.mark.asyncio
async def test_hanging_up_requires_confirmation():
    result = await MockVLMProvider().analyze(None, [HANGUP], "leave the meeting")
    validated = validate_intents(result["actions"], [HANGUP])
    assert validated[0].requires_confirmation is True


def test_confirmation_is_forced_even_if_the_provider_says_otherwise():
    # The gate must not depend on a provider being honest or correct — this
    # is the whole reason validate_intents re-derives it from the element's
    # locally-assigned semantic type.
    rogue = [{"action": "click", "target": "pba-52", "reason": "x", "requires_confirmation": False}]
    validated = validate_intents(rogue, [HANGUP])
    assert validated[0].requires_confirmation is True
