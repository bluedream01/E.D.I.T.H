import { describe, expect, it } from "vitest";
import { fuseRegions, sanitizeElements, type FusedRegion } from "../src/privacy/redactor";
import { SemanticTokenizer } from "../src/privacy/tokenizer";
import type { DetectedRegion, RawFieldInfo } from "../src/shared/types";

const RAW_NAME = "Rahul Sharma";
const RAW_EMAIL = "rahul@example.com";
const RAW_PHONE = "9876543210";
const RAW_PASSWORD = "hunter2super";

function makeInputs() {
  const mk = (
    elementId: string,
    inputType: string | null,
    rawValue: string,
    rawLabelText: string,
    autocomplete: string | null = null
  ) => ({
    field: {
      elementId,
      domSelector: `#${elementId}`,
      tagName: "input",
      inputType,
      rawValue,
      rawLabelText,
      bbox: { x: 0, y: 0, width: 200, height: 24 },
      editable: true,
      __autocomplete: autocomplete,
    } as RawFieldInfo & { __autocomplete: string | null },
    elementId,
    elementType: "input",
  });

  return [
    mk("name_1", "text", RAW_NAME, "Full Name"),
    mk("email_1", "email", RAW_EMAIL, "Email"),
    mk("phone_1", "tel", RAW_PHONE, "Phone"),
    mk("password_1", "password", RAW_PASSWORD, "Password"),
    mk("search_1", "search", "sofa", "Search products"),
  ];
}

function makeButtonInput(elementId: string, inputType: string | null, text: string) {
  return {
    field: {
      elementId,
      domSelector: `#${elementId}`,
      tagName: "button",
      inputType,
      rawValue: text,
      rawLabelText: "",
      bbox: { x: 0, y: 200, width: 100, height: 32 },
      editable: true,
      __autocomplete: null,
    } as RawFieldInfo & { __autocomplete: string | null },
    elementId,
    elementType: "button",
  };
}

describe("sanitizeElements — the core privacy boundary", () => {
  it("produces semantic tokens instead of raw values for sensitive fields", () => {
    const { elements, redactions } = sanitizeElements(makeInputs(), new SemanticTokenizer());

    const byId = Object.fromEntries(elements.map((e) => [e.id, e]));
    expect(byId["name_1"].label_token).toBe("[PERSON_FIELD_1]");
    expect(byId["email_1"].label_token).toBe("[EMAIL_FIELD_1]");
    expect(byId["phone_1"].label_token).toBe("[PHONE_FIELD_1]");
    expect(byId["password_1"].label_token).toBe("[PASSWORD_FIELD_1]");
    expect(byId["search_1"].label_token).toBeNull();

    expect(redactions).toHaveLength(4);
  });

  it("never includes the raw value anywhere in the serialized output payload", () => {
    const { elements, redactions } = sanitizeElements(makeInputs(), new SemanticTokenizer());
    const serialized = JSON.stringify({ elements, redactions });

    for (const raw of [RAW_NAME, RAW_EMAIL, RAW_PHONE, RAW_PASSWORD]) {
      expect(serialized).not.toContain(raw);
    }
  });

  it("marks fields as filled/empty correctly without exposing the value", () => {
    const { elements } = sanitizeElements(makeInputs(), new SemanticTokenizer());
    const email = elements.find((e) => e.id === "email_1")!;
    expect(email.state).toBe("filled");
    expect((email as any).value).toBeUndefined();
    expect((email as any).rawValue).toBeUndefined();
  });
});

describe("sanitizeElements — button classification", () => {
  it("classifies a type=submit button as semantic_type submit", () => {
    const inputs = [...makeInputs(), makeButtonInput("submit_1", "submit", "Register")];
    const { elements } = sanitizeElements(inputs, new SemanticTokenizer());
    const btn = elements.find((e) => e.id === "submit_1")!;
    expect(btn.semantic_type).toBe("submit");
    expect(btn.type).toBe("button");
  });

  it("classifies a plain button with submit-like text as submit", () => {
    const inputs = [makeButtonInput("btn_1", "button", "Create Account")];
    const { elements } = sanitizeElements(inputs, new SemanticTokenizer());
    expect(elements[0].semantic_type).toBe("submit");
  });

  it("classifies a non-submit button as plain button", () => {
    const inputs = [makeButtonInput("btn_2", "button", "Cancel")];
    const { elements } = sanitizeElements(inputs, new SemanticTokenizer());
    expect(elements[0].semantic_type).toBe("button");
  });
});

