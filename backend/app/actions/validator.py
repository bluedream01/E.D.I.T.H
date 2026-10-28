"""Turns raw provider intents into a validated list of Action objects.

This is the single choke point every action plan must pass through before it
can leave the backend. Anything that doesn't fit the strict schema, targets
an element that doesn't exist, or tries to smuggle a raw value is rejected
here rather than forwarded and validated "hopefully" by the extension.
"""
from __future__ import annotations

from typing import Any

from pydantic import ValidationError

from app.models.schemas import (
    Action,
    ActionType,
    Element,
    HIGH_RISK_SEMANTIC_TYPES,
    SENSITIVE_SEMANTIC_TYPES,
)


class ActionValidationError(Exception):
    def __init__(self, reason: str):
        self.reason = reason
        super().__init__(reason)


def _rewrite_literal_fill_as_token_fill(
    candidate: dict[str, Any], element_by_id: dict[str, Element]
) -> dict[str, Any]:
    """Turns "type <literal> into a sensitive field" into "type the LOCAL
    secret for that field", discarding the literal.

    A real VLM asked to fill a form does the obvious human thing and invents
    plausible data — `{"action": "type", "value": "john.doe@example.com"}` —
    instead of referencing the field's token. Rejecting the whole plan for
    that is correct but useless: the user asked to fill a form with their own
    details and got an error, and no amount of prompt wording makes a model
    perfect at this.

    The rewrite is only applied when the element carries a label_token, which
    the extension sets only for fields it classified as sensitive locally.
    The result is strictly safer than what the provider asked for: the
    invented value is dropped, and the field gets filled from the local
    profile without the value ever reaching the backend. What it is NOT is a
    licence to trust the provider — everything below still runs, and a
    literal aimed at a sensitive field with no token is still refused.
    """
    if candidate.get("type") != ActionType.TYPE.value:
        return candidate
    if candidate.get("value") is None:
        return candidate

    element = element_by_id.get(candidate.get("target") or "")
    if element is None or not element.label_token:
        return candidate
    if element.semantic_type not in SENSITIVE_SEMANTIC_TYPES:
        return candidate

    rewritten = dict(candidate)
    rewritten["type"] = ActionType.TYPE_SENSITIVE.value
    rewritten["secret_ref"] = element.label_token.strip("[]")
    rewritten["value"] = None
    rewritten["reason"] = (
        f"Provider proposed a literal value for a {element.semantic_type.value} field; "
        "replaced with the local secret reference and the literal discarded."
    )
    return rewritten


def validate_intents(raw_intents: list[dict[str, Any]], elements: list[Element]) -> list[Action]:
    element_by_id = {e.id: e for e in elements}
    validated: list[Action] = []

    for raw in raw_intents:
        # 1. Map provider's "action" key -> schema's "type" key and coerce.
        candidate = dict(raw)
        if "action" in candidate and "type" not in candidate:
            candidate["type"] = candidate.pop("action")

        candidate = _rewrite_literal_fill_as_token_fill(candidate, element_by_id)

        try:
            action = Action(**candidate)
        except ValidationError as exc:
            raise ActionValidationError(f"malformed action from provider: {exc}") from exc

        # 2. Target must reference a real, currently-known element (except
        #    for scroll, which may be page-relative).
        if action.type != ActionType.SCROLL:
            if not action.target:
                raise ActionValidationError(f"action {action.type.value} missing target")
            if action.target not in element_by_id:
                raise ActionValidationError(f"unknown target element '{action.target}'")

        # 3. type_sensitive must carry a secret_ref (a token), never a value.
        if action.type == ActionType.TYPE_SENSITIVE:
            if not action.secret_ref:
                raise ActionValidationError("type_sensitive action missing secret_ref")
            if action.value is not None:
                raise ActionValidationError("type_sensitive action must not carry a literal value")

        # 4. Non-sensitive `type` actions must not target a sensitive element.
        if action.type == ActionType.TYPE and action.target in element_by_id:
            el = element_by_id[action.target]
            if el.semantic_type.value in {
                "email", "phone", "password", "name", "address", "date_of_birth",
                "card_number", "cvv", "aadhaar", "pan", "api_key", "otp",
            }:
                raise ActionValidationError(
                    f"refusing literal 'type' action against sensitive field '{action.target}'; "
                    "use type_sensitive with a secret_ref instead"
                )

        # 5. Force requires_confirmation for anything high-risk, regardless of
        #    what the provider claimed.
        target_el = element_by_id.get(action.target) if action.target else None
        is_high_risk = (
            action.type == ActionType.SUBMIT
            or (target_el is not None and target_el.semantic_type in HIGH_RISK_SEMANTIC_TYPES)
        )
        if is_high_risk:
            action.requires_confirmation = True

        validated.append(action)

    return validated
