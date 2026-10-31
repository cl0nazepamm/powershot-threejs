import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  base: "/powershot-threejs/",
  build: {
    // Build BOTH pages — vite only builds index.html by default, which left
    // nv.html (the true-NIR demo) out of `npm run build` and its import checks.
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        nv: resolve(import.meta.dirname, "nv.html"),
        flare: resolve(import.meta.dirname, "flare.html"),
      },
    },
  },
});
