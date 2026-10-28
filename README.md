# Privacy-Preserving On-Device Visual Browser Agent

SIH 2026, Problem Statement #26171 — *On-device Visual Perception for
Light-weight Browser Agents*.

A Chrome extension + local AI pipeline that lets a browser agent understand
and act on a webpage while ensuring raw sensitive data (passwords, names,
emails, phone numbers, addresses, financial/identity data) never has to
leave the device in raw form. See `docs/architecture.md` for the full
design, `docs/privacy.md` for the redaction pipeline, `docs/security.md` and
`docs/threat-model.md` for the security posture.

```
User Browser → Local Sanitization → Sanitized Screenshot/DOM → VLM Backend → Action Plan → Extension → Local Action Execution
```

## Repository layout

```
privacy-browser-agent/
├── extension/    Chrome MV3 extension (TypeScript)
├── backend/      FastAPI backend (Python)
├── demo/         Static mock registration form
├── docs/         Architecture / privacy / security / threat-model
└── scripts/      Latency benchmark script
```

## 1. Install dependencies

```bash
cd backend && pip install -r requirements.txt
cd ../extension && npm install
```

## 2. Build the extension

```bash
cd extension
npm run build
```

This produces `extension/dist/` — the loadable, unpacked extension.

## 3. Load the extension into Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select `extension/dist`.
4. Pin the extension (puzzle-piece icon → pin) so its popup is easy to reach.

## 4. Start the backend

```bash
cd backend
uvicorn app.main:app --reload
```

Runs on `http://127.0.0.1:8001` by default, using the mock VLM provider and
a dev API key (`dev-local-only-key`) — both configured via environment
variables (see `backend/app/security/config.py`). Verify it's up:

```bash
curl http://127.0.0.1:8001/health
```

Or with Docker:

```bash
docker compose up --build
```

## 5. Open the demo webpage

Open `demo/mock-form/index.html` directly in Chrome (`file://...`), or serve
it with any static server. It's a small registration form (name, email,
phone, password, address) with no real backend of its own — submitting it
just shows a local "registered" message.

## 6. Run the agent

1. Click the extension's toolbar icon to open the popup.
2. (Optional) Expand **Local profile** and fill in the values you want the
   agent to use (e.g. your demo name/email/phone) — these are stored only in
   `chrome.storage.local` on your device and are never sent to the backend.
   Name is split into **First name** / **Last name** / **Full name** so the
   agent can fill either a split or a single-field form; leave one side blank
   and it is derived from the other (first + last -> full name, full name ->
   first + rest).
3. Confirm **Backend settings** matches your running backend
   (`http://127.0.0.1:8001` / `dev-local-only-key` by default).
4. With the demo page as the active tab, type a message in the popup's chat
   box — e.g. *"fill the form"*, *"search for headphones"*, on YouTube
   *"play believer"* (say it once to search, again to open the top result),
   or in a video call *"leave the meeting"* — and press
   Enter/**Send**.
5. Watch the chat: the agent replies explaining what it's doing (or why it
   isn't), fills fields automatically, then shows a confirmation prompt
   (**Allow**/**Deny**) before submitting — this is the human-in-the-loop
   gate for high-risk actions. You can keep chatting — it's a real
   conversation, not a one-shot command box; each new message can build on
   what you said before.

## 7. Observe the privacy behavior

In the popup dashboard:
- **Privacy Shield: ACTIVE**
- **Raw PII sent to server: 0** — always zero; the backend's response
  literally carries this as a field (`raw_pii_sent_to_server`) so it can be
  displayed directly rather than inferred.
- **Sensitive regions hidden: N** — count of fields the local detector
  redacted before anything left the device.

To verify this yourself rather than take the UI's word for it: open Chrome
DevTools → Network on the extension's service worker (`chrome://extensions`
→ your extension → *service worker* → *inspect*), trigger a task, and
inspect the `POST /api/agent/plan` request body — you'll see
`[EMAIL_FIELD_1]`-style tokens and a redacted screenshot, never the values
you typed into the local profile.

## Using a real VLM instead of the mock (optional)

By default the backend uses `MockVLMProvider` — rule-based, zero-config, no
network dependency. To use a real hosted vision-language model
(Qwen3-VL 8B, via [OpenRouter](https://openrouter.ai)):

1. Get an OpenRouter API key.
2. **Recommended:** `cp backend/.env.example backend/.env`, then edit
   `backend/.env` and fill in `OPENROUTER_API_KEY` / uncomment
   `VLM_PROVIDER=qwen`. `.env` is gitignored and loaded automatically on
   every backend start — no need to re-type it in each new terminal.

   Alternative (session-only, forgotten the moment you close that terminal
   or the process gets restarted from a different shell):
   ```bash
   export OPENROUTER_API_KEY=sk-or-...
   export VLM_PROVIDER=qwen
   ```

3. Start the backend as usual (`uvicorn app.main:app --port 8001`). Check
   `curl http://127.0.0.1:8001/health` — it reports `"provider": "qwen2-vl"`.
4. Run the demo exactly as before. `POST /api/agent/plan` responses will now
   show `"provider": "qwen2-vl"`, and the backend sends the *sanitized*
   screenshot + tokenized elements to OpenRouter (see `docs/security.md` for
   what does and doesn't leave the device once a real third-party API is in
   the loop). Every action the model proposes still passes through the exact
   same schema/business-rule validator as the mock provider's output — see
   `backend/tests/test_openrouter_provider.py`.

If `VLM_PROVIDER=qwen` is set without `OPENROUTER_API_KEY`, the backend
raises a clear error rather than silently falling back to the mock.

## Running tests

```bash
cd backend && pytest
cd ../extension && npm test
```

## Running the benchmark

```bash
# Backend latency (requires the backend to be running)
python scripts/benchmark_backend.py --url http://127.0.0.1:8001 --api-key dev-local-only-key

# Local (in-browser) pipeline latency
cd extension && npm run benchmark
```

These measure real wall-clock latency on whatever machine you run them on —
see `docs/architecture.md`'s "what's real vs. mocked" table before treating
any number as representative of a production deployment (the shipped VLM
provider is a rule-based mock, not a real model).

## Development phases (what's implemented)

1. ✅ Working Chrome extension shell
2. ✅ DOM extraction + PII detection
3. ✅ Sanitized screenshot generation
4. ✅ Backend API
5. ✅ Mock VLM / action planner
6. ✅ Local action execution (DOM + Debugger API fallback)
7. ✅ Human confirmation
8. ✅ Real on-device vision detector — face detection via `onnxruntime-web`
   (WASM), run in the background service worker
   (`extension/src/ml/onnxFaceDetector.ts`). WebGPU was tried and found
   unusable from an MV3 service worker — see `docs/architecture.md`.
9. ✅ Real hosted VLM — Qwen3-VL via OpenRouter, opt-in
   (`backend/app/inference/qwen_provider.py`; see "Using a real VLM" below).
   `LLaVAProvider` remains a stub.
10. ⚙️ Further performance/security hardening — see `docs/security.md` for
    what's already in place and what's noted as follow-up work

## License

MVP/prototype built for SIH 2026. No license file included; treat as
all-rights-reserved unless the team adds one.
