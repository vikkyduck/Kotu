import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error(
    "DATABASE_URL must be set. Did you forget to provision a database?",
  );
}

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// Простаивающее соединение может оборваться само (рестарт Postgres, сеть).
// pg сообщает об этом событием error на пуле, и без обработчика Node роняет
// процесс вместе с очередью задач. Пул сам выбросит мёртвый клиент и откроет
// новый при следующем запросе — достаточно записать причину.
pool.on("error", (err) => {
  console.error("Postgres: оборвалось простаивающее соединение пула, работаем дальше", err);
});
export const db = drizzle(pool, { schema });

export * from "./schema";
