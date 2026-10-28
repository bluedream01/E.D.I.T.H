/**
 * Semantic tokenization: turns "this field holds an email" into a stable,
 * content-free label like "EMAIL_FIELD_1". The token is derived purely from
 * semantic type + ordinal position on the page — it is never derived from
 * (and never contains) the field's actual value.
 */
import type { SemanticType } from "../shared/types";

const TOKEN_PREFIX: Partial<Record<SemanticType, string>> = {
  email: "EMAIL_FIELD",
  phone: "PHONE_FIELD",
  password: "PASSWORD_FIELD",
  name: "PERSON_FIELD",
  first_name: "FIRST_NAME_FIELD",
  last_name: "LAST_NAME_FIELD",
  address: "ADDRESS_FIELD",
  date_of_birth: "DOB_FIELD",
  card_number: "CARD_NUMBER_FIELD",
  cvv: "CVV_FIELD",
  aadhaar: "AADHAAR_FIELD",
  pan: "PAN_FIELD",
  api_key: "API_KEY_FIELD",
  otp: "OTP_FIELD",
};

export class SemanticTokenizer {
  private counters = new Map<string, number>();

  /** Returns a token like "[EMAIL_FIELD_1]", or null for non-sensitive types
   * (which don't need tokenization — their value, if any, may be handled as
   * ordinary non-sensitive text). */
  nextToken(semanticType: SemanticType): string | null {
    const prefix = TOKEN_PREFIX[semanticType];
    if (!prefix) return null;
    const n = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, n);
    return `[${prefix}_${n}]`;
  }

  reset(): void {
    this.counters.clear();
  }
}

export function tokenToRefName(token: string): string {
  return token.replace(/^\[|\]$/g, "");
}
