import { beforeEach, describe, expect, it } from "vitest";
import { getLocalProfile, resolveSecretRef, setLocalProfile, EMPTY_PROFILE } from "../src/background/secretStore";

describe("secretStore", () => {
  beforeEach(async () => {
    await setLocalProfile({ ...EMPTY_PROFILE });
  });

  it("resolves a secret_ref token to the matching local profile field", async () => {
    await setLocalProfile({ ...EMPTY_PROFILE, email: "rahul@example.com" });
    const resolved = await resolveSecretRef("EMAIL_FIELD_1");
    expect(resolved).toBe("rahul@example.com");
  });

  it("resolves regardless of the numeric suffix", async () => {
    await setLocalProfile({ ...EMPTY_PROFILE, phone: "9876543210" });
    expect(await resolveSecretRef("PHONE_FIELD_3")).toBe("9876543210");
  });

  it("returns null for an unmapped token prefix", async () => {
    expect(await resolveSecretRef("MYSTERY_FIELD_1")).toBeNull();
  });

  it("resolves first/last name tokens from their own profile fields", async () => {
    await setLocalProfile({ ...EMPTY_PROFILE, firstName: "Rahul", lastName: "Sharma" });
    expect(await resolveSecretRef("FIRST_NAME_FIELD_1")).toBe("Rahul");
    expect(await resolveSecretRef("LAST_NAME_FIELD_1")).toBe("Sharma");
  });

  it("derives first/last from a full name when only full name is stored", async () => {
    await setLocalProfile({ ...EMPTY_PROFILE, name: "Rahul Kumar Sharma" });
    expect(await resolveSecretRef("FIRST_NAME_FIELD_1")).toBe("Rahul");
    expect(await resolveSecretRef("LAST_NAME_FIELD_1")).toBe("Kumar Sharma");
  });

  it("derives a full name from first + last when only those are stored", async () => {
    await setLocalProfile({ ...EMPTY_PROFILE, firstName: "Rahul", lastName: "Sharma" });
    expect(await resolveSecretRef("PERSON_FIELD_1")).toBe("Rahul Sharma");
  });

  it("prefers an explicit first/last over one split out of the full name", async () => {
    await setLocalProfile({ ...EMPTY_PROFILE, name: "Rahul Sharma", firstName: "Raj" });
    expect(await resolveSecretRef("FIRST_NAME_FIELD_1")).toBe("Raj");
  });

  it("returns null for a last name that cannot be derived from a one-word full name", async () => {
    await setLocalProfile({ ...EMPTY_PROFILE, name: "Rahul" });
    expect(await resolveSecretRef("LAST_NAME_FIELD_1")).toBeNull();
  });

  it("returns null when the profile field is empty", async () => {
    const profile = await getLocalProfile();
    expect(profile.name).toBe("");
    expect(await resolveSecretRef("PERSON_FIELD_1")).toBeNull();
  });
});
