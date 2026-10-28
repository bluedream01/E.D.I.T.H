from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

from app.actions.validator import ActionValidationError
from app.agent.planner import build_plan
from app.models.schemas import PlanRequest, PlanResponse
from app.privacy.validators import RawPiiDetected, redact_for_log, scan_for_raw_pii
from app.security.auth import require_api_key
from app.security.replay import action_token_guard, nonce_guard
from app.security.tokens import InvalidActionToken, verify_action_token

logger = logging.getLogger("api.agent")

router = APIRouter(prefix="/api/agent", tags=["agent"])


@router.post("/plan", response_model=PlanResponse, dependencies=[Depends(require_api_key)])
async def plan(request: PlanRequest) -> PlanResponse:
    # Layer 1: reject replayed plan requests.
    if not nonce_guard.check_and_record(request.nonce):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="replayed request nonce")

    # Layer 2: reject any request that still carries raw PII-shaped values,
    # even though the extension is supposed to have already sanitized them.
    #
    # Two fields are excluded, both because they are high-entropy data that
    # no text-PII regex can judge, not because they are trusted:
    #
    # `screenshot` is base64-encoded binary image data, where these regexes
    # produce near-guaranteed false positives (a "pk"/"sk"-prefixed 16+ char
    # run turns up by chance in almost any real screenshot). It has already
    # been redacted client-side via canvas boxes, which a text scan can't
    # meaningfully re-verify.
    #
    # `nonce` is a random identifier, and randomness eventually looks like
    # anything: a measured 1.1% of crypto.randomUUID() values contain a
    # digit/dash run the phone pattern matches, plus 0.35% for Aadhaar and
    # 0.12% for card — roughly one message in sixty failing with a privacy
    # error that named no real privacy problem. The schema constrains nonce
    # to hex and dashes, so it has no room to carry PII in the first place.
    try:
        scan_for_raw_pii(request.model_dump(exclude={"screenshot", "nonce"}))
    except RawPiiDetected as exc:
        logger.warning("rejected request containing raw-PII-shaped value: category=%s field=%s", exc.category, exc.field_path)
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"request rejected: raw sensitive-looking value detected (category={exc.category})",
        ) from exc

    try:
        return await build_plan(
            task=request.task,
            screenshot=request.screenshot,
            elements=request.elements,
            conversation_history=request.conversation_history,
        )
    except ActionValidationError as exc:
        # Expected, foreseeable failure mode with a real (occasionally
        # imperfect) VLM provider: it proposed an action that doesn't satisfy
        # our schema/business rules (e.g. missing target, unknown element,
        # a literal value where only a secret_ref is allowed). This is
        # exactly what that validation exists to catch — reject cleanly
        # rather than letting it fall through as an unhandled 500.
        #
        # The detail is redacted, not returned raw. This previously assumed
        # str(exc) only ever described action *structure*; it does not. When
        # the failure comes from Pydantic, the message quotes the offending
        # input — so a plan carrying a literal email produced a 422 whose own
        # body contained that email. The extension then showed it in chat,
        # chat became conversation_history, and every later request was
        # rejected for carrying raw PII: the boundary tripping over a value
        # it leaked itself, with no way out but clearing the conversation.
        logger.warning("rejected an invalid action plan from the VLM provider: %s", redact_for_log(str(exc)))
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"model produced an invalid action plan: {redact_for_log(str(exc))}",
        ) from exc
    except ValueError as exc:
        # e.g. misconfigured/unavailable provider
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=redact_for_log(str(exc))) from exc


class VerifyActionRequest(BaseModel):
    action_token: str


class VerifyActionResponse(BaseModel):
    valid: bool
    plan_id: str
    action_type: str
    target: str | None


@router.post("/verify-action", response_model=VerifyActionResponse, dependencies=[Depends(require_api_key)])
async def verify_action(body: VerifyActionRequest) -> VerifyActionResponse:
    """Optional extra check before executing a HIGH-RISK action: confirms the
    token is signed, unexpired, and hasn't already been consumed (replay
    protection at the action level, not just the plan level)."""
    try:
        payload = verify_action_token(body.action_token)
    except InvalidActionToken as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=str(exc)) from exc

    if not action_token_guard.check_and_record(body.action_token):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="action token already used")

    return VerifyActionResponse(
        valid=True, plan_id=payload.plan_id, action_type=payload.action_type, target=payload.target
    )
