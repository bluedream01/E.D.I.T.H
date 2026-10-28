import pytest

from app.inference.mock_provider import MockVLMProvider
from app.models.schemas import Element

from tests.conftest import make_element


def _elements(*overrides_list):
    return [Element(**make_element(**o)) for o in overrides_list]


@pytest.mark.asyncio
async def test_search_intent_types_query_and_presses_enter():
    provider = MockVLMProvider()
    elements = _elements({
        "id": "search_1", "type": "input", "semantic_type": "search",
        "label_token": None, "state": "empty",
    })
    result = await provider.analyze(None, elements, "search for wireless headphones")

    assert "wireless headphones" in result["message"]
    types = [a["action"] for a in result["actions"]]
    assert types == ["type", "press_key"]
    assert result["actions"][0]["value"] == "wireless headphones"
    assert result["actions"][0]["target"] == "search_1"
    assert result["actions"][1]["target"] == "search_1"


@pytest.mark.asyncio
async def test_search_intent_without_a_search_field_explains_why():
    provider = MockVLMProvider()
    elements = _elements({"id": "email_1", "semantic_type": "email"})
    result = await provider.analyze(None, elements, "search for shoes")

    assert result["actions"] == []
    assert "search" in result["message"].lower()


@pytest.mark.asyncio
async def test_fill_intent_explains_what_it_filled():
    provider = MockVLMProvider()
    elements = _elements(
        {"id": "email_1", "semantic_type": "email", "label_token": "[EMAIL_FIELD_1]"},
        {"id": "phone_1", "semantic_type": "phone", "label_token": "[PHONE_FIELD_1]"},
    )
    result = await provider.analyze(None, elements, "fill the form")

    assert "email" in result["message"].lower()
    assert "phone" in result["message"].lower()
    assert len(result["actions"]) == 2


@pytest.mark.asyncio
async def test_fill_intent_with_nothing_to_fill_says_so():
    provider = MockVLMProvider()
    elements = _elements({
        "id": "email_1", "semantic_type": "email", "state": "filled",
    })
    result = await provider.analyze(None, elements, "fill the form")

    assert result["actions"] == []
    assert "didn't find" in result["message"].lower() or "did not find" in result["message"].lower()


@pytest.mark.asyncio
async def test_unrecognized_task_explains_what_it_can_do_instead_of_silence():
    provider = MockVLMProvider()
    elements = _elements({"id": "email_1", "semantic_type": "email"})
    result = await provider.analyze(None, elements, "what's the weather like today")

    assert result["actions"] == []
    assert len(result["message"]) > 0
    assert "not sure" in result["message"].lower()


@pytest.mark.asyncio
async def test_play_intent_clicks_button_by_label_hint():
    provider = MockVLMProvider()
    elements = _elements(
        {"id": "play_btn", "type": "button", "semantic_type": "button", "label_token": None, "label_hint": "Play"},
        {"id": "mute_btn", "type": "button", "semantic_type": "button", "label_token": None, "label_hint": "Mute"},
    )
    result = await provider.analyze(None, elements, "play")

    assert len(result["actions"]) == 1
    assert result["actions"][0]["action"] == "click"
    assert result["actions"][0]["target"] == "play_btn"


@pytest.mark.asyncio
async def test_pause_intent_clicks_button_by_label_hint_not_play():
    provider = MockVLMProvider()
    elements = _elements(
        {"id": "play_btn", "type": "button", "semantic_type": "button", "label_token": None, "label_hint": "Play"},
        {"id": "pause_btn", "type": "button", "semantic_type": "button", "label_token": None, "label_hint": "Pause (k)"},
    )
    result = await provider.analyze(None, elements, "pause the video")

    assert len(result["actions"]) == 1
    assert result["actions"][0]["target"] == "pause_btn"


@pytest.mark.asyncio
async def test_play_label_word_boundary_does_not_match_playlist_button():
    """'playlist' contains the substring 'play' but must NOT match a plain
    \\bplay\\b word-boundary search — otherwise "play" would randomly hit a
    completely unrelated "Add to Playlist" button instead of the real
    play/pause control."""
    provider = MockVLMProvider()
    elements = _elements(
        {"id": "playlist_btn", "type": "button", "semantic_type": "button", "label_token": None, "label_hint": "Add to Playlist"},
    )
    result = await provider.analyze(None, elements, "play")

    assert result["actions"] == []
    assert "don't see" in result["message"].lower()


@pytest.mark.asyncio
async def test_play_with_a_song_name_is_treated_as_search_not_a_click():
    provider = MockVLMProvider()
    elements = _elements({
        "id": "search_1", "type": "input", "semantic_type": "search",
        "label_token": None, "state": "empty",
    })
    result = await provider.analyze(None, elements, "play believer by imagine dragons")

    types = [a["action"] for a in result["actions"]]
    assert types == ["type", "press_key"]
    assert result["actions"][0]["value"] == "believer by imagine dragons"


@pytest.mark.asyncio
async def test_search_strips_a_leading_site_mention():
    provider = MockVLMProvider()
    elements = _elements({
        "id": "search_1", "type": "input", "semantic_type": "search",
        "label_token": None, "state": "empty",
    })
    result = await provider.analyze(None, elements, "search youtube for lofi hip hop")

    assert result["actions"][0]["value"] == "lofi hip hop"


@pytest.mark.asyncio
async def test_submit_only_triggered_when_task_and_submit_button_both_present():
    provider = MockVLMProvider()
    elements = _elements(
        {"id": "email_1", "semantic_type": "email", "label_token": "[EMAIL_FIELD_1]"},
        {"id": "submit_1", "type": "button", "semantic_type": "submit", "label_token": None},
    )
    result = await provider.analyze(None, elements, "fill and submit the form")

    submit_actions = [a for a in result["actions"] if a["action"] == "submit"]
    assert len(submit_actions) == 1
    assert submit_actions[0]["requires_confirmation"] is True
    assert "confirm" in result["message"].lower()
