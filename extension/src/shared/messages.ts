/** chrome.runtime message protocol shared by popup / background / content script. */
import type { AgentAction, RedactionRecord, SanitizedElement } from "./types";

export interface ChatMessage {
  id: string;
  role: "user" | "agent";
  text: string;
  timestamp: number;
  /** Client-side diagnostics (backend errors, transport failures) shown in
   * the chat log but never replayed as conversation_history. Error text can
   * quote whatever tripped the failure, so sending it back turned one bad
   * response into a conversation that could never recover. */
  localOnly?: boolean;
}

export type ExtMessage =
  | { kind: "SEND_CHAT_MESSAGE"; text: string }
  | { kind: "GET_STATUS" }
  | {
      kind: "STATUS_UPDATE";
      status: AgentStatus;
    }
  | { kind: "PAGE_SANITIZED"; elements: SanitizedElement[]; redactions: RedactionRecord[]; screenshotDataUrl: string | null }
  | { kind: "PLAN_READY"; actions: AgentAction[]; planId: string }
  | { kind: "CONFIRMATION_REQUIRED"; actions: AgentAction[] }
  | { kind: "CONFIRMATION_RESULT"; approved: boolean }
  | { kind: "ACTION_EXECUTED"; action: AgentAction; ok: boolean; error?: string }
  | { kind: "ERROR"; message: string }
  | { kind: "RESET" };

export interface AgentStatus {
  backendConnected: boolean;
  privacyShieldActive: boolean;
  sensitiveRegionsHidden: number;
  rawPiiSentToServer: 0;
  chatHistory: ChatMessage[];
  currentAction: string | null;
  awaitingConfirmation: AgentAction[] | null;
  lastError: string | null;
  /** Exactly what was (or is about to be) sent to POST /api/agent/plan on
   * the most recent run — rendered in the popup's "Sanitized View" panel so
   * the privacy boundary is directly observable, not just claimed. */
  lastSanitizedScreenshot: string | null;
  lastSanitizedElements: SanitizedElement[] | null;
}

export const defaultAgentStatus = (): AgentStatus => ({
  backendConnected: false,
  privacyShieldActive: true,
  sensitiveRegionsHidden: 0,
  rawPiiSentToServer: 0,
  chatHistory: [],
  currentAction: null,
  awaitingConfirmation: null,
  lastError: null,
  lastSanitizedScreenshot: null,
  lastSanitizedElements: null,
});
