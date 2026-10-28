/**
 * DOM extraction. Walks the page for interactive elements, computes their
 * bounding boxes and metadata, and assigns each a stable local id. Values
 * are read here (RawFieldInfo.rawValue) but this module's output never
 * leaves the content script directly — it always passes through
 * privacy/redactor.ts first.
 */
import type { BBox, RawFieldInfo } from "../shared/types";

const ID_ATTR = "data-pba-id";

export interface ExtractedField {
  elementId: string;
  element: HTMLElement;
  elementType: string;
  field: RawFieldInfo & { __autocomplete: string | null; __sameOrigin: boolean };
}

/**
 * Content scripts are re-injected fresh (via chrome.scripting.executeScript)
 * on every chat turn — a plain module-level counter resets to 0 each time,
 * which on a dynamic page (new elements appeared since the last turn) hands
 * out ids that collide with ones already tagged in the DOM from the
 * previous injection. Two elements sharing an id means
 * `document.querySelector('[data-pba-id="..."]')` silently resolves to only
 * the first one — a real risk of an action targeting the wrong element.
 * Scanning the DOM for the current max on every extraction call makes id
 * generation correct regardless of injection lifecycle, with no reliance on
 * any state surviving between injections.
 */
function nextCounterStart(): number {
  // Always scans the whole document, not just the extraction root — a
  // previously-tagged element could exist anywhere, and the point is to
  // never reuse a number that's live anywhere on the page.
  let max = 0;
  document.querySelectorAll(`[${ID_ATTR}]`).forEach((el) => {
    const match = el.getAttribute(ID_ATTR)?.match(/^pba-(\d+)$/);
    if (match) max = Math.max(max, Number(match[1]));
  });
  return max;
}

function assignId(el: HTMLElement, counter: { n: number }): string {
  const existing = el.getAttribute(ID_ATTR);
  if (existing) return existing;
  const id = `pba-${++counter.n}`;
  el.setAttribute(ID_ATTR, id);
  return id;
}

function rectToBBox(el: HTMLElement): BBox {
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}

function findLabelText(el: HTMLElement): string {
  const id = el.id;
  if (id) {
    const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
    if (label?.textContent) return label.textContent.trim();
  }
  const closestLabel = el.closest("label");
  if (closestLabel?.textContent) return closestLabel.textContent.trim();
  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel) return ariaLabel;
  const placeholder = el.getAttribute("placeholder");
  if (placeholder) return placeholder;
  const name = el.getAttribute("name");
  if (name) return name;
  return "";
}

function isVisible(el: HTMLElement): boolean {
  const style = window.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/**
 * Links are capped separately from everything else. A content site's page is
 * mostly links — a YouTube results page carries several hundred — and the
 * backend rejects a payload over 600 elements outright, so an uncapped sweep
 * would push the page's actual controls out of the request entirely. Results
 * are in document order, which on a search page puts the top results first.
 */
const MAX_LINKS = 120;

/** Same-origin decides whether following a link keeps the user on the site
 * they're on. Unresolvable or non-navigating hrefs (`#`, `javascript:`) go
 * nowhere, so they count as staying put. */
function isSameOriginLink(el: HTMLAnchorElement): boolean {
  const href = el.getAttribute("href") ?? "";
  if (!href || href.startsWith("#") || href.toLowerCase().startsWith("javascript:")) return true;
  try {
    return new URL(href, window.location.href).origin === window.location.origin;
  } catch {
    return true;
  }
}

export function extractFields(root: ParentNode = document): ExtractedField[] {
  const results: ExtractedField[] = [];
  const nodes = root.querySelectorAll<HTMLElement>("input, textarea, select, button, [role='button'], a[href]");
  const counter = { n: nextCounterStart() };
  let linkCount = 0;

  nodes.forEach((el) => {
    if (!isVisible(el)) return;
    const tagName0 = el.tagName.toLowerCase();

    // A link with no text is a wrapper (a thumbnail, an icon) that some
    // labelled sibling already covers. Surfacing it would spend the link
    // budget on entries the agent can't tell apart anyway.
    if (tagName0 === "a" && el.getAttribute("role") !== "button") {
      if (!el.textContent?.trim()) return;
      if (linkCount >= MAX_LINKS) return;
      linkCount++;
    }

    const elementId = assignId(el, counter);
    const tagName = el.tagName.toLowerCase();
    // For <button>, `.type` is a DOM property that DEFAULTS TO "submit" per
    // spec even when no `type` attribute was ever written — a very common
    // real-world footgun that would otherwise flag nearly every plain
    // button on a non-form page (e.g. a nav icon button) as a form-submit
    // control. Reading the ATTRIBUTE instead (null when unset) avoids that.
    // <input> doesn't have this problem — its default `.type` is "text".
    const inputType =
      tagName === "button" ? el.getAttribute("type")?.toLowerCase() ?? null : (el as HTMLInputElement).type?.toLowerCase?.() ?? null;

    let rawValue = "";
    let editable = true;
    let elementType = tagName;

    if (tagName === "input" || tagName === "textarea") {
      rawValue = (el as HTMLInputElement | HTMLTextAreaElement).value ?? "";
      editable = !(el as HTMLInputElement).disabled && !(el as HTMLInputElement).readOnly;
      elementType = "input";
    } else if (tagName === "select") {
      rawValue = (el as HTMLSelectElement).value ?? "";
      editable = !(el as HTMLSelectElement).disabled;
      elementType = "select";
    } else if (tagName === "a" && el.getAttribute("role") !== "button") {
      // A link's visible text is page content (a video title, a headline),
      // not a user's data. It goes through the same PII scrub as button copy
      // in redactor.ts before any of it is allowed into label_hint.
      rawValue = el.textContent?.trim() ?? "";
      editable = true;
      elementType = "link";
    } else {
      // button / role=button — value is the visible label text, which is
      // UI copy, not user data, so it's fine to surface (still capped/sanitized downstream).
      rawValue = el.textContent?.trim() ?? "";
      editable = !(el as HTMLButtonElement).disabled;
      elementType = "button";
    }

    if (tagName === "input" && inputType && ["hidden", "submit", "button", "image"].includes(inputType)) {
      if (inputType === "hidden") return; // never surface hidden inputs
      elementType = "button";
    }

    const field: ExtractedField["field"] = {
      elementId,
      domSelector: `[${ID_ATTR}="${elementId}"]`,
      tagName,
      inputType,
      rawValue,
      rawLabelText: findLabelText(el),
      bbox: rectToBBox(el),
      editable,
      __autocomplete: el.getAttribute("autocomplete"),
      __sameOrigin: tagName === "a" ? isSameOriginLink(el as HTMLAnchorElement) : true,
    };

    results.push({ elementId, element: el, elementType, field });
  });

  return results;
}

export function resolveElementById(id: string): HTMLElement | null {
  return document.querySelector(`[${ID_ATTR}="${CSS.escape(id)}"]`);
}
