/**
 * Pure pre/post-processing math for version-RFB-320.onnx (Ultra-Light-Fast-
 * Generic-Face-Detector-1MB, MIT licensed — see public/models/NOTICE).
 * Kept separate from onnxFaceDetector.ts (which owns the ONNX Runtime
 * session/IO) so this can be unit-tested with plain arrays — no WebGPU, no
 * WASM, no OffscreenCanvas required.
 *
 * Model IO (confirmed directly from the .onnx graph, not assumed):
 *   input:  float32 [1, 3, 240, 320]   (NCHW, height=240, width=320)
 *   scores: float32 [1, 4420, 2]       (background, face) per anchor
 *   boxes:  float32 [1, 4420, 4]       (x1, y1, x2, y2), normalized 0..1
 */
import type { BBox, DetectedRegion } from "../shared/types";

export const MODEL_INPUT_WIDTH = 320;
export const MODEL_INPUT_HEIGHT = 240;
export const FACE_CONFIDENCE_THRESHOLD = 0.7;
export const NMS_IOU_THRESHOLD = 0.3;

/** Channel-planar (CHW) normalize: (pixel - 127) / 128, RGB order (the
 * browser's ImageData is already RGBA — no BGR swap needed, unlike the
 * reference OpenCV implementation which starts from BGR). */
export function preprocessImageData(image: ImageData): Float32Array {
  const { data, width, height } = image;
  if (width !== MODEL_INPUT_WIDTH || height !== MODEL_INPUT_HEIGHT) {
    throw new Error(
      `preprocessImageData expects a ${MODEL_INPUT_WIDTH}x${MODEL_INPUT_HEIGHT} image, got ${width}x${height}`
    );
  }
  const plane = width * height;
  const out = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    out[i] = (data[i * 4] - 127) / 128; // R
    out[plane + i] = (data[i * 4 + 1] - 127) / 128; // G
    out[2 * plane + i] = (data[i * 4 + 2] - 127) / 128; // B
  }
  return out;
}

export interface RawDetection {
  box: [number, number, number, number]; // normalized x1,y1,x2,y2
  score: number;
}

function iou(a: RawDetection["box"], b: RawDetection["box"]): number {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]);
  const y2 = Math.min(a[3], b[3]);
  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const areaA = Math.max(0, a[2] - a[0]) * Math.max(0, a[3] - a[1]);
  const areaB = Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
  const union = areaA + areaB - intersection;
  return union <= 0 ? 0 : intersection / union;
}

/** Hard NMS: greedily keep the highest-scoring box, drop anything that
 * overlaps it by more than iouThreshold, repeat. */
export function nonMaxSuppression(detections: RawDetection[], iouThreshold: number): RawDetection[] {
  const sorted = [...detections].sort((a, b) => b.score - a.score);
  const kept: RawDetection[] = [];
  for (const candidate of sorted) {
    if (kept.every((k) => iou(k.box, candidate.box) < iouThreshold)) {
      kept.push(candidate);
    }
  }
  return kept;
}

/** scores/boxes are the flat, raw tensor .data arrays from ort.Tensor
 * (batch size is always 1 for this model). */
export function postprocess(
  scores: ArrayLike<number>,
  boxes: ArrayLike<number>,
  numAnchors: number,
  confidenceThreshold = FACE_CONFIDENCE_THRESHOLD,
  iouThreshold = NMS_IOU_THRESHOLD
): RawDetection[] {
  const candidates: RawDetection[] = [];
  for (let i = 0; i < numAnchors; i++) {
    const faceScore = scores[i * 2 + 1]; // index 1 = face class, 0 = background
    if (faceScore > confidenceThreshold) {
      candidates.push({
        score: faceScore,
        box: [boxes[i * 4], boxes[i * 4 + 1], boxes[i * 4 + 2], boxes[i * 4 + 3]],
      });
    }
  }
  return nonMaxSuppression(candidates, iouThreshold);
}

/** Normalized [0,1] box coordinates scale directly by the ORIGINAL image
 * dimensions (not the 320x240 model-input size) — the model was trained on
 * a plain (non-aspect-preserving) resize, so normalized coordinates are
 * proportionally identical at any target size. */
export function toDetectedRegions(detections: RawDetection[], originalWidth: number, originalHeight: number): DetectedRegion[] {
  return detections.map((d): DetectedRegion => {
    const [x1, y1, x2, y2] = d.box;
    const bbox: BBox = {
      x: x1 * originalWidth,
      y: y1 * originalHeight,
      width: (x2 - x1) * originalWidth,
      height: (y2 - y1) * originalHeight,
    };
    return { bbox, label: "face", confidence: d.score, source: "vision" };
  });
}

/** Resizes (squashes, no letterboxing — matches the reference cv2.resize
 * behavior) an ImageData to the model's expected input size. Requires
 * OffscreenCanvas, available in both window and dedicated-worker contexts. */
