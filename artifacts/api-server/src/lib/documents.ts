import { readFile } from "node:fs/promises";
import mammoth from "mammoth";
import JSZip from "jszip";

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

let pdfParseModule: Promise<typeof import("pdf-parse")> | undefined;

/**
 * pdf-parse v2 грузим лениво, но строкой-литералом: esbuild всё равно кладёт
 * его в бандл (на сервере node_modules нет), а исполняется он только при
 * первом PDF. Лениво — из-за pdfjs внутри: при загрузке модуля он делает
 * `new DOMMatrix()`, а DOMMatrix в Node берётся из нативного @napi-rs/canvas,
 * которого на сервере нет. Статический импорт ронял бы весь сервер на старте.
 * Для извлечения текста DOMMatrix не нужен (он для отрисовки страниц), поэтому
 * на время загрузки подставляем пустышку и сразу убираем, чтобы не выдавать
 * её остальному коду за настоящий DOMMatrix.
 *
 * НЕ делать импорт статическим: в vitest на Mac canvas установлен, и тесты это
 * не поймают — упадёт только прод. После обновления pdf-parse/pdfjs-dist
 * прогнать `pnpm --filter @workspace/api-server run smoke:pdf`.
 */
function loadPdfParse(): Promise<typeof import("pdf-parse")> {
  pdfParseModule ??= (async () => {
    const g = globalThis as { DOMMatrix?: unknown };
    const stub = g.DOMMatrix === undefined;
    if (stub) g.DOMMatrix = class {};
    try {
      return await import("pdf-parse");
    } finally {
      if (stub) delete g.DOMMatrix;
    }
  })();
  // Провал загрузки запоминается намеренно: повтор его не лечит (и ESM, и
  // обёртка esbuild кэшируют упавший модуль — второй заход дал бы невнятное
  // «PDFParse is not a constructor»), а так каждый PDF получает исходную
  // ошибку. Лечится только рестартом процесса.
  return pdfParseModule;
}

/**
 * Текст PDF через pdf-parse v2 (обёртка над pdfjs). В Node pdfjs работает без
 * настоящего воркера: подгружает pdf.worker.mjs динамическим import рядом с
 * собой, поэтому build.mjs кладёт этот файл в dist рядом с бандлом.
 */
export async function extractPdf(data: Uint8Array): Promise<ExtractedDoc> {
  const { PDFParse } = await loadPdfParse();
  const parser = new PDFParse({ data });
  try {
    // Без pageJoiner v2 вставляет между страницами «-- 1 of 12 --», а это
    // мусор во фрагментах и цитатах; страницы разделяем пустой строкой, как v1.
    const result = await parser.getText({ pageJoiner: "" });
    return { text: normalize(result.text), pages: result.total };
  } finally {
    // Документ pdfjs держит память и фейковый воркер — освобождаем даже при ошибке.
    await parser.destroy();
  }
}

/** Достаёт текст из файла. Формат определяется по расширению и mime. */
export async function extractText(
  path: string,
  mime: string,
  filename: string,
): Promise<ExtractedDoc> {
  const ext = (filename.match(/\.([^.]+)$/)?.[1] ?? "").toLowerCase();

  if (ext === "pdf" || mime === "application/pdf") {
    return extractPdf(await readFile(path));
  }

  if (ext === "docx" || mime.includes("wordprocessingml")) {
    const { value } = await mammoth.extractRawText({ path });
    return { text: normalize(value) };
  }

  if (ext === "epub" || mime === "application/epub+zip") {
    const zip = await JSZip.loadAsync(await readFile(path));
    const parts: string[] = [];
    // Внутри epub — обычные xhtml-файлы. Порядок глав берём по имени с
    // числовым сравнением: ch2 раньше ch10 и без ведущих нулей.
    const names = Object.keys(zip.files)
      .filter((n) => /\.x?html?$/i.test(n))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
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
