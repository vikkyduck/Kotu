import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import mammoth from "mammoth";
import JSZip from "jszip";

const require = createRequire(import.meta.url);

export interface ExtractedDoc {
  text: string;
  pages?: number;
}

export interface Chunk {
  ord: number;
  text: string;
  heading?: string;
  page?: number;
}

/** Целевой размер фрагмента: осмысленный кусок, но цитата остаётся точной. */
const CHUNK_CHARS = 1000;
/** Нахлёст: мысль на границе фрагментов не должна теряться. */
const OVERLAP_CHARS = 150;

function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li)>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCharCode(Number(code)));
}

function normalize(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    // Переносы слов по слогам в конце строки — частая беда PDF.
    .replace(/(\p{Ll})-\n(\p{Ll})/gu, "$1$2")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Достаёт текст из файла. Формат определяется по расширению и mime. */
export async function extractText(
  path: string,
  mime: string,
  filename: string,
): Promise<ExtractedDoc> {
  const ext = (filename.match(/\.([^.]+)$/)?.[1] ?? "").toLowerCase();

  if (ext === "pdf" || mime === "application/pdf") {
    // Импорт именно из lib/: корневой index у pdf-parse при загрузке лезет
    // читать собственный тестовый файл и падает в собранном бандле.
    const pdfParse = require("pdf-parse/lib/pdf-parse.js") as (
      b: Buffer,
    ) => Promise<{ text: string; numpages: number }>;
    const data = await pdfParse(await readFile(path));
    return { text: normalize(data.text), pages: data.numpages };
  }

  if (ext === "docx" || mime.includes("wordprocessingml")) {
    const { value } = await mammoth.extractRawText({ path });
    return { text: normalize(value) };
  }

  if (ext === "epub" || mime === "application/epub+zip") {
    const zip = await JSZip.loadAsync(await readFile(path));
    const parts: string[] = [];
    // Внутри epub — обычные xhtml-файлы; порядок по имени достаточно близок
    // к порядку глав, чтобы текст не перемешался.
    const names = Object.keys(zip.files)
      .filter((n) => /\.x?html?$/i.test(n))
      .sort();
    for (const name of names) {
      const raw = await zip.files[name].async("string");
      parts.push(stripHtml(raw));
    }
    return { text: normalize(parts.join("\n\n")) };
  }

  if (ext === "html" || ext === "htm") {
    return { text: normalize(stripHtml(await readFile(path, "utf8"))) };
  }

  // txt, md и всё прочее текстовое
  return { text: normalize(await readFile(path, "utf8")) };
}

/** Похоже ли на заголовок: короткая строка без точки в конце. */
function looksLikeHeading(line: string): boolean {
  const t = line.trim();
  if (t.length < 3 || t.length > 90) return false;
  if (/[.!?;:,]$/.test(t)) return false;
  return /^(глава|часть|раздел|лекция|§|\d+[.)]\s)/i.test(t) || t === t.toUpperCase();
}

/**
 * Режет текст на фрагменты по абзацам, с нахлёстом и запоминанием последнего
 * заголовка — чтобы в цитате было видно, откуда она.
 */
export function chunkText(text: string): Chunk[] {
  const paragraphs = text.split(/\n\s*\n/);
  const chunks: Chunk[] = [];
  let buffer = "";
  let heading: string | undefined;
  let ord = 0;

  const flush = (): void => {
    const body = buffer.trim();
    if (body.length === 0) return;
    chunks.push({ ord: ord++, text: body, heading });
    // Хвост предыдущего фрагмента переносим в начало следующего.
    buffer = body.length > OVERLAP_CHARS ? body.slice(-OVERLAP_CHARS) : "";
  };

  for (const para of paragraphs) {
    const p = para.trim();
    if (p === "") continue;

    const firstLine = p.split("\n")[0];
    if (looksLikeHeading(firstLine)) {
      flush();
      heading = firstLine.trim();
      buffer = "";
    }

    if (buffer.length + p.length > CHUNK_CHARS) flush();
    buffer += (buffer ? "\n\n" : "") + p;
  }

  const tail = buffer.trim();
  if (tail.length > OVERLAP_CHARS / 2) chunks.push({ ord: ord++, text: tail, heading });

  return chunks;
}
