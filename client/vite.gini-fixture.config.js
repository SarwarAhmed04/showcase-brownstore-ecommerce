import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  define: {
    "import.meta.env.VITE_API_URL": JSON.stringify(""),
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@gini-category-tree": fileURLToPath(new URL("../server/src/utils/giniCategoryTree.js", import.meta.url)),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 5174,
    strictPort: true,
    fs: {
      allow: [
        fileURLToPath(new URL(".", import.meta.url)),
        fileURLToPath(new URL("../server/src/utils", import.meta.url)),
      ],
    },
    proxy: {
      "/api": { target: "http://127.0.0.1:5055", timeout: 600000, proxyTimeout: 600000 },
      "/media": "http://127.0.0.1:5055",
    },
  },
});
