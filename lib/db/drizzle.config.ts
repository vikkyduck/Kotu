import { defineConfig } from "drizzle-kit";
import path from "path";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL, ensure the database is provisioned");
}

export default defineConfig({
  schema: path.join(__dirname, "./src/schema/index.ts"),
  dialect: "postgresql",
  // Только public: рядом живёт схема archive (архив прежних версий, её
  // ставит сам сервер — artifacts/api-server/src/lib/archive-sql.ts). push
  // не должен ни видеть её, ни предлагать удалить.
  schemaFilter: ["public"],
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});
