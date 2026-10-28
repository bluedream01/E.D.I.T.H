import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

os.environ.setdefault("AGENT_API_KEY", "test-key")
os.environ.setdefault("AGENT_TOKEN_SECRET", "test-secret")
os.environ.setdefault("VLM_PROVIDER", "mock")

import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture()
def client():
    return TestClient(app)


@pytest.fixture()
def auth_headers():
    return {"X-API-Key": "test-key"}


def make_element(**overrides):
    base = {
        "id": "email_1",
        "type": "input",
        "semantic_type": "email",
        "bbox": {"x": 10, "y": 10, "width": 100, "height": 20},
        "state": "empty",
        "editable": True,
        "label_token": "[EMAIL_FIELD_1]",
    }
    base.update(overrides)
    return base
