import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "svelte/index": "src/svelte/index.ts",
    "offline/index": "src/offline/index.ts",
  },
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: true,
  treeshake: true,
  external: ["hls.js", "hls.js/light", "svelte", "svelte/store"],
  target: "es2022",
});
