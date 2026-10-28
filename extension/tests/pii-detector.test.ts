import { describe, expect, it } from "vitest";
import { detectButtonSemantic, detectFromAutocomplete, detectFromDom, detectLinkSemantic, scanTextForPii } from "../src/privacy/pii-detector";
import type { RawFieldInfo } from "../src/shared/types";

function field(overrides: Partial<RawFieldInfo & { __autocomplete: string | null }> = {}) {
  return {
    elementId: "el-1",
    domSelector: "#el-1",
    tagName: "input",
    inputType: "text",
    rawValue: "",
    rawLabelText: "",
    bbox: { x: 0, y: 0, width: 100, height: 20 },
    editable: true,
    __autocomplete: null,
    ...overrides,
  };
}

describe("detectFromDom", () => {
  it("detects password fields from input type alone", () => {
    const result = detectFromDom(field({ inputType: "password" }));
    expect(result.semanticType).toBe("password");
    expect(result.confidence).toBeGreaterThan(0.9);
  });

  it("detects email from value shape even with generic metadata", () => {
    const result = detectFromDom(field({ rawValue: "rahul@example.com", rawLabelText: "field3" }));
    expect(result.semanticType).toBe("email");
  });

  it("detects phone from value shape", () => {
    const result = detectFromDom(field({ rawValue: "9876543210" }));
    expect(result.semanticType).toBe("phone");
  });

  it("detects name from label metadata", () => {
    const result = detectFromDom(field({ rawLabelText: "Full Name", domSelector: "#fullname" }));
    expect(result.semanticType).toBe("name");
  });

  it("detects a first-name field and does not fall back to the generic name type", () => {
    const result = detectFromDom(field({ rawLabelText: "First Name", domSelector: "#firstname" }));
    expect(result.semanticType).toBe("first_name");
  });

  it("detects a last-name field", () => {
    const result = detectFromDom(field({ rawLabelText: "Last Name", domSelector: "#lastname" }));
    expect(result.semanticType).toBe("last_name");
  });

  it("detects abbreviated fname/lname attributes as whole tokens", () => {
    expect(detectFromDom(field({ rawLabelText: "", domSelector: "#fname" })).semanticType).toBe("first_name");
    expect(detectFromDom(field({ rawLabelText: "", domSelector: "#lname" })).semanticType).toBe("last_name");
  });

  it("does not read 'lname' out of the middle of 'fullname'", () => {
    // "ful|lname" — a plain substring match would classify a full-name
    // field as a surname, which is why short abbreviations are matched
    // against whole haystack tokens instead.
    expect(detectFromDom(field({ domSelector: "#fullname" })).semanticType).toBe("name");
  });

  it("maps given-name/family-name autocomplete to first/last name", () => {
    expect(detectFromAutocomplete("given-name")?.semanticType).toBe("first_name");
    expect(detectFromAutocomplete("family-name")?.semanticType).toBe("last_name");
    expect(detectFromAutocomplete("name")?.semanticType).toBe("name");
  });

  it("detects address from label/name metadata keywords", () => {
    const result = detectFromDom(field({ rawLabelText: "Shipping Address" }));
    expect(result.semanticType).toBe("address");
  });

  it("returns unknown for a plain unlabeled text field", () => {
    const result = detectFromDom(field({ domSelector: "#field42", rawLabelText: "" }));
    expect(result.semanticType).toBe("unknown");
    expect(result.confidence).toBe(0);
  });

  // Regression tests from a manual audit against a real, live registration
  // form (demoqa.com/automation-practice-form) — both bugs below were
  // observed there, not invented synthetically.

  it("does not misclassify an email-shaped placeholder as a name field (real bug: 'name@example.com')", () => {
    // The literal substring "name" inside the placeholder used to win via
    // the generic keyword rule before the placeholder's email SHAPE was
    // ever considered.
    const result = detectFromDom(field({ rawLabelText: "name@example.com" }));
    expect(result.semanticType).toBe("email");
  });

  it("a value-shaped placeholder does not override an actually-filled value", () => {
    const result = detectFromDom(field({ rawLabelText: "name@example.com", rawValue: "9876543210" }));
    expect(result.semanticType).toBe("phone");
  });

  it("detects a date-picker's month-name date format (real bug: '02 Sep 2026' from a live react-datepicker widget)", () => {
    const result = detectFromDom(field({ rawValue: "02 Sep 2026" }));
    expect(result.semanticType).toBe("date_of_birth");
  });

  it("detects a 'Month Day, Year' date format", () => {
    const result = detectFromDom(field({ rawValue: "September 2, 2026" }));
    expect(result.semanticType).toBe("date_of_birth");
  });

  it("detects aadhaar-like 12-digit grouped numbers", () => {
    const result = detectFromDom(field({ rawValue: "1234 5678 9012" }));
    expect(result.semanticType).toBe("aadhaar");
  });

  it("detects pan-like identifiers", () => {
    const result = detectFromDom(field({ rawValue: "ABCDE1234F" }));
    expect(result.semanticType).toBe("pan");
  });

  it("detects card-like numbers", () => {
    const result = detectFromDom(field({ rawValue: "4111111111111111" }));
    expect(result.semanticType).toBe("card_number");
  });

  it("detects api keys/tokens by value shape", () => {
    const result = detectFromDom(field({ rawValue: "sk-abcdefghijklmnopqrstuvwx" }));
    expect(result.semanticType).toBe("api_key");
  });
});

