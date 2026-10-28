/**
 * Shared types, mirroring backend/app/models/schemas.py. Keeping both sides
 * in lockstep is what lets the backend enforce a strict schema instead of
 * trusting free-form JSON from either direction.
 */

/**
 * The runtime list is the source of truth and SemanticType is derived from
 * it, rather than the reverse. A bare union exists only at compile time, so
 * nothing could ask "what types does this build know about?" — which is
 * exactly the question the backend-skew check in apiClient.ts needs to
 * answer, and the reason a stale backend showed up as an unreadable wall of
 * enum errors instead of "your server is out of date".
 */
export const ALL_SEMANTIC_TYPES = [
  "email",
  "phone",
  "password",
  "name",
  "first_name",
  "last_name",
  "address",
  "date_of_birth",
  "card_number",
  "cvv",
  "aadhaar",
  "pan",
  "api_key",
  "otp",
  "face",
  "payment",
  "account_delete",
  "call_end",
  "search",
  "generic_text",
  "button",
  "submit",
  "link",
  "external_link",
  "checkbox",
  "select",
  "unknown",
] as const;

export type SemanticType = (typeof ALL_SEMANTIC_TYPES)[number];

export const SENSITIVE_SEMANTIC_TYPES: ReadonlySet<SemanticType> = new Set([
  "email",
  "phone",
  "password",
  "name",
  "first_name",
  "last_name",
  "address",
  "date_of_birth",
  "card_number",
  "cvv",
  "aadhaar",
  "pan",
  "api_key",
  "otp",
  "face",
]);

export type ElementState = "empty" | "filled" | "disabled";

export interface BBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A fully-sanitized UI element description — safe to leave the device. */
export interface SanitizedElement {
  id: string;
  type: string;
  semantic_type: SemanticType;
  bbox: BBox;
  state: ElementState;
  editable: boolean;
  label_token: string | null;
  /** Visible text for BUTTON elements only (e.g. "Play", "Search", "Home")
   * — UI chrome copy, not user data, so it's safe to send as-is (same
   * category domExtractor.ts already treats as non-sensitive for a
   * button's rawValue). Always null for input/select/textarea, where any
   * text could be user-entered or PII-derived. Still passed through the
   * same PII scan as everything else before being set (see redactor.ts) —
   * defense in depth, not a trust boundary on its own. Without this the
   * backend has no way to tell which of many buttons is "the play button",
   * which is exactly why earlier plans hallucinated a target by visible
   * label instead of by id. */
  label_hint: string | null;
}

/** DOM element info BEFORE sanitization — never leaves the content script. */
export interface RawFieldInfo {
  elementId: string;
  domSelector: string;
  tagName: string;
  inputType: string | null;
  rawValue: string;
  rawLabelText: string;
  bbox: BBox;
  editable: boolean;
}

export type ActionType =
  | "click"
  | "focus"
  | "type"
  | "type_sensitive"
  | "select"
  | "scroll"
  | "press_key"
  | "submit";

export interface AgentAction {
  type: ActionType;
  target: string | null;
  reason: string;
  value?: string | null;
  secret_ref?: string | null;
  requires_confirmation: boolean;
  action_token?: string | null;
}

export interface ConversationTurn {
  role: "user" | "agent";
  text: string;
}

export interface PlanRequest {
  task: string;
  screenshot: string | null;
  elements: SanitizedElement[];
  conversation_history: ConversationTurn[];
  nonce: string;
}

export interface PlanResponse {
  plan_id: string;
  message: string;
  actions: AgentAction[];
  provider: string;
  raw_pii_sent_to_server: 0;
}

export interface DetectedRegion {
  bbox: BBox;
  label: SemanticType;
  confidence: number;
  source: "vision";
}

export interface RedactionRecord {
  elementId: string;
  semanticType: SemanticType;
  token: string;
  source: "dom" | "vision" | "fusion";
}