describe("sanitizeElements — button label_hint (grounding)", () => {
  it("carries a button's visible text as label_hint", () => {
    const inputs = [makeButtonInput("play_btn", null, "Play")];
    const { elements } = sanitizeElements(inputs, new SemanticTokenizer());
    expect(elements[0].label_hint).toBe("Play");
  });

  it("falls back to the accessible label for icon-only buttons with no visible text", () => {
    const inputs = [
      {
        field: {
          elementId: "pause_btn",
          domSelector: "#pause_btn",
          tagName: "button",
          inputType: null,
          rawValue: "", // icon-only, no text content
          rawLabelText: "Pause (k)", // from aria-label
          bbox: { x: 0, y: 0, width: 40, height: 40 },
          editable: true,
          __autocomplete: null,
        } as RawFieldInfo & { __autocomplete: string | null },
        elementId: "pause_btn",
        elementType: "button",
      },
    ];
    const { elements } = sanitizeElements(inputs, new SemanticTokenizer());
    expect(elements[0].label_hint).toBe("Pause (k)");
  });

  it("never sets label_hint for non-button (input/select/textarea) elements", () => {
    const { elements } = sanitizeElements(makeInputs(), new SemanticTokenizer());
    for (const el of elements) {
      if (el.type !== "button") expect(el.label_hint).toBeNull();
    }
  });

  it("suppresses label_hint if the button's text happens to look like PII", () => {
    const inputs = [makeButtonInput("weird_btn", null, "rahul@example.com")];
    const { elements } = sanitizeElements(inputs, new SemanticTokenizer());
    expect(elements[0].label_hint).toBeNull();
  });

  it("truncates an unusually long label_hint", () => {
    const longText = "A".repeat(200);
    const inputs = [makeButtonInput("long_btn", null, longText)];
    const { elements } = sanitizeElements(inputs, new SemanticTokenizer());
    expect(elements[0].label_hint?.length).toBeLessThanOrEqual(60);
  });
});

describe("fuseRegions", () => {
  it("merges an overlapping vision region into the existing DOM region instead of duplicating", () => {
    const domRegions: FusedRegion[] = [
      { elementId: "email_1", bbox: { x: 10, y: 10, width: 100, height: 20 }, semanticType: "email", confidence: 0.9, source: "dom" },
    ];
    const visionRegions: DetectedRegion[] = [
      { bbox: { x: 12, y: 11, width: 95, height: 18 }, label: "email", confidence: 0.8, source: "vision" },
    ];

    const fused = fuseRegions(domRegions, visionRegions);
    expect(fused).toHaveLength(1);
    expect(fused[0].source).toBe("fusion");
  });

  it("adds a non-overlapping vision region as a new entry", () => {
    const domRegions: FusedRegion[] = [];
    const visionRegions: DetectedRegion[] = [
      { bbox: { x: 300, y: 300, width: 80, height: 40 }, label: "card_number", confidence: 0.7, source: "vision" },
    ];
    const fused = fuseRegions(domRegions, visionRegions);
    expect(fused).toHaveLength(1);
    expect(fused[0].source).toBe("vision");
  });

  it("fuses a 'face' region exactly like any other vision label — no special-casing needed", () => {
    // A detected face has no corresponding DOM element (photos aren't form
    // fields), so it always arrives as a fresh, non-overlapping vision region.
    const domRegions: FusedRegion[] = [];
    const visionRegions: DetectedRegion[] = [
      { bbox: { x: 40, y: 20, width: 120, height: 120 }, label: "face", confidence: 0.92, source: "vision" },
    ];
    const fused = fuseRegions(domRegions, visionRegions);
    expect(fused).toHaveLength(1);
    expect(fused[0]).toMatchObject({ semanticType: "face", source: "vision", elementId: null });

    // redactCanvasRegions draws a "[FACE]" label for this region — verified
    // by construction: it uppercases whatever semanticType it's given, with
    // no per-label branching (see privacy/redactor.ts: redactCanvasRegions).
  });
});
