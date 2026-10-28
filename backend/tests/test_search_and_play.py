"""Search-then-play on a content site, and staying on that site."""
import pytest

from app.inference.mock_provider import MockVLMProvider, _clean_query
from app.models.schemas import Element, SemanticType

from tests.conftest import make_element


def el(**overrides):
    base = dict(id="pba-1", type="button", semantic_type="button", state="empty", label_token=None)
    base.update(overrides)
    return Element(**make_element(**base))


SEARCH_BOX = el(id="pba-2", type="input", semantic_type="search", label_token=None)
RESULT = el(
    id="pba-10",
    type="link",
    semantic_type="link",
    label_hint="Imagine Dragons - Believer (Official Music Video)",
)
OFFSITE_RESULT = el(
    id="pba-11",
    type="link",
    semantic_type="external_link",
    label_hint="Believer - listen free on SomeOtherSite",
)
UNRELATED = el(id="pba-12", type="link", semantic_type="link", label_hint="Home")


class TestQueryCleaning:
    @pytest.mark.parametrize(
        "raw,expected",
        [
            # The phrasing that motivated this: _SEARCH_PATTERN matches at the
            # first verb, leaving everything after "search" as the query.
            ("and play a song called believer while staying in youtube", "believer"),
            ("a song called believer", "believer"),
            ("the video titled believer", "believer"),
            ("believer on youtube", "believer"),
            ("believer while staying on youtube", "believer"),
            ("headphones", "headphones"),
            ("noise cancelling headphones", "noise cancelling headphones"),
            # A leading "for" is NOT stripped: _SEARCH_PATTERN already eats
            # the one in "search for X", so any that survives is part of the
            # title — "For Whom the Bell Tolls" would lose its first word.
            ("For Whom the Bell Tolls", "For Whom the Bell Tolls"),
        ],
    )
    def test_strips_scaffolding_but_keeps_the_subject(self, raw, expected):
        assert _clean_query(raw) == expected


@pytest.mark.asyncio
class TestSearchThenPlay:
    async def test_searches_when_the_results_are_not_on_the_page_yet(self):
        result = await MockVLMProvider().analyze(
            None, [SEARCH_BOX], "go to youtube and search and play a song called believer while staying in youtube"
        )
        typed = [a for a in result["actions"] if a["action"] == "type"]
        assert typed[0]["value"] == "believer"

    async def test_tells_the_user_what_to_say_for_step_two(self):
        result = await MockVLMProvider().analyze(None, [SEARCH_BOX], "play believer")
        assert 'play believer' in result["message"]

    async def test_clicks_the_matching_result_once_it_is_on_screen(self):
        result = await MockVLMProvider().analyze(None, [SEARCH_BOX, RESULT, UNRELATED], "play believer")
        assert [a["target"] for a in result["actions"]] == ["pba-10"]

    async def test_the_same_sentence_works_for_both_steps(self):
        task = "go to youtube and search and play a song called believer while staying in youtube"
        first = await MockVLMProvider().analyze(None, [SEARCH_BOX], task)
        second = await MockVLMProvider().analyze(None, [SEARCH_BOX, RESULT], task)
        assert [a["action"] for a in first["actions"]] == ["type", "press_key"]
        assert [a["action"] for a in second["actions"]] == ["click"]

    async def test_never_clicks_an_off_site_result(self):
        # "while staying in youtube" has to be a property of the code, not a
        # hope: an external link matching the query must not win, even when
        # it is the only match on the page.
        result = await MockVLMProvider().analyze(None, [SEARCH_BOX, OFFSITE_RESULT], "play believer")
        assert all(a["target"] != "pba-11" for a in result["actions"])
        # Falls back to searching rather than doing nothing.
        assert any(a["action"] == "type" for a in result["actions"])

    async def test_a_plain_search_still_just_searches(self):
        result = await MockVLMProvider().analyze(None, [SEARCH_BOX, RESULT], "search for headphones")
        assert [a["action"] for a in result["actions"]] == ["type", "press_key"]

    async def test_bare_play_still_means_resume_the_current_video(self):
        play_button = el(id="pba-20", label_hint="Play")
        result = await MockVLMProvider().analyze(None, [play_button, RESULT], "play")
        assert [a["target"] for a in result["actions"]] == ["pba-20"]
