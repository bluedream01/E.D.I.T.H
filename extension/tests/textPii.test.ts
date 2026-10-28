import { describe, expect, it } from "vitest";
import { findValuePatternMatches } from "../src/privacy/pii-detector";
import { hasPersonNameContext, looksLikePersonName, scanTextNode, tokenizeIdentifier } from "../src/privacy/textPii";

describe("findValuePatternMatches", () => {
  it("reports offsets so a caller can redact just the matched span", () => {
    const text = "Reach me at rahul@example.com any time";
    const [hit] = findValuePatternMatches(text);
    expect(hit.semanticType).toBe("email");
    expect(text.slice(hit.start, hit.end)).toBe("rahul@example.com");
  });

  it("reports every occurrence, not just the first", () => {
    const hits = findValuePatternMatches("a@b.com and c@d.com");
    expect(hits.map((h) => h.match)).toEqual(["a@b.com", "c@d.com"]);
  });

  it("does not report overlapping spans for one value", () => {
    // A 12-digit run matches the Aadhaar, card-number and phone patterns.
    // Three stacked boxes on the same pixels would also triple the count of
    // "sensitive regions hidden" the user is shown.
    const hits = findValuePatternMatches("1234 5678 9012");
    expect(hits).toHaveLength(1);
  });

  it("returns matches in document order", () => {
    const hits = findValuePatternMatches("call 9876543210 or mail rahul@example.com");
    expect(hits.map((h) => h.start)).toEqual([...hits.map((h) => h.start)].sort((a, b) => a - b));
  });
});

describe("tokenizeIdentifier", () => {
  it("splits separators and camelCase humps alike", () => {
    expect(tokenizeIdentifier("data-self-name")).toEqual(["data", "self", "name"]);
    expect(tokenizeIdentifier("displayName")).toEqual(["display", "name"]);
  });

  it("does not split a word that merely contains a keyword", () => {
    expect(tokenizeIdentifier("filename")).toEqual(["filename"]);
  });
});

describe("hasPersonNameContext", () => {
  it("recognises name-bearing markup hints", () => {
    expect(hasPersonNameContext(["participant-name"])).toBe(true);
    expect(hasPersonNameContext(["data-self-name"])).toBe(true);
    expect(hasPersonNameContext(["css-1x2y3z", "authorByline"])).toBe(true);
  });

  it("is not fooled by words that merely contain 'name'", () => {
    expect(hasPersonNameContext(["filename-label"])).toBe(false);
    expect(hasPersonNameContext(["nameplate"])).toBe(false);
  });
});

describe("looksLikePersonName", () => {
  it("matches ordinary two- and three-word names", () => {
    expect(looksLikePersonName("Disha Chakraborty")).toBe(true);
    expect(looksLikePersonName("Rahul Kumar Sharma")).toBe(true);
    expect(looksLikePersonName("Aishiki Podder")).toBe(true);
  });

  it("rejects sentence-case UI copy", () => {
    expect(looksLikePersonName("You are presenting")).toBe(false);
    expect(looksLikePersonName("Show my screen anyway")).toBe(false);
    expect(looksLikePersonName("Stop presenting")).toBe(false);
  });

  it("rejects title-case chrome and product names", () => {
    expect(looksLikePersonName("Privacy Policy")).toBe(false);
    expect(looksLikePersonName("Google Meet")).toBe(false);
    expect(looksLikePersonName("New Tab")).toBe(false);
    expect(looksLikePersonName("Sign In")).toBe(false);
  });

  it("still matches a real name sitting beside a stopword", () => {
    // Rejecting on ANY stopword would lose a person whose name collides
    // with product vocabulary; only an all-stopword phrase is chrome.
    expect(looksLikePersonName("Priya Google")).toBe(true);
  });

  it("rejects a single word", () => {
    expect(looksLikePersonName("Disha")).toBe(false);
  });

  it("finds a name embedded in surrounding copy", () => {
    // The whole-string version of this test missed the header label in the
    // reported screenshot, which reads "<name> (You, presenting)".
    expect(looksLikePersonName("Swpnanil Das (You, presenting)")).toBe(true);
  });

  it("ignores prose too long to be a label", () => {
    expect(looksLikePersonName("Disha Chakraborty joined the call a little while ago, twice")).toBe(false);
  });

  it("rejects bare initials with no substantial word", () => {
    expect(looksLikePersonName("A. B.")).toBe(false);
  });
});

describe("scanTextNode", () => {
  it("flags a rendered participant name — the case that leaked", () => {
    const [hit] = scanTextNode("Disha Chakraborty");
    expect(hit.semanticType).toBe("name");
    expect(hit.source).toBe("name-shape");
    expect(hit.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it("trusts markup context over shape, catching names shape cannot", () => {
    const [hit] = scanTextNode("swpnanil das", { hints: ["data-self-name"] });
    expect(hit.semanticType).toBe("name");
    expect(hit.source).toBe("name-context");
  });

  it("covers the whole node for a name but only the span for a shaped value", () => {
    const text = "Questions? Write to rahul@example.com.";
    const [hit] = scanTextNode(text);
    expect(text.slice(hit.start, hit.end)).toBe("rahul@example.com");
  });

  it("ignores offsets of surrounding whitespace when covering a node", () => {
    const [hit] = scanTextNode("\n  Disha Chakraborty\n  ");
    expect(hit.start).toBe(3);
    expect(hit.end).toBe(20);
  });

  it("leaves ordinary prose alone", () => {
    expect(scanTextNode("To avoid an infinity mirror, share just a tab instead.")).toHaveLength(0);
  });

  it("covers only the name inside a longer label, not the whole label", () => {
    const text = "Swpnanil Das (You, presenting)";
    const [hit] = scanTextNode(text);
    expect(hit.semanticType).toBe("name");
    expect(text.slice(hit.start, hit.end)).toBe("Swpnanil Das");
  });

  it("does not double-report a capitalised name inside an email address", () => {
    const hits = scanTextNode("Disha.Chakraborty@example.com");
    expect(hits).toHaveLength(1);
    expect(hits[0].semanticType).toBe("email");
  });

  it("does not add a name guess on top of a node that is entirely one shaped value", () => {
    const hits = scanTextNode("rahul@example.com");
    expect(hits).toHaveLength(1);
    expect(hits[0].semanticType).toBe("email");
  });
});
