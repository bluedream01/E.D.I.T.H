/**
 * Finds sensitive PLAIN TEXT on the page and reports where it sits on
 * screen, so the screenshot redactor can cover it.
 *
 * domExtractor.ts walks form controls; this walks text nodes. Without it,
 * anything a page merely renders — a participant's name in a video call, an
 * address in an order summary — survived into the screenshot sent to the
 * backend, because it was never a form field and so was never a candidate
 * for redaction. Faces were covered (vision detector) and field values were
 * covered (DOM detector); rendered text was the hole between them.
 *
 * Detection lives in privacy/textPii.ts. This module is only the DOM half:
 * walk, filter, measure.
 */
import type { BBox, SemanticType } from "../shared/types";
import type { FusedRegion } from "../privacy/redactor";
import { MIN_REDACTION_CONFIDENCE } from "../privacy/privacy-policy";
import { scanTextNode } from "../privacy/textPii";

/** Elements whose text is never page content. TEXTAREA/OPTION are excluded
 * because domExtractor.ts already owns form controls — scanning them here
 * would double-redact a field that redactor.ts has tokenized already. */
const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TITLE", "HEAD", "META", "LINK", "TEXTAREA", "OPTION", "INPUT", "SELECT"]);

/** How far up the tree to collect naming hints. Deep enough to find a
 * wrapper like `<div class="participant-name"><span>...</span></div>`,
 * shallow enough that a page-level `<div id="user-profile">` doesn't mark
 * every string inside it as a name. */
const HINT_ANCESTOR_DEPTH = 3;

/** Pathological pages (a long table of contacts) could produce thousands of
 * regions; each one is a fill + fillText on the screenshot canvas. Capping
 * keeps a worst-case page from stalling the capture. The cap is on REGIONS,
 * not on detection, so the most sensitive content still wins — matches are
 * collected in document order and the page's own layout puts what's on
 * screen first. */
const MAX_TEXT_REGIONS = 400;

/**
 * Invisible text isn't in the screenshot, so redacting it would just draw
 * boxes over whatever IS there.
 *
 * `checkVisibility()` is the primary test because the obvious check is
 * wrong: `display` is not inherited, so a span inside a `display:none`
 * wrapper still computes `display: inline` and a naive style check calls it
 * visible. checkVisibility() accounts for ancestors (and for
 * content-visibility) and is available in the Chrome this extension
 * targets; the style+rect fallback covers the case where it isn't, since a
 * hidden element's rect collapses to zero.
 */
function isRenderedVisible(el: Element): boolean {
  const withCheck = el as Element & { checkVisibility?: (opts?: Record<string, boolean>) => boolean };
  if (typeof withCheck.checkVisibility === "function") {
    return withCheck.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  }

  const style = window.getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/** class / id / aria-label / data-* attribute NAMES from an element and a
 * few of its ancestors. Data attribute names matter more than their values:
 * Meet-style markup says `data-self-name="..."`, where the *name of the
 * attribute* is the signal and the value is the PII itself. */
function collectHints(node: Text): string[] {
  const hints: string[] = [];
  let el: Element | null = node.parentElement;

  for (let depth = 0; el && depth < HINT_ANCESTOR_DEPTH; depth++, el = el.parentElement) {
    if (el.className && typeof el.className === "string") hints.push(el.className);
    if (el.id) hints.push(el.id);
    const aria = el.getAttribute("aria-label");
    if (aria) hints.push(aria);
    const itemprop = el.getAttribute("itemprop");
    if (itemprop) hints.push(itemprop);
    for (const attr of Array.from(el.attributes)) {
      if (attr.name.startsWith("data-")) hints.push(attr.name);
    }
  }

  return hints;
}

function rectsForRange(node: Text, start: number, end: number): BBox[] {
  const range = document.createRange();
  try {
    range.setStart(node, Math.max(0, Math.min(start, node.length)));
    range.setEnd(node, Math.max(0, Math.min(end, node.length)));
  } catch {
    // Offsets can go stale if the page mutates mid-walk; a region we can't
    // measure is simply not reported rather than reported at the wrong place.
    return [];
  }

  // A match that wraps across lines produces one rect per line — redacting
  // the union rectangle would black out unrelated content to the left and
  // right of the wrap, so each line gets its own box.
  return Array.from(range.getClientRects())
    .map((r) => ({ x: r.x, y: r.y, width: r.width, height: r.height }))
    .filter((b) => b.width > 0 && b.height > 0);
}

export interface TextRegion extends FusedRegion {
  semanticType: SemanticType;
}

/**
 * Walks visible text nodes and returns a redaction region per sensitive
 * span, in the same CSS-pixel viewport space as domExtractor.ts's boxes
 * (both come from getBoundingClientRect-family APIs), so the two sets can
 * be concatenated and handed to the screenshot sanitizer together.
 */
export function scanVisibleTextForPii(root: Node = document.body): TextRegion[] {
  const regions: TextRegion[] = [];
  if (!root) return regions;

  for (const node of collectTextNodes(root)) {
    if (regions.length >= MAX_TEXT_REGIONS) break;
    const text = node.textContent ?? "";
    const matches = scanTextNode(text, { hints: collectHints(node) });

    for (const match of matches) {
      if (match.confidence < MIN_REDACTION_CONFIDENCE) continue;
      for (const bbox of rectsForRange(node, match.start, match.end)) {
        if (regions.length >= MAX_TEXT_REGIONS) break;
        regions.push({
          elementId: null,
          bbox,
          semanticType: match.semanticType,
          confidence: match.confidence,
          source: "dom",
        });
      }
    }
  }

  return regions;
}

/**
 * Every candidate text node under `root`, INCLUDING those inside open shadow
 * roots.
 *
 * TreeWalker stops at a shadow boundary, so on any page that renders its
 * content in web components the walk returns nothing from precisely the
 * parts that matter and the scanner reports a confident, wrong zero. A
 * shadow root's contents share the host document's coordinate space, so the
 * boxes measured inside one need no adjustment.
 *
 * Closed shadow roots stay unreachable by design — `element.shadowRoot` is
 * null for them and there is no API that isn't a hack. That is a real limit
 * of this layer, recorded in docs/privacy.md.
 */
function collectTextNodes(root: Node): Text[] {
  const found: Text[] = [];
  const roots: Node[] = [root];

  while (roots.length && found.length < MAX_TEXT_REGIONS * 4) {
    const current = roots.shift()!;
    const walker = document.createTreeWalker(current, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);

    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const shadow = (node as Element).shadowRoot;
        if (shadow) roots.push(shadow);
        continue;
      }

      const text = node.textContent ?? "";
      if (!text.trim()) continue;
      const parent = (node as Text).parentElement;
      if (!parent || SKIP_TAGS.has(parent.tagName)) continue;
      if (!isRenderedVisible(parent)) continue;
      found.push(node as Text);
    }
  }

  return found;
}
