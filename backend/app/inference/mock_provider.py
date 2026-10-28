"""Deterministic, rule-based stand-in for a real VLM.

Good enough to drive the full demo workflow (fill a registration form, run a
simple search) without any GPU/model weights, while exercising the exact
same interface a real Qwen provider implements. Because it's rule-based
rather than free-text generation, it structurally cannot be "talked into"
doing something outside the schema — but app/agent/planner.py validates its
output anyway, since that validation is what actually has to hold for real
providers too.

Always returns a `message` explaining what it did (or why it did nothing) —
silence is what makes an agent feel "dumb"; a clear reason, even a canned
one, doesn't.
"""
from __future__ import annotations

import re
from typing import Any

from app.models.schemas import ConversationTurn, Element, ElementState, SemanticType
from app.inference.vlm_base import AnalyzeResult, VisionLanguageModel

_FILLABLE_SENSITIVE = {
    SemanticType.EMAIL,
    SemanticType.PHONE,
    SemanticType.NAME,
    SemanticType.FIRST_NAME,
    SemanticType.LAST_NAME,
    SemanticType.ADDRESS,
    SemanticType.DOB,
    SemanticType.PASSWORD,
    SemanticType.CARD_NUMBER,
    SemanticType.CVV,
    SemanticType.AADHAAR,
    SemanticType.PAN,
}

_FILL_KEYWORDS = ("fill", "complete", "register", "sign up", "signup")
_SUBMIT_KEYWORDS = ("submit",)
# "play <song/artist>" is treated as a search (find it, then click it to play)
# — distinct from "play"/"play it"/"resume" alone, which means "resume the
# already-loaded video" and is handled by _PLAY_RESUME_PATTERN first.
_SEARCH_PATTERN = re.compile(r"(?:search|look|find|play)(?: for| up)?\s+(.+)", re.IGNORECASE)
_SITE_MENTION_PATTERN = re.compile(r"^(on\s+)?(youtube|google|this\s+site)\s+(for\s+)?", re.IGNORECASE)
_WANTS_PLAY_PATTERN = re.compile(r"\bplay\b", re.IGNORECASE)

# A real request is rarely just "play X". "go to youtube and search and play a
# song called believer while staying in youtube" leaves _SEARCH_PATTERN
# holding "and play a song called believer while staying in youtube", which
# matches no video title on earth. These two strip the scaffolding off the
# front and back until what's left is the thing the user actually named.
#
# This is string surgery, not language understanding — it handles the
# phrasings people actually type at a browser agent, and an unusual one will
# leave noise in the query. The failure is visible and harmless: the search
# box gets a worse query, which the user can see and retype.
_QUERY_LEAD_NOISE = re.compile(
    r"^(?:and|then|also|please|now|to|go\s+to)\s+"
    r"|^(?:search|look|find|play|open)(?:\s+for|\s+up)?\s+"
    r"|^(?:a|an|the)\s+(?:song|video|track|music\s+video|clip|movie)\s+(?:called|named|titled)\s+"
    r"|^(?:a|an|the)\s+(?:song|video|track|clip|movie)\s+"
    r"|^(?:called|named|titled)\s+",
    re.IGNORECASE,
)
_QUERY_TRAIL_NOISE = re.compile(
    r"\s+(?:while|without|but|and)\s+(?:stay|staying|remain|remaining|not\s+leaving|leaving|keep|keeping).*$"
    r"|\s+(?:on|in|from)\s+(?:youtube|google|this\s+site|here)\s*$",
    re.IGNORECASE,
)


def _query_tokens(text: str) -> set[str]:
    """Lowercase word set, so "believer" matches inside
    "Imagine Dragons - Believer (Official Music Video)"."""
    return {t for t in re.split(r"[^a-z0-9]+", text.lower()) if t}


def _clean_query(raw: str) -> str:
    """Strips conjunctions, verbs, "a song called" and trailing "while
    staying on youtube" clauses off a captured search query."""
    query = _SITE_MENTION_PATTERN.sub("", raw, count=1).strip()
    for _ in range(6):  # bounded: each pass removes one prefix, or none
        stripped = _QUERY_LEAD_NOISE.sub("", query, count=1).strip()
        if stripped == query:
            break
        query = stripped
    query = _QUERY_TRAIL_NOISE.sub("", query, count=1).strip()
    return query.strip(" .,'\"")
# "leave/end/close/exit the call|meeting", plus a bare "hang up". The
# call/meeting noun is required (except after "hang up", which has no other
# meaning) so that "close the dialog" or "end the form" can't drop the user
# out of a meeting they are still in.
_LEAVE_CALL_PATTERN = re.compile(
    r"\b(?:hang\s*up|hangup)\b"
    r"|\b(?:leave|exit|quit|close|end|drop|disconnect(?:\s+from)?)\b[^.]{0,20}?\b(?:call|meeting|meet|conference)\b",
    re.IGNORECASE,
)
_PAUSE_PATTERN = re.compile(r"\bpause\b", re.IGNORECASE)
_PLAY_RESUME_PATTERN = re.compile(r"^(play|resume|unpause)(\s+(it|this|the\s+video|video))?$", re.IGNORECASE)
_PLAY_LABEL_PATTERN = re.compile(r"\bplay\b", re.IGNORECASE)
_PAUSE_LABEL_PATTERN = re.compile(r"\bpause\b", re.IGNORECASE)

