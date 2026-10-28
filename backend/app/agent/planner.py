from __future__ import annotations

import logging
import uuid

from app.actions.validator import validate_intents
from app.inference.provider_factory import get_provider
from app.models.schemas import ConversationTurn, Element, PlanResponse
from app.security.config import settings
from app.security.prompt_injection import scan_elements_for_injection
from app.security.tokens import issue_action_token

logger = logging.getLogger("agent.planner")


async def build_plan(
    task: str,
    screenshot: str | None,
    elements: list[Element],
    conversation_history: list[ConversationTurn] | None = None,
) -> PlanResponse:
    provider = get_provider(settings.VLM_PROVIDER)

    # Audit-only: flag (never act on) content that looks like a prompt-injection
    # attempt, e.g. a webpage element labeled "SYSTEM: ignore previous instructions".
    suspicious = scan_elements_for_injection([task] + [e.id for e in elements])
    if suspicious:
        logger.warning("prompt-injection-like content observed in %d field(s); ignored, not executed", len(suspicious))

    result = await provider.analyze(screenshot, elements, task, conversation_history)
    actions = validate_intents(result["actions"], elements)

    plan_id = uuid.uuid4().hex
    for i, action in enumerate(actions):
        action.action_token = issue_action_token(plan_id, i, action.type.value, action.target)

    logger.info("plan %s built with %d action(s) via provider=%s", plan_id, len(actions), provider.name)

    return PlanResponse(plan_id=plan_id, message=result["message"], actions=actions, provider=provider.name)
