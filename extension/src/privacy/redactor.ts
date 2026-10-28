/**
 * Local redaction: fuses DOM-detected and vision-detected sensitive regions,
 * then produces (a) a sanitized element list with semantic tokens instead of
 * raw values, and (b) a redacted screenshot with visual placeholder tokens
 * drawn over sensitive regions. Nothing in this module's OUTPUT can contain
 * a raw value — the types (SanitizedElement, RedactionRecord) simply have no
 * field for it.
 */
import type { BBox, DetectedRegion, RawFieldInfo, RedactionRecord, SanitizedElement, SemanticType } from "../shared/types";
import { detectButtonSemantic, detectFromAutocomplete, detectFromDom, detectLinkSemantic, scanTextForPii, type DetectionResult } from "./pii-detector";
import { isSensitiveSemanticType, MIN_REDACTION_CONFIDENCE, DEFAULT_REDACTION_STYLE } from "./privacy-policy";
import { looksLikePersonName } from "./textPii";
import { SemanticTokenizer } from "./tokenizer";
import { auditLog } from "./audit";

export interface FusedRegion {
  elementId: string | null;
  bbox: BBox;
  semanticType: SemanticType;
  confidence: number;
  source: "dom" | "vision" | "fusion";
}

function bboxOverlap(a: BBox, b: BBox): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  const w = Math.max(0, x2 - x1);
  const h = Math.max(0, y2 - y1);
  const intersection = w * h;
  const smaller = Math.min(a.width * a.height, b.width * b.height) || 1;
  return intersection / smaller;
}

/** PII region fusion: DOM detections are authoritative for form fields
 * (precise element boundaries); vision detections fill gaps DOM can't see
 * (e.g. a passport photo, or PII baked into a canvas/image). Overlapping
 * vision hits are merged into the DOM region rather than duplicated. */
export function fuseRegions(domRegions: FusedRegion[], visionRegions: DetectedRegion[]): FusedRegion[] {
  const fused: FusedRegion[] = [...domRegions];

  for (const vr of visionRegions) {
    const overlapping = fused.find((f) => bboxOverlap(f.bbox, vr.bbox) > 0.3);
    if (overlapping) {
      overlapping.confidence = Math.max(overlapping.confidence, vr.confidence);
      overlapping.source = "fusion";
    } else {
      fused.push({ elementId: null, bbox: vr.bbox, semanticType: vr.label, confidence: vr.confidence, source: "vision" });
    }
  }

  return fused;
}

export interface SanitizeInput {
  field: RawFieldInfo;
  elementId: string;
  elementType: string;
}

export interface SanitizeOutput {
  elements: SanitizedElement[];
  redactions: RedactionRecord[];
  regions: FusedRegion[]; // for screenshot redaction
}

/** Runs DOM detection over every field, tokenizes the sensitive ones, and
 * returns a fully sanitized element list plus the region list needed to
 * redact the screenshot. Raw values from `input.field.rawValue` are read
 * ONLY to classify state (empty/filled) and are never copied into the output. */
