import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import PDFDocument from "pdfkit";
import type {
  Deck,
  DeckSlide,
  DeckImage,
  StylePack,
  SlideLayout,
  SlideContent,
  DiagramSpec,
} from "@workspace/db";
import {
  SLIDE_SPEC,
  SLIDE_TYPE as T,
  SLIDE_LEADING as L,
  SHEET,
  SLIDE_TEXT as TEXT,
  SLIDE_SEAM as SEAM,
  MAX_CARDS,
  slideColor,
  type BrandColor,
} from "@workspace/db/slides";
import { logger } from "./logger";

/**
 * PDF-раздатка по утверждённой колоде. Макеты повторяют lib/pptx.ts —
 * раздел 9 брендбука Psy3107 «Архивный сон»: та же композиция, те же цвета.
 * Отличия от PPTX осознанные: notes не включаем (раздатка — то, что видят,
 * а не то, что говорят), шрифты зашиты в файл — PDF не может рассчитывать
 * на шрифты машины читателя, поэтому TTF едут внутри документа.
 */

/** Дюйм PPTX → пункт PDF: страница 960×540 pt = 13.333×7.5 in при 72 dpi. */
const IN = 72;
const PAGE_W = SHEET.width;
const PAGE_H = SHEET.height;
/** Музейное поле по краям — то же число, что в pptx: общая таблица. */
const MARGIN = SLIDE_SPEC.margin;

/**
 * Имена шрифтов, под которыми TTF регистрируются в документе. Пакет может
 * называть гарнитуры как угодно, но физически в раздатку встраиваются ровно
 * эти три файла — других на сервере нет.
 */
const FONT = {
  display: "Manrope-ExtraBold.ttf",
  body: "Manrope-Regular.ttf",
  medium: "Manrope-Medium.ttf",
} as const;

type FontName = keyof typeof FONT;

/**
 * Где лежат TTF. В проде рядом с бандлом: build.mjs копирует assets/fonts
 * в dist/fonts, а import.meta.url бандла указывает на dist/index.mjs.
 * В dev код исполняется из src/lib — тогда шрифты в ../../assets/fonts.
 */
function resolveFontsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const bundled = path.join(here, "fonts");
  if (existsSync(bundled)) return bundled;
  return path.resolve(here, "../../assets/fonts");
}

function fontPath(dir: string, name: FontName): string {
  const file = path.join(dir, FONT[name]);
  if (!existsSync(file)) {
    // Понятная ошибка вместо загадочного падения fontkit где-то в глубине.
    throw new Error(
      `Шрифт для PDF не найден: ${file}. ` +
        "Проверьте artifacts/api-server/assets/fonts и копирование dist/fonts в build.mjs",
    );
  }
  return file;
}

interface Style {
  color: (name: BrandColor) => string;
}

function makeStyle(pack: StylePack | null): Style {
  return { color: (name) => slideColor(pack?.palette, name) };
}

// ── Текстовые примитивы ─────────────────────────────────────────────────
// pdfkit — императивный курсор, а не текстовые рамки, как pptxgenjs.
// Раны собираем сами: измеряем каждый, считаем общую высоту, valign руками.

interface Run {
  text: string;
  font: FontName;
  size: number;
  color: string;
  /** 1 по умолчанию; в pptx это transparency 25/40 у подписей. */
  opacity?: number;
  charSpacing?: number;
  /** Аналог lineSpacingMultiple из pptx: 1.05 → межстрочный +5%. */
  lineMult?: number;
  /** Аналог paraSpaceAfter, pt. */
  spaceAfter?: number;
  align?: "left" | "center";
}

/** lineSpacingMultiple → lineGap: pdfkit добавляет зазор в пунктах. */
function lineGap(run: Run): number {
  return run.size * ((run.lineMult ?? 1) - 1);
}

function runHeight(doc: PDFKit.PDFDocument, run: Run, width: number): number {
  doc.font(run.font).fontSize(run.size);
  return doc.heightOfString(run.text, {
    width,
    lineGap: lineGap(run),
    characterSpacing: run.charSpacing,
  });
}

/**
 * Нарисовать стопку ранов в «рамке» x/y/w/h. height у каждого text —
 * обязательный потолок: без него pdfkit молча создаёт новую страницу,
 * и раздатка разъезжается.
 */
