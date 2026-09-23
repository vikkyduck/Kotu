import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Где на диске лежат файлы приложения — ОДНО место на весь сервер.
 *
 * Раньше каждое из этих выражений было продублировано в трёх файлах: один
 * кусок кода писал картинку, другой её отдавал, третий подчищал каталоги.
 * Разъехаться им было проще, чем совпасть, а поломка выглядела бы как
 * «картинки пропали» — без единой ошибки в логах.
 *
 * В базе лежат только тексты и ссылки; сами книги, аудио и картинки — здесь.
 * Поэтому эти каталоги входят в ночной бэкап (ops/kotu-backup.sh).
 */

/**
 * Книги, статьи и текстовые копии работ — то, по чему идёт поиск. В
 * разработке — свой подкаталог tmp, а не сам tmp: сверка архива обходит
 * каталоги данных целиком и иначе утащила бы в архив всё содержимое /tmp.
 */
export const LIBRARY_DIR =
  process.env["LIBRARY_DIR"] ??
  (process.env["NODE_ENV"] === "production"
    ? "/opt/kotu/library"
    : path.join(tmpdir(), "kotu-library"));

/** Картинки презентаций: по каталогу на колоду, внутри — файлы попыток. */
export const DECKS_DIR =
  process.env["DECKS_DIR"] ??
  (process.env["NODE_ENV"] === "production"
    ? "/opt/kotu/decks"
    : path.join(tmpdir(), "kotu-decks"));

/**
 * Загруженное аудио записей — зона А, сервер не покидает. Имя переменной
 * окружения историческое (UPLOAD_DIR, без «s») — оно уже описано
 * в .env.example, менять его значило бы сломать существующие установки.
 */
export const UPLOAD_DIR =
  process.env["UPLOAD_DIR"] ??
  (process.env["NODE_ENV"] === "production"
    ? "/opt/kotu/uploads"
    : path.join(tmpdir(), "kotu-uploads"));

/**
 * Архив файлов: всё, что когда-либо лежало в трёх каталогах выше, по одному
 * экземпляру на содержимое (имя — sha256). Только пополняется: решение
 * владелицы 23.09.2026 — ничего загруженного не стирается, кроме как ею самой
 * вручную. Подробности — lib/archive-files.ts.
 */
export const ARCHIVE_DIR =
  process.env["ARCHIVE_DIR"] ??
  (process.env["NODE_ENV"] === "production"
    ? "/opt/kotu/archive"
    : path.join(tmpdir(), "kotu-archive"));

/**
 * Каталоги, чьё содержимое уходит в архив файлов. Новый каталог данных (как и
 * ARCHIVE_DIR) дописать ещё в скрипты: deploy.sh — оба цикла по каталогам и
 * число строк в проверке описи; ops/kotu-backup.sh — цикл шага 1 и --include
 * шага 2; ops/pull-backup.sh — MIRRORS. Иначе он молча не попадёт в бэкап.
 */
export const DATA_DIRS = [LIBRARY_DIR, UPLOAD_DIR, DECKS_DIR] as const;

// Каталоги создаём здесь же, один раз на запуск: раньше каждый файл делал
// это сам, и появление каталога зависело от того, кто первым загрузится.
for (const dir of [LIBRARY_DIR, DECKS_DIR, UPLOAD_DIR, ARCHIVE_DIR]) {
  mkdirSync(dir, { recursive: true });
}
