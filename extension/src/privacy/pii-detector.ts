/**
 * DOM-based PII detection.
 *
 * Regex alone is not sufficient (per the problem statement) — we combine
 * value-shape regexes with field-metadata heuristics (input type, name/id/
 * autocomplete attributes, associated <label> text) and weight them, since
 * metadata is often a stronger, more reliable signal than the current value
 * (e.g. an empty password field has no value to match against at all).
 */
import type { RawFieldInfo, SemanticType } from "../shared/types";

interface ValuePattern {
  semanticType: SemanticType;
  pattern: RegExp;
}

// Order matters: more specific patterns first so e.g. a PAN doesn't get
// mis-caught by a looser alphanumeric rule.
const VALUE_PATTERNS: ValuePattern[] = [
  { semanticType: "email", pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/ },
  { semanticType: "pan", pattern: /\b[A-Z]{5}\d{4}[A-Z]\b/ },
  { semanticType: "aadhaar", pattern: /\b\d{4}\s?\d{4}\s?\d{4}\b/ },
  { semanticType: "card_number", pattern: /\b(?:\d[ -]?){13,19}\b/ },
  { semanticType: "phone", pattern: /(?<!\w)(\+?\d[\d\- ]{8,14}\d)(?!\w)/ },
  { semanticType: "date_of_birth", pattern: /\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/ },
  // Widget-rendered date formats (e.g. a date-picker's displayed value)
  // frequently use a month NAME rather than a numeric month — a real,
  // observed case: "02 Sep 2026". Neither of these contains digits-only
  // runs, so they can't collide with the phone/card patterns above.
  { semanticType: "date_of_birth", pattern: /\b\d{1,2}\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{4}\b/i },
  { semanticType: "date_of_birth", pattern: /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2},?\s+\d{4}\b/i },
  { semanticType: "api_key", pattern: /\b(sk|pk|ghp|xox[baprs])-?[A-Za-z0-9_]{16,}\b/ },
];

interface MetaRule {
  semanticType: SemanticType;
  keywords: string[];
  /** Matched against whole tokens of the haystack rather than as a
   * substring. Needed for short abbreviations that occur INSIDE longer,
   * differently-meaning words — "fullname" contains "lname", so a plain
   * substring match would classify a full-name field as a surname. */
  tokenKeywords?: string[];
}

const METADATA_RULES: MetaRule[] = [
  { semanticType: "password", keywords: ["password", "passwd", "pwd", "pass"] },
  { semanticType: "email", keywords: ["email", "e-mail"] },
  { semanticType: "phone", keywords: ["phone", "mobile", "tel", "contact-number"] },
  // First/last must come BEFORE the generic "name" rule: the loop below
  // stops at the first rule that matches, and every one of these haystacks
  // also contains the bare substring "name".
  {
    semanticType: "first_name",
    keywords: ["firstname", "first-name", "first name", "givenname", "given-name", "given name", "forename"],
    tokenKeywords: ["fname", "fn"],
  },
  {
    semanticType: "last_name",
    keywords: ["lastname", "last-name", "last name", "surname", "familyname", "family-name", "family name"],
    tokenKeywords: ["lname", "ln"],
  },
  { semanticType: "name", keywords: ["fullname", "full-name", "full name", "name", "username"] },
  { semanticType: "address", keywords: ["address", "street", "city", "zipcode", "postal", "pincode"] },
  { semanticType: "date_of_birth", keywords: ["dob", "birthdate", "birth-date", "dateofbirth"] },
  { semanticType: "card_number", keywords: ["cardnumber", "card-number", "ccnumber", "cc-number"] },
  { semanticType: "cvv", keywords: ["cvv", "cvc", "security-code"] },
  { semanticType: "aadhaar", keywords: ["aadhaar", "aadhar", "uidai"] },
  { semanticType: "pan", keywords: ["pan", "pancard", "pan-number"] },
  { semanticType: "api_key", keywords: ["apikey", "api-key", "token", "secret"] },
  { semanticType: "otp", keywords: ["otp", "one-time-code", "verification-code"] },
  { semanticType: "payment", keywords: ["payment", "checkout", "pay-now"] },
  { semanticType: "account_delete", keywords: ["delete-account", "deleteaccount", "close-account"] },
  { semanticType: "search", keywords: ["search", "query", "q"] },
];