export function sanitizeElements(inputs: SanitizeInput[], tokenizer: SemanticTokenizer): SanitizeOutput {
  const elements: SanitizedElement[] = [];
  const redactions: RedactionRecord[] = [];
  const regions: FusedRegion[] = [];

  for (const { field, elementId, elementType } of inputs) {
    if (elementType === "button" || elementType === "link") {
      // Links take the same path as buttons: both are clickable, neither
      // holds a user's data, and both surface their visible text through
      // computeButtonLabelHint — which is where the PII scrub lives, so a
      // link titled with someone's name is withheld exactly as a button
      // would be.
      const semanticType =
        elementType === "link"
          ? detectLinkSemantic(extractSameOrigin(field))
          : detectButtonSemantic(field.inputType, field.rawValue, field.rawLabelText);
      auditLog.record({
        elementId,
        semanticType,
        token: null,
        confidence: 1,
        matchedBy: ["metadata"],
        action: "detected",
      });
      elements.push({
        id: elementId,
        type: elementType,
        semantic_type: semanticType,
        bbox: field.bbox,
        state: field.editable ? "empty" : "disabled",
        editable: field.editable,
        label_token: null,
        label_hint: computeButtonLabelHint(field),
      });
      continue;
    }

    const autocompleteDetection = detectFromAutocomplete(extractAutocomplete(field));
    const domDetection: DetectionResult = autocompleteDetection ?? detectFromDom(field);

    const sensitive = domDetection.confidence >= MIN_REDACTION_CONFIDENCE && isSensitiveSemanticType(domDetection.semanticType);

    auditLog.record({
      elementId,
      semanticType: domDetection.semanticType,
      token: null,
      confidence: domDetection.confidence,
      matchedBy: domDetection.matchedBy,
      action: "detected",
    });

    let token: string | null = null;
    if (sensitive) {
      token = tokenizer.nextToken(domDetection.semanticType);
      if (token) {
        redactions.push({ elementId, semanticType: domDetection.semanticType, token, source: "dom" });
        regions.push({ elementId, bbox: field.bbox, semanticType: domDetection.semanticType, confidence: domDetection.confidence, source: "dom" });
        auditLog.record({
          elementId,
          semanticType: domDetection.semanticType,
          token,
          confidence: domDetection.confidence,
          matchedBy: domDetection.matchedBy,
          action: "tokenized",
        });
      }
    }

    elements.push({
      id: elementId,
      type: elementType,
      semantic_type: domDetection.semanticType,
      bbox: field.bbox,
      state: field.rawValue.length > 0 ? "filled" : "empty",
      editable: field.editable,
      label_token: token,
      // Never populated for input/select/textarea — any text here could be
      // user-entered or a PII-derived placeholder, unlike a button's fixed
      // UI copy. Their semantic_type + label_token already carry everything
      // the backend needs to reason about a form field.
      label_hint: null,
    });
  }

  return { elements, redactions, regions };
}

function extractSameOrigin(_field: RawFieldInfo): boolean {
  // Same side channel as __autocomplete: kept off RawFieldInfo's core shape
  // so that type stays a description of the field itself. See domExtractor.ts.
  return (_field as any).__sameOrigin ?? true;
}

function extractAutocomplete(_field: RawFieldInfo): string | null {
  // Populated by the DOM extractor via a side channel (kept out of
  // RawFieldInfo's core shape to keep that type minimal); see domExtractor.ts.
  return (_field as any).__autocomplete ?? null;
}

const MAX_LABEL_HINT_LENGTH = 60;

/** Visible-text hint for a button, e.g. "Play", "Search", "Home". Prefers
 * the button's own text content, falling back to its accessible label
 * (aria-label) for icon-only buttons — many real controls (YouTube's
 * play/pause, for instance) have no visible text at all, only an
 * aria-label, and without this the backend has no way to distinguish one
 * icon button from another. Still scanned for PII shape as a defensive
 * backstop even though button copy is normally just UI chrome, not user
 * data — never trust a single layer. Name-shaped copy is withheld too: a
 * button labelled with a person's name (a contact row, a "message <name>"
 * control) gets its pixels redacted by the text scanner, and sending the
 * same string here as a plain label_hint would hand the backend exactly
 * what the black box was drawn to withhold. */
function computeButtonLabelHint(field: RawFieldInfo): string | null {
  const raw = (field.rawValue || field.rawLabelText || "").trim();
  if (!raw) return null;
  if (scanTextForPii(raw).length > 0) return null;
  if (looksLikePersonName(raw)) return null;
  return raw.length > MAX_LABEL_HINT_LENGTH ? raw.slice(0, MAX_LABEL_HINT_LENGTH) : raw;
}

/** Draws opaque placeholder boxes + semantic labels over sensitive regions
 * on a canvas 2D context, in place. Works with both HTMLCanvasElement and
 * OffscreenCanvas contexts. */
export function redactCanvasRegions(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  regions: FusedRegion[]
): void {
  const style = DEFAULT_REDACTION_STYLE;
  for (const region of regions) {
    ctx.fillStyle = style.fillColor;
    ctx.fillRect(region.bbox.x, region.bbox.y, region.bbox.width, region.bbox.height);
    ctx.fillStyle = style.labelColor;
    ctx.font = style.font;
    const label = `[${region.semanticType.toUpperCase()}]`;
    const textX = region.bbox.x + 4;
    const textY = region.bbox.y + Math.min(region.bbox.height / 2 + 4, region.bbox.height - 2);
    ctx.fillText(label, textX, textY, Math.max(region.bbox.width - 8, 0));
  }
}
