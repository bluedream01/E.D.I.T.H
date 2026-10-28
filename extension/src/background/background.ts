/**
 * MV3 service worker — orchestrates the full privacy pipeline:
 *   DOM extraction -> DOM PII detection -> local redaction/tokenization (content script)
 *   -> visual region detection (on-device ONNX face detector, on the captured screenshot)
 *   -> PII region fusion -> sanitized screenshot (OffscreenCanvas)
 *   -> POST /api/agent/plan (sanitized elements + screenshot only, plus
 *      text-only conversation history for multi-turn context)
 *   -> human confirmation for high-risk actions
 *   -> local action execution (content script, with Debugger API fallback)
 *
 * Driven by chat messages (SEND_CHAT_MESSAGE) rather than a one-shot task —
 * each user message becomes a turn; the agent always replies with a chat
 * message (never silence), then carries out whatever actions it proposed.
 */
import type { AgentAction, ConversationTurn, DetectedRegion, PlanResponse, SanitizedElement } from "../shared/types";
import { defaultAgentStatus, type AgentStatus, type ChatMessage, type ExtMessage } from "../shared/messages";
import { checkHealth, findUnsupportedSemanticTypes, requestPlan, verifyActionToken } from "./apiClient";
import { getSettings } from "./settings";
import { executeAction } from "../actions/actionExecutor";
import { fuseRegions, type FusedRegion } from "../privacy/redactor";
import { sanitizeScreenshot } from "../content/screenshotSanitizer";
import { auditLog } from "../privacy/audit";
import { actionRequiresConfirmation } from "../privacy/privacy-policy";
import { createVisionDetector } from "../ml/visionDetector";

let status: AgentStatus = defaultAgentStatus();

function broadcastStatus() {
  chrome.runtime.sendMessage({ kind: "STATUS_UPDATE", status } satisfies ExtMessage).catch(() => {
    /* no listener (popup closed) — fine */
  });
}

function setStatus(patch: Partial<AgentStatus>) {
  status = { ...status, ...patch };
  broadcastStatus();
}

function pushChatMessage(role: ChatMessage["role"], text: string, localOnly = false): void {
  const message: ChatMessage = { id: crypto.randomUUID(), role, text, timestamp: Date.now(), localOnly };
  setStatus({ chatHistory: [...status.chatHistory, message] });
}

/** Errors are shown to the user but never sent back to the backend. */
function pushErrorMessage(text: string): void {
  pushChatMessage("agent", text, true);
}

/** Prior turns for the backend's conversation_history — text only, excludes
 * the current message (already sent separately as `task`), capped to a
 * reasonable window so requests don't grow unbounded over a long session. */
function historyForRequest(): ConversationTurn[] {
  return status.chatHistory
    .slice(0, -1)
    .filter((m) => !m.localOnly)
    .slice(-20)
    .map((m) => ({ role: m.role, text: m.text }));
}

/** Pages no extension may script, no matter its permissions — Chrome blocks
 * injection into its own UI and into the Web Store. Worth naming explicitly:
 * the raw failure ("Cannot access a chrome:// URL") reads like a bug in the
 * extension rather than a browser rule, and it fires most often right after
 * someone reloads the extension and asks a question without switching back
 * to their page first. */
const UNSCRIPTABLE_URL = /^(chrome|chrome-extension|edge|about|devtools|view-source):|^https:\/\/chrome\.google\.com\/webstore|^https:\/\/chromewebstore\.google\.com/i;

async function getActiveTab(): Promise<chrome.tabs.Tab> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("no active tab");
  if (tab.url && UNSCRIPTABLE_URL.test(tab.url)) {
    throw new Error(
      "I can't read this page — Chrome blocks extensions from its own pages (chrome://, the Web Store, " +
        "devtools). Switch to an ordinary tab and ask me again."
    );
  }
  return tab;
}

async function collectFromPage(tabId: number) {
  await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  return new Promise<any>((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, { kind: "CS_COLLECT" }, (response) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(response);
    });
  });
}

