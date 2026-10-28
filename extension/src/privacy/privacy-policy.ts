/**
 * Central, single-source-of-truth privacy policy. Every module that needs to
 * decide "is this sensitive?" or "does this action need confirmation?"
 * should consult this file rather than re-implementing the rule.
 */
import type { ActionType, SemanticType } from "../shared/types";
import { SENSITIVE_SEMANTIC_TYPES } from "../shared/types";

export function isSensitiveSemanticType(t: SemanticType): boolean {
  return SENSITIVE_SEMANTIC_TYPES.has(t);
}

/** Minimum DOM-detector confidence before a field is treated as sensitive
 * and redacted. Kept low-ish (favoring false positives over false
 * negatives) because over-redacting costs UX; under-redacting costs privacy. */
export const MIN_REDACTION_CONFIDENCE = 0.5;

export const HIGH_RISK_SEMANTIC_TYPES: ReadonlySet<SemanticType> = new Set([
  "payment",
  "account_delete",
  "password",
  // Hanging up ends the call for everyone in it and cannot be undone by
  // clicking again — rejoining is a different act with a different result.
  // It is the clearest case there is for asking a human first.
  "call_end",
]);

export const ACTIONS_ALWAYS_REQUIRING_CONFIRMATION: ReadonlySet<ActionType> = new Set(["submit"]);

export function actionRequiresConfirmation(
  actionType: ActionType,
  targetSemanticType: SemanticType | null
): boolean {
  if (ACTIONS_ALWAYS_REQUIRING_CONFIRMATION.has(actionType)) return true;
  if (targetSemanticType && HIGH_RISK_SEMANTIC_TYPES.has(targetSemanticType)) return true;
  return false;
}

export interface RedactionStyle {
  fillColor: string;
  labelColor: string;
  font: string;
}

export const DEFAULT_REDACTION_STYLE: RedactionStyle = {
  // Near-black at the theme's green hue, matching the popup's darkest stop.
  // Any change here must stay a FULLY OPAQUE colour — the fill is what
  // actually destroys the pixels under a sensitive region before the
  // screenshot leaves the device, so transparency would be a privacy
  // regression, not a styling one.
  fillColor: "#15322a",
  labelColor: "#d9ed92",
  font: "12px sans-serif",
};

/** Whether the confirmation UI is required before executing ANY action at
 * all (not just high-risk ones) — configurable from the popup settings. */
export interface ConfirmationConfig {
  confirmAllActions: boolean;
  confirmHighRiskOnly: boolean;
}

export const DEFAULT_CONFIRMATION_CONFIG: ConfirmationConfig = {
  confirmAllActions: false,
  confirmHighRiskOnly: true,
};
