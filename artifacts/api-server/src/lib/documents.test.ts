import { test, describe, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";
import JSZip from "jszip";
import { Document, Packer, Paragraph } from "docx";
import { chunkText, extractPdf, extractText, joinChunks } from "./documents";

/**
 * Разбор загружаемых в библиотеку файлов.
 *
 * PDF в проде не разбирался ни разу: код звал pdf-parse по пути из версии 1.x,
 * а стояла 2.x. Поэтому PDF здесь настоящий — собирается pdfkit с кириллическим
 * шрифтом на две страницы, как типичная глава книги. Бинарники в репозиторий
 * не кладём: файл рождается в тесте.
 */

const FONT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../assets/fonts/Manrope-Regular.ttf",
);

const PAGE_ONE = "Работа горя требует времени";
const PAGE_TWO = "Навязчивое повторение вытесненного";

function makePdf(): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4" });
    const parts: Buffer[] = [];
    doc.on("data", (b: Buffer) => parts.push(b));
    doc.on("end", () => resolve(Buffer.concat(parts)));
    doc.on("error", reject);
    doc.font(FONT).fontSize(14).text(PAGE_ONE);
    doc.addPage().font(FONT).fontSize(14).text(PAGE_TWO);
    doc.end();
  });
}

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "kotu-documents-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("PDF", () => {
  test("текст с обеих страниц и число страниц", async () => {
    const result = await extractPdf(await makePdf());
    expect(result.pages).toBe(2);
    expect(result.text).toContain(PAGE_ONE);
    expect(result.text).toContain(PAGE_TWO);
    // Служебный разделитель pdf-parse v2 («-- 1 of 2 --») в текст попадать не должен.
    expect(result.text).not.toMatch(/--\s*\d+\s+of\s+\d+\s*--/);
  });

  test("через extractText по файлу, как при загрузке", async () => {
    const file = path.join(dir, "book.pdf");
    await writeFile(file, await makePdf());
    const result = await extractText(file, "application/pdf", "Книга.PDF");
    expect(result.pages).toBe(2);
    expect(result.text).toContain(PAGE_TWO);
  });

  test("битый файл — ошибка, а не зависание", async () => {
    await expect(extractPdf(Buffer.from("это не pdf"))).rejects.toThrow();
  });
});

describe("остальные форматы не задеты", () => {
  test("DOCX", async () => {
    const doc = new Document({
      sections: [{ children: [new Paragraph("Перенос в анализе")] }],
    });
    const file = path.join(dir, "note.docx");
    await writeFile(file, await Packer.toBuffer(doc));
    const result = await extractText(file, "", "note.docx");
    expect(result.text).toBe("Перенос в анализе");
  });

  test("EPUB: главы по номерам, ch2 раньше ch10", async () => {
    const zip = new JSZip();
    zip.file("OEBPS/ch10.xhtml", "<html><body><p>Десятая глава</p></body></html>");
    zip.file("OEBPS/ch1.xhtml", "<html><body><p>Первая глава</p></body></html>");
    zip.file("OEBPS/ch2.xhtml", "<html><body><p>Вторая&nbsp;глава</p></body></html>");
    const file = path.join(dir, "book.epub");
    await writeFile(file, await zip.generateAsync({ type: "nodebuffer" }));
    const result = await extractText(file, "application/epub+zip", "book.epub");
    expect(result.text).toMatch(/^Первая глава\s+Вторая глава\s+Десятая глава$/);
  });

  test("TXT", async () => {
    const file = path.join(dir, "note.txt");
    await writeFile(file, "Строка\r\nвторая   строка\n\n\n\nконец");
    const result = await extractText(file, "text/plain", "note.txt");
    expect(result).toEqual({ text: "Строка\nвторая строка\n\nконец" });
  });
});

describe("фрагменты обратно в текст", () => {
  test("joinChunks(chunkText(t)) — исходный текст без повторов нахлёста", () => {
    const para = (n: number): string =>
      Array.from({ length: 4 + (n % 5) }, (_, i) => `Абзац ${n}, мысль ${i}: перенос и сопротивление в работе.`).join(" ");
    const text = [
      ...Array.from({ length: 12 }, (_, n) => para(n)),
      "Глава 2",
      ...Array.from({ length: 12 }, (_, n) => para(n + 100)),
    ].join("\n\n");
    const chunks = chunkText(text);
    const squash = (s: string): string => s.replace(/\s+/g, " ").trim();
    // Простая склейка повторяет нахлёст — иначе тест ничего не проверяет.
    expect(squash(chunks.map((c) => c.text).join("\n\n"))).not.toBe(squash(text));
    expect(squash(joinChunks(chunks))).toBe(squash(text));
  });
});