export function resizeImageData(image: ImageData, targetWidth: number, targetHeight: number): ImageData {
  const srcCanvas = new OffscreenCanvas(image.width, image.height);
  const srcCtx = srcCanvas.getContext("2d");
  if (!srcCtx) throw new Error("failed to acquire OffscreenCanvas 2d context (source)");
  srcCtx.putImageData(image, 0, 0);

  const dstCanvas = new OffscreenCanvas(targetWidth, targetHeight);
  const dstCtx = dstCanvas.getContext("2d");
  if (!dstCtx) throw new Error("failed to acquire OffscreenCanvas 2d context (target)");
  dstCtx.drawImage(srcCanvas, 0, 0, image.width, image.height, 0, 0, targetWidth, targetHeight);
  return dstCtx.getImageData(0, 0, targetWidth, targetHeight);
}

// --- Tiling: recall on pages with many small photos --------------------
//
// A single 320x240 model input squashing a whole full-page screenshot makes
// small thumbnail faces (a grid of profile photos, say) only a few pixels
// wide — too small for this lightweight model to reliably see. Splitting
// the screenshot into overlapping tiles and running detection on each tile
// separately gives every face more effective resolution, at the cost of
// one inference call per tile instead of one per screenshot.

export interface Tile {
  x: number;
  y: number;
  width: number;
  height: number;
}

const MAX_TILE_COLS = 3;
const MAX_TILE_ROWS = 3;
const TARGET_TILE_SIZE_PX = 640;
const TILE_OVERLAP_FRACTION = 0.15;

/** Small/simple screenshots (most single-viewport pages) come back as a
 * single tile — the whole image, unchanged — so this adds no overhead for
 * the common case. Larger/denser screenshots get split into up to a 3x3
 * grid of overlapping tiles (capped, so worst-case latency stays bounded
 * regardless of how large the screenshot is). */
export function computeTiles(imageWidth: number, imageHeight: number): Tile[] {
  const cols = Math.min(MAX_TILE_COLS, Math.max(1, Math.round(imageWidth / TARGET_TILE_SIZE_PX)));
  const rows = Math.min(MAX_TILE_ROWS, Math.max(1, Math.round(imageHeight / TARGET_TILE_SIZE_PX)));

  if (cols === 1 && rows === 1) {
    return [{ x: 0, y: 0, width: imageWidth, height: imageHeight }];
  }

  const baseWidth = imageWidth / cols;
  const baseHeight = imageHeight / rows;
  const overlapX = baseWidth * TILE_OVERLAP_FRACTION;
  const overlapY = baseHeight * TILE_OVERLAP_FRACTION;

  const tiles: Tile[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x0 = Math.max(0, Math.round(col * baseWidth - overlapX));
      const y0 = Math.max(0, Math.round(row * baseHeight - overlapY));
      const x1 = Math.min(imageWidth, Math.round((col + 1) * baseWidth + overlapX));
      const y1 = Math.min(imageHeight, Math.round((row + 1) * baseHeight + overlapY));
      tiles.push({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 });
    }
  }
  return tiles;
}

/** Crops a sub-region out of a larger ImageData. */
export function cropImageData(image: ImageData, tile: Tile): ImageData {
  const canvas = new OffscreenCanvas(image.width, image.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("failed to acquire OffscreenCanvas 2d context (crop)");
  ctx.putImageData(image, 0, 0);
  return ctx.getImageData(tile.x, tile.y, tile.width, tile.height);
}

/** Merges detections gathered across overlapping tiles: the same face
 * caught by two adjacent (overlapping) tiles must collapse into one region,
 * not two. Same greedy-NMS approach as nonMaxSuppression, generalized to
 * DetectedRegion (pixel-space bbox) instead of RawDetection (normalized). */
export function mergeOverlappingRegions(regions: DetectedRegion[], iouThreshold = NMS_IOU_THRESHOLD): DetectedRegion[] {
  const toBox = (r: DetectedRegion): [number, number, number, number] => [
    r.bbox.x,
    r.bbox.y,
    r.bbox.x + r.bbox.width,
    r.bbox.y + r.bbox.height,
  ];
  const regionIou = (a: DetectedRegion, b: DetectedRegion): number => {
    const [ax1, ay1, ax2, ay2] = toBox(a);
    const [bx1, by1, bx2, by2] = toBox(b);
    const x1 = Math.max(ax1, bx1);
    const y1 = Math.max(ay1, by1);
    const x2 = Math.min(ax2, bx2);
    const y2 = Math.min(ay2, by2);
    const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    const areaA = Math.max(0, ax2 - ax1) * Math.max(0, ay2 - ay1);
    const areaB = Math.max(0, bx2 - bx1) * Math.max(0, by2 - by1);
    const union = areaA + areaB - intersection;
    return union <= 0 ? 0 : intersection / union;
  };

  const sorted = [...regions].sort((a, b) => b.confidence - a.confidence);
  const kept: DetectedRegion[] = [];
  for (const candidate of sorted) {
    if (kept.every((k) => regionIou(k, candidate) < iouThreshold)) {
      kept.push(candidate);
    }
  }
  return kept;
}
