import path from "node:path";
import { defineConfig } from "vitest/config";

/**
 * Отдельная настройка для тестов: vite.config.ts требует PORT — он про
 * запуск сервера разработки, а тестам сервер не нужен.
 */
export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "src") },
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