const AUTOCOMPLETE_MAP: Record<string, SemanticType> = {
  email: "email",
  tel: "phone",
  "tel-national": "phone",
  name: "name",
  "given-name": "first_name",
  "family-name": "last_name",
  "additional-name": "name",
  "street-address": "address",
  "address-line1": "address",
  "address-line2": "address",
  "postal-code": "address",
  bday: "date_of_birth",
  "cc-number": "card_number",
  "cc-csc": "cvv",
  "current-password": "password",
  "new-password": "password",
  "one-time-code": "otp",
};

export interface DetectionResult {
  semanticType: SemanticType;
  confidence: number; // 0..1
  matchedBy: ("value" | "label-pattern" | "metadata" | "autocomplete" | "input-type")[];
}

function normalizeHaystack(field: RawFieldInfo): string {
  return `${field.tagName} ${field.inputType ?? ""} ${field.domSelector} ${field.rawLabelText}`.toLowerCase();
}

/** Whole "words" of the haystack, split on anything that isn't a letter or
 * digit, so `#fname`, `user_fname` and "F. Name" all yield the token "fname". */
function haystackTokens(haystack: string): Set<string> {
  return new Set(haystack.split(/[^a-z0-9]+/).filter(Boolean));
}

function matchesMetaRule(rule: MetaRule, haystack: string, tokens: Set<string>): boolean {
  if (rule.keywords.some((kw) => haystack.includes(kw))) return true;
  return (rule.tokenKeywords ?? []).some((kw) => tokens.has(kw));
}

export function detectFromDom(field: RawFieldInfo): DetectionResult {
  const matchedBy: DetectionResult["matchedBy"] = [];
  let best: SemanticType = "unknown";
  let confidence = 0;

  if (field.inputType === "password") {
    best = "password";
    confidence = 0.95;
    matchedBy.push("input-type");
  }

  // A placeholder/label that itself looks like an example value (e.g. a
  // placeholder of "name@example.com") is a more specific signal than a
  // generic keyword substring match, and must be checked BEFORE the
  // metadata-keyword loop below — otherwise a placeholder like
  // "name@example.com" gets caught by the bare "name" keyword and
  // misclassified, even though it's shaped exactly like an email.
  if (confidence < 0.8 && field.rawLabelText) {
    for (const vp of VALUE_PATTERNS) {
      if (vp.pattern.test(field.rawLabelText)) {
        best = vp.semanticType;
        confidence = 0.8;
        matchedBy.push("label-pattern");
        break;
      }
    }
  }

  const haystack = normalizeHaystack(field);
  const tokens = haystackTokens(haystack);
  for (const rule of METADATA_RULES) {
    if (matchesMetaRule(rule, haystack, tokens)) {
      if (confidence < 0.75) {
        best = rule.semanticType;
        confidence = 0.75;
      }
      matchedBy.push("metadata");
      break;
    }
  }

  if (field.rawValue) {
    for (const vp of VALUE_PATTERNS) {
      if (vp.pattern.test(field.rawValue)) {
        // Value-shape match is the strongest signal — a filled field that
        // *looks* like an email is an email regardless of what its `name`
        // attribute says.
        best = vp.semanticType;
        confidence = 0.9;
        matchedBy.push("value");
        break;
      }
    }
  }

  return { semanticType: confidence > 0 ? best : "unknown", confidence, matchedBy };
}

export function detectFromAutocomplete(autocompleteAttr: string | null): DetectionResult | null {
  if (!autocompleteAttr) return null;
  const key = autocompleteAttr.trim().toLowerCase();
  const mapped = AUTOCOMPLETE_MAP[key];
  if (!mapped) return null;
  return { semanticType: mapped, confidence: 0.85, matchedBy: ["autocomplete"] };
}

