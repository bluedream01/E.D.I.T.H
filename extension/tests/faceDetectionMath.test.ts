import { describe, expect, it } from "vitest";
import {
  FACE_CONFIDENCE_THRESHOLD,
  MODEL_INPUT_HEIGHT,
  MODEL_INPUT_WIDTH,
  computeTiles,
  mergeOverlappingRegions,
  nonMaxSuppression,
  postprocess,
  preprocessImageData,
  toDetectedRegions,
  type RawDetection,
} from "../src/ml/faceDetectionMath";
import type { DetectedRegion } from "../src/shared/types";

function makeImageData(width: number, height: number, fill: [number, number, number, number]): ImageData {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = fill[0];
    data[i * 4 + 1] = fill[1];
    data[i * 4 + 2] = fill[2];
    data[i * 4 + 3] = fill[3];
  }
  // jsdom doesn't provide a global ImageData constructor in this test
  // environment — build a structurally-compatible plain object instead
  // (preprocessImageData only reads .data/.width/.height).
  return { data, width, height, colorSpace: "srgb" } as ImageData;
}

describe("preprocessImageData", () => {
  it("normalizes (pixel - 127) / 128 in CHW planar order", () => {
    const image = makeImageData(MODEL_INPUT_WIDTH, MODEL_INPUT_HEIGHT, [127, 255, 0, 255]);
    const out = preprocessImageData(image);
    const plane = MODEL_INPUT_WIDTH * MODEL_INPUT_HEIGHT;
    expect(out.length).toBe(3 * plane);
    // R channel (127) -> 0
    expect(out[0]).toBeCloseTo(0, 5);
    // G channel (255) -> (255-127)/128 = 1
    expect(out[plane]).toBeCloseTo(1, 5);
    // B channel (0) -> (0-127)/128 = -0.9921875
    expect(out[2 * plane]).toBeCloseTo((0 - 127) / 128, 5);
  });

  it("rejects images that aren't already resized to the model's expected input size", () => {
    const image = makeImageData(100, 100, [0, 0, 0, 255]);
    expect(() => preprocessImageData(image)).toThrow();
  });
});

describe("nonMaxSuppression", () => {
  it("drops heavily-overlapping lower-score boxes", () => {
    const dets: RawDetection[] = [
      { box: [0.1, 0.1, 0.5, 0.5], score: 0.95 },
      { box: [0.12, 0.12, 0.52, 0.52], score: 0.8 }, // near-identical, should be suppressed
      { box: [0.6, 0.6, 0.9, 0.9], score: 0.75 }, // distinct region, should survive
    ];
    const kept = nonMaxSuppression(dets, 0.3);
    expect(kept).toHaveLength(2);
    expect(kept.map((d) => d.score)).toEqual([0.95, 0.75]);
  });

  it("keeps all boxes when none overlap", () => {
    const dets: RawDetection[] = [
      { box: [0, 0, 0.2, 0.2], score: 0.9 },
      { box: [0.5, 0.5, 0.7, 0.7], score: 0.8 },
    ];
    expect(nonMaxSuppression(dets, 0.3)).toHaveLength(2);
  });
});

describe("postprocess", () => {
  it("filters by confidence threshold and applies NMS", () => {
    // 3 anchors: [background, face] score pairs
    const scores = new Float32Array([
      0.1, 0.9, // anchor 0: face, above threshold
      0.95, 0.05, // anchor 1: background, below threshold
      0.2, 0.75, // anchor 2: face, above threshold, distinct box
    ]);
    const boxes = new Float32Array([
      0.1, 0.1, 0.5, 0.5,
      0, 0, 0, 0,
      0.6, 0.6, 0.9, 0.9,
    ]);
    const result = postprocess(scores, boxes, 3);
    expect(result).toHaveLength(2);
    expect(result[0].score).toBeCloseTo(0.9, 5);
  });

  it("returns nothing when no anchor clears the confidence threshold", () => {
    const scores = new Float32Array([0.9, 0.1]);
    const boxes = new Float32Array([0.1, 0.1, 0.5, 0.5]);
    expect(postprocess(scores, boxes, 1)).toHaveLength(0);
    expect(FACE_CONFIDENCE_THRESHOLD).toBeGreaterThan(0.1);
  });
});

describe("toDetectedRegions", () => {
  it("scales normalized boxes by the ORIGINAL image dimensions, not the model input size", () => {
    const detections: RawDetection[] = [{ box: [0.25, 0.5, 0.75, 1.0], score: 0.9 }];
    const regions = toDetectedRegions(detections, 1000, 400);
    expect(regions).toHaveLength(1);
    expect(regions[0]).toMatchObject({
      label: "face",
      confidence: 0.9,
      source: "vision",
      bbox: { x: 250, y: 200, width: 500, height: 200 },
    });
  });
});

describe("computeTiles", () => {
  it("returns a single whole-image tile for small/simple screenshots (no tiling overhead)", () => {
    const tiles = computeTiles(600, 400);
    expect(tiles).toEqual([{ x: 0, y: 0, width: 600, height: 400 }]);
  });

  it("splits a large screenshot into a bounded grid of overlapping tiles", () => {
    const tiles = computeTiles(2560, 1440);
    expect(tiles.length).toBeGreaterThan(1);
    expect(tiles.length).toBeLessThanOrEqual(9); // capped at 3x3
    // every tile stays within the image bounds
    for (const t of tiles) {
      expect(t.x).toBeGreaterThanOrEqual(0);
      expect(t.y).toBeGreaterThanOrEqual(0);
      expect(t.x + t.width).toBeLessThanOrEqual(2560);
      expect(t.y + t.height).toBeLessThanOrEqual(1440);
    }
  });

  it("caps the grid at 3x3 even for a very large screenshot", () => {
    const tiles = computeTiles(8000, 6000);
    expect(tiles.length).toBeLessThanOrEqual(9);
  });

  it("adjacent tiles overlap (so a face straddling a boundary isn't split in half)", () => {
    const tiles = computeTiles(2000, 800);
    if (tiles.length > 1) {
      const sortedByX = [...tiles].filter((t) => t.y === tiles[0].y).sort((a, b) => a.x - b.x);
      for (let i = 0; i < sortedByX.length - 1; i++) {
        expect(sortedByX[i].x + sortedByX[i].width).toBeGreaterThan(sortedByX[i + 1].x);
      }
    }
  });
});

describe("mergeOverlappingRegions", () => {
  function region(x: number, y: number, size: number, confidence: number): DetectedRegion {
    return { bbox: { x, y, width: size, height: size }, label: "face", confidence, source: "vision" };
  }

  it("collapses the same face detected by two overlapping tiles into one region", () => {
    const regions = [region(100, 100, 80, 0.9), region(105, 103, 78, 0.85)];
    const merged = mergeOverlappingRegions(regions);
    expect(merged).toHaveLength(1);
    expect(merged[0].confidence).toBe(0.9); // keeps the higher-confidence one
  });

  it("keeps distinct, non-overlapping faces from different tiles separate", () => {
    const regions = [region(0, 0, 50, 0.9), region(500, 500, 50, 0.8)];
    const merged = mergeOverlappingRegions(regions);
    expect(merged).toHaveLength(2);
  });
});
