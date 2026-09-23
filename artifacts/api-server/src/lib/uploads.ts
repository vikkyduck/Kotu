import path from "node:path";

/**
 * Аудио сеанса лежит в UPLOAD_DIR, пока владелица не удалит запись, — и после
 * успешной расшифровки тоже. Автоматической чистки НЕТ намеренно: решение
 * владелицы (2026-09-23) — всё загруженное на платформу сохраняется, а
 * удалённое ею уходит в архив файлов (lib/archive-files.ts).
 */

/**
 * Абсолютный путь, если он лежит строго внутри каталога, иначе null. Путь из
 * payload приходит из базы — перед rm его нельзя принимать на веру: «../» или
 * чужой абсолютный путь не должны дотянуться до файлов вне загрузок.
 */
export function resolveInsideDir(dir: string, candidate: unknown): string | null {
  if (typeof candidate !== "string" || candidate === "") return null;
  const base = path.resolve(dir);
  const full = path.resolve(base, candidate);
  const rel = path.relative(base, full);
  if (rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    return null;
  }
  return full;
}
