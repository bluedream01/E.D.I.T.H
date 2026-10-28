/**
 * Redacts a captured screenshot using OffscreenCanvas, which is available
 * both in window contexts and in the MV3 service worker — so this same
 * function runs in background.ts right after chrome.tabs.captureVisibleTab,
 * meaning the UNREDACTED screenshot bitmap never needs to be handed to a
 * page context or serialized/stored anywhere.
 */
import type { FusedRegion } from "../privacy/redactor";
import { redactCanvasRegions } from "../privacy/redactor";

export async function sanitizeScreenshot(
  rawDataUrl: string,
  regions: FusedRegion[],
  devicePixelRatio: number = 1
): Promise<string> {
  const blob = await (await fetch(rawDataUrl)).blob();
  const bitmap = await createImageBitmap(blob);

  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("failed to acquire OffscreenCanvas 2d context");

  ctx.drawImage(bitmap, 0, 0);

  // captureVisibleTab returns pixels at devicePixelRatio scale, but bbox
  // values were computed in CSS pixels (getBoundingClientRect) — rescale so
  // redaction boxes land on the right region of the actual captured bitmap.
  const scaledRegions =
    devicePixelRatio === 1
      ? regions
      : regions.map((r) => ({
          ...r,
          bbox: {
            x: r.bbox.x * devicePixelRatio,
            y: r.bbox.y * devicePixelRatio,
            width: r.bbox.width * devicePixelRatio,
            height: r.bbox.height * devicePixelRatio,
          },
        }));

  redactCanvasRegions(ctx, scaledRegions);

  const outBlob = await canvas.convertToBlob({ type: "image/png" });
  return blobToDataUrl(outBlob);
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