/**
 * Controls that hang up a call. Matched ahead of everything else because
 * these buttons are frequently icon-only: the visible "text" is a
 * Material Symbols LIGATURE ("call_end"), and the human-readable name lives
 * in aria-label ("Leave call"), so both have to be consulted or a hang-up
 * button reads as an anonymous generic button.
 */
const CALL_END_KEYWORDS = [
  "call_end", "callend", "leave call", "leave meeting", "leave the call",
  "leave the meeting", "end call", "end meeting", "end the call",
  "end the meeting", "hang up", "hangup", "disconnect", "leave_call",
];

const SUBMIT_TEXT_KEYWORDS = [
  "submit", "register", "sign up", "signup", "continue", "confirm",
  "create account", "save", "send", "checkout", "pay now", "log in",
  "login", "sign in", "place order", "finish",
];

/** Buttons don't go through the value/metadata pipeline above (their
 * "value" is UI copy, not user data) — classify them structurally instead,
 * so a Register/Submit button reliably ends up as semantic_type "submit"
 * and can be gated behind human confirmation server- and client-side. */
export function detectButtonSemantic(
  inputType: string | null,
  buttonText: string,
  labelText: string = ""
): SemanticType {
  const text = `${buttonText} ${labelText}`.toLowerCase();

  // Checked before `inputType === "submit"`: a hang-up control inside a form
  // would otherwise classify as a plain submit, and "submit" and "end the
  // call for everyone" are not the same risk even though both are gated.
  if (CALL_END_KEYWORDS.some((kw) => text.includes(kw))) return "call_end";

  if (inputType === "submit") return "submit";
  if (SUBMIT_TEXT_KEYWORDS.some((kw) => text.includes(kw))) return "submit";
  return "button";
}

/**
 * A link is classified by where it goes, not by what it says. The
 * distinction exists so a task like "play this while staying on YouTube"
 * can be honoured mechanically rather than hoped for: off-site links get
 * their own type, and the planner can decline to follow one.
 */
export function detectLinkSemantic(sameOrigin: boolean): SemanticType {
  return sameOrigin ? "link" : "external_link";
}

/** Scans free text (e.g. a page's visible text nodes) for PII-shaped substrings,
 * used to catch sensitive data rendered as plain text rather than form fields. */
export function scanTextForPii(text: string): { semanticType: SemanticType; match: string }[] {
  const hits: { semanticType: SemanticType; match: string }[] = [];
  for (const vp of VALUE_PATTERNS) {
    const m = text.match(vp.pattern);
    if (m) hits.push({ semanticType: vp.semanticType, match: m[0] });
  }
  return hits;
}

export interface ValuePatternMatch {
  semanticType: SemanticType;
  match: string;
  start: number;
  end: number;
}

/**
 * Like scanTextForPii, but reports EVERY occurrence with its character
 * offsets, which is what lets a caller redact just the matched span of a
 * text node instead of the whole node.
 *
 * Patterns are applied in VALUE_PATTERNS order (most specific first) and a
 * span already claimed by an earlier pattern is not re-claimed: the card,
 * Aadhaar and phone patterns all match the same digit runs, and reporting
 * one string as three overlapping regions would stack three black boxes on
 * the same pixels and lie about how much PII the page holds.
 */
export function findValuePatternMatches(text: string): ValuePatternMatch[] {
  const claimed: ValuePatternMatch[] = [];

  for (const vp of VALUE_PATTERNS) {
    const global = new RegExp(vp.pattern.source, vp.pattern.flags.includes("g") ? vp.pattern.flags : vp.pattern.flags + "g");
    for (const m of text.matchAll(global)) {
      if (m.index === undefined || !m[0]) continue;
      const start = m.index;
      const end = start + m[0].length;
      if (claimed.some((c) => start < c.end && end > c.start)) continue;
      claimed.push({ semanticType: vp.semanticType, match: m[0], start, end });
    }
  }

  return claimed.sort((a, b) => a.start - b.start);
}
