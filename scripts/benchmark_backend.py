#!/usr/bin/env python3
"""
Benchmarks backend latency: /api/agent/plan (which includes the privacy
scan + mock-VLM planning + action-token signing) and /health as a baseline.

Usage:
    python scripts/benchmark_backend.py --url http://127.0.0.1:8001 --api-key dev-local-only-key --n 50

This measures REAL wall-clock latency against a running backend instance —
it does not fabricate numbers. Run it yourself and report what you observe;
figures will vary by machine, provider (mock vs. a real VLM), and load.
"""
from __future__ import annotations

import argparse
import statistics
import time
import uuid

import httpx


def percentile(data: list[float], pct: float) -> float:
    if not data:
        return float("nan")
    s = sorted(data)
    k = (len(s) - 1) * pct
    f = int(k)
    c = min(f + 1, len(s) - 1)
    if f == c:
        return s[f]
    return s[f] + (s[c] - s[f]) * (k - f)


def sample_elements() -> list[dict]:
    return [
        {
            "id": "name_1", "type": "input", "semantic_type": "name",
            "bbox": {"x": 10, "y": 40, "width": 200, "height": 24},
            "state": "empty", "editable": True, "label_token": "[PERSON_FIELD_1]",
        },
        {
            "id": "email_1", "type": "input", "semantic_type": "email",
            "bbox": {"x": 10, "y": 80, "width": 200, "height": 24},
            "state": "empty", "editable": True, "label_token": "[EMAIL_FIELD_1]",
        },
        {
            "id": "phone_1", "type": "input", "semantic_type": "phone",
            "bbox": {"x": 10, "y": 120, "width": 200, "height": 24},
            "state": "empty", "editable": True, "label_token": "[PHONE_FIELD_1]",
        },
        {
            "id": "submit_1", "type": "button", "semantic_type": "submit",
            "bbox": {"x": 10, "y": 160, "width": 100, "height": 32},
            "state": "empty", "editable": True, "label_token": None,
        },
    ]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:8001")
    parser.add_argument("--api-key", default="dev-local-only-key")
    parser.add_argument("--n", type=int, default=50)
    args = parser.parse_args()

    client = httpx.Client(base_url=args.url, headers={"X-API-Key": args.api_key}, timeout=10.0)

    health_latencies: list[float] = []
    for _ in range(args.n):
        t0 = time.perf_counter()
        resp = client.get("/health")
        health_latencies.append((time.perf_counter() - t0) * 1000)
        resp.raise_for_status()

    plan_latencies: list[float] = []
    for _ in range(args.n):
        body = {
            "task": "Fill out the registration form",
            "screenshot": None,
            "elements": sample_elements(),
            "nonce": uuid.uuid4().hex,
        }
        t0 = time.perf_counter()
        resp = client.post("/api/agent/plan", json=body)
        plan_latencies.append((time.perf_counter() - t0) * 1000)
        resp.raise_for_status()

    def report(name: str, data: list[float]) -> None:
        print(f"\n{name} (n={len(data)})")
        print(f"  mean : {statistics.mean(data):.2f} ms")
        print(f"  p50  : {percentile(data, 0.50):.2f} ms")
        print(f"  p95  : {percentile(data, 0.95):.2f} ms")
        print(f"  max  : {max(data):.2f} ms")

    report("GET /health", health_latencies)
    report("POST /api/agent/plan (mock provider)", plan_latencies)
    print("\nNote: /api/agent/plan latency includes privacy PII scanning, mock-VLM")
    print("planning, action validation, and action-token signing end to end.")
    print("A real VLM provider (Qwen2-VL/LLaVA) will be substantially slower than")
    print("the mock provider — rerun this script against that deployment to measure it.")


if __name__ == "__main__":
    main()
