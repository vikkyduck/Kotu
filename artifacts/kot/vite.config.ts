import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

const port = Number(process.env.PORT ?? 5173);

export default defineConfig({
  base: process.env.BASE_PATH ?? "/",
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
    dedupe: ["react", "react-dom"],
  },
  root: path.resolve(import.meta.dirname),
  build: {
    outDir: path.resolve(import.meta.dirname, "dist/public"),
    emptyOutDir: true,
  },
  server: {
    port,
    strictPort: true,
    host: "0.0.0.0",
    allowedHosts: true,
    fs: {
      strict: true,
    },
    // Локальная разработка: фронт ходит в /api относительными путями,
    // прокидываем их в API-сервер (или заглушку) через API_PROXY.
    proxy: {
      "/api": process.env.API_PROXY ?? "http://127.0.0.1:5010",
    },
  },
  preview: {
    port,
    host: "0.0.0.0",
    allowedHosts: true,
  },
});
