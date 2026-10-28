"""An error must not quote the value it is complaining about.

The observed failure: a provider proposed a literal email, Pydantic's message
quoted it, the 422 body carried it verbatim, the extension showed it in chat,
chat became conversation_history — and every later request was then rejected
for carrying raw PII. The privacy boundary tripping over a value it leaked
itself, with no way out but clearing the conversation.
"""
from app.inference.vlm_base import VisionLanguageModel
from app.privacy.validators import redact_for_log

from tests.conftest import make_element

LEAKED = "john.doe@example.com"


def test_a_rejected_plan_never_echoes_the_offending_value(client, auth_headers, monkeypatch):
    class InventsData(VisionLanguageModel):
        name = "invents-data"

        async def analyze(self, screenshot, elements, task, conversation_history=None):
            # A literal into a field with no token can't be safely rewritten,
            # so this still fails — the point is HOW it fails.
            return {
                "message": "filling it in",
                "actions": [{"action": "type", "target": "email_1", "value": LEAKED}],
            }

    monkeypatch.setattr("app.agent.planner.get_provider", lambda name: InventsData())

    body = {
        "task": "fill up the form",
        "elements": [make_element(label_token=None)],
        "nonce": "nonce-error-leak-1",
    }
    resp = client.post("/api/agent/plan", json=body, headers=auth_headers)
    assert resp.status_code == 422
    assert LEAKED not in resp.text


def test_the_error_text_cannot_poison_the_next_request(client, auth_headers, monkeypatch):
    # Replaying a redacted error back as history must not trip the scan —
    # otherwise the conversation stays wedged even after the fix above.
    class InventsData(VisionLanguageModel):
        name = "invents-data"

        async def analyze(self, screenshot, elements, task, conversation_history=None):
            return {"message": "ok", "actions": []}

    monkeypatch.setattr("app.agent.planner.get_provider", lambda name: InventsData())

    body = {
        "task": "fill up the form",
        "elements": [make_element()],
        "conversation_history": [
            {"role": "agent", "text": redact_for_log(f"model produced an invalid action plan: {LEAKED}")}
        ],
        "nonce": "nonce-error-leak-2",
    }
    resp = client.post("/api/agent/plan", json=body, headers=auth_headers)
    assert resp.status_code == 200, resp.text
