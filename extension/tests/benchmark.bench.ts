/**
 * Local-inference latency benchmarks: DOM PII detection, tokenization,
 * redaction, and the face-detector's pre/post-processing math. Run with:
 *   npx vitest bench
 *
 * Per project constraint: we do not claim a specific latency number in docs
 * unless it comes from actually running this. Numbers vary by machine.
 *
 * NOTE: this does NOT benchmark actual ONNX Runtime session inference
 * (WebGPU/WASM) — that requires a real browser (OffscreenCanvas + WebGPU/WASM
 * runtime), not vitest's jsdom environment. It benchmarks the pure
 * preprocess/postprocess math from faceDetectionMath.ts in isolation. For an
 * end-to-end face-detection latency number (including actual model
 * inference), time it manually in the loaded extension (service worker
 * console) — see docs/architecture.md.
 */
import { bench, describe } from "vitest";
import { detectFromDom } from "../src/privacy/pii-detector";
import { sanitizeElements } from "../src/privacy/redactor";
import { SemanticTokenizer } from "../src/privacy/tokenizer";
import { MODEL_INPUT_HEIGHT, MODEL_INPUT_WIDTH, postprocess, preprocessImageData } from "../src/ml/faceDetectionMath";
import type { RawFieldInfo } from "../src/shared/types";

function syntheticField(i: number): RawFieldInfo & { __autocomplete: string | null } {
  const kinds = [
    { inputType: "email", value: `user${i}@example.com`, label: "Email" },
    { inputType: "tel", value: "9876543210", label: "Phone" },
    { inputType: "password", value: "hunter2x", label: "Password" },
    { inputType: "text", value: "Rahul Sharma", label: "Full Name" },
    { inputType: "text", value: "sofa", label: "Search" },
  ];
  const k = kinds[i % kinds.length];
  return {
    elementId: `el-${i}`,
    domSelector: `#el-${i}`,
    tagName: "input",
    inputType: k.inputType,
    rawValue: k.value,
    rawLabelText: k.label,
    bbox: { x: 0, y: i * 30, width: 200, height: 24 },
    editable: true,
    __autocomplete: null,
  };
}

const FIELD_COUNT = 40; // a large, realistic form

describe("DOM PII detection", () => {
  bench(`detectFromDom x${FIELD_COUNT}`, () => {
    for (let i = 0; i < FIELD_COUNT; i++) {
      detectFromDom(syntheticField(i));
    }
  });
});

describe("Full local sanitization pipeline", () => {
  bench(`sanitizeElements x${FIELD_COUNT} fields`, () => {
    const tokenizer = new SemanticTokenizer();
    const inputs = Array.from({ length: FIELD_COUNT }, (_, i) => ({
      field: syntheticField(i),
      elementId: `el-${i}`,
      elementType: "input",
    }));
    sanitizeElements(inputs, tokenizer);
  });
});

function syntheticFaceModelImage(): ImageData {
  const data = new Uint8ClampedArray(MODEL_INPUT_WIDTH * MODEL_INPUT_HEIGHT * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = (i * 7) % 256;
    data[i + 1] = (i * 13) % 256;
    data[i + 2] = (i * 19) % 256;
    data[i + 3] = 255;
  }
  return { data, width: MODEL_INPUT_WIDTH, height: MODEL_INPUT_HEIGHT, colorSpace: "srgb" } as ImageData;
}

const NUM_ANCHORS = 4420; // version-RFB-320.onnx's fixed anchor count

function syntheticScoresAndBoxes(): { scores: Float32Array; boxes: Float32Array } {
  const scores = new Float32Array(NUM_ANCHORS * 2);
  const boxes = new Float32Array(NUM_ANCHORS * 4);
  for (let i = 0; i < NUM_ANCHORS; i++) {
    // ~1% of anchors "fire" above threshold, roughly like a real frame with a couple of faces
    const face = i % 100 === 0 ? 0.85 : 0.1;
    scores[i * 2] = 1 - face;
    scores[i * 2 + 1] = face;
    boxes[i * 4] = (i % 320) / 320;
    boxes[i * 4 + 1] = (i % 240) / 240;
    boxes[i * 4 + 2] = Math.min(1, ((i % 320) + 40) / 320);
    boxes[i * 4 + 3] = Math.min(1, ((i % 240) + 40) / 240);
  }
  return { scores, boxes };
}

describe("Face detector pre/post-processing (pure math, no ONNX session)", () => {
  const image = syntheticFaceModelImage();
  bench("preprocessImageData (320x240)", () => {
    preprocessImageData(image);
  });

  const { scores, boxes } = syntheticScoresAndBoxes();
  bench(`postprocess (${NUM_ANCHORS} anchors incl. NMS)`, () => {
    postprocess(scores, boxes, NUM_ANCHORS);
  });
});
