/**
 * PII detection for PLAIN TEXT on the page — text nodes, not form fields.
 *
 * domExtractor.ts only walks `input, textarea, select, button` and friends,
 * so anything a page merely *renders* (a participant name in a video call, a
 * mailing address in an order summary, a phone number in a footer) was never
 * a candidate for redaction and stayed legible in the screenshot sent to the
 * backend. This module is the detection half of closing that gap;
 * content/textScanner.ts is the half that walks the DOM and measures where
 * each match sits on screen.
 *
 * Everything here is a pure string function so it can be tested without a
 * layout engine — jsdom does no layout, and the interesting decisions are
 * all about text, not geometry.
 */
import type { SemanticType } from "../shared/types";
import { findValuePatternMatches } from "./pii-detector";

export type TextPiiSource = "value-shape" | "name-context" | "name-shape";

export interface TextPiiMatch {
  semanticType: SemanticType;
  /** Character offsets into the text node's data, so the caller can build a
   * Range over exactly the sensitive substring rather than blacking out a
   * whole paragraph because one phone number appeared in it. */
  start: number;
  end: number;
  confidence: number;
  source: TextPiiSource;
}

/** Longer than this and a node is prose, not a label. Prose is still scanned
 * for shaped PII (emails, phone numbers) — it just isn't eligible for the
 * name heuristics, which only make sense for a short standalone string. */
const MAX_NAME_NODE_LENGTH = 48;

/** Attribute/class keywords that mark an element as holding a person's name.
 * Matched against TOKENS, not substrings: "filename" and "nameplate" both
 * contain "name" without being one. */
const NAME_CONTEXT_TOKENS = new Set([
  "name", "names", "fullname", "firstname", "lastname", "surname", "username",
  "displayname", "realname", "nickname", "author", "user", "participant",
  "attendee", "member", "sender", "recipient", "byline", "profile", "account",
  "owner", "contact", "customer", "patient", "employee",
]);

/**
 * Title-case words that are overwhelmingly UI chrome or product names rather
 * than people. The name-shape heuristic is otherwise just "two or more
 * capitalised words", which "Privacy Policy" and "Google Meet" satisfy as
 * readily as a real name does. A candidate is rejected only when EVERY word
 * is a stopword, so a real first name sitting beside one still matches.
 */
const NAME_SHAPE_STOPWORDS = new Set([
  // product / brand / platform
  "google", "meet", "chrome", "gmail", "youtube", "microsoft", "windows",
  "apple", "facebook", "instagram", "whatsapp", "twitter", "linkedin", "zoom",
  "slack", "teams", "github", "amazon", "netflix", "drive", "docs", "maps",
  // page and app chrome
  "privacy", "policy", "terms", "service", "services", "conditions", "cookie",
  "cookies", "settings", "setting", "preferences", "account", "accounts",
  "profile", "dashboard", "home", "page", "new", "tab", "window", "menu",
  "help", "support", "about", "contact", "us", "sign", "log", "in", "out",
  "up", "on", "off", "my", "your", "our", "the", "and", "or", "of", "to",
  "search", "results", "result", "view", "views", "edit", "delete", "remove",
  "add", "create", "save", "cancel", "close", "open", "next", "previous",
  "back", "forward", "continue", "submit", "send", "share", "sharing",
  "download", "upload", "start", "stop", "pause", "play", "resume", "show",
  "hide", "more", "less", "all", "none", "yes", "no", "ok", "done", "loading",
  "error", "warning", "success", "notice", "alert", "welcome", "hello",
  "shield", "active", "inactive", "enabled", "disabled", "local", "backend",
  "server", "client", "status", "connection", "connected", "sanitized",
  "redacted", "sensitive", "regions", "hidden", "raw", "screen", "presenting",
  "present", "anyway", "camera", "microphone", "mute", "unmute", "chat",
  "message", "messages", "call", "video", "audio", "people", "read", "write",
  "learn", "get", "started", "free", "pro", "premium", "plan", "plans",
  "pricing", "buy", "cart", "checkout", "order", "orders", "shipping",
  "billing", "payment", "total", "subtotal", "quantity",
]);

/** Splits an identifier into lowercase word tokens, across BOTH separator
 * characters and camelCase humps, so `data-self-name`, `self_name` and
 * `selfName` all yield "name" while `filename` correctly does not. */
export function tokenizeIdentifier(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((t) => t.toLowerCase());
}

/** True when any of the supplied strings (an element's class list, id,
 * aria-label, data-* attribute names, itemprop, ...) marks its content as a
 * person's name. */
export function hasPersonNameContext(hints: readonly string[]): boolean {
  for (const hint of hints) {
    for (const token of tokenizeIdentifier(hint)) {
      if (NAME_CONTEXT_TOKENS.has(token)) return true;
    }
  }
  return false;
}

