import json

import pytest

from app.privacy.validators import RawPiiDetected, redact_for_log, scan_for_raw_pii
from tests.conftest import make_element


def test_scan_allows_semantic_tokens():
    payload = {"task": "Fill the registration form", "elements": [make_element()]}
    scan_for_raw_pii(payload)  # should not raise


@pytest.mark.parametrize(
    "value",
    [
        "rahul@example.com",
        "9876543210123",  # phone-like
        "4111 1111 1111 1111",  # card-like
        "1234 5678 9012",  # aadhaar-like
        "ABCDE1234F",  # pan-like
        "password: hunter22",
    ],
)
def test_scan_rejects_raw_pii_like_values(value):
    payload = {"task": "irrelevant", "note": value}
    with pytest.raises(RawPiiDetected):
        scan_for_raw_pii(payload)


def test_redact_for_log_strips_email():
    msg = "user entered rahul@example.com into the form"
    redacted = redact_for_log(msg)
    assert "rahul@example.com" not in redacted
    assert "[REDACTED]" in redacted


def test_plan_endpoint_does_not_scan_screenshot_field_for_pii(client, auth_headers):
    # Base64 image data is high-entropy and will very often coincidentally
    # contain substrings matching the loose PII regexes (e.g. an api_key-like
    # "pk"/"sk" + 16 alnum chars run). The screenshot has already been
    # redacted client-side (canvas boxes) — it must not be text-scanned.
    fake_base64_screenshot = "data:image/png;base64," + ("pk_" + "A1b2C3d4E5f6G7h8I9j0" * 50)
    body = {
        "task": "Fill out the registration form",
        "screenshot": fake_base64_screenshot,
        "elements": [make_element()],
        "nonce": "nonce-screenshot-not-scanned-1",
    }
    resp = client.post("/api/agent/plan", json=body, headers=auth_headers)
    assert resp.status_code == 200


def test_plan_endpoint_rejects_raw_email(client, auth_headers):
    body = {
        "task": "Fill the form with rahul@example.com",
        "elements": [make_element()],
        "nonce": "nonce-raw-pii-1",
    }
    resp = client.post("/api/agent/plan", json=body, headers=auth_headers)
    assert resp.status_code == 422
    assert "rahul@example.com" not in resp.text


def test_plan_endpoint_sanitized_payload_never_leaks_pii_in_response(client, auth_headers):
    body = {
        "task": "Fill out the registration form",
        "elements": [make_element()],
        "nonce": "nonce-clean-1",
    }
    resp = client.post("/api/agent/plan", json=body, headers=auth_headers)
    assert resp.status_code == 200
    raw_text = resp.text
    for forbidden in ("Rahul Sharma", "rahul@example.com", "9876543210", "hunter2"):
        assert forbidden not in raw_text
    data = resp.json()
    assert data["raw_pii_sent_to_server"] == 0


def test_plan_response_never_contains_raw_value_only_secret_ref(client, auth_headers):
    body = {
        "task": "Fill out the registration form",
        "elements": [make_element()],
        "nonce": "nonce-clean-2",
    }
    resp = client.post("/api/agent/plan", json=body, headers=auth_headers)
    data = resp.json()
    sensitive_actions = [a for a in data["actions"] if a["type"] == "type_sensitive"]
    assert sensitive_actions, "expected at least one type_sensitive action"
    for action in sensitive_actions:
        assert action["secret_ref"] == "EMAIL_FIELD_1"
        assert action.get("value") is None
