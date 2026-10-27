import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@gini-category-tree": fileURLToPath(new URL("../server/src/utils/giniCategoryTree.js", import.meta.url)),
    },
  },
  server: {
    fs: {
      allow: [
        fileURLToPath(new URL(".", import.meta.url)),
        fileURLToPath(new URL("../server/src/utils", import.meta.url)),
      ],
    },
    proxy: {
      "/api": {
        target: "http://localhost:5000",
        timeout: 600000,
        proxyTimeout: 600000,
      },
      "/media": "http://localhost:5000",
    },
  },
});
