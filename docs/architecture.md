# Architecture

## Problem

SIH 2026 #26171 — On-device Visual Perception for Light-weight Browser Agents.
A browser agent needs to *see* a webpage (screenshot + DOM) and *act* on it,
but the reasoning model (a VLM) typically runs remotely. Sending raw page
content to that remote service risks leaking passwords, names, emails,
phone numbers, addresses, financial data, and other PII. This project keeps
all raw sensitive data on-device and sends the remote model only a
sanitized, tokenized representation of the page.

## Two-tier design

```
                 USER DEVICE (Tier 1 — extension)
┌──────────────────────────────────────────────────────────┐
│ Web Page (DOM + rendered pixels)                          │
│    ↓ DOM Extraction (domExtractor.ts)                     │
│ DOM PII Detection (privacy/pii-detector.ts)                │
│    ↓                                                        │
│ Visual Region Detection (ml/visionDetector.ts, run          │
│   directly in the background service worker)                │
│    ↓                                                        │
│ PII Region Fusion (privacy/redactor.ts: fuseRegions)        │
│    ↓                                                        │
│ Local Redaction + Semantic Tokenization                     │
│   (privacy/redactor.ts, privacy/tokenizer.ts)                │
│    ↓                                                        │
│ Sanitized Screenshot (OffscreenCanvas) + UI Metadata         │
└──────────────────────┬──────────────────────────────────────┘
                        │ sanitized data only (tokens, bboxes,
                        │ redacted screenshot) — nonce + API key
                        ↓
                 REMOTE (Tier 2 — backend)
┌──────────────────────────────────────────────────────────┐
│ FastAPI: POST /api/agent/plan                              │
│   privacy/validators.py — rejects raw-PII-shaped payloads   │
│   agent/planner.py → inference/<provider>.py (VLM)          │
│   actions/validator.py — strict schema + business rules     │
│   security/tokens.py — signs short-lived action tokens      │
└──────────────────────┬──────────────────────────────────────┘
                        │ structured, validated action plan
                        │ (target ids + secret_ref tokens only)
                        ↓
                 USER DEVICE (Tier 1 — extension)
┌──────────────────────────────────────────────────────────┐
│ background.ts: human confirmation for high-risk actions     │
│   background/secretStore.ts: secret_ref → real value         │
│     (chrome.storage.local; never sent over the network)     │
│   actions/actionExecutor.ts → content-script.ts (DOM),        │
│     falling back to actions/debuggerExecutor.ts (CDP)        │
└──────────────────────────────────────────────────────────┘
```

## Repository layout

```
privacy-browser-agent/
├── extension/     Chrome MV3 extension (TypeScript, esbuild)
├── backend/       FastAPI backend (Python)
├── demo/          Static mock registration form for the end-to-end demo
├── docs/          This file + security/privacy/threat-model
└── scripts/       Latency benchmark script
```

## Extension internals (`extension/src`)