describe("detectFromAutocomplete", () => {
  it("maps standard autocomplete tokens to semantic types", () => {
    expect(detectFromAutocomplete("email")?.semanticType).toBe("email");
    expect(detectFromAutocomplete("current-password")?.semanticType).toBe("password");
    expect(detectFromAutocomplete("cc-number")?.semanticType).toBe("card_number");
    expect(detectFromAutocomplete("bday")?.semanticType).toBe("date_of_birth");
  });

  it("returns null for unmapped/absent autocomplete", () => {
    expect(detectFromAutocomplete(null)).toBeNull();
    expect(detectFromAutocomplete("off")).toBeNull();
  });
});

describe("scanTextForPii", () => {
  it("finds PII-shaped substrings inside free text", () => {
    const hits = scanTextForPii("Contact us at support@example.com or call 9876543210");
    const types = hits.map((h) => h.semanticType);
    expect(types).toContain("email");
  });
});

describe("detectButtonSemantic — hang-up controls", () => {
  it("recognises a Material-ligature hang-up button", () => {
    // Meet's control is icon-only; its visible "text" is the ligature.
    expect(detectButtonSemantic(null, "call_end")).toBe("call_end");
  });

  it("recognises one by its accessible name when it has no text at all", () => {
    expect(detectButtonSemantic(null, "", "Leave call")).toBe("call_end");
  });

  it("recognises the common phrasings", () => {
    expect(detectButtonSemantic(null, "End call")).toBe("call_end");
    expect(detectButtonSemantic(null, "Hang up")).toBe("call_end");
    expect(detectButtonSemantic(null, "Leave meeting")).toBe("call_end");
  });

  it("outranks the submit classification, which carries a different risk", () => {
    expect(detectButtonSemantic("submit", "End call")).toBe("call_end");
  });

  it("leaves unrelated controls alone", () => {
    expect(detectButtonSemantic(null, "Stop presenting")).toBe("button");
    expect(detectButtonSemantic(null, "mic")).toBe("button");
    expect(detectButtonSemantic("submit", "Register")).toBe("submit");
  });
});

describe("detectLinkSemantic", () => {
  it("separates links by destination, not by their text", () => {
    expect(detectLinkSemantic(true)).toBe("link");
    expect(detectLinkSemantic(false)).toBe("external_link");
  });
});