async function detectVisionRegions(screenshotDataUrl: string, devicePixelRatio: number): Promise<DetectedRegion[]> {
  try {
    const blob = await (await fetch(screenshotDataUrl)).blob();
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) return [];
    ctx.drawImage(bitmap, 0, 0);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

    // Runs directly in this service worker rather than a nested Worker:
    // `new Worker()` is not available inside ServiceWorkerGlobalScope on
    // Chrome (confirmed by testing — a real platform constraint, not an
    // oversight). This still satisfies "don't block the page's main
    // thread" — the service worker is already a separate thread from any
    // page, which is the actual requirement; the extra Worker layer this
    // originally used added isolation but wasn't load-bearing for that.
    const regions = await createVisionDetector().detect(imageData);

    // `imageData` is the RAW captured bitmap — device-pixel resolution
    // (e.g. 2x on a HiDPI display) — so the detector's bboxes come back in
    // that same space. `domRegions` (from getBoundingClientRect) are in CSS
    // pixels, and sanitizeScreenshot() later scales the WHOLE fused region
    // list by devicePixelRatio once, uniformly, assuming CSS-pixel input.
    // Rescale here so vision regions land in that same CSS-pixel space —
    // otherwise they get scaled a second time and drift off their photos.
    if (devicePixelRatio === 1) return regions;
    return regions.map((r) => ({
      ...r,
      bbox: {
        x: r.bbox.x / devicePixelRatio,
        y: r.bbox.y / devicePixelRatio,
        width: r.bbox.width / devicePixelRatio,
        height: r.bbox.height / devicePixelRatio,
      },
    }));
  } catch (err) {
    console.warn("vision detection skipped:", err);
    return [];
  }
}

let confirmationResolver: ((approved: boolean) => void) | null = null;

function awaitConfirmation(actions: AgentAction[]): Promise<boolean> {
  setStatus({ awaitingConfirmation: actions });
  return new Promise((resolve) => {
    confirmationResolver = resolve;
  });
}