function drawRuns(
  doc: PDFKit.PDFDocument,
  runs: Run[],
  x: number,
  y: number,
  w: number,
  h: number,
  valign: "top" | "middle" = "top",
): void {
  const usable = runs.filter((r) => r.text !== "");
  if (usable.length === 0) return;

  let total = 0;
  usable.forEach((r, i) => {
    total += runHeight(doc, r, w);
    if (i < usable.length - 1) total += r.spaceAfter ?? 0;
  });

  let cy = valign === "middle" ? y + Math.max(0, (h - total) / 2) : y;
  for (const r of usable) {
    const room = Math.max(0, Math.min(y + h, PAGE_H) - cy);
    if (room <= 0) break; // как в pptx: лишнее тихо не помещается, страниц не плодим
    doc
      .font(r.font)
      .fontSize(r.size)
      .fillColor(r.color, r.opacity ?? 1)
      .text(r.text, x, cy, {
        width: w,
        height: room,
        lineGap: lineGap(r),
        characterSpacing: r.charSpacing,
        align: r.align ?? "left",
      });
    cy += runHeight(doc, r, w) + (r.spaceAfter ?? 0);
  }
}

/**
 * Пункты с ромбом «◊ » — маркер серии, набранный той же гарнитурой, что и
 * текст: ромба U+25C7 в Manrope нет, зато есть лозенг U+25CA — та же фигура.
 * Текст идёт с висячим отступом, как положено списку.
 */
function drawBullets(
  doc: PDFKit.PDFDocument,
  bullets: string[],
  x: number,
  y: number,
  w: number,
  h: number,
  size: number,
  color: string,
): void {
  const indent = size * 1.3;
  const mult = L.bullets;
  let cy = y;
  for (const b of bullets) {
    const room = Math.max(0, Math.min(y + h, PAGE_H) - cy);
    if (room <= 0) break;
    doc.font("display").fontSize(size).fillColor(color, 1).text("◊", x, cy, {
      width: indent,
      height: room,
      lineBreak: false,
    });
    doc
      .font("body")
      .fontSize(size)
      .fillColor(color, 1)
      .text(b, x + indent, cy, { width: w - indent, height: room, lineGap: size * (mult - 1) });
    const bh = doc.heightOfString(b, { width: w - indent, lineGap: size * (mult - 1) });
    cy += bh + 10; // paraSpaceAfter 10 — как в pptx
  }
}

// ── Картинки ────────────────────────────────────────────────────────────

/**
 * Гравюра «cover» в заданной рамке. pdfkit масштабирует cover без обрезки,
 * поэтому кадрируем клипом сами. Битый файл не валит экспорт — слайд уходит
 * текстовой пластиной.
 */
function drawImageCover(
  doc: PDFKit.PDFDocument,
  file: string,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  doc.save();
  try {
    doc.rect(x, y, w, h).clip();
    doc.image(file, x, y, { cover: [w, h], align: "center", valign: "center" });
  } catch {
    // повреждённый или неожиданный формат — пропускаем молча
  } finally {
    doc.restore();
  }
}

/** Полноростовая гравюра у края листа — как addPlateImage в pptx. */
function drawPlateImage(doc: PDFKit.PDFDocument, file: string, x: number, w: number): void {
  drawImageCover(doc, file, x, 0, w, PAGE_H);
}

/**
 * Путь к картинке слайда. Отличие от pptx: webp pdfkit не умеет —
 * по контракту такую картинку пропускаем молча, слайд идёт без образа.
 */
function imagePath(s: DeckSlide, imagesById: Map<number, DeckImage>): string | null {
  if (!s.imageId) return null;
  const img = imagesById.get(s.imageId);
  if (!img?.path || !existsSync(img.path)) return null;
  if (!/\.(jpe?g|png)$/i.test(img.path)) {
    // Не тихо: без лога пропавший на раздатке образ выглядит багом рисования,
    // хотя картинка есть и цела — просто в формате, который pdfkit не встраивает.
    logger.warn({ slideId: s.id, path: img.path }, "PDF: пропускаю образ — формат не jpg/png");
    return null;
  }
  return img.path;
}

