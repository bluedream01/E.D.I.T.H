/**
 * Vision-based sensitive-region detector abstraction.
 *
 * `createVisionDetector()` returns the real on-device face detector
 * (onnxFaceDetector.ts, running via onnxruntime-web — WebGPU preferred, WASM
 * fallback). `MockVisionDetector` is kept as a defensive fallback used only
 * if constructing the real detector throws synchronously — everything else
 * (model/session loading failures, WebGPU unavailability at runtime) is
 * already handled inside `OnnxFaceDetector.detect()` itself, which never
 * throws and returns `[]` on any failure.
 *
 * Called directly from background.ts (the MV3 service worker), not from a
 * nested Worker — `new Worker()` is unavailable inside
 * ServiceWorkerGlobalScope on Chrome (confirmed by testing, not assumed).
 * The service worker is already off any page's main thread, which is what
 * "don't block the page" actually requires.
 */
import type { DetectedRegion } from "../shared/types";
import { OnnxFaceDetector } from "./onnxFaceDetector";

export interface VisionDetector {
  detect(image: ImageData): Promise<DetectedRegion[]>;
}

/**
 * No-op fallback. Used only if the real detector's construction fails
 * outright (e.g. an unexpected environment where `onnxruntime-web` itself
 * can't be set up) — not the normal path.
 */
export class MockVisionDetector implements VisionDetector {
  async detect(_image: ImageData): Promise<DetectedRegion[]> {
    return [];
  }
}

export function createVisionDetector(): VisionDetector {
  try {
    return new OnnxFaceDetector();
  } catch (err) {
    console.warn("[visionDetector] falling back to MockVisionDetector:", err);
    return new MockVisionDetector();
  }
}
