import path from "node:path";
import { attachmentHeader } from "../../lib/filename";

/**
 * Расширение по типу, присланному при загрузке. Нужно книгам, у которых в
 * задаче разбора не осталось имени файла: с 31.07 по 23.09.2026 очередь
 * стирала payload выполненных задач.
 */
const EXT_BY_MIME: Record<string, string> = {
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/markdown": "md",
  "text/html": "html",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/epub+zip": "epub",
};

/**
 * Во вкладке открываются только PDF и простой текст — с типом, заданным здесь,
 * а не присланным при загрузке. Остальное скачивается: сохранённая из
 * интернета HTML-страница, открытая inline, запустила бы чужие скрипты на
 * домене приложения — с доступом ко всей библиотеке через cookie владелицы.
 */
const INLINE_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  txt: "text/plain; charset=utf-8",
  md: "text/plain; charset=utf-8",
  markdown: "text/plain; charset=utf-8",
};

/** Заголовки для отдачи загруженного файла: во вкладку или скачать под названием книги. */
export function documentFileHeaders(
  doc: { title: string; mime: string },
  filename: unknown,
): Record<string, string> {
  const fromName = typeof filename === "string" ? path.extname(filename).slice(1).toLowerCase() : "";
  const ext = fromName || EXT_BY_MIME[doc.mime.split(";")[0]!.trim().toLowerCase()] || "";
  const inlineType = INLINE_TYPES[ext];
  const disposition = attachmentHeader(doc.title, ext, "документ");
  return {
    "Content-Type": inlineType ?? "application/octet-stream",
    "Content-Disposition": inlineType ? disposition.replace(/^attachment/, "inline") : disposition,
    "X-Content-Type-Options": "nosniff",
  };
}