/** Арабский folio внизу листа — на обложке и финале, как в pptx. */
function drawFolio(doc: PDFKit.PDFDocument, idx: number): void {
  doc
    .font("body")
    .fontSize(T.folio)
    .fillColor(TEXT, 1)
    .text(String(idx + 1).padStart(2, "0"), MARGIN, PAGE_H - 0.6 * IN, {
      characterSpacing: 2,
      lineBreak: false,
    });
}

function fillBackground(doc: PDFKit.PDFDocument, color: string): void {
  doc.rect(0, 0, PAGE_W, PAGE_H).fill(color);
}

// ── Макеты (координаты = pptx.ts × 72) ──────────────────────────────────

function addCover(doc: PDFKit.PDFDocument, c: SlideContent, img: string | null, st: Style, idx: number): void {
  fillBackground(doc, st.color("archiveBlack"));

  // Брендбук: текст слева 42%, образ справа 58%.
  const imgW = PAGE_W * SLIDE_SPEC.imageShare.cover;
  if (img) drawPlateImage(doc, img, PAGE_W - imgW, imgW);
  const textW = img ? PAGE_W - imgW - MARGIN - 0.35 * IN : PAGE_W - MARGIN * 2;

  if (c.eyebrow) {
    drawRuns(
      doc,
      [
        {
          text: c.eyebrow.toUpperCase(),
          font: "medium",
          size: T.coverEyebrow,
          charSpacing: 2.5,
          color: TEXT,
        },
      ],
      MARGIN,
      1.55 * IN,
      textW,
      0.4 * IN,
    );
  }
  drawRuns(
    doc,
    [{ text: c.title ?? "", font: "display", size: T.coverTitle, color: TEXT, lineMult: L.title }],
    MARGIN,
    2.0 * IN,
    textW,
    2.7 * IN,
  );
  if (c.subtitle) {
    drawRuns(
      doc,
      [{ text: c.subtitle, font: "body", size: T.coverSubtitle, color: TEXT }],
      MARGIN,
      4.85 * IN,
      textW,
      0.9 * IN,
    );
  }
  drawFolio(doc, idx);
}

function addDivider(doc: PDFKit.PDFDocument, c: SlideContent, img: string | null, st: Style): void {
  fillBackground(doc, st.color("archiveBlack"));

  // Образ — узкий край архивной пластины; 60–70% листа остаются воздухом.
  const imgW = PAGE_W * SLIDE_SPEC.imageShare.divider;
  if (img) drawPlateImage(doc, img, PAGE_W - imgW, imgW);

  const runs: Run[] = [];
  if (c.eyebrow) {
    runs.push({
      text: c.eyebrow.toUpperCase(),
      font: "medium",
      size: T.dividerEyebrow,
      charSpacing: 2.5,
      color: TEXT,
      spaceAfter: 14,
    });
  }
  runs.push({ text: c.title ?? "", font: "display", size: T.dividerTitle, color: TEXT, lineMult: L.title });
  // Один блок на всю высоту: имя части само встаёт по центру вертикали.
  drawRuns(
    doc,
    runs,
    MARGIN,
    0,
    img ? PAGE_W - imgW - MARGIN - 0.4 * IN : PAGE_W - MARGIN * 2,
    PAGE_H,
    "middle",
  );
}

function addTheory(
  doc: PDFKit.PDFDocument,
  c: SlideContent,
  img: string | null,
  st: Style,
  side: "left" | "right",
): void {
  fillBackground(doc, st.color("archiveBlack"));

  const imgW = PAGE_W * SLIDE_SPEC.imageShare.theory;
  const imgX = side === "left" ? 0 : PAGE_W - imgW;
  if (img) drawPlateImage(doc, img, imgX, imgW);

  const textX = img && side === "left" ? imgW + 0.55 * IN : MARGIN;
  // Без образа поле не растягиваем: брендбук держит строку в 45–65 знаков.
  const textW = img ? PAGE_W - imgW - MARGIN - 0.55 * IN : 9.5 * IN;

  drawRuns(
    doc,
    [{ text: c.title ?? "", font: "display", size: T.theoryTitle, color: TEXT, lineMult: L.title }],
    textX,
    0.75 * IN,
    textW,
    1.35 * IN,
  );

  if (c.bullets?.length) {
    drawBullets(doc, c.bullets, textX, 2.25 * IN, textW, 3.7 * IN, T.bullets, TEXT);
  }

  if (c.question) {
    drawRuns(
      doc,
      [{ text: c.question, font: "body", size: T.question, color: TEXT }],
      textX,
      6.15 * IN,
      textW,
      1.0 * IN,
    );
  }

  if (img && c.plate) {
    // Музейная подпись капителью по нижнему краю пластины.
    drawRuns(
      doc,
      [
        {
          text: c.plate.toUpperCase(),
          font: "medium",
          size: T.plate,
          charSpacing: 2,
          color: TEXT,
          align: "center",
        },
      ],
      imgX + 0.3 * IN,
      PAGE_H - 0.5 * IN,
      imgW - 0.6 * IN,
      0.32 * IN,
    );
  }
}

