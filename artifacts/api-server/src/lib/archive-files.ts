import { createHash, randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { link, lstat, mkdir, open, readdir, rename, rm, rmdir, type FileHandle } from "node:fs/promises";
import path from "node:path";
import type { Query } from "./archive-sql";

/**
 * Архив файлов — хранилище по содержимому: <archiveDir>/<sha[0:2]>/<sha>.
 *
 * Всё, что когда-либо лежало в каталогах данных (книги, аудио, картинки,
 * текстовые копии работ), получает здесь экземпляр, который не удаляется и не
 * переписывается. Удаление и замена файла в рабочем каталоге допустимы ТОЛЬКО
 * после того, как прежнее содержимое легло сюда (решение владелицы
 * 23.09.2026: стереть может только она сама, вручную).
 *
 * Экземпляр — жёсткая ссылка на тот же inode: место не занимает, а rm
 * оригинала его не трогает. Поэтому все перезаписи файлов данных обязаны идти
 * через временный файл и rename (writeFileAtomic): writeFile по тому же пути
 * писал бы в тот же inode и испортил бы архивную копию — и снимок деплоя.
 *
 * Внутри архива код ничего не удаляет и не перезаписывает: объект
 * публикуется через link (EEXIST — «уже есть»), а не rename поверх. Убирается
 * только временное имя после публикации — второе имя того же содержимого.
 * Брошенный временный файл (обрыв посреди копирования) остаётся лежать — с
 * префиксом TMP_PREFIX.
 */

/** Префикс временных файлов атомарной записи; сверка их не трогает. */
export const TMP_PREFIX = ".kotu-tmp-";

export interface FileMeta {
  /** upload | write | replace | remove | sweep — откуда пришёл экземпляр. */
  kind: string;
  entityType?: string | null;
  entityId?: number | null;
  originalName?: string | null;
  mime?: string | null;
}

export interface ArchivedFile {
  sha256: string;
  size: number;
  storedPath: string;
  /** true — на этом вызове в архиве появился новый экземпляр. */
  stored: boolean;
  /** inode заархивированного содержимого — чтобы rm удалил именно его. */
  dev: number;
  ino: number;
  /**
   * mtime в момент архивации: тот же inode мог переписаться на месте (другой
   * диск, где архив — копия, а не ссылка), и тогда rm удалил бы содержимое,
   * которого в архиве нет. Сверяем вместе с размером перед rm.
   */
  mtimeMs: number;
}

export class ArchiveUnavailableError extends Error {
  constructor(message = "Архив недоступен — ничего не удаляю") {
    super(message);
    this.name = "ArchiveUnavailableError";
  }
}

interface Log {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
}

const silent: Log = { info() {}, warn() {}, error() {} };

function tmpName(base: string): string {
  return `${TMP_PREFIX}${base}-${process.pid}-${randomBytes(6).toString("hex")}`;
}

/**
 * Запись файла данных без порчи прежнего inode: временный файл в том же
 * каталоге (тот же диск — rename атомарен) и rename поверх. Прежнее
 * содержимое остаётся жить в архиве и в снимках деплоя, если там на него
 * была жёсткая ссылка.
 */
export async function writeFileAtomic(filePath: string, data: string | Uint8Array): Promise<void> {
  const dir = path.dirname(filePath);
  await mkdir(dir, { recursive: true });
  const tmp = path.join(dir, tmpName(path.basename(filePath)));
  const fh = await open(tmp, "wx", 0o644);
  try {
    await fh.writeFile(data);
    await fh.sync();
  } catch (err) {
    await fh.close().catch(() => undefined);
    // Недописанный временный файл — не данные, а мусор этой же записи.
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
  await fh.close();
  try {
    await rename(tmp, filePath);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

/** Размер куска при чтении файла для хэша и копии. */
const CHUNK = 1 << 20;

/**
 * Хэш и копия — простым циклом fh.read по позиции, без потоков из FileHandle:
 * поток с autoClose:false держит ссылку на дескриптор, и fh.close() после
 * него не завершается никогда — архивация повисала бы навсегда.
 */
async function hashHandle(fh: FileHandle): Promise<string> {
  const hash = createHash("sha256");
  const buf = Buffer.allocUnsafe(CHUNK);
  for (let pos = 0; ; ) {
    const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
    if (bytesRead === 0) break;
    hash.update(buf.subarray(0, bytesRead));
    pos += bytesRead;
  }
  return hash.digest("hex");
}

/** Копия содержимого from → to с начала файла; дописанное до конца, с fsync. */
async function copyHandle(from: FileHandle, to: FileHandle): Promise<void> {
  const buf = Buffer.allocUnsafe(CHUNK);
  for (let pos = 0; ; ) {
    const { bytesRead } = await from.read(buf, 0, buf.length, pos);
    if (bytesRead === 0) break;
    // write может записать меньше, чем просили, — дописываем остаток.
    for (let off = 0; off < bytesRead; ) {
      const { bytesWritten } = await to.write(buf, off, bytesRead - off, pos + off);
      off += bytesWritten;
    }
    pos += bytesRead;
  }
  await to.sync();
}

async function lstatOrNull(p: string): Promise<Stats | null> {
  try {
    return await lstat(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function isInside(dir: string, candidate: string): boolean {
  const rel = path.relative(path.resolve(dir), path.resolve(candidate));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

export interface FileArchiveOptions {
  archiveDir: string;
  /** Каталоги данных: их обходит сверка, и только в них разрешён rm. */
  dataDirs: readonly string[];
  query: Query;
  /** Готов ли архив строк (таблицы archive.*). Без него ничего не удаляем. */
  ready: () => Promise<boolean>;
  log?: Log;
  /**
   * Жёсткая ссылка — подменяется в тестах, чтобы проверить запасной путь
   * (копию) без второго диска и без запретов ядра.
   */
  link?: typeof link;
  /**
   * Сверка не трогает файлы моложе этого: их, возможно, ещё дописывает
   * multer. Жёсткая ссылка на недописанный файл легла бы в архив под
   * хэшем обрывка.
   */
  minAgeMs?: number;
}

export function createFileArchive(opts: FileArchiveOptions) {
  const { archiveDir, dataDirs, query } = opts;
  const log = opts.log ?? silent;
  const minAgeMs = opts.minAgeMs ?? 2 * 60 * 1000;
  const hardLink = opts.link ?? link;

  const storedPathFor = (sha: string) => path.join(archiveDir, sha.slice(0, 2), sha);

  /**
   * Опубликовать временный файл под именем объекта. link, а не rename:
   * rename молча заменил бы уже лежащий объект, а архив свои объекты не
   * перезаписывает никогда — даже тем же содержимым (на прежнем inode
   * могут висеть снимки деплоя и бэкап). EEXIST — объект уже есть (его
   * положил параллельный вызов с тем же sha): это успех, не ошибка.
   * Временное имя после этого убираем: оно лишь второе имя того же
   * содержимого, которое теперь лежит под именем объекта (или уже лежало).
   * true — объект появился именно сейчас.
   */
  async function publish(tmp: string, target: string): Promise<boolean> {
    let created = true;
    try {
      await link(tmp, target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      created = false;
    }
    await rm(tmp, { force: true });
    return created;
  }

  /**
   * Кладёт в архив именно то содержимое, что захэшировано через fh.
   * Сначала жёсткая ссылка во временное имя и сверка inode: путь могли
   * подменить rename'ом, пока шёл хэш, и тогда ссылка указала бы на чужое
   * содержимое под нашим именем. Не вышло со ссылкой (другой диск, запрет
   * ядра) — копия из того же открытого файла.
   * true — объект появился на этом вызове; false — его уже положил другой.
   */
  async function store(filePath: string, fh: FileHandle, st: Stats, sha: string): Promise<boolean> {
    const dir = path.dirname(storedPathFor(sha));
    await mkdir(dir, { recursive: true });
    const target = storedPathFor(sha);

    const linkTmp = path.join(dir, tmpName(sha));
    try {
      await hardLink(filePath, linkTmp);
      const linked = await lstat(linkTmp);
      if (linked.ino === st.ino && linked.dev === st.dev) {
        return await publish(linkTmp, target);
      }
      // Путь уже указывает на другой файл. Ссылку не удаляем (в архиве
      // ничего не удаляется) — она остаётся временным файлом, а наше
      // содержимое копируем из открытого дескриптора.
      log.warn({ filePath, linkTmp }, "Файл подменили во время архивации — копирую содержимое");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "EXDEV" && code !== "EPERM" && code !== "EMLINK" && code !== "ENOTSUP" && code !== "ENOENT") {
        throw err;
      }
    }

    const copyTmp = path.join(dir, tmpName(sha));
    const out = await open(copyTmp, "wx", 0o600);
    try {
      await copyHandle(fh, out);
    } finally {
      await out.close();
    }
    return publish(copyTmp, target);
  }

  /**
   * Заархивировать файл, если он есть. null — файла нет (архивировать нечего).
   * Идемпотентно: одинаковое содержимое хранится один раз, а в file_events
   * пишется каждое событие — откуда и когда оно пришло.
   */
  async function archiveFile(filePath: string, meta: FileMeta): Promise<ArchivedFile | null> {
    let fh: FileHandle;
    try {
      // O_NOFOLLOW: симлинк в каталоге данных — не наш файл, в архив не идёт.
      fh = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
    try {
      const st = await fh.stat();
      if (!st.isFile()) throw new Error(`В архив идут только обычные файлы: ${filePath}`);
      const sha = await hashHandle(fh);
      const storedPath = storedPathFor(sha);
      let stored = false;
      if (!(await lstatOrNull(storedPath))) {
        stored = await store(filePath, fh, st, sha);
      }
      await query(
        `INSERT INTO archive.files (sha256, size, stored_path) VALUES ($1, $2, $3)
         ON CONFLICT (sha256) DO NOTHING`,
        [sha, st.size, storedPath],
      );
      await query(
        `INSERT INTO archive.file_events
           (sha256, source_path, kind, entity_type, entity_id, original_name, mime)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          sha,
          path.resolve(filePath),
          meta.kind,
          meta.entityType ?? null,
          meta.entityId ?? null,
          meta.originalName ?? null,
          meta.mime ?? null,
        ],
      );
      await query(
        `INSERT INTO archive.file_seen (path, size, mtime_ms, ino, sha256, seen_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (path) DO UPDATE SET size = EXCLUDED.size, mtime_ms = EXCLUDED.mtime_ms,
           ino = EXCLUDED.ino, sha256 = EXCLUDED.sha256, seen_at = now()`,
        [path.resolve(filePath), st.size, st.mtimeMs, String(st.ino), sha],
      );
      return {
        sha256: sha,
        size: st.size,
        storedPath,
        stored,
        dev: st.dev,
        ino: st.ino,
        mtimeMs: st.mtimeMs,
      };
    } finally {
      await fh.close();
    }
  }

  async function requireReady(): Promise<void> {
    if (!(await opts.ready())) throw new ArchiveUnavailableError();
  }

  /**
   * rm файла данных — только после архивации того самого содержимого.
   * Архивация не удалась — исключение, файл на месте. Между архивацией и rm
   * путь могли подменить: тогда архивируем заново, а не удаляем вслепую.
   */
  async function archiveAndRemove(
    filePath: string,
    meta: Omit<FileMeta, "kind"> & { kind?: string },
  ): Promise<ArchivedFile | null> {
    await requireReady();
    return removeArchived(filePath, meta, null);
  }

  /**
   * rm после архивации. already — итог архивации первым проходом
   * (archiveTreeAndRemove архивирует всё заранее): если файл тот же — inode,
   * устройство, размер и mtime совпадают, — второй раз не архивируем и
   * второго события в file_events не пишем. Хоть что-то разошлось (файл
   * подменили или дописали между проходами) — архивируем заново прямо перед
   * rm, как archiveAndRemove.
   */
  async function removeArchived(
    filePath: string,
    meta: Omit<FileMeta, "kind"> & { kind?: string },
    already: ArchivedFile | null,
  ): Promise<ArchivedFile | null> {
    let archived = already;
    for (let attempt = 0; attempt < 3; attempt++) {
      archived ??= await archiveFile(filePath, { ...meta, kind: meta.kind ?? "remove" });
      if (!archived) return null;
      const now = await lstatOrNull(filePath);
      if (!now) return archived;
      if (
        now.ino !== archived.ino ||
        now.dev !== archived.dev ||
        now.size !== archived.size ||
        now.mtimeMs !== archived.mtimeMs
      ) {
        // Путь подменили или файл изменили после архивации — новое
        // содержимое тоже в архив, и только потом rm.
        archived = null;
        continue;
      }
      if (!dataDirs.some((d) => isInside(d, filePath))) {
        // Путь из базы вне каталогов данных: заархивировали, но чужое не удаляем.
        log.warn({ filePath }, "Файл вне каталогов данных — в архиве, но на месте");
        return archived;
      }
      await rm(filePath, { force: true });
      return archived;
    }
    throw new Error(`Файл меняется быстрее, чем архивируется: ${filePath}`);
  }

  /** Все обычные файлы под dir (симлинки и временные файлы — мимо). */
  async function listFiles(dir: string): Promise<string[]> {
    const out: string[] = [];
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return out;
      throw err;
    }
    for (const e of entries) {
      if (e.name.startsWith(TMP_PREFIX)) continue;
      const full = path.join(dir, e.name);
      // Архив может оказаться внутри каталога данных (настройки окружения) —
      // обходить его самого бессмысленно.
      if (path.resolve(full) === path.resolve(archiveDir)) continue;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) out.push(...(await listFiles(full)));
      else if (e.isFile()) out.push(full);
    }
    return out;
  }

  /**
   * Каталог целиком (картинки удалённой колоды): сначала архивируем ВСЁ и
   * только потом удаляем — упади архивация на любом файле, не удалено ничего.
   * Каталоги убираем rmdir, только пустые: файл, дописанный в это время,
   * остаётся на месте, и его подберёт сверка.
   */
  async function archiveTreeAndRemove(
    dir: string,
    meta: Omit<FileMeta, "kind">,
  ): Promise<number> {
    await requireReady();
    const files = await listFiles(dir);
    const done: (ArchivedFile | null)[] = [];
    for (const f of files) done.push(await archiveFile(f, { ...meta, kind: "remove" }));
    for (const [i, f] of files.entries()) {
      // Файл исчез между проходами — архивировать и удалять нечего.
      if (!done[i]) continue;
      await removeArchived(f, { ...meta, kind: "remove" }, done[i]!);
    }
    const dirs: string[] = [];
    const collect = async (d: string) => {
      const entries = await readdir(d, { withFileTypes: true }).catch(() => []);
      for (const e of entries) if (e.isDirectory()) await collect(path.join(d, e.name));
      dirs.push(d);
    };
    await collect(dir);
    for (const d of dirs) {
      if (!dataDirs.some((root) => isInside(root, d))) continue;
      await rmdir(d).catch(() => undefined);
    }
    return files.length;
  }

  /**
   * Записать файл данных: прежняя версия — сначала в архив (без архива не
   * перезаписываем), новая — атомарно и тоже в архив. Архивация новой версии
   * не удалась — запись остаётся, её подберёт сверка.
   */
  async function writeDataFile(
    filePath: string,
    data: string | Uint8Array,
    meta: Omit<FileMeta, "kind">,
  ): Promise<void> {
    if (await lstatOrNull(filePath)) {
      await requireReady();
      await archiveFile(filePath, { ...meta, kind: "replace" });
    }
    await writeFileAtomic(filePath, data);
    await archiveFile(filePath, { ...meta, kind: "write" }).catch((err) =>
      log.error({ err, filePath }, "Не смог заархивировать записанный файл — догонит сверка"),
    );
  }

  /**
   * Сверка: всё, что лежит в каталогах данных и ещё не в архиве, — в архив.
   * Первичная загрузка существующих файлов и страховка на случай, если
   * какое-то место в коде пишет мимо archiveFile. Чтобы не хэшировать весь
   * диск каждый раз, узнаём уже виденное по пути, размеру, mtime и inode.
   */
  async function sweep(): Promise<{ scanned: number; archived: number; failed: number }> {
    let scanned = 0;
    let archived = 0;
    let failed = 0;
    for (const root of dataDirs) {
      for (const f of await listFiles(root)) {
        scanned += 1;
        try {
          const st = await lstatOrNull(f);
          if (!st || !st.isFile()) continue;
          // 0 — без порога: mtime с наносекундами бывает «впереди» Date.now().
          if (minAgeMs > 0 && Date.now() - st.mtimeMs < minAgeMs) continue;
          const { rows } = await query(
            `SELECT size, mtime_ms, ino, sha256 FROM archive.file_seen WHERE path = $1`,
            [path.resolve(f)],
          );
          const seen = rows[0];
          if (
            seen &&
            Number(seen["size"]) === st.size &&
            Number(seen["mtime_ms"]) === st.mtimeMs &&
            String(seen["ino"]) === String(st.ino) &&
            (await lstatOrNull(storedPathFor(String(seen["sha256"]))))
          ) {
            continue;
          }
          await archiveFile(f, { kind: "sweep" });
          archived += 1;
        } catch (err) {
          failed += 1;
          log.error({ err, file: f }, "Сверка архива: файл не заархивирован");
        }
      }
    }
    return { scanned, archived, failed };
  }

  return { archiveFile, archiveAndRemove, archiveTreeAndRemove, writeDataFile, sweep, storedPathFor };
}

export type FileArchive = ReturnType<typeof createFileArchive>;
