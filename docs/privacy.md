# Privacy Design

## Principle

Raw sensitive data (passwords, names, emails, phone numbers, addresses,
financial/identity data, personal documents, other PII) never needs to
leave the user's device in raw form. The backend reasons about the page
using semantic tokens, bounding boxes, and a redacted screenshot only.

## Pipeline

See `docs/architecture.md` for the full diagram. In short:

1. **DOM extraction** (`extension/src/content/domExtractor.ts`) reads the
   live DOM (values, labels, autocomplete attributes, bounding boxes).
2. **DOM PII detection** (`extension/src/privacy/pii-detector.ts`) classifies
   each field using three signals, not regex alone: value shape (email/phone/
   card/Aadhaar/PAN/API-key patterns), field metadata (name/id/label
   keywords), and `autocomplete` attribute mapping. `input[type=password]`
   is always treated as sensitive regardless of value.
3. **Visual region detection** (`extension/src/ml/visionDetector.ts`) is an
   abstraction (`VisionDetector.detect(image): Promise<DetectedRegion[]>`)
   for catching sensitive regions the DOM can't see. `OnnxFaceDetector`
   (`onnxFaceDetector.ts`) is the real implementation: on-device face
   detection via `onnxruntime-web` (WASM execution provider — WebGPU is not
   usable from an MV3 service worker, see `docs/architecture.md`), run
   directly in the background service worker (already off any page's main
   thread — a nested Worker was tried and doesn't work inside
   ServiceWorkerGlobalScope on Chrome) — a face in a screenshot (photo,
   scanned ID) is visual PII the DOM layer structurally cannot see.
   `MockVisionDetector` remains as a defensive fallback if the real
   detector fails to construct.
4. **Rendered-text scanning** (`extension/src/content/textScanner.ts`,
   detection in `privacy/textPii.ts`) covers what the other two layers
   structurally cannot: text a page merely *prints*. Steps 1-2 only walk
   form controls, and step 3 looks for faces, so a participant name in a
   video call or an address in an order summary was a field nobody owned —
   it produced no element, no region, and stayed legible in the screenshot.
   Shaped values (email/phone/card/Aadhaar/...) are matched with offsets so
   only the matching span is covered. Names have no detectable shape, so
   they are caught two ways: a markup signal (`data-self-name`,
   `class="participant-name"`, matched on identifier TOKENS so `filename`
   doesn't qualify), or a capitalised-word-run heuristic filtered through a
   UI/product stoplist. The heuristic errs toward over-redaction, per the
   trade-off stated on `MIN_REDACTION_CONFIDENCE` — see the limits below.
5. **PII region fusion** (`redactor.ts: fuseRegions`) merges overlapping
   DOM/vision detections rather than duplicating them.
6. **Local redaction + semantic tokenization** (`redactor.ts`,
   `tokenizer.ts`) replaces each sensitive field with a token like
   `[EMAIL_FIELD_1]` and draws an opaque placeholder box + label over the
   corresponding screenshot region (`content/screenshotSanitizer.ts`, via
   `OffscreenCanvas`).
7. **Sanitized screenshot + UI metadata** — the `SanitizedElement` list
   (id, type, semantic_type, bbox, state, editable, label_token) plus the
   redacted screenshot are the *only* things sent to the backend.

## Known limits of name detection

A person's name has no shape to match, unlike an email or an Aadhaar
number. `privacy/textPii.ts` therefore makes a judgement call, and it is
wrong in both directions:

- **False positives.** A short title-case phrase the stoplist doesn't know
  ("Blue Origin", an unusual button label) gets a black box. The cost is
  page context the agent can no longer read.
- **False negatives.** A name rendered lowercase, as a single word, or in a
  non-Latin script is invisible to the shape heuristic and is only caught
  if the surrounding markup names it. A page that renders names in obfuscated
  markup with no naming hint — which is most single-page apps — relies on
  the shape heuristic alone.

The bias is deliberate and matches `MIN_REDACTION_CONFIDENCE`: over-redacting
costs UX, under-redacting costs privacy. What this layer is NOT is a
guarantee — it is best-effort coverage for a category that cannot be
detected exactly without a named-entity model running on-device.

## What the backend receives (and what it never receives)

Given a page with:
```
Name: Rahul Sharma
Email: rahul@example.com
Phone: 9876543210
Password: ********
```

the backend receives elements shaped like:
```json
{
  "id": "pba-3", "type": "input", "semantic_type": "email",
  "bbox": {"x": 10, "y": 80, "width": 200, "height": 24},
  "state": "filled", "editable": true, "label_token": "[EMAIL_FIELD_1]"
}
```
— never `"rahul@example.com"`. The backend's action plan then references
`secret_ref: "EMAIL_FIELD_1"`, and only the extension (via
`background/secretStore.ts`, backed by `chrome.storage.local`) turns that
back into the real email when filling the form.

## Server-side backstop

`extension` sanitization is the primary control, but a compromised or buggy
client is still possible, so the backend independently scans every request
for PII-shaped values (`backend/app/privacy/validators.py`) and rejects the
request with HTTP 422 if it finds one — see `backend/tests/test_privacy.py`.

## Module map (`privacy/` on both sides)

| File | Responsibility |
|---|---|
| `extension/src/privacy/pii-detector.ts` | DOM-based classification |
| `extension/src/privacy/redactor.ts` | Fusion + redaction + tokenized element output |
| `extension/src/privacy/tokenizer.ts` | Stable semantic token assignment |
| `extension/src/privacy/privacy-policy.ts` | Single source of truth: what's sensitive, what needs confirmation |
| `extension/src/privacy/audit.ts` | Dev/debug trail — records detected/redacted/token, never the raw value |
| `backend/app/privacy/validators.py` | Server-side raw-PII rejection + log redaction |

## Automated proof, not just a claim

- `extension/tests/redactor.test.ts` — `sanitizeElements` output, serialized
  to JSON exactly as it would be sent over the wire, is asserted to never
  contain the original name/email/phone/password strings.
- `backend/tests/test_privacy.py` — the `/api/agent/plan` response body is
  asserted to never contain sample raw PII strings, and a request that does
  contain one is asserted to be rejected (422).

## What is explicitly NOT implemented (future work)

- **ZK-ML / cryptographic privacy proofs.** This MVP does not implement
  EZKL/Halo2 or any zero-knowledge proof that redaction was performed
  correctly — that would let a *third party* verify the privacy guarantee
  without trusting the extension's code. What's here is ordinary
  engineering-level data minimization, enforced by the client, backed up by
  server-side validation, and covered by tests — not a mathematical proof.
  `backend/app/security/` is structured so a future EZKL/Halo2 verifier could
  sit between `privacy/validators.py` and the agent planner without
  disrupting the rest of the pipeline, but no such verifier exists yet.
- **Vision detection is face-only.** `OnnxFaceDetector` catches faces
  rendered as pixels (photos, scanned IDs); it does not attempt general
  document/text-in-image PII (e.g. OCR over a scanned form). A general
  on-device OCR/PII-in-image pass is future work, not implemented here.
- **VLM: one real provider.** `OpenRouterVLMProvider` (Qwen3-VL via
  OpenRouter, opt-in via `VLM_PROVIDER=qwen`) is real; `mock` remains the
  zero-config default; `LLaVAProvider` is still a documented stub.
- **No formal precision/recall evaluation set.** PII detection and face
  detection have been exercised manually against the demo page and ad hoc
  test images, not against a labeled benchmark dataset — a real precision/
  recall number is not claimed anywhere in this repo for that reason.

Do not represent this MVP as providing mathematically verified privacy —
it provides an enforced, tested data-minimization pipeline.