function addQuote(
  doc: PDFKit.PDFDocument,
  c: SlideContent,
  img: string | null,
  st: Style,
  side: "left" | "right",
): void {
  fillBackground(doc, st.color("archiveBlack"));

  const imgW = PAGE_W * SLIDE_SPEC.imageShare.quote;
  if (img) drawPlateImage(doc, img, side === "left" ? 0 : PAGE_W - imgW, imgW);

  // Текст — на противоположном от образа краю, с воздухом.
  const textX = img ? (side === "left" ? imgW + 0.6 * IN : MARGIN + 0.25 * IN) : 1.7 * IN;
  const textW = img ? PAGE_W - imgW - MARGIN - 0.85 * IN : PAGE_W - 1.7 * IN * 2;

  const runs: Run[] = [
    {
      text: c.quote ?? "",
      font: "display",
      size: T.quote,
      color: TEXT,
      lineMult: L.quote,
      spaceAfter: 16,
    },
  ];
  if (c.attribution) {
    runs.push({
      text: c.attribution,
      font: "body",
      size: T.attribution,
      color: TEXT,
    });
  }
  drawRuns(doc, runs, textX, 0.9 * IN, textW, PAGE_H - 1.8 * IN, "middle");
}

function addClinical(
  doc: PDFKit.PDFDocument,
  c: SlideContent,
  img: string | null,
  st: Style,
  side: "left" | "right",
): void {
  fillBackground(doc, st.color("archiveBlack"));

  const imgW = PAGE_W * SLIDE_SPEC.imageShare.clinical;
  if (img) drawPlateImage(doc, img, side === "left" ? 0 : PAGE_W - imgW, imgW);

  const textX = img && side === "left" ? imgW + 0.55 * IN : MARGIN;
  // Спокойная бумажная колонка ~55%; шире не делаем даже без образа.
  const textW = img ? PAGE_W - imgW - MARGIN - 0.55 * IN : 8.0 * IN;

  drawRuns(doc, [{ text: c.title ?? "", font: "display", size: T.clinicalTitle, color: TEXT }], textX, 0.8 * IN, textW, 1.1 * IN);

  const paragraphs = c.bullets ?? [];
  if (paragraphs.length) {
    drawRuns(
      doc,
      paragraphs.map((p) => ({
        text: p,
        font: "body" as const,
        size: T.clinicalBody,
        color: TEXT,
        lineMult: L.body,
        spaceAfter: 12,
      })),
      textX,
      2.0 * IN,
      textW,
      3.9 * IN,
    );
  }

  if (c.question) {
    drawRuns(
      doc,
      [{ text: c.question, font: "body", size: T.question, color: TEXT }],
      textX,
      6.1 * IN,
      textW,
      1.0 * IN,
    );
  }
}

