import { vi } from "vitest";

// jsdom doesn't implement CSS.escape — polyfill the minimal behavior
// domExtractor.ts relies on (escaping a value for use in an attribute
// selector) so tests exercising it don't fail on an unrelated jsdom gap.
if (typeof (globalThis as any).CSS === "undefined") {
  (globalThis as any).CSS = {};
}
if (typeof (globalThis as any).CSS.escape !== "function") {
  (globalThis as any).CSS.escape = (value: string) => value.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
}

// Minimal chrome.storage.local mock (in-memory), enough for
// background/secretStore.ts and background/settings.ts unit tests. Real
// browser behavior is covered by manual/E2E testing per the demo workflow.
const memoryStore: Record<string, unknown> = {};

(globalThis as any).chrome = {
  storage: {
    local: {
      get: vi.fn(async (key: string) => ({ [key]: memoryStore[key] })),
      set: vi.fn(async (obj: Record<string, unknown>) => {
        Object.assign(memoryStore, obj);
      }),
    },
  },
  runtime: {
    sendMessage: vi.fn(),
    onMessage: { addListener: vi.fn() },
    getURL: vi.fn((p: string) => `chrome-extension://test/${p}`),
  },
};