async function handleChatMessage(text: string) {
  pushChatMessage("user", text);
  setStatus({ lastError: null, currentAction: "Collecting page state...", awaitingConfirmation: null });

  const settings = await getSettings();
  const backendConnected = await checkHealth(settings);
  setStatus({ backendConnected });
  if (!backendConnected) {
    const errText = `I can't reach the backend at ${settings.baseUrl}. Is it running?`;
    pushErrorMessage(errText);
    setStatus({ lastError: errText, currentAction: null });
    return;
  }

  // A backend running older code rejects this build's payload with a 422
  // listing every valid enum value — which reads as "the extension sent
  // garbage" when it actually means "the server hasn't been restarted".
  // Checked before doing any work, so the answer arrives instead of the wall
  // of text.
  const unsupported = await findUnsupportedSemanticTypes(settings);
  if (unsupported.length > 0) {
    const errText =
      `The backend at ${settings.baseUrl} is running older code than this extension — it doesn't ` +
      `recognise: ${unsupported.join(", ")}. Restart it (uvicorn picks up changes only on start, ` +
      `unless it was launched with --reload), then try again.`;
    pushErrorMessage(errText);
    setStatus({ lastError: errText, currentAction: null });
    return;
  }

  const tab = await getActiveTab();
  const tabId = tab.id!;

  const collected = await collectFromPage(tabId);
  const elements: SanitizedElement[] = collected.elements;
  const domRegions: FusedRegion[] = collected.domRegions;

  setStatus({ currentAction: "Capturing + redacting screenshot locally..." });

  let sanitizedScreenshot: string | null = null;
  try {
    const rawDataUrl = await chrome.tabs.captureVisibleTab({ format: "png" });
    const visionRegions = await detectVisionRegions(rawDataUrl, collected.devicePixelRatio);
    const fused = fuseRegions(domRegions, visionRegions);
    sanitizedScreenshot = await sanitizeScreenshot(rawDataUrl, fused, collected.devicePixelRatio);
    // Counted AFTER fusing, not from `redactions` alone. `redactions` covers
    // tokenized form fields only, so the badge read "0" on a page whose
    // every sensitive region came from the vision detector or the text
    // scanner — under-reporting the one number the user is watching to
    // decide whether to trust the extension.
    setStatus({ sensitiveRegionsHidden: fused.length });
  } catch (err) {
    console.warn("screenshot capture/redaction failed, proceeding with DOM-only plan:", err);
  }

  setStatus({
    currentAction: "Thinking...",
    lastSanitizedScreenshot: sanitizedScreenshot,
    lastSanitizedElements: elements,
  });

  let plan: PlanResponse;
  try {
    plan = await requestPlan(settings, text, sanitizedScreenshot, elements, historyForRequest());
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    pushErrorMessage(`Something went wrong talking to the backend: ${msg}`);
    setStatus({ lastError: msg, currentAction: null });
    return;
  }

  pushChatMessage("agent", plan.message);

  // The backend's requires_confirmation is re-derived here rather than
  // trusted. The gate is what stands between a plan and an irreversible act
  // (hanging up a call, paying, deleting an account), and a gate that only
  // exists on the far side of the network is no gate at all: a wrong answer,
  // a stale backend, or a tampered response would sail straight through.
  // Elements are the locally-classified ones, so the semantic type consulted
  // here was decided on-device.
  const semanticTypeById = new Map(elements.map((el) => [el.id, el.semantic_type]));
  const needsConfirmation = (a: AgentAction): boolean =>
    a.requires_confirmation ||
    actionRequiresConfirmation(a.type, a.target ? semanticTypeById.get(a.target) ?? null : null);

  const autoActions = plan.actions.filter((a) => !needsConfirmation(a));
  const confirmActions = plan.actions.filter(needsConfirmation);

  for (const action of autoActions) {
    setStatus({ currentAction: describeAction(action) });
    const result = await executeAction(tabId, action);
    chrome.runtime.sendMessage({ kind: "ACTION_EXECUTED", action, ok: result.ok, error: result.error } satisfies ExtMessage).catch(() => {});
    if (!result.ok) {
      setStatus({ lastError: `Action failed: ${result.error}` });
      pushErrorMessage(`I couldn't ${action.type} on ${action.target ?? "that element"}: ${result.error}`);
    }
  }

  if (confirmActions.length > 0) {
    pushChatMessage(
      "agent",
      confirmActions.length === 1
        ? `One more thing needs your OK before I do it — see below.`
        : `A few things need your OK before I do them — see below.`
    );
    setStatus({ currentAction: "Waiting for user confirmation on high-risk action(s)..." });
    const approved = await awaitConfirmation(confirmActions);
    setStatus({ awaitingConfirmation: null });

    if (!approved) {
      pushChatMessage("agent", "Okay, I won't do that.");
      setStatus({ currentAction: "User denied high-risk action(s). Stopped." });
      return;
    }

    for (const action of confirmActions) {
      if (action.action_token) {
        const verified = await verifyActionToken(settings, action.action_token);
        if (!verified) {
          const msg = `Action token for ${action.type} on ${action.target} failed verification (expired or replayed) — skipped.`;
          setStatus({ lastError: msg });
          pushChatMessage("agent", `I skipped one action because its approval expired — try again if you still want it done.`);
          continue;
        }
      }
      setStatus({ currentAction: describeAction(action) });
      const result = await executeAction(tabId, action);
      chrome.runtime.sendMessage({ kind: "ACTION_EXECUTED", action, ok: result.ok, error: result.error } satisfies ExtMessage).catch(() => {});
      if (!result.ok) {
        setStatus({ lastError: `Action failed: ${result.error}` });
        pushErrorMessage(`I couldn't ${action.type} on ${action.target ?? "that element"}: ${result.error}`);
      }
    }

    if (confirmActions.some((a) => a.type === "submit")) {
      pushChatMessage("agent", "Done — submitted.");
    }
  }

  setStatus({ currentAction: null });
}

function describeAction(action: AgentAction): string {
  const targetPart = action.target ? ` on ${action.target}` : "";
  return `${action.type}${targetPart}${action.reason ? ` — ${action.reason}` : ""}`;
}

chrome.runtime.onMessage.addListener((msg: ExtMessage, _sender, sendResponse) => {
  if (msg.kind === "SEND_CHAT_MESSAGE") {
    handleChatMessage(msg.text).catch((err) => {
      const text = err instanceof Error ? err.message : String(err);
      pushErrorMessage(`Something went wrong: ${text}`);
      setStatus({ lastError: text, currentAction: null });
    });
    sendResponse({ ok: true });
    return true;
  }
  if (msg.kind === "GET_STATUS") {
    sendResponse(status);
    return true;
  }
  if (msg.kind === "CONFIRMATION_RESULT") {
    confirmationResolver?.(msg.approved);
    confirmationResolver = null;
    sendResponse({ ok: true });
    return true;
  }
  if (msg.kind === "RESET") {
    status = defaultAgentStatus();
    auditLog.clear();
    broadcastStatus();
    sendResponse({ ok: true });
    return true;
  }
  return false;
});

// Keep backendConnected fresh even when idle.
getSettings().then((s) => checkHealth(s).then((ok) => setStatus({ backendConnected: ok })));