function addComparison(doc: PDFKit.PDFDocument, c: SlideContent, img: string | null, st: Style): void {
  fillBackground(doc, st.color("archiveBlack"));

  // Общая гравюра — полосой сверху, обе колонки остаются под одним образом.
  const imgH = PAGE_H * SLIDE_SPEC.comparisonBand;
  if (img) drawImageCover(doc, img, 0, 0, PAGE_W, imgH);
  const top = img ? imgH + 0.25 * IN : 0.75 * IN;

  drawRuns(
    doc,
    [{ text: c.title ?? "", font: "display", size: T.comparisonTitle, color: TEXT }],
    MARGIN,
    top,
    PAGE_W - MARGIN * 2,
    0.8 * IN,
  );

  const colY = top + 0.95 * IN;
  const colH = PAGE_H - colY - 0.45 * IN;
  const colW = PAGE_W / 2 - MARGIN - 0.45 * IN;

  const cards = c.cards ?? [];
  cards.slice(0, MAX_CARDS).forEach((card, i) => {
    drawRuns(
      doc,
      [
        { text: card.title, font: "display", size: T.cardTitle, color: TEXT, spaceAfter: 8 },
        { text: card.body, font: "body", size: T.cardBody, color: TEXT, lineMult: L.body },
      ],
      i === 0 ? MARGIN : PAGE_W / 2 + 0.45 * IN,
      colY,
      colW,
      colH,
    );
  });

  // Шов — не интерфейсный разделитель, а волосяная линия старой сшивки.
  // Только между двумя колонками, как в предпросмотре: у одной шить нечего.
  if (cards.length > 1) {
    doc
      .moveTo(PAGE_W / 2, colY + 0.05 * IN)
      .lineTo(PAGE_W / 2, colY + colH - 0.1 * IN)
      .lineWidth(0.75)
      .stroke(SEAM);
  }
}

function addFinal(doc: PDFKit.PDFDocument, c: SlideContent, st: Style, idx: number): void {
  fillBackground(doc, st.color("archiveBlack"));

  // Один вывод по центру-слева; «спасибо за внимание» отсёк ещё storyboard.
  const runs: Run[] = [
    {
      text: c.title ?? c.subtitle ?? "",
      font: "display",
      size: T.finalTitle,
      color: TEXT,
      lineMult: L.final,
    },
  ];
  if (c.subtitle && c.title) {
    runs[0]!.spaceAfter = 18;
    runs.push({ text: c.subtitle, font: "body", size: T.finalSubtitle, color: TEXT });
  }
  drawRuns(doc, runs, MARGIN, 0, 9.8 * IN, PAGE_H, "middle");
  drawFolio(doc, idx);
}

// ── Схема (diagram) ─────────────────────────────────────────────────────

/**
 * Подписи внутри фигуры: label, под ним sub. Шаг потока — по центру,
 * опора — слева сверху, как в PPTX и предпросмотре.
 */
function drawNodeText(
  doc: PDFKit.PDFDocument,
  item: { label: string; sub?: string },
  kind: DiagramSpec["kind"],
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  const align = kind === "flow" ? "center" : "left";
  const runs: Run[] = [
    {
      text: item.label,
      font: "display",
      size: T.nodeLabel,
      color: TEXT,
      align,
      spaceAfter: kind === "flow" ? 4 : 8,
    },
  ];
  if (item.sub) {
    runs.push({ text: item.sub, font: "body", size: T.nodeSub, color: TEXT, align, lineMult: L.nodeSub });
  }
  drawRuns(doc, runs, x, y, w, h, kind === "flow" ? "middle" : "top");
}

/**
 * Схема кодом: rect со скруглением 0 и линии-стрелки — лист атласа,
 * а не интерфейсная блок-схема. Панели — deepIndigo с рамкой museumIndigo.
 * Геометрия — та же, что в pptx.ts (дюймы × 72).
 */
