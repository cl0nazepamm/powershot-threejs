import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  base: "/powershot-threejs/",
  // One three (and one BVH) instance even when speedball-gi is npm-linked
  // from a sibling checkout — its bare imports must resolve to OUR deps.
  resolve: { dedupe: ["three", "three-mesh-bvh"] },
  build: {
    // Build BOTH pages — vite only builds index.html by default, which left
    // nv.html (the true-NIR demo) out of `npm run build` and its import checks.
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        nv: resolve(import.meta.dirname, "nv.html"),
      },
    },
  },
});
