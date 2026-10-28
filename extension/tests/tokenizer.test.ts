import { describe, expect, it } from "vitest";
import { SemanticTokenizer, tokenToRefName } from "../src/privacy/tokenizer";

describe("SemanticTokenizer", () => {
  it("assigns incrementing tokens per semantic type", () => {
    const t = new SemanticTokenizer();
    expect(t.nextToken("email")).toBe("[EMAIL_FIELD_1]");
    expect(t.nextToken("email")).toBe("[EMAIL_FIELD_2]");
    expect(t.nextToken("phone")).toBe("[PHONE_FIELD_1]");
  });

  it("returns null for semantic types without a token prefix (non-sensitive)", () => {
    const t = new SemanticTokenizer();
    expect(t.nextToken("search")).toBeNull();
    expect(t.nextToken("button")).toBeNull();
    expect(t.nextToken("unknown")).toBeNull();
  });

  it("resets counters", () => {
    const t = new SemanticTokenizer();
    t.nextToken("email");
    t.reset();
    expect(t.nextToken("email")).toBe("[EMAIL_FIELD_1]");
  });
});

describe("tokenToRefName", () => {
  it("strips the surrounding brackets", () => {
    expect(tokenToRefName("[EMAIL_FIELD_1]")).toBe("EMAIL_FIELD_1");
  });
});
