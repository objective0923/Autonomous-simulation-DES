import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { "/api": process.env.CROIS_API_PROXY ?? "http://127.0.0.1:8000" },
  },
  preview: {
    proxy: { "/api": process.env.CROIS_API_PROXY ?? "http://127.0.0.1:8000" },
  },
  build: {
    rollupOptions: {
      output: { manualChunks: { three: ["three"], pdf: ["pdfjs-dist"] } },
    },
  },
});
