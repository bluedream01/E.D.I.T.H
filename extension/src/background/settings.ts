export interface BackendSettings {
  baseUrl: string;
  apiKey: string;
  confirmAllActions: boolean;
}

const SETTINGS_KEY = "pba_settings_v1";

export const DEFAULT_SETTINGS: BackendSettings = {
  baseUrl: "http://127.0.0.1:8001",
  apiKey: "dev-local-only-key",
  confirmAllActions: false,
};

export async function getSettings(): Promise<BackendSettings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(stored[SETTINGS_KEY] ?? {}) };
}

export async function setSettings(settings: BackendSettings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}
