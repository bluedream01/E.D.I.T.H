import { build, context } from "esbuild";
import { mkdirSync, copyFileSync, cpSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(__dirname, "dist");
const watch = process.argv.includes("--watch");

mkdirSync(dist, { recursive: true });

const entries = {
  background: "src/background/background.ts",
  content: "src/content/content-script.ts",
  popup: "src/popup/popup.ts",
};

const commonOptions = {
  bundle: true,
  format: "iife",
  target: "chrome110",
  sourcemap: true,
  logLevel: "info",
};

function copyStatic() {
  copyFileSync(path.join(__dirname, "manifest.json"), path.join(dist, "manifest.json"));
  copyFileSync(path.join(__dirname, "src/popup/popup.html"), path.join(dist, "popup.html"));
  copyFileSync(path.join(__dirname, "src/popup/popup.css"), path.join(dist, "popup.css"));
  const iconsDir = path.join(__dirname, "public/icons");
  if (existsSync(iconsDir) && readdirSync(iconsDir).length > 0) {
    cpSync(iconsDir, path.join(dist, "icons"), { recursive: true });
  }

  // onnxruntime-web's WASM binary is not something esbuild bundles (it's
  // fetched at runtime, not imported). Copy the genuinely non-threaded SIMD
  // build (`ort-wasm-simd.wasm`) from the pinned 1.14.0 install — every
  // 1.19+ build (WASM-only included) loads its wasm factory via a dynamic
  // import(), which is disallowed inside ServiceWorkerGlobalScope
  // (confirmed by testing — see onnxFaceDetector.ts's header comment for
  // why the dependency is pinned to this exact old version).
  const ortDir = path.join(dist, "ort");
  mkdirSync(ortDir, { recursive: true });
  copyFileSync(
    path.join(__dirname, "node_modules/onnxruntime-web/dist/ort-wasm-simd.wasm"),
    path.join(ortDir, "ort-wasm-simd.wasm")
  );

  const modelsDir = path.join(dist, "models");
  mkdirSync(modelsDir, { recursive: true });
  copyFileSync(
    path.join(__dirname, "public/models/version-RFB-320.onnx"),
    path.join(modelsDir, "version-RFB-320.onnx")
  );
}

async function run() {
  const builds = Object.entries(entries).map(([name, entry]) =>
    build({
      ...commonOptions,
      entryPoints: [path.join(__dirname, entry)],
      outfile: path.join(dist, `${name}.js`),
    })
  );
  await Promise.all(builds);
  copyStatic();
  console.log("Build complete ->", dist);
}

if (watch) {
  const ctxs = await Promise.all(
    Object.entries(entries).map(([name, entry]) =>
      context({
        ...commonOptions,
        entryPoints: [path.join(__dirname, entry)],
        outfile: path.join(dist, `${name}.js`),
      })
    )
  );
  for (const ctx of ctxs) await ctx.watch();
  copyStatic();
  console.log("Watching for changes... (dist/manifest.json, popup.html copied once — rerun build for static changes)");
} else {
  await run();
}