- `shared/` — types and message protocol shared by every extension context.
- `privacy/` — `pii-detector.ts` (DOM heuristics), `redactor.ts` (fusion +
  redaction), `tokenizer.ts` (semantic token assignment), `privacy-policy.ts`
  (single source of truth for what's sensitive / what needs confirmation),
  `audit.ts` (debug trail that structurally cannot record raw values).
- `ml/` — `visionDetector.ts` (the `VisionDetector` interface),
  `onnxFaceDetector.ts` (the real detector — `onnxruntime-web`, WASM
  execution provider), `faceDetectionMath.ts` (pure, unit-testable
  pre/post-processing). Called directly from `background.ts`'s service
  worker, not a nested Worker — `new Worker()` is unavailable inside
  `ServiceWorkerGlobalScope` on Chrome (confirmed by testing, not assumed;
  an earlier version tried a dedicated Worker and hit
  `ReferenceError: Worker is not defined` in practice). The service worker
  is already off any page's main thread, which is what "don't block the
  page" actually requires — the extra Worker layer would have added
  isolation, but wasn't load-bearing for that requirement.

  **WebGPU was attempted and removed, not just left unimplemented** — also
  confirmed by testing, not assumed. `onnxruntime-web`'s WebGPU/JSEP backend
  loads its glue code via a dynamic `import()`, which the HTML spec
  disallows inside `ServiceWorkerGlobalScope`
  (`TypeError: import() is disallowed on ServiceWorkerGlobalScope by the
  HTML specification`). Worse, even attempting it first left
  `onnxruntime-web`'s shared WASM init state poisoned, so a same-realm
  WASM-only retry after a failed WebGPU attempt failed too. Real WebGPU
  support would require moving inference into a `chrome.offscreen` document
  (a genuine page context, where both `import()` and `Worker` work) — a
  concrete, scoped future-work item, not implemented here. Current
  execution is WASM-only, via `onnxruntime-web/wasm` (not `.../webgpu`),
  which avoids the JSEP code path entirely; this also halved the shipped
  WASM binary (~14MB vs. ~28MB for the JSEP build).

  Model: [`version-RFB-320.onnx`](https://github.com/Linzaer/Ultra-Light-Fast-Generic-Face-Detector-1MB)
  (MIT license, ~1.1MB — see `extension/public/models/NOTICE`), bundled in
  the extension for offline/on-device operation. Only
  `npm run benchmark`'s measured numbers should be quoted as latency, per
  this project's benchmark-honesty rule.
- `content/` — injected on demand into the active tab: DOM extraction,
  screenshot redaction (OffscreenCanvas), and local action execution.
- `background/` — the service worker: orchestrates the pipeline, holds the
  local secret store, talks to the backend, and drives the confirmation flow.
- `actions/` — `actionExecutor.ts` (executes a validated action, resolving
  `secret_ref` locally first) and `debuggerExecutor.ts` (Chrome Debugger API
  fallback for pages where synthetic DOM events don't register).
- `popup/` — the dashboard UI (status, confirmations, local profile, backend
  settings).

Nothing is injected as a persistent `<all_urls>` content script — see
`docs/security.md` for why (permission minimization).

## Backend internals (`backend/app`)

- `models/schemas.py` — the strict Pydantic schema every request/response
  must satisfy (elements, actions, plan request/response).
- `privacy/validators.py` — scans every inbound payload for PII-shaped
  values and rejects the request if any are found (defense in depth on top
  of client-side sanitization); also provides log redaction.
- `inference/` — `vlm_base.py` (the `VisionLanguageModel` interface),
  `mock_provider.py` (rule-based, zero-config default), `qwen_provider.py`
  (real — Qwen3-VL 8B via OpenRouter's hosted API, opt-in via
  `VLM_PROVIDER=qwen` + `OPENROUTER_API_KEY`; see README "Using a real VLM"),
  `llava_provider.py` (still a documented stub), `provider_factory.py`.
- `agent/` — `planner.py` (orchestrates provider → validator → token
  signing) and `prompts.py` (channel-separated `SYSTEM POLICY`/`USER
  TASK`/`WEBPAGE CONTENT` prompt template, used directly by
  `qwen_provider.py` — see `docs/security.md` §Prompt Injection).
- `actions/validator.py` — turns raw provider intents into validated
  `Action` objects; rejects unknown targets, malformed actions, and forces
  `requires_confirmation=true` on anything high-risk.
- `security/` — API-key auth, HMAC-signed short-lived action tokens, replay
  guards (nonce + action-token), and a prompt-injection heuristic.

## Data flow guarantee

The type system enforces the privacy boundary as much as the logic does:
`SanitizedElement` (extension → backend) and the backend's `Element`/`Action`
models have no field capable of holding a raw value — `label_token`/
`secret_ref` are the only content-carrying fields, and both are semantic
token strings, never user data. See `docs/privacy.md` for how this is tested.

## Why DOM extraction, not a general vision model, reads the screen

SIH #26171 scores "accuracy of visual context from screen" as its single
highest-weighted criterion. This system's answer is **DOM extraction**
(`content/domExtractor.ts`), not a general-purpose on-device vision
transformer — deliberately. The browser's own render tree already gives
element positions, types, and current values *exactly*, not as an
approximation recovered from pixels; a vision model asked to reconstruct
that same structure from a screenshot could only ever approach, never
exceed, that accuracy, while consuming meaningfully more client-side
compute and latency (both separately scored criteria) to do it.

Vision is deliberately scoped to the one thing DOM extraction cannot see at
all: pixel content that was never text or DOM in the first place — a
rendered photo, a scanned ID card, a passport image embedded as an `<img>`.
That's exactly what `OnnxFaceDetector` targets (see below). Fusing the two
(`privacy/redactor.ts: fuseRegions`) gives ground-truth structure plus
vision's one genuine addition, rather than a single model doing both jobs
worse.

## What's real vs. mocked in this MVP

| Component | Status |
|---|---|
| DOM PII detection | Real (heuristic: value-shape + metadata + autocomplete) |
| Local redaction/tokenization | Real |
| Screenshot redaction (OffscreenCanvas) | Real |
| Vision-based region detection | Real — on-device face detection (`OnnxFaceDetector`, `version-RFB-320.onnx` via `onnxruntime-web`/WASM), run directly in the background service worker. Tiled (`faceDetectionMath.ts: computeTiles`, up to a bounded 3x3 grid) so small thumbnail faces on dense pages don't get lost in a single full-screenshot downscale — verified end to end by testing on a real photo-grid page, not assumed. WebGPU was tried and is not usable from a service worker (see above) — a documented future-work item, not silently dropped. `MockVisionDetector` remains as a defensive fallback only |
| Backend privacy validation | Real |
| VLM planning | Real, opt-in — `OpenRouterVLMProvider` calls a hosted Qwen3-VL model; `mock` (rule-based) stays the zero-config default. `LLaVAProvider` remains a documented stub |
| Action schema validation | Real |
| Action tokens / replay protection | Real |
| Human confirmation | Real |
| Local action execution (DOM) | Real |
| Local action execution (Debugger API fallback) | Real, exercised only when the DOM path fails |
| ZK-ML / cryptographic privacy proofs | **Not implemented** — see `docs/privacy.md` §Future Work |