function addDiagram(doc: PDFKit.PDFDocument, c: SlideContent, spec: DiagramSpec, st: Style): void {
  fillBackground(doc, st.color("archiveBlack"));

  // Заголовок сверху — как в theory.
  drawRuns(
    doc,
    [{ text: c.title ?? "", font: "display", size: T.diagramTitle, color: TEXT, lineMult: L.title }],
    MARGIN,
    0.75 * IN,
    PAGE_W - MARGIN * 2,
    1.1 * IN,
  );

  const panel = st.color("deepIndigo");
  const line = st.color("museumIndigo");
  const items = spec.items;
  const n = items.length;

  const top = 2.05 * IN;
  const bottom = PAGE_H - 0.55 * IN;

  if (spec.kind === "flow") {
    // Вертикальная колонна шагов со стрелками сверху вниз.
    const gap = 0.42 * IN; // просвет под стрелку
    const boxW = 7.2 * IN;
    const boxX = (PAGE_W - boxW) / 2;
    // Потолок высоты шага: два шага не должны раздуваться в плакаты.
    const boxH = Math.min(1.15 * IN, (bottom - top - (n - 1) * gap) / n);
    const total = n * boxH + (n - 1) * gap;
    let cy = top + (bottom - top - total) / 2;

    items.forEach((item, i) => {
      doc.rect(boxX, cy, boxW, boxH).lineWidth(1).fillAndStroke(panel, line);
      drawNodeText(doc, item, "flow", boxX + 0.25 * IN, cy, boxW - 0.5 * IN, boxH);

      if (i < n - 1) {
        // Стрелка к следующему шагу: стержень + две засечки-наконечника.
        const cx = PAGE_W / 2;
        const y1 = cy + boxH + 0.06 * IN;
        const y2 = cy + boxH + gap - 0.06 * IN;
        doc.moveTo(cx, y1).lineTo(cx, y2).lineWidth(1.5).stroke(line);
        doc
          .moveTo(cx - 4, y2 - 5)
          .lineTo(cx, y2)
          .lineTo(cx + 4, y2 - 5)
          .lineWidth(1.5)
          .stroke(line);
      }
      cy += boxH + gap;
    });
    return;
  }

  // pillars: колонки рядом во всё поле, без стрелок — опоры, а не процесс.
  // Больше maxItems в строку не встаёт — режем так же, как PPTX и предпросмотр.
  const pillars = items.slice(0, SLIDE_SPEC.diagram.maxItems);
  const gap = 0.45 * IN;
  const colW = (PAGE_W - MARGIN * 2 - (pillars.length - 1) * gap) / pillars.length;
  const colH = bottom - top;
  pillars.forEach((item, i) => {
    const x = MARGIN + i * (colW + gap);
    doc.rect(x, top, colW, colH).lineWidth(1).fillAndStroke(panel, line);
    drawNodeText(doc, item, "pillars", x + 0.3 * IN, top + 0.35 * IN, colW - 0.6 * IN, colH - 0.7 * IN);
  });
}

// ── Сборка ──────────────────────────────────────────────────────────────

export async function buildDeckPdf(
  deck: Deck,
  slides: DeckSlide[],
  imagesById: Map<number, DeckImage>,
  pack: StylePack | null,
): Promise<Buffer> {
  const fontsDir = resolveFontsDir();
  const bodyFont = fontPath(fontsDir, "body");
  const displayFont = fontPath(fontsDir, "display");
  const mediumFont = fontPath(fontsDir, "medium");

  const doc = new PDFDocument({
    size: [PAGE_W, PAGE_H],
    margin: 0,
    autoFirstPage: false,
    // Свой шрифт с порога: иначе pdfkit полезет за Helvetica.afm,
    // которого рядом с esbuild-бандлом нет.
    font: bodyFont,
    info: { Title: deck.title, Author: "Psy3107" },
  });
  doc.registerFont("display", displayFont);
  doc.registerFont("body", bodyFont);
  doc.registerFont("medium", mediumFont);

  const chunks: Buffer[] = [];
  doc.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  // Слайды приходят уже по порядку (ручка выгрузки сортирует по ord).
  const st = makeStyle(pack);

  slides.forEach((s, idx) => {
    doc.addPage();
    const c = s.content ?? {};
    const img = imagePath(s, imagesById);
    const layout: SlideLayout = s.layout;

    switch (layout) {
      case "cover":
        addCover(doc, c, img, st, idx);
        break;
      case "divider":
        addDivider(doc, c, img, st);
        break;
      case "quote":
        addQuote(doc, c, img, st, s.imageSide);
        break;
      case "clinical":
        addClinical(doc, c, img, st, s.imageSide);
        break;
      case "comparison":
        addComparison(doc, c, img, st);
        break;
      case "final":
        addFinal(doc, c, st, idx);
        break;
      case "diagram":
        // Есть описание структуры — рисуем фигурами, нет — текстом как теория.
        // Форму spec держит разбор раскадровки — единственное место записи.
        if (s.diagramSpec) addDiagram(doc, c, s.diagramSpec, st);
        else addTheory(doc, c, null, st, s.imageSide);
        break;
      case "theory":
      default:
        addTheory(doc, c, img, st, s.imageSide);
    }
    // notes сюда не попадают намеренно: раздатка — то, что видит зал.
  });

  doc.end();
  return done;
}
