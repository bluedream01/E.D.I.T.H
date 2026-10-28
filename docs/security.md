# Security

## Auth

`POST /api/agent/plan` and `POST /api/agent/verify-action` require an
`X-API-Key` header (`backend/app/security/auth.py`), compared with
`hmac.compare_digest` to avoid timing side channels. This is an MVP-grade
scheme (a single shared static key) — before any real deployment, replace it
with per-installation credentials issued at extension setup time (e.g. OAuth
2.0 device-code flow or a backend-issued installation token), and put the
backend behind TLS (the FastAPI app is TLS-ready — terminate TLS at a
reverse proxy or via `uvicorn --ssl-keyfile/--ssl-certfile`).

## Third-party VLM calls (OpenRouter)

When `VLM_PROVIDER=qwen` is set, `backend/app/inference/qwen_provider.py`
sends requests to `https://openrouter.ai/api/v1/chat/completions` — the
first (and only) point in this codebase where data leaves the backend to a
third-party network service. What it sends is exactly what the rest of the
system already guarantees never contains raw PII: the *sanitized* screenshot
(already redacted client-side) and the tokenized elements list — the same
payload that already passed `privacy/validators.py`'s raw-PII rejection
before `qwen_provider.py` ever sees it. See `backend/tests/test_openrouter_provider.py::test_sanitized_screenshot_is_the_only_image_data_sent`.

`OPENROUTER_API_KEY` (`security/config.py`) is read from the environment
only, sent solely as an `Authorization: Bearer` header (never a query
param — verified by `test_api_key_sent_as_header_not_query_param`), and is
never placed in a log message; the existing `RedactingLogFilter` /
`redact_for_log()` machinery covers it the same way it covers everything
else. A non-200 or malformed response from OpenRouter is turned into a
generic `ValueError` → HTTP 503, never echoing the raw response body back to
the extension (which could, in principle, itself have been influenced by
adversarial webpage content reflected through the model).

## Origin / CORS

`ALLOWED_ORIGINS` (see `backend/app/security/config.py`) defaults to `*` for
local development, because an *unpacked* extension gets a random
`chrome-extension://<id>` origin that can't be pinned ahead of time. **Before
packing/publishing the extension**, set `ALLOWED_ORIGINS` to the extension's
real, fixed origin (Chrome Web Store extension IDs are stable) and drop the
wildcard.

## Request validation

Every request body is a strict Pydantic model (`backend/app/models/schemas.py`)
— unknown fields, malformed bounding boxes, oversized strings, and duplicate
element ids are all rejected before any business logic runs.

## Strict action schema

The backend can only ever emit `Action` objects matching the enum of
`ActionType`s; a provider can never smuggle free-form text or code into the
plan. `backend/app/actions/validator.py` additionally:
- rejects any action whose `target` isn't a known element id,
- rejects `type_sensitive` actions without a `secret_ref` (or with a literal
  `value`, which would defeat the point),
- rejects literal `type` actions against a field whose `semantic_type` is
  sensitive,
- forces `requires_confirmation = true` on `submit` and on any action
  targeting a high-risk field (`payment`, `account_delete`, `password`) —
  **regardless of what the provider returned**, so a compromised/hallucinating
  provider can't skip confirmation.

## Short-lived, single-use action tokens

Every returned action carries an HMAC-signed `action_token`
(`backend/app/security/tokens.py`) covering `(plan_id, index, action_type,
target, expiry)`, with a short TTL (default 120s,
`ACTION_TOKEN_TTL_SECONDS`). `POST /api/agent/verify-action` checks the
signature, expiry, and (via `security/replay.py`) that the token hasn't
already been consumed, before the extension executes a high-risk action.

## Replay protection

Two layers, both in `backend/app/security/replay.py`:
1. **Plan-request nonces** — `PlanRequest.nonce` must be unique per request;
   a repeat is rejected with HTTP 409.
2. **Action-token consumption** — each `action_token` can be verified/consumed
   exactly once via `/api/agent/verify-action`.

Both guards are in-memory (single backend instance). For a multi-replica
deployment, back them with Redis/a shared store instead — noted here rather
than implemented, to keep the MVP dependency-light.

## Logging

`backend/app/main.py` installs a `RedactingLogFilter` on every log handler
that strips PII-shaped substrings from any log message before it's emitted,
on top of `privacy/validators.py`'s `redact_for_log()` helper used
explicitly where user-influenced strings are logged. The global exception
handler returns a generic `"internal server error"` — never a stack trace or
raw exception text — to the client, and logs the full traceback
server-side-only.

## Extension permission minimization

- **No persistent content script.** `manifest.json` declares no
  `content_scripts` entry; the content script is injected on demand via
  `chrome.scripting.executeScript`, gated by the `activeTab` permission
  (granted only when the user invokes the extension). This avoids requesting
  `<all_urls>` host permissions entirely.
- **`host_permissions`** is limited to the local backend origins
  (`http://localhost:8001`, `http://127.0.0.1:8001`). Change this to the
  deployed backend's origin in production.
- **`debugger`** is an *optional* permission
  (`optional_permissions`), requested just-in-time via
  `chrome.permissions.request` only when the DOM-based action path fails
  (`extension/src/actions/debuggerExecutor.ts`), and the debugger is
  detached immediately after each use. Chrome also shows its own
  "this extension is debugging this browser" infobar while attached.
- **`content_security_policy`** restricts extension pages to `script-src
  'self'` — no inline scripts, no remote code.

## Threat model

See `docs/threat-model.md`.
