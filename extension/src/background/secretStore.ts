/**
 * Local resolution of secret_ref tokens -> actual values.
 *
 * This is the ONLY place raw sensitive values exist in the extension at
 * runtime, and they never leave it: the backend hands back a plan that
 * references "EMAIL_FIELD_1"; this module turns that back into the user's
 * real email, purely from data stored in chrome.storage.local (which never
 * gets network-synced off-device by this extension, and is never included
 * in any request body sent to the backend).
 */

export interface LocalProfile {
  /** Full name. Kept alongside firstName/lastName because plenty of forms
   * still ask for a single "Full Name" field; the three are kept consistent
   * by deriving whichever side the user left blank (see resolveSecretRef). */
  name: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  password: string;
  address: string;
  dateOfBirth: string;
  cardNumber: string;
  cvv: string;
  aadhaar: string;
  pan: string;
  apiKey: string;
  otp: string;
}

const PROFILE_STORAGE_KEY = "pba_local_profile_v1";

export const EMPTY_PROFILE: LocalProfile = {
  name: "",
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  password: "",
  address: "",
  dateOfBirth: "",
  cardNumber: "",
  cvv: "",
  aadhaar: "",
  pan: "",
  apiKey: "",
  otp: "",
};

const PREFIX_TO_PROFILE_KEY: Record<string, keyof LocalProfile> = {
  EMAIL_FIELD: "email",
  PHONE_FIELD: "phone",
  PASSWORD_FIELD: "password",
  PERSON_FIELD: "name",
  FIRST_NAME_FIELD: "firstName",
  LAST_NAME_FIELD: "lastName",
  ADDRESS_FIELD: "address",
  DOB_FIELD: "dateOfBirth",
  CARD_NUMBER_FIELD: "cardNumber",
  CVV_FIELD: "cvv",
  AADHAAR_FIELD: "aadhaar",
  PAN_FIELD: "pan",
  API_KEY_FIELD: "apiKey",
  OTP_FIELD: "otp",
};

export async function getLocalProfile(): Promise<LocalProfile> {
  const stored = await chrome.storage.local.get(PROFILE_STORAGE_KEY);
  return { ...EMPTY_PROFILE, ...(stored[PROFILE_STORAGE_KEY] ?? {}) };
}

export async function setLocalProfile(profile: LocalProfile): Promise<void> {
  await chrome.storage.local.set({ [PROFILE_STORAGE_KEY]: profile });
}

/** Name fields are the one place where the profile is redundant: a user who
 * filled in only "Full Name" should still be able to fill a split
 * First/Last form, and vice versa. Everything here is local string
 * manipulation on data that never leaves the device.
 *
 * Splitting is deliberately naive — first whitespace-separated word is the
 * given name, the rest is the family name. That is wrong for plenty of real
 * names, which is exactly why it is only a FALLBACK: an explicitly entered
 * firstName/lastName always wins. */
function deriveName(profile: LocalProfile, key: keyof LocalProfile): string {
  const full = profile.name.trim();
  const first = profile.firstName.trim();
  const last = profile.lastName.trim();

  if (key === "firstName") {
    if (first) return first;
    return full ? full.split(/\s+/)[0] : "";
  }
  if (key === "lastName") {
    if (last) return last;
    if (!full) return "";
    const parts = full.split(/\s+/);
    return parts.length > 1 ? parts.slice(1).join(" ") : "";
  }
  if (key === "name") {
    if (full) return full;
    return [first, last].filter(Boolean).join(" ");
  }
  return profile[key];
}

/** secret_ref looks like "EMAIL_FIELD_1" (no brackets — those are stripped
 * before this function is called). Returns null if unresolvable. */
export async function resolveSecretRef(secretRef: string): Promise<string | null> {
  const match = secretRef.match(/^(.*)_(\d+)$/);
  const prefix = match ? match[1] : secretRef;
  const profileKey = PREFIX_TO_PROFILE_KEY[prefix];
  if (!profileKey) return null;
  const profile = await getLocalProfile();
  const value = deriveName(profile, profileKey);
  return value || null;
}
