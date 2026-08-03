import {
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun,
  AlignmentType,
} from "docx";
import type { Lecture, LectureSection, LectureSource, Bibliography } from "@workspace/db";

/**
 * Выгрузка лекции: Markdown и Word.
 *
 * Word здесь не прихоть — им пользуются кафедры и оргкомитеты; .docx к тому же
 * открывается Google Документами после загрузки на Диск, так лекция попадает
 * и туда. Оба формата собираются из одних данных, чтобы не разъезжались.
 */

export interface LectureFull extends Lecture {
  sections: LectureSection[];
  sources: LectureSource[];
}

/** Хвост из литературы есть в обоих форматах — собираем один раз. */
function bibliographyBlocks(bib: Bibliography | null): { level: string; items: string[] }[] {
  if (!bib) return [];
  const blocks: { level: string; items: string[] }[] = [];
  if (bib.primary.length > 0) blocks.push({ level: "Первоисточники", items: bib.primary });
  if (bib.modern.length > 0)
    blocks.push({ level: "Современные работы для углубления", items: bib.modern });
  return blocks;
}

export function buildLectureMarkdown(full: LectureFull): string {
  const parts: string[] = [`# ${full.title}`, ""];
  for (const section of full.sections) {
    parts.push(`## ${section.heading}`, "", section.text || "_глава ещё не написана_", "");
    const used = full.sources.filter((s) => s.sectionId === section.id);
    if (used.length > 0) {
      parts.push("**Источники:**", "");
      used.forEach((s, i) => parts.push(`${i + 1}. ${s.title}${s.url ? ` — ${s.url}` : ""}`));
      parts.push("");
    }
  }
  for (const block of bibliographyBlocks(full.bibliography)) {
    parts.push(`## Литература: ${block.level.toLowerCase()}`, "");
    block.items.forEach((b, i) => parts.push(`${i + 1}. ${b}`));
    parts.push("");
  }
  return parts.join("\n");
}

export async function buildLectureDocx(full: LectureFull): Promise<Buffer> {
  const children: Paragraph[] = [
    new Paragraph({
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.LEFT,
      children: [new TextRun({ text: full.title })],
    }),
  ];

  for (const section of full.sections) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 360, after: 160 },
        children: [new TextRun({ text: `${section.ord + 1}. ${section.heading}` })],
      }),
    );

    const text = section.text || "Глава ещё не написана.";
    for (const para of text.split(/\n{2,}/)) {
      const clean = para.trim();
      if (clean === "") continue;
      children.push(
        new Paragraph({
          spacing: { after: 140, line: 320 },
          children: [new TextRun({ text: clean.replace(/\n/g, " ") })],
        }),
      );
    }

    const used = full.sources.filter((s) => s.sectionId === section.id);
    if (used.length > 0) {
      children.push(
        new Paragraph({
          spacing: { before: 120, after: 60 },
          children: [new TextRun({ text: "Источники:", bold: true })],
        }),
      );
      used.forEach((s, i) =>
        children.push(
          new Paragraph({
            spacing: { after: 40 },
            children: [new TextRun({ text: `${i + 1}. ${s.title}${s.url ? ` — ${s.url}` : ""}` })],
          }),
        ),
      );
    }
  }

  for (const block of bibliographyBlocks(full.bibliography)) {
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 360, after: 160 },
        children: [new TextRun({ text: `Литература: ${block.level.toLowerCase()}` })],
      }),
    );
    block.items.forEach((b, i) =>
      children.push(
        new Paragraph({
          spacing: { after: 60 },
          children: [new TextRun({ text: `${i + 1}. ${b}` })],
        }),
      ),
    );
  }

  const doc = new Document({
    styles: {
      default: {
        document: { run: { font: "Calibri", size: 24 } }, // 12pt: читаемо и привычно Word
      },
    },
    sections: [{ children }],
  });

  return Packer.toBuffer(doc);
}
