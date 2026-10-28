import { describe, expect, it } from "vitest";
import { actionRequiresConfirmation, isSensitiveSemanticType } from "../src/privacy/privacy-policy";

describe("privacy-policy", () => {
  it("flags known sensitive semantic types", () => {
    expect(isSensitiveSemanticType("email")).toBe(true);
    expect(isSensitiveSemanticType("password")).toBe(true);
    expect(isSensitiveSemanticType("card_number")).toBe(true);
    expect(isSensitiveSemanticType("search")).toBe(false);
    expect(isSensitiveSemanticType("button")).toBe(false);
  });

  it("always requires confirmation for submit actions", () => {
    expect(actionRequiresConfirmation("submit", null)).toBe(true);
  });

  it("requires confirmation for high-risk target fields regardless of action type", () => {
    expect(actionRequiresConfirmation("type_sensitive", "password")).toBe(true);
    expect(actionRequiresConfirmation("click", "payment")).toBe(true);
    expect(actionRequiresConfirmation("click", "account_delete")).toBe(true);
    // Ending a call is not undone by clicking again — rejoining is a
    // different act with a different result.
    expect(actionRequiresConfirmation("click", "call_end")).toBe(true);
  });

  it("does not require confirmation for ordinary field fills", () => {
    expect(actionRequiresConfirmation("type_sensitive", "email")).toBe(false);
    expect(actionRequiresConfirmation("click", "search")).toBe(false);
  });
});
