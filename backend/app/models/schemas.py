"""
Strict Pydantic schemas for the agent API.

Every model here is deliberately narrow: the backend should only ever be able to
express "click element X" / "type the secret referenced by TOKEN into element X",
never free text, free-form JS, or raw values. This is what makes it possible to
reject a malformed or malicious plan before it ever reaches the browser.
"""
from __future__ import annotations

from enum import Enum
from typing import List, Literal, Optional

from pydantic import BaseModel, Field, field_validator

# ---------------------------------------------------------------------------
# Elements (sanitized DOM/vision metadata sent by the extension)
# ---------------------------------------------------------------------------


class SemanticType(str, Enum):
    EMAIL = "email"
    PHONE = "phone"
    PASSWORD = "password"
    NAME = "name"
    FIRST_NAME = "first_name"
    LAST_NAME = "last_name"
    ADDRESS = "address"
    DOB = "date_of_birth"
    CARD_NUMBER = "card_number"
    CVV = "cvv"
    AADHAAR = "aadhaar"
    PAN = "pan"
    API_KEY = "api_key"
    OTP = "otp"
    FACE = "face"
    PAYMENT = "payment"
    ACCOUNT_DELETE = "account_delete"
    CALL_END = "call_end"
    SEARCH = "search"
    GENERIC_TEXT = "generic_text"
    BUTTON = "button"
    SUBMIT = "submit"
    LINK = "link"
    EXTERNAL_LINK = "external_link"
    CHECKBOX = "checkbox"
    SELECT = "select"
    UNKNOWN = "unknown"


SENSITIVE_SEMANTIC_TYPES = {
    SemanticType.EMAIL,
    SemanticType.PHONE,
    SemanticType.PASSWORD,
    SemanticType.NAME,
    SemanticType.FIRST_NAME,
    SemanticType.LAST_NAME,
    SemanticType.ADDRESS,
    SemanticType.DOB,
    SemanticType.CARD_NUMBER,
    SemanticType.CVV,
    SemanticType.AADHAAR,
    SemanticType.PAN,
    SemanticType.API_KEY,
    SemanticType.OTP,
    SemanticType.FACE,
}

# Semantic types / action types that must always require human confirmation,
# no matter what the VLM provider returns. This is enforced server-side AND
# re-enforced client-side in the extension (defense in depth).
HIGH_RISK_SEMANTIC_TYPES = {
    SemanticType.PAYMENT,
    SemanticType.ACCOUNT_DELETE,
    SemanticType.PASSWORD,
    # Hanging up ends the call for everyone in it, and rejoining is a
    # different act with a different result — not an undo.
    SemanticType.CALL_END,
}


class ElementState(str, Enum):
    EMPTY = "empty"
    FILLED = "filled"
    DISABLED = "disabled"


class BBox(BaseModel):
    x: float
    y: float
    width: float
    height: float


class Element(BaseModel):
    id: str = Field(..., min_length=1, max_length=128)
    type: str = Field(..., description="DOM element kind, e.g. input/button/select")
    semantic_type: SemanticType = SemanticType.UNKNOWN
    bbox: BBox
    state: ElementState = ElementState.EMPTY
    editable: bool = True
    label_token: Optional[str] = Field(
        default=None,
        description="Semantic placeholder token, e.g. [EMAIL_FIELD_1]. Never the raw value.",
    )
    label_hint: Optional[str] = Field(
        default=None,
        max_length=60,
        description=(
            "Visible text for BUTTON and LINK elements only (e.g. 'Play', 'Search', "
            "a video title) — UI chrome or page content, not user data, and scrubbed "
            "of PII-shaped and name-shaped text client-side before it is set. "
            "Always null for input/select/textarea. "
            "Lets the planner tell one button apart from another; without it the only "
            "signal is semantic_type + bbox, which is why earlier plans hallucinated "
            "targets by label instead of by id."
        ),
    )

    @field_validator("id")
    @classmethod
    def id_must_be_identifier_like(cls, v: str) -> str:
        if any(c in v for c in ("<", ">", "\n", "\r")):
            raise ValueError("element id contains invalid characters")
        return v


# ---------------------------------------------------------------------------
# Plan request / response
# ---------------------------------------------------------------------------


class ConversationTurn(BaseModel):
    """One prior turn in the chat, for multi-turn context. Text-only — no
    element/screenshot data is ever replayed through history, only what was
    actually said, so history can't smuggle stale sensitive-looking content
    past the same PII scan every request already goes through."""

    role: Literal["user", "agent"]
    text: str = Field(..., max_length=2000)


class PlanRequest(BaseModel):
    task: str = Field(..., max_length=2000)
    screenshot: Optional[str] = Field(
        default=None, description="Base64 PNG/JPEG of the SANITIZED screenshot only"
    )
    # Real, complex pages (YouTube-style SPAs, etc.) can easily have 200+
    # interactive elements — 200 was tested against the demo form only and
    # was too tight for real-world use.
    elements: List[Element] = Field(default_factory=list, max_length=600)
    conversation_history: List[ConversationTurn] = Field(default_factory=list, max_length=40)
    # Constrained to an identifier charset rather than free text, because
    # api/agent.py excludes this field from the raw-PII scan and an unscanned
    # free-text field would be a hole straight through that boundary. No
    # spaces, "@" or punctuation means no name, address or email can ride
    # along here. It does NOT rule out a bare digit run — a phone number is
    # valid hex — so this narrows the unscanned channel rather than closing
    # it. Closing it entirely isn't possible while the field is random by
    # design; see the note in api/agent.py for why exclusion is still the
    # right trade.
    nonce: str = Field(
        ...,
        min_length=8,
        max_length=128,
        pattern=r"^[A-Za-z0-9_-]+$",
        description="Client-generated replay-protection nonce (opaque identifier)",
    )

    @field_validator("elements")
    @classmethod
    def unique_ids(cls, v: List[Element]) -> List[Element]:
        ids = [e.id for e in v]
        if len(ids) != len(set(ids)):
            raise ValueError("duplicate element ids")
        return v


class ActionType(str, Enum):
    CLICK = "click"
    FOCUS = "focus"
    TYPE = "type"
    TYPE_SENSITIVE = "type_sensitive"
    SELECT = "select"
    SCROLL = "scroll"
    PRESS_KEY = "press_key"
    SUBMIT = "submit"


class Action(BaseModel):
    type: ActionType
    target: Optional[str] = Field(default=None, max_length=128)
    reason: str = Field(default="", max_length=300)
    # Only for ActionType.TYPE — non-sensitive literal value (e.g. a search query).
    value: Optional[str] = Field(default=None, max_length=500)
    # Only for ActionType.TYPE_SENSITIVE — a TOKEN, never a raw value.
    secret_ref: Optional[str] = Field(default=None, max_length=128)
    requires_confirmation: bool = False
    # Filled in by the server after validation; short-lived, single-use.
    action_token: Optional[str] = None

    @field_validator("value")
    @classmethod
    def value_must_not_look_sensitive(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return v
        # Defense in depth: this field must never carry secrets. Real detection
        # happens in app.privacy.validators; this just blocks the obvious cases.
        if "@" in v and "." in v:
            raise ValueError("value field must not contain email-like content")
        return v


class PlanResponse(BaseModel):
    plan_id: str
    message: str = Field(..., max_length=2000, description="Natural-language reply shown to the user in the chat")
    actions: List[Action]
    provider: str
    raw_pii_sent_to_server: Literal[0] = 0
