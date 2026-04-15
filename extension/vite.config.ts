import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import wasm from "vite-plugin-wasm";
import topLevelAwait from "vite-plugin-top-level-await";
import { resolve } from "path";

// wasm-bindgen generates `window.window` to get the browser global object.
// Service workers don't have `window`, so we replace it with `globalThis`
// which is equivalent in both browser pages and worker contexts.
const loroServiceWorkerCompat = {
  name: "loro-service-worker-compat",
  transform(code: string, id: string) {
    if (id.includes("loro_wasm")) {
      return code.replace(/\bwindow\.window\b/g, "globalThis");
    }
  },
};

export default defineConfig({
  plugins: [loroServiceWorkerCompat, wasm(), topLevelAwait(), solid()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Disable Vite's module-preload polyfill — it injects document.createElement("link")
    // which throws in the background service worker (no DOM).
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: {
        background: resolve(__dirname, "src/background/index.ts"),
        popup: resolve(__dirname, "popup.html"),
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
  // Loro WASM must be excluded from dep pre-bundling so its .wasm asset is handled correctly.
  optimizeDeps: {
    exclude: ["loro-wasm"],
  },
});
