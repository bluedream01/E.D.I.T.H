/**
 * Real on-device vision detector: face detection via version-RFB-320.onnx
 * (Ultra-Light-Fast-Generic-Face-Detector-1MB, MIT — see public/models/NOTICE),
 * run through onnxruntime-web. WASM execution provider, single-threaded,
 * non-JSEP — never throws out of `detect()`, since a vision-detector
 * failure must not block the (DOM-driven) rest of the privacy pipeline.
 *
 * onnxruntime-web is DELIBERATELY PINNED to 1.14.0 (exact — see
 * package.json, no "^"). This is load-bearing, not incidental: every
 * current (1.19+) build of onnxruntime-web — WASM-only included, not just
 * the WebGPU/JSEP one — loads its WASM factory module via a dynamic
 * `import()` internally, and that is disallowed inside
 * `ServiceWorkerGlobalScope` by the HTML spec (confirmed by testing, not
 * assumed):
 *   "TypeError: import() is disallowed on ServiceWorkerGlobalScope by the
 *    HTML specification."
 * 1.14.0 is the last line that ships a genuinely synchronous, non-import()
 * WASM loader with a true non-threaded build (`ort-wasm-simd.wasm`) — no
 * pthread/worker bootstrapping machinery at all, which is what actually
 * makes this runnable directly inside the MV3 background service worker.
 * Do not bump this dependency without re-verifying (`grep -o "import("` over
 * the new version's dist/*.js) that it still avoids dynamic import().
 *
 * A face in a screenshot (profile photo, scanned ID/passport) is visual PII
 * the DOM layer structurally cannot see — this is the one thing vision adds
 * on top of DOM extraction in this system (see docs/architecture.md for why
 * DOM extraction, not a general vision model, remains the primary
 * screen-reading mechanism).
 */
import * as ort from "onnxruntime-web";
import type { DetectedRegion } from "../shared/types";
import type { VisionDetector } from "./visionDetector";
import {
  MODEL_INPUT_HEIGHT,
  MODEL_INPUT_WIDTH,
  computeTiles,
  cropImageData,
  mergeOverlappingRegions,
  postprocess,
  preprocessImageData,
  resizeImageData,
  toDetectedRegions,
} from "./faceDetectionMath";

const MODEL_URL = "models/version-RFB-320.onnx";
// Forcing simd=true + numThreads=1 makes the runtime request exactly
// `ort-wasm-simd.wasm` — the one file build.mjs copies into dist/ort/.
// Every target Chrome version (110+) supports WASM SIMD, so this is safe.
const WASM_DIR = "ort/";

let sessionPromise: Promise<ort.InferenceSession> | null = null;

function configureOrtEnv(): void {
  ort.env.wasm.wasmPaths = chrome.runtime.getURL(WASM_DIR);
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.simd = true;
}

async function getSession(): Promise<ort.InferenceSession> {
  if (sessionPromise) return sessionPromise;

  configureOrtEnv();
  const modelUrl = chrome.runtime.getURL(MODEL_URL);

  sessionPromise = ort.InferenceSession.create(modelUrl, { executionProviders: ["wasm"] }).then((session) => {
    console.info("[onnxFaceDetector] session created (wasm execution provider, onnxruntime-web 1.14.0)");
    return session;
  });

  return sessionPromise;
}

export class OnnxFaceDetector implements VisionDetector {
  private async detectOneFrame(session: ort.InferenceSession, image: ImageData): Promise<DetectedRegion[]> {
    const resized = resizeImageData(image, MODEL_INPUT_WIDTH, MODEL_INPUT_HEIGHT);
    const inputData = preprocessImageData(resized);
    const inputTensor = new ort.Tensor("float32", inputData, [1, 3, MODEL_INPUT_HEIGHT, MODEL_INPUT_WIDTH]);

    const results = await session.run({ input: inputTensor });
    const scores = results["scores"].data as Float32Array;
    const boxes = results["boxes"].data as Float32Array;
    const numAnchors = results["scores"].dims[1] as number;

    const detections = postprocess(scores, boxes, numAnchors);
    return toDetectedRegions(detections, image.width, image.height);
  }

  async detect(image: ImageData): Promise<DetectedRegion[]> {
    try {
      const session = await getSession();
      const tiles = computeTiles(image.width, image.height);

      // Small/simple screenshots come back as a single tile (the whole
      // image) — one inference call, same as before tiling existed. Larger
      // screenshots (e.g. a page full of small thumbnail photos) get split
      // so each face is seen at higher effective resolution; results are
      // then de-duplicated across overlapping tiles.
      const allRegions: DetectedRegion[] = [];
      for (const tile of tiles) {
        const frame = tiles.length === 1 ? image : cropImageData(image, tile);
        const regions = await this.detectOneFrame(session, frame);
        for (const r of regions) {
          allRegions.push({ ...r, bbox: { ...r.bbox, x: r.bbox.x + tile.x, y: r.bbox.y + tile.y } });
        }
      }

      return mergeOverlappingRegions(allRegions);
    } catch (err) {
      console.warn("[onnxFaceDetector] detection failed, returning no regions:", err);
      return [];
    }
  }
}
