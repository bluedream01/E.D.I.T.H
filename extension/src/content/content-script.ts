/**
 * Injected on demand (via chrome.scripting.executeScript, triggered by a
 * user-initiated action in the popup — see background.ts) rather than
 * declared as a persistent <all_urls> content script. This keeps the
 * extension's standing permissions to activeTab/scripting only.
 *
 * Responsibilities: DOM extraction -> DOM PII detection -> local redaction/
 * tokenization -> reports sanitized elements + DOM-derived regions to the
 * background service worker, which fuses in vision-based regions and
 * redacts the screenshot before anything is sent to the backend.
 */
import { extractFields, resolveElementById } from "./domExtractor";
import { scanVisibleTextForPii } from "./textScanner";
import { sanitizeElements } from "../privacy/redactor";
import { SemanticTokenizer } from "../privacy/tokenizer";
import { auditLog } from "../privacy/audit";
import type { AgentAction } from "../shared/types";

const tokenizer = new SemanticTokenizer();

function collectAndSanitize() {
  tokenizer.reset();
  auditLog.clear();

  const extracted = extractFields();
  const { elements, redactions, regions } = sanitizeElements(
    extracted.map((e) => ({ field: e.field, elementId: e.elementId, elementType: e.elementType })),
    tokenizer
  );

  // Rendered text is scanned separately from form fields: `extractFields`
  // only sees inputs and buttons, so a name or address the page merely
  // PRINTS (a video call's participant labels, an order summary) produced no
  // element, no region, and therefore no redaction — it stayed legible in
  // the screenshot. These regions redact the screenshot only; they have no
  // element id and so add nothing to the elements payload.
  const textRegions = scanVisibleTextForPii();

  // Counts and types only — never the matched text. A page's own console is
  // a local surface, but printing the very strings this layer exists to hide
  // would be an odd way to prove it works. Enough to answer "did the scanner
  // see this page at all, and what did it think was on it?" from the page's
  // DevTools console when a name survives into the screenshot.
  console.debug(
    "[privacy-browser-agent] text scan:",
    textRegions.length,
    "region(s)",
    textRegions.reduce<Record<string, number>>((acc, r) => {
      acc[r.semanticType] = (acc[r.semanticType] ?? 0) + 1;
      return acc;
    }, {})
  );

  return {
    elements,
    redactions,
    domRegions: [...regions, ...textRegions],
    textRegionCount: textRegions.length,
    devicePixelRatio: window.devicePixelRatio || 1,
    viewport: { width: window.innerWidth, height: window.innerHeight },
  };
}

// --- local action execution -------------------------------------------------

function dispatchInputEvent(el: HTMLElement) {
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

async function executeAction(action: AgentAction, resolvedValue: string | null): Promise<{ ok: boolean; error?: string }> {
  const el = action.target ? resolveElementById(action.target) : null;
  if (action.target && !el) {
    return { ok: false, error: `target element '${action.target}' not found (page may have changed)` };
  }

  try {
    switch (action.type) {
      case "click":
      case "submit": {
        (el as HTMLElement).scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior });
        (el as HTMLElement).click();
        return { ok: true };
      }
      case "focus": {
        (el as HTMLElement).focus();
        return { ok: true };
      }
      case "type": {
        if (action.value == null) return { ok: false, error: "missing value for type action" };
        (el as HTMLInputElement).focus();
        (el as HTMLInputElement).value = action.value;
        dispatchInputEvent(el as HTMLElement);
        return { ok: true };
      }
      case "type_sensitive": {
        if (resolvedValue == null) return { ok: false, error: "no locally-stored value for this secret_ref" };
        (el as HTMLInputElement).focus();
        (el as HTMLInputElement).value = resolvedValue;
        dispatchInputEvent(el as HTMLElement);
        return { ok: true };
      }
      case "select": {
        if (action.value == null) return { ok: false, error: "missing value for select action" };
        (el as HTMLSelectElement).value = action.value;
        dispatchInputEvent(el as HTMLElement);
        return { ok: true };
      }
      case "scroll": {
        window.scrollBy({ top: 400, behavior: "smooth" });
        return { ok: true };
      }
      case "press_key": {
        if (!el) return { ok: false, error: "no target for press_key" };
        el.dispatchEvent(new KeyboardEvent("keydown", { key: action.value ?? "Enter", bubbles: true }));
        el.dispatchEvent(new KeyboardEvent("keyup", { key: action.value ?? "Enter", bubbles: true }));
        return { ok: true };
      }
      default:
        return { ok: false, error: `unsupported action type: ${action.type}` };
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// --- message handling ---------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.kind === "CS_COLLECT") {
    sendResponse(collectAndSanitize());
    return true;
  }
  if (msg?.kind === "CS_EXECUTE_ACTION") {
    executeAction(msg.action as AgentAction, msg.resolvedValue as string | null).then(sendResponse);
    return true; // async response
  }
  return false;
});
