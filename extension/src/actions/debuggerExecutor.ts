/**
 * Chrome Debugger API fallback for pages where plain DOM value-assignment +
 * synthetic events don't stick (common with heavily-controlled React/Vue
 * inputs that track the native property setter). Used only as a fallback
 * from actionExecutor.ts when the DOM-based attempt fails.
 *
 * "debugger" is an OPTIONAL permission (see manifest.json) — it's requested
 * just-in-time via chrome.permissions.request, used for the minimum
 * necessary time, and detached immediately after. Chrome also shows its own
 * "<ext> is debugging this browser" infobar while attached, which is
 * intentional extra transparency for a fairly powerful capability.
 */

const PROTOCOL_VERSION = "1.3";

export async function ensureDebuggerPermission(): Promise<boolean> {
  const has = await chrome.permissions.contains({ permissions: ["debugger"] });
  if (has) return true;
  return chrome.permissions.request({ permissions: ["debugger"] });
}

async function attach(tabId: number): Promise<void> {
  await chrome.debugger.attach({ tabId }, PROTOCOL_VERSION);
}

async function detach(tabId: number): Promise<void> {
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // already detached (e.g. tab closed) — fine to ignore
  }
}

function sendCommand<T = unknown>(tabId: number, method: string, params?: object): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(result as T);
    });
  });
}

/** Types `text` into whatever element currently has focus in the given tab,
 * using CDP Input.insertText — bypasses framework-level onChange interception
 * issues that plain `element.value = x` + dispatchEvent can hit. */
export async function typeViaDebugger(tabId: number, text: string): Promise<void> {
  const granted = await ensureDebuggerPermission();
  if (!granted) throw new Error("user denied the 'debugger' permission required for this fallback");

  await attach(tabId);
  try {
    await sendCommand(tabId, "Input.insertText", { text });
  } finally {
    await detach(tabId);
  }
}

export async function clickViaDebugger(tabId: number, x: number, y: number): Promise<void> {
  const granted = await ensureDebuggerPermission();
  if (!granted) throw new Error("user denied the 'debugger' permission required for this fallback");

  await attach(tabId);
  try {
    await sendCommand(tabId, "Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await sendCommand(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  } finally {
    await detach(tabId);
  }
}
