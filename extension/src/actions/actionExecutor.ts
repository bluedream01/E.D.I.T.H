/**
 * Runs in the background service worker. Resolves any secret_ref locally,
 * asks the content script to perform the DOM action, and falls back to the
 * Chrome Debugger API (see debuggerExecutor.ts) if the DOM path fails.
 *
 * High-risk actions (requires_confirmation) must already have been approved
 * by the human-in-the-loop confirmation flow before this is ever called —
 * see background.ts's handling of AgentAction.requires_confirmation.
 */
import type { AgentAction } from "../shared/types";
import { resolveSecretRef } from "../background/secretStore";
import { typeViaDebugger } from "./debuggerExecutor";

export interface ExecutionResult {
  action: AgentAction;
  ok: boolean;
  error?: string;
  usedDebuggerFallback?: boolean;
}

function sendToContentScript(tabId: number, message: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(response);
    });
  });
}

export async function executeAction(tabId: number, action: AgentAction): Promise<ExecutionResult> {
  let resolvedValue: string | null = null;

  if (action.type === "type_sensitive") {
    if (!action.secret_ref) {
      return { action, ok: false, error: "type_sensitive action missing secret_ref" };
    }
    resolvedValue = await resolveSecretRef(action.secret_ref);
    if (resolvedValue == null) {
      return { action, ok: false, error: `no local value configured for ${action.secret_ref} (set it in the popup's Local Profile)` };
    }
  }

  try {
    const result = await sendToContentScript(tabId, { kind: "CS_EXECUTE_ACTION", action, resolvedValue });
    if (result?.ok) return { action, ok: true };

    // DOM path failed — try the Debugger API fallback for typing actions only.
    if ((action.type === "type" || action.type === "type_sensitive") && (action.value != null || resolvedValue != null)) {
      await typeViaDebugger(tabId, action.type === "type_sensitive" ? (resolvedValue as string) : (action.value as string));
      return { action, ok: true, usedDebuggerFallback: true };
    }

    return { action, ok: false, error: result?.error ?? "content script action failed" };
  } catch (err) {
    return { action, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
