import path from "node:path";

/**
 * Аудио сеанса лежит в UPLOAD_DIR до успешной расшифровки или до удаления
 * записи владелицей. Автоматической чистки по сроку НЕТ намеренно: решение
 * владелицы (2026-09-23) — всё загруженное на платформу сохраняется, пока она
 * сама его не удалит.
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