const NAME_WORD = "[A-ZÀ-Þ][a-zà-ÿ'’.\\-]*";
const NAME_RUN_PATTERN = new RegExp(`${NAME_WORD}(?:\\s+${NAME_WORD}){1,3}`, "gu");

/** Is this exact run of capitalised words a plausible person's name, rather
 * than product or UI vocabulary? */
function isPlausibleNameRun(run: string): boolean {
  const words = run.split(/\s+/);
  // A lone capital or initial ("A.", "J") isn't enough to call a word a name
  // part; require at least one substantial word.
  if (!words.some((w) => w.replace(/[^A-Za-zÀ-ÿ]/g, "").length >= 3)) return false;

  const bare = words.map((w) => w.replace(/[^A-Za-zÀ-ÿ'’-]/g, "").toLowerCase());
  return !bare.every((w) => NAME_SHAPE_STOPWORDS.has(w));
}

/**
 * Finds name-shaped runs ANYWHERE in a string, not only strings that are
 * entirely a name.
 *
 * A page rarely renders a bare name. The markup that prompted this reads
 * "Swpnanil Das (You, presenting)" — a whole-string test sees the
 * parenthetical, fails, and leaves the name legible right next to the two
 * it caught. Scanning for runs widens the net, at the cost of false
 * positives on short title-case copy the stoplist doesn't know: the
 * over-redaction trade-off documented on looksLikePersonName.
 */
export function findNameShapeMatches(text: string): { start: number; end: number }[] {
  const found: { start: number; end: number }[] = [];
  for (const m of text.matchAll(NAME_RUN_PATTERN)) {
    if (m.index === undefined) continue;
    const run = m[0].trim();
    if (run.length < 3 || !isPlausibleNameRun(run)) continue;
    found.push({ start: m.index, end: m.index + m[0].length });
  }
  return found;
}

/**
 * "Does this short string look like a person's name?" — two to four
 * capitalised words and nothing else.
 *
 * This is a heuristic and it is WRONG sometimes, in both directions: it
 * cannot see that "Blue Origin" is a company, and it cannot see that
 * "rahul sharma" rendered lowercase is a person. It exists because a name
 * has no detectable shape the way an email or an Aadhaar number does, and
 * the alternative — shipping a named-entity model — is not something this
 * extension should load to decide where to draw a black box. Deliberately
 * biased toward over-redaction, matching MIN_REDACTION_CONFIDENCE's stated
 * trade-off: a wrongly-hidden heading costs the agent a little page
 * context, a wrongly-exposed name costs the user their privacy.
 */
export function looksLikePersonName(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 3 || trimmed.length > MAX_NAME_NODE_LENGTH) return false;
  return findNameShapeMatches(trimmed).length > 0;
}

export interface TextNodeContext {
  /** class names, id, aria-label, data-* attribute names, itemprop, ... from
   * the text node's element ancestors. */
  hints: readonly string[];
}

/**
 * All PII in one text node: shaped values first (an email is an email
 * wherever it appears), then the name heuristics over what's left.
 *
 * Name detections cover the WHOLE node rather than a substring — a name
 * match is a judgement about the node as a unit ("this element holds a
 * person's name"), unlike a regex hit, which knows precisely which
 * characters matched.
 */
export function scanTextNode(text: string, context: TextNodeContext = { hints: [] }): TextPiiMatch[] {
  const matches: TextPiiMatch[] = findValuePatternMatches(text).map((m) => ({
    semanticType: m.semanticType,
    start: m.start,
    end: m.end,
    confidence: 0.9,
    source: "value-shape" as const,
  }));

  const trimmed = text.trim();
  if (!trimmed) return matches;
  // A node already covered end to end by a shaped match needs no name pass.
  if (matches.some((m) => m.start === 0 && m.end >= text.trimEnd().length)) return matches;

  const start = text.indexOf(trimmed);
  const whole = { start, end: start + trimmed.length };

  if (trimmed.length > MAX_NAME_NODE_LENGTH) return matches;

  if (hasPersonNameContext(context.hints)) {
    // An explicit "this is a name" signal from the markup beats shape: it
    // catches names shape cannot (lowercase, single-word, non-Latin script),
    // and it describes the element as a whole.
    matches.push({ semanticType: "name", ...whole, confidence: 0.85, source: "name-context" });
    return matches;
  }

  for (const run of findNameShapeMatches(text)) {
    // Skip a run already covered by a shaped match — the local part of an
    // email address can itself look like a capitalised name.
    if (matches.some((m) => run.start < m.end && run.end > m.start)) continue;
    matches.push({ semanticType: "name", start: run.start, end: run.end, confidence: 0.6, source: "name-shape" });
  }

  return matches;
}
