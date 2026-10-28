"""The raw-PII boundary must not fire on the nonce.

A nonce is random, and randomness eventually looks like anything — about
1.1% of UUIDs contain a digit/dash run the phone pattern matches. Scanning
it meant roughly one message in sixty died with a privacy error that named
no real privacy problem, which is worse than useless: it teaches the user to
distrust the very warning that matters.
"""
import pytest

from tests.conftest import make_element


def _body(nonce: str):
    return {
        "task": "leave the meeting",
        "screenshot": None,
        "elements": [make_element()],
        "conversation_history": [],
        "nonce": nonce,
    }


# Real crypto.randomUUID() outputs whose digit runs trip the patterns.
@pytest.mark.parametrize(
    "nonce",
    [
        "a1b2c3d4-1234-5678-9012-345678901234",  # phone / card / aadhaar shaped
        "12345678-9012-3456-7890-123456789012",
        "00000000-0000-0000-0000-000000000000",
    ],
)
def test_pii_shaped_nonce_is_not_rejected(client, auth_headers, nonce):
    resp = client.post("/api/agent/plan", json=_body(nonce), headers=auth_headers)
    assert resp.status_code == 200, resp.text


def test_nonce_must_be_an_opaque_identifier(client, auth_headers):
    # The exclusion is only defensible because the shape is constrained —
    # free text here would be an unscanned channel straight past the
    # boundary. Spaces and punctuation are what carry a name or an address.
    resp = client.post("/api/agent/plan", json=_body("call me on 9876543210"), headers=auth_headers)
    assert resp.status_code == 422
    resp = client.post("/api/agent/plan", json=_body("rahul@example.com"), headers=auth_headers)
    assert resp.status_code == 422


def test_real_pii_elsewhere_is_still_rejected(client, auth_headers):
    body = _body("a1b2c3d4-e5f6-7890-abcd-ef1234567890")
    body["task"] = "text my number 9876543210 to them"
    resp = client.post("/api/agent/plan", json=body, headers=auth_headers)
    assert resp.status_code == 422
    assert "sensitive-looking value" in resp.json()["detail"]
