import type { PlanRequest, PlanResponse, SemanticType } from "../shared/types";
import { ALL_SEMANTIC_TYPES } from "../shared/types";
import type { BackendSettings } from "./settings";

export class ApiError extends Error {}

function nonce(): string {
  return crypto.randomUUID();
}

export async function checkHealth(settings: BackendSettings): Promise<boolean> {
  try {
    const resp = await fetch(`${settings.baseUrl}/health`, { method: "GET" });
    return resp.ok;
  } catch {
    return false;
  }
}

/**
 * Semantic types this extension can send that the backend has never heard
 * of — i.e. it is running older code than this build.
 *
 * The two SemanticType lists are duplicated on purpose (it's what lets the
 * backend reject anything not classified on-device), so skew is a normal
 * consequence of changing one side. Left undetected it surfaces as a 422
 * listing every VALID value, which reads like the extension sent garbage
 * rather than like the server being out of date.
 *
 * Returns an empty list when the backend can't be reached or predates this
 * check — an unknown answer must not be reported as a problem.
 */
export async function findUnsupportedSemanticTypes(settings: BackendSettings): Promise<SemanticType[]> {
  try {
    const resp = await fetch(`${settings.baseUrl}/health`, { method: "GET" });
    if (!resp.ok) return [];
    const body = (await resp.json()) as { semantic_types?: string[] };
    if (!Array.isArray(body.semantic_types) || body.semantic_types.length === 0) return [];
    const known = new Set(body.semantic_types);
    return ALL_SEMANTIC_TYPES.filter((t) => !known.has(t));
  } catch {
    return [];
  }
}

export async function requestPlan(
  settings: BackendSettings,
  task: string,
  screenshot: string | null,
  elements: PlanRequest["elements"],
  conversationHistory: PlanRequest["conversation_history"] = []
): Promise<PlanResponse> {
  const body: PlanRequest = { task, screenshot, elements, conversation_history: conversationHistory, nonce: nonce() };

  const resp = await fetch(`${settings.baseUrl}/api/agent/plan`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": settings.apiKey },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => resp.statusText);
    throw new ApiError(`backend rejected plan request (${resp.status}): ${detail}`);
  }

  return (await resp.json()) as PlanResponse;
}

export async function verifyActionToken(settings: BackendSettings, actionToken: string): Promise<boolean> {
  const resp = await fetch(`${settings.baseUrl}/api/agent/verify-action`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": settings.apiKey },
    body: JSON.stringify({ action_token: actionToken }),
  });
  return resp.ok;
}
