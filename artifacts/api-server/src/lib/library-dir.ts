import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";

/**
 * Каталог библиотеки — один на всё приложение. Раньше это выражение
 * дублировалось в трёх местах, и разъехаться им было проще, чем совпасть.
 */
export const LIBRARY_DIR =
  process.env["LIBRARY_DIR"] ??
  (process.env["NODE_ENV"] === "production" ? "/opt/kotu/library" : tmpdir());
mkdirSync(LIBRARY_DIR, { recursive: true });
