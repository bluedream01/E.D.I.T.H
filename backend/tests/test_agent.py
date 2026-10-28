import pytest

from app.actions.validator import ActionValidationError, validate_intents
from app.models.schemas import Element

from tests.conftest import make_element


def _elements(*overrides_list):
    return [Element(**make_element(**o)) for o in overrides_list]


def test_valid_type_sensitive_action_is_accepted():
    elements = _elements({})
    intents = [{"action": "type_sensitive", "target": "email_1", "secret_ref": "EMAIL_FIELD_1"}]
    actions = validate_intents(intents, elements)
    assert len(actions) == 1
    assert actions[0].type.value == "type_sensitive"


def test_malformed_action_missing_type_is_rejected():
    elements = _elements({})
    intents = [{"target": "email_1", "secret_ref": "EMAIL_FIELD_1"}]
    with pytest.raises(ActionValidationError):
        validate_intents(intents, elements)


def test_unknown_target_is_rejected():
    elements = _elements({})
    intents = [{"action": "click", "target": "does_not_exist"}]
    with pytest.raises(ActionValidationError):
        validate_intents(intents, elements)


def test_type_sensitive_without_secret_ref_is_rejected():
    elements = _elements({})
    intents = [{"action": "type_sensitive", "target": "email_1"}]
    with pytest.raises(ActionValidationError):
        validate_intents(intents, elements)


def test_literal_type_against_a_tokenized_sensitive_field_is_rewritten_not_rejected():
    # BEHAVIOUR CHANGE: this used to raise. A real VLM asked to fill a form
    # invents plausible data instead of referencing the field's token, and
    # failing the whole plan left the user unable to fill a form with their
    # own details. The literal is discarded and the field is filled from the
    # local profile instead — the security property (no literal ever reaches
    # a sensitive field) is unchanged; only the recovery is new.
    elements = _elements({})
    intents = [{"action": "type", "target": "email_1", "value": "john.doe@example.com"}]
    actions = validate_intents(intents, elements)
    assert actions[0].type.value == "type_sensitive"
    assert actions[0].secret_ref == "EMAIL_FIELD_1"
    assert actions[0].value is None


def test_literal_type_against_an_untokenized_sensitive_field_is_still_rejected():
    # No token means no local value to substitute, so there is nothing safe
    # to rewrite it into — fail closed.
    elements = _elements({"label_token": None})
    intents = [{"action": "type", "target": "email_1", "value": "john.doe@example.com"}]
    with pytest.raises(ActionValidationError):
        validate_intents(intents, elements)


def test_literal_type_into_an_ordinary_field_is_untouched():
    elements = _elements({"id": "q_1", "semantic_type": "search", "label_token": None})
    intents = [{"action": "type", "target": "q_1", "value": "headphones"}]
    actions = validate_intents(intents, elements)
    assert actions[0].type.value == "type"
    assert actions[0].value == "headphones"


def test_submit_action_forced_to_require_confirmation():
    elements = _elements({"id": "submit_1", "type": "button", "semantic_type": "submit", "label_token": None})
    intents = [{"action": "submit", "target": "submit_1", "requires_confirmation": False}]
    actions = validate_intents(intents, elements)
    assert actions[0].requires_confirmation is True


def test_password_field_action_forced_to_require_confirmation():
    elements = _elements(
        {"id": "password_1", "type": "input", "semantic_type": "password", "label_token": "[PASSWORD_FIELD_1]"}
    )
    intents = [
        {
            "action": "type_sensitive",
            "target": "password_1",
            "secret_ref": "PASSWORD_FIELD_1",
            "requires_confirmation": False,
        }
    ]
    actions = validate_intents(intents, elements)
    assert actions[0].requires_confirmation is True


def test_end_to_end_plan_via_api(client, auth_headers):
    body = {
        "task": "Fill out the registration form",
        "elements": [
            make_element(id="name_1", semantic_type="name", label_token="[PERSON_FIELD_1]"),
            make_element(id="email_1", semantic_type="email", label_token="[EMAIL_FIELD_1]"),
            make_element(id="phone_1", semantic_type="phone", label_token="[PHONE_FIELD_1]"),
            make_element(
                id="submit_1", type="button", semantic_type="submit", state="empty",
                editable=True, label_token=None,
            ),
        ],
        "nonce": "nonce-e2e-1",
    }
    resp = client.post("/api/agent/plan", json=body, headers=auth_headers)
    assert resp.status_code == 200
    data = resp.json()
    types = [a["type"] for a in data["actions"]]
    assert "type_sensitive" in types
    submit_actions = [a for a in data["actions"] if a["type"] == "submit"]
    assert submit_actions and submit_actions[0]["requires_confirmation"] is True
    # Every action must carry a signed, short-lived action token.
    assert all(a["action_token"] for a in data["actions"])


def test_invalid_action_from_a_provider_is_rejected_cleanly_not_500(client, auth_headers, monkeypatch):
    """Regression test: a real (occasionally imperfect) VLM provider can
    propose a structurally invalid action — e.g. a press_key with no target,
    which is exactly what happened against the live Qwen3-VL provider. This
    must come back as a clean 422, not fall through to an unhandled 500."""
    from app.inference.vlm_base import VisionLanguageModel

    class BadProvider(VisionLanguageModel):
        name = "bad-provider"

        async def analyze(self, screenshot, elements, task, conversation_history=None):
            return {
                "message": "pressing a key",
                "actions": [{"action": "press_key", "reason": "no target given, like the real model did"}],
            }

    monkeypatch.setattr("app.agent.planner.get_provider", lambda name: BadProvider())

    body = {
        "task": "Fill out the registration form",
        "elements": [make_element()],
        "nonce": "nonce-bad-provider-1",
    }
    resp = client.post("/api/agent/plan", json=body, headers=auth_headers)
    assert resp.status_code == 422
    assert "press_key" in resp.text


def test_plain_button_is_not_mistaken_for_submit(client, auth_headers):
    body = {
        "task": "Fill out the registration form",
        "elements": [
            make_element(id="email_1", semantic_type="email", label_token="[EMAIL_FIELD_1]"),
            make_element(
                id="cancel_btn", type="button", semantic_type="button", state="empty",
                editable=True, label_token=None,
            ),
        ],
        "nonce": "nonce-plain-button-1",
    }
    resp = client.post("/api/agent/plan", json=body, headers=auth_headers)
    assert resp.status_code == 200
    data = resp.json()
    submit_actions = [a for a in data["actions"] if a["type"] == "submit"]
    assert submit_actions == []


def test_real_world_page_element_counts_are_accepted(client, auth_headers):
    """Regression test: a complex real page (e.g. a YouTube-style SPA) can
    easily have 200+ interactive elements — the old 200-item cap rejected
    real usage outright. 300 must be accepted; well above the cap must not."""
    elements = [make_element(id=f"el_{i}", semantic_type="button", type="button", label_token=None) for i in range(300)]
    body = {"task": "look around", "elements": elements, "nonce": "nonce-many-elements-1"}
    resp = client.post("/api/agent/plan", json=body, headers=auth_headers)
    assert resp.status_code == 200

    too_many = [make_element(id=f"el_{i}", semantic_type="button", type="button", label_token=None) for i in range(700)]
    body2 = {"task": "look around", "elements": too_many, "nonce": "nonce-many-elements-2"}
    resp2 = client.post("/api/agent/plan", json=body2, headers=auth_headers)
    assert resp2.status_code == 422