_FRIENDLY_LABEL = {
    SemanticType.EMAIL: "email",
    SemanticType.PHONE: "phone number",
    SemanticType.NAME: "name",
    SemanticType.FIRST_NAME: "first name",
    SemanticType.LAST_NAME: "last name",
    SemanticType.ADDRESS: "address",
    SemanticType.DOB: "date of birth",
    SemanticType.PASSWORD: "password",
    SemanticType.CARD_NUMBER: "card number",
    SemanticType.CVV: "CVV",
    SemanticType.AADHAAR: "Aadhaar number",
    SemanticType.PAN: "PAN",
}


class MockVLMProvider(VisionLanguageModel):
    name = "mock"

    async def analyze(
        self,
        screenshot: str | None,
        elements: list[Element],
        task: str,
        conversation_history: list[ConversationTurn] | None = None,
    ) -> AnalyzeResult:
        task_lower = task.lower().strip()

        # Checked first. "end the call" contains no search or fill verb, so
        # order isn't strictly required — but putting the most consequential
        # intent ahead of the others means a phrasing that could match two
        # patterns can never quietly resolve to the wrong one.
        if _LEAVE_CALL_PATTERN.search(task_lower):
            return self._handle_leave_call(elements)

        # Checked before the search pattern: "pause"/"play" alone (or "play
        # it"/"resume") means control the already-loaded video, not search
        # for something new.
        if _PAUSE_PATTERN.search(task_lower):
            return self._handle_click_by_label(elements, _PAUSE_LABEL_PATTERN, "pause")
        if _PLAY_RESUME_PATTERN.match(task_lower):
            return self._handle_click_by_label(elements, _PLAY_LABEL_PATTERN, "play")

        search_match = _SEARCH_PATTERN.search(task_lower)
        if search_match:
            query = _clean_query(search_match.group(1))
            # "Search and play X" is two steps that can't share one turn: the
            # results don't exist in the DOM until the search has run, so
            # there is no element to click yet. Rather than guess at a second
            # step against a page that hasn't loaded, the same sentence does
            # the right thing twice — click the match if it's on screen now,
            # otherwise search and say what to ask for next.
            if _WANTS_PLAY_PATTERN.search(task_lower):
                played = self._handle_play_result(elements, query)
                if played is not None:
                    return played
            return self._handle_search(elements, query, wants_play=bool(_WANTS_PLAY_PATTERN.search(task_lower)))

        wants_fill = any(w in task_lower for w in _FILL_KEYWORDS)
        wants_submit = any(w in task_lower for w in _SUBMIT_KEYWORDS)
        if wants_fill or wants_submit:
            return self._handle_fill(elements, wants_submit=wants_submit or wants_fill)

        return {
            "message": (
                "I'm not sure what you'd like me to do with this page. "
                "I can fill out a form (\"fill the form\"), run a search "
                "(\"search for <something>\") or leave a call (\"leave the "
                "meeting\") — try one of those, or tell me more specifically "
                "what to click or type."
            ),
            "actions": [],
        }

    def _handle_leave_call(self, elements: list[Element]) -> AnalyzeResult:
        """Hangs up — always behind a confirmation prompt.

        `requires_confirmation` is set here to be honest about intent, but it
        is not what enforces the gate. actions/validator.py re-derives it
        from CALL_END's membership in HIGH_RISK_SEMANTIC_TYPES, and the
        extension re-derives it a third time from its own local
        classification. A provider that forgot this flag — or lied about it —
        still cannot hang up without the user clicking Allow.
        """
        target = next((el for el in elements if el.semantic_type == SemanticType.CALL_END), None)
        if not target:
            return {
                "message": (
                    "I can't find a leave or hang-up control on this page. If you're in a call, "
                    "its controls may be hidden until you move the mouse — nudge it and ask again."
                ),
                "actions": [],
            }
        return {
            "message": "Found the leave-call button. Ending a call needs your OK first — confirm below.",
            "actions": [
                {
                    "action": "click",
                    "target": target.id,
                    "reason": "Task asked to leave the call; matched the hang-up control.",
                    "requires_confirmation": True,
                }
            ],
        }

    def _handle_play_result(self, elements: list[Element], query: str) -> AnalyzeResult | None:
        """Clicks the on-screen result matching `query`, or returns None so
        the caller can fall back to searching.

        Only SAME-ORIGIN links are eligible. That is what makes "play it
        while staying on YouTube" a property of the code rather than a hope:
        an off-site link carries semantic_type EXTERNAL_LINK, and nothing
        here will click one. It also declines the sponsored links that sit
        above real results on most search pages, which are the likeliest
        thing to carry a query word and take the user somewhere else.
        """
        wanted = _query_tokens(query)
        if not wanted:
            return None

        for el in elements:
            if el.semantic_type != SemanticType.LINK or not el.label_hint:
                continue
            if wanted <= _query_tokens(el.label_hint):
                return {
                    "message": f'Opening "{el.label_hint}".',
                    "actions": [
                        {
                            "action": "click",
                            "target": el.id,
                            "reason": f"Task asked to play '{query}'; matched an on-page result with that title.",
                        }
                    ],
                }
        return None

    def _handle_click_by_label(self, elements: list[Element], label_pattern: re.Pattern, friendly: str) -> AnalyzeResult:
        """Finds a button by its visible-text label_hint (e.g. YouTube's
        Play/Pause control) rather than by semantic_type, which only
        distinguishes 'submit' from generic 'button' — not what a button
        actually does. Without label_hint there would be no way to tell
        one icon button from another at all."""
        target = next(
            (el for el in elements if el.type == "button" and el.label_hint and label_pattern.search(el.label_hint)),
            None,
        )
        if not target:
            return {
                "message": f"I don't see a {friendly} control on this page.",
                "actions": [],
            }
        verb_ing = {"play": "Playing", "pause": "Pausing"}.get(friendly, f"{friendly.capitalize()}ing")
        return {
            "message": f"{verb_ing}.",
            "actions": [
                {
                    "action": "click",
                    "target": target.id,
                    "reason": f"Task asked to {friendly}; matched a button labeled '{target.label_hint}'.",
                }
            ],
        }

    def _handle_search(self, elements: list[Element], query: str, wants_play: bool = False) -> AnalyzeResult:
        query = _SITE_MENTION_PATTERN.sub("", query, count=1).strip()
        search_field = next((el for el in elements if el.semantic_type == SemanticType.SEARCH and el.editable), None)
        if not search_field:
            return {
                "message": "I don't see a search box on this page, so I can't run that search.",
                "actions": [],
            }

        actions: list[dict[str, Any]] = [
            {
                "action": "type",
                "target": search_field.id,
                "value": query,
                "reason": f"Task asked to search for '{query}'.",
            },
            {
                "action": "press_key",
                "target": search_field.id,
                "value": "Enter",
                "reason": "Submit the search.",
            },
        ]
        if wants_play:
            # Says out loud that this is step one of two, and exactly what to
            # say for step two — otherwise a search that was asked to "play
            # X" just stops, looking like it half-understood.
            return {
                "message": (
                    f'Searching for "{query}". The results aren\'t on the page yet, so there\'s '
                    f'nothing to click until they load — say "play {query}" again once you see '
                    f"them and I'll open the top match."
                ),
                "actions": actions,
            }
        return {"message": f"Searching for \"{query}\"...", "actions": actions}

    def _handle_fill(self, elements: list[Element], wants_submit: bool) -> AnalyzeResult:
        actions: list[dict[str, Any]] = []
        filled_labels: list[str] = []
        skipped_no_token: list[str] = []

        for el in elements:
            if el.state != ElementState.EMPTY or not el.editable:
                continue
            if el.semantic_type in _FILLABLE_SENSITIVE:
                if el.label_token:
                    actions.append(
                        {
                            "action": "type_sensitive",
                            "target": el.id,
                            "secret_ref": el.label_token.strip("[]"),
                            "reason": f"Form requests {el.semantic_type.value}, resolved locally by the browser.",
                        }
                    )
                    filled_labels.append(_FRIENDLY_LABEL.get(el.semantic_type, el.semantic_type.value))
                else:
                    skipped_no_token.append(_FRIENDLY_LABEL.get(el.semantic_type, el.semantic_type.value))

        submit_target = next((el.id for el in elements if el.semantic_type == SemanticType.SUBMIT), None)
        will_submit = wants_submit and submit_target is not None
        if will_submit:
            actions.append(
                {
                    "action": "submit",
                    "target": submit_target,
                    "reason": "All required fields are filled; task requests form submission.",
                    "requires_confirmation": True,
                }
            )

        message = self._build_fill_message(filled_labels, skipped_no_token, will_submit, submit_target)
        return {"message": message, "actions": actions}

    def _build_fill_message(
        self,
        filled_labels: list[str],
        skipped_no_token: list[str],
        will_submit: bool,
        submit_target: str | None,
    ) -> str:
        parts: list[str] = []
        if filled_labels:
            parts.append(f"I filled in your {_join(filled_labels)}.")
        else:
            parts.append("I didn't find any empty fields on this page that I can fill.")

        if skipped_no_token:
            parts.append(
                f"I noticed {_join(skipped_no_token)} but couldn't classify it as something safe to "
                "auto-fill, so I left it for you."
            )

        if will_submit:
            parts.append("I'm ready to submit the form — just confirm when you want me to.")
        elif submit_target and not filled_labels and not skipped_no_token:
            parts.append("There's a submit button here, but nothing to fill first.")

        return " ".join(parts)


def _join(items: list[str]) -> str:
    if len(items) == 1:
        return items[0]
    if len(items) == 2:
        return f"{items[0]} and {items[1]}"
    return f"{', '.join(items[:-1])}, and {items[-1]}"
