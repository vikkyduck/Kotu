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
import { SLIDE_SPEC, SLIDE_TYPE as T, SHEET } from "@workspace/db/slides";
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

/** Фолбэки палитры из брендбука (раздел 2) — колода собирается всегда. */
const BRAND_FALLBACK = {
  archiveBlack: "#1D1E24",
  deepIndigo: "#232638",
  charcoal: "#2B292B",
  agedPaper: "#D8C7A7",
  deepSepia: "#C4AD87",
  etchingInk: "#302B27",
  burntUmber: "#7B432F",
  museumIndigo: "#677184",
  driedCarmine: "#955A52",
  dullGold: "#B08D57",
} as const;

type BrandColor = keyof typeof BRAND_FALLBACK;

/** Светлый пергамент для текста на тёмных фонах (см. комментарий в pptx.ts). */
const VELLUM = "#E5D8C1";
/** Шов между колонками сравнения — волосяная линия старой сшивки. */
const SEAM = "#65594E";

/**
 * Имена шрифтов, под которыми TTF регистрируются в документе. Пакет может
 * называть гарнитуры как угодно, но физически в раздатку встраиваются ровно
 * эти три файла — других на сервере нет.
 */
const FONT = {
  display: "CormorantGaramond-SemiBold.ttf",
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

function hex(value: string): string {
  const v = value.trim();
  return v.startsWith("#") ? v : `#${v}`;
}

/** Подмешать белого — та же поправка, что в pptx.ts: умбра тонет на чёрном. */
function lighten(color: string, amount: number): string {
  const n = parseInt(color.replace(/^#/, ""), 16);
  const mix = (c: number): number => Math.round(c + (255 - c) * amount);
  const rgb = (mix((n >> 16) & 0xff) << 16) | (mix((n >> 8) & 0xff) << 8) | mix(n & 0xff);
  return `#${rgb.toString(16).padStart(6, "0")}`;
}

interface Style {
  color: (name: BrandColor) => string;
}

function makeStyle(pack: StylePack | null): Style {
  const palette = pack?.palette ?? {};
  return { color: (name) => hex(palette[name] ?? BRAND_FALLBACK[name]) };
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
 * Пункты с ромбом «◇ » — маркер серии. В Manrope глифа U+25C7 нет,
 * поэтому ромб рисуется гарнитурой Cormorant отдельным раном, а текст —
 * с висячим отступом, как положено списку.
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
  const mult = 1.1;
  let cy = y;
  for (const b of bullets) {
    const room = Math.max(0, Math.min(y + h, PAGE_H) - cy);
    if (room <= 0) break;
    doc.font("display").fontSize(size).fillColor(color, 1).text("◇", x, cy, {
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
function drawFolio(doc: PDFKit.PDFDocument, st: Style, idx: number): void {
  doc
    .font("body")
    .fontSize(T.folio)
    .fillColor(st.color("museumIndigo"), 1)
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
          color: lighten(st.color("burntUmber"), 0.3),
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
    [{ text: c.title ?? "", font: "display", size: T.coverTitle, color: VELLUM, lineMult: 1.05 }],
    MARGIN,
    2.0 * IN,
    textW,
    2.7 * IN,
  );
  if (c.subtitle) {
    drawRuns(
      doc,
      [{ text: c.subtitle, font: "body", size: T.coverSubtitle, color: st.color("deepSepia") }],
      MARGIN,
      4.85 * IN,
      textW,
      0.9 * IN,
    );
  }
  drawFolio(doc, st, idx);
}

function addDivider(doc: PDFKit.PDFDocument, c: SlideContent, img: string | null, st: Style): void {
  fillBackground(doc, st.color("deepIndigo"));

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
      color: lighten(st.color("burntUmber"), 0.3),
      spaceAfter: 14,
    });
  }
  runs.push({ text: c.title ?? "", font: "display", size: T.dividerTitle, color: VELLUM, lineMult: 1.05 });
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
    [{ text: c.title ?? "", font: "display", size: T.theoryTitle, color: VELLUM, lineMult: 1.05 }],
    textX,
    0.75 * IN,
    textW,
    1.35 * IN,
  );

  if (c.bullets?.length) {
    drawBullets(doc, c.bullets, textX, 2.25 * IN, textW, 3.7 * IN, T.bullets, VELLUM);
  }

  if (c.question) {
    // Рабочий вопрос выделяется умброй, а не курсивом (приём брендбука).
    drawRuns(
      doc,
      [{ text: c.question, font: "body", size: T.question, color: st.color("burntUmber") }],
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
          color: VELLUM,
          opacity: 0.75,
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
  // Бумажная пластина: светлый фон, текст тушью.
  fillBackground(doc, st.color("agedPaper"));

  const imgW = PAGE_W * SLIDE_SPEC.imageShare.quote;
  if (img) drawPlateImage(doc, img, side === "left" ? 0 : PAGE_W - imgW, imgW);

  // Текст — на противоположном от образа краю, с воздухом.
  const textX = img ? (side === "left" ? imgW + 0.6 * IN : MARGIN + 0.25 * IN) : 1.7 * IN;
  const textW = img ? PAGE_W - imgW - MARGIN - 0.85 * IN : PAGE_W - 1.7 * IN * 2;

  const runs: Run[] = [
    {
      text: c.quote ?? c.title ?? "",
      font: "display",
      size: T.quote,
      color: st.color("etchingInk"),
      lineMult: 1.15,
      spaceAfter: 16,
    },
  ];
  if (c.attribution) {
    runs.push({
      text: c.attribution,
      font: "body",
      size: T.attribution,
      color: st.color("etchingInk"),
      opacity: 0.6,
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
  fillBackground(doc, st.color("agedPaper"));
  const ink = st.color("etchingInk");

  const imgW = PAGE_W * SLIDE_SPEC.imageShare.clinical;
  if (img) drawPlateImage(doc, img, side === "left" ? 0 : PAGE_W - imgW, imgW);

  const textX = img && side === "left" ? imgW + 0.55 * IN : MARGIN;
  // Спокойная бумажная колонка ~55%; шире не делаем даже без образа.
  const textW = img ? PAGE_W - imgW - MARGIN - 0.55 * IN : 8.0 * IN;

  drawRuns(doc, [{ text: c.title ?? "", font: "display", size: T.clinicalTitle, color: ink }], textX, 0.8 * IN, textW, 1.1 * IN);

  const paragraphs = c.bullets?.length ? c.bullets : c.subtitle ? [c.subtitle] : [];
  if (paragraphs.length) {
    drawRuns(
      doc,
      paragraphs.map((p) => ({
        text: p,
        font: "body" as const,
        size: T.clinicalBody,
        color: ink,
        lineMult: 1.15,
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
      [{ text: c.question, font: "body", size: T.question, color: st.color("burntUmber") }],
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
    [{ text: c.title ?? "", font: "display", size: T.comparisonTitle, color: VELLUM }],
    MARGIN,
    top,
    PAGE_W - MARGIN * 2,
    0.8 * IN,
  );

  const colY = top + 0.95 * IN;
  const colH = PAGE_H - colY - 0.45 * IN;
  const colW = PAGE_W / 2 - MARGIN - 0.45 * IN;

  const cards = c.cards ?? [];
  cards.slice(0, 2).forEach((card, i) => {
    drawRuns(
      doc,
      [
        { text: card.title, font: "display", size: T.cardTitle, color: VELLUM, spaceAfter: 8 },
        { text: card.body, font: "body", size: T.cardBody, color: st.color("deepSepia"), lineMult: 1.15 },
      ],
      i === 0 ? MARGIN : PAGE_W / 2 + 0.45 * IN,
      colY,
      colW,
      colH,
    );
  });

  // Шов — не интерфейсный разделитель, а волосяная линия старой сшивки.
  doc
    .moveTo(PAGE_W / 2, colY + 0.05 * IN)
    .lineTo(PAGE_W / 2, colY + colH - 0.1 * IN)
    .lineWidth(0.75)
    .stroke(SEAM);
}

function addFinal(doc: PDFKit.PDFDocument, c: SlideContent, st: Style, idx: number): void {
  fillBackground(doc, st.color("archiveBlack"));

  // Один вывод по центру-слева; «спасибо за внимание» отсёк ещё storyboard.
  const runs: Run[] = [
    {
      text: c.title ?? c.quote ?? c.subtitle ?? "",
      font: "display",
      size: T.finalTitle,
      color: VELLUM,
      lineMult: 1.1,
    },
  ];
  if (c.subtitle && c.title) {
    runs[0]!.spaceAfter = 18;
    runs.push({ text: c.subtitle, font: "body", size: T.finalSubtitle, color: st.color("deepSepia") });
  }
  drawRuns(doc, runs, MARGIN, 0, 9.8 * IN, PAGE_H, "middle");
  drawFolio(doc, st, idx);
}

// ── Схема (diagram) ─────────────────────────────────────────────────────

/**
 * diagramSpec приходит из jsonb: форму гарантирует sanitize при записи,
 * но старые строки могли лечь до него — перепроверяем перед отрисовкой.
 */
function readDiagramSpec(value: unknown): DiagramSpec | null {
  if (!value || typeof value !== "object") return null;
  const o = value as { kind?: unknown; items?: unknown };
  if (o.kind !== "flow" && o.kind !== "pillars") return null;
  if (!Array.isArray(o.items)) return null;
  const items: { label: string; sub?: string }[] = [];
  for (const it of o.items.slice(0, 6)) {
    if (!it || typeof it !== "object") continue;
    const label = (it as { label?: unknown }).label;
    const sub = (it as { sub?: unknown }).sub;
    if (typeof label !== "string" || label === "") continue;
    items.push(typeof sub === "string" && sub !== "" ? { label, sub } : { label });
  }
  if (items.length < 2) return null;
  return { kind: o.kind, items };
}

/** Подписи внутри фигуры: label по центру, sub под ним. */
function drawNodeText(
  doc: PDFKit.PDFDocument,
  item: { label: string; sub?: string },
  st: Style,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  const runs: Run[] = [
    { text: item.label, font: "display", size: T.nodeLabel, color: VELLUM, align: "center", spaceAfter: 4 },
  ];
  if (item.sub) {
    runs.push({ text: item.sub, font: "body", size: T.nodeSub, color: st.color("deepSepia"), align: "center" });
  }
  drawRuns(doc, runs, x, y, w, h, "middle");
}

/**
 * Схема кодом: rect со скруглением 0 и линии-стрелки — лист атласа,
 * а не интерфейсная блок-схема. Панели — deepIndigo с рамкой museumIndigo.
 */
function addDiagram(doc: PDFKit.PDFDocument, c: SlideContent, spec: DiagramSpec, st: Style): void {
  fillBackground(doc, st.color("archiveBlack"));

  // Заголовок сверху — как в theory.
  drawRuns(
    doc,
    [{ text: c.title ?? "", font: "display", size: T.diagramTitle, color: VELLUM, lineMult: 1.05 }],
    MARGIN,
    0.75 * IN,
    PAGE_W - MARGIN * 2,
    1.35 * IN,
  );

  const panel = st.color("deepIndigo");
  const line = st.color("museumIndigo");
  const items = spec.items;
  const n = items.length;

  const areaY = 165;
  const areaH = PAGE_H - areaY - 35;

  if (spec.kind === "flow") {
    // Вертикальная колонна шагов со стрелками сверху вниз.
    const gap = 22;
    const boxW = 480;
    const boxX = (PAGE_W - boxW) / 2;
    const boxH = Math.min(78, (areaH - (n - 1) * gap) / n);
    const total = n * boxH + (n - 1) * gap;
    let cy = areaY + Math.max(0, (areaH - total) / 2);

    items.forEach((item, i) => {
      doc.rect(boxX, cy, boxW, boxH).lineWidth(1).fillAndStroke(panel, line);
      drawNodeText(doc, item, st, boxX + 16, cy, boxW - 32, boxH);

      if (i < n - 1) {
        // Стрелка к следующему шагу: стержень + две засечки-наконечника.
        const cx = PAGE_W / 2;
        const y1 = cy + boxH + 3;
        const y2 = cy + boxH + gap - 3;
        doc.moveTo(cx, y1).lineTo(cx, y2).lineWidth(1).stroke(line);
        doc
          .moveTo(cx - 4, y2 - 5)
          .lineTo(cx, y2)
          .lineTo(cx + 4, y2 - 5)
          .lineWidth(1)
          .stroke(line);
      }
      cy += boxH + gap;
    });
    return;
  }

  // pillars: колонки рядом, без стрелок — опоры, а не процесс.
  const gap = 24;
  const colW = (PAGE_W - MARGIN * 2 - (n - 1) * gap) / n;
  const colH = Math.min(310, areaH);
  const colY = areaY + (areaH - colH) / 2;
  items.forEach((item, i) => {
    const x = MARGIN + i * (colW + gap);
    doc.rect(x, colY, colW, colH).lineWidth(1).fillAndStroke(panel, line);
    drawNodeText(doc, item, st, x + 12, colY + 16, colW - 24, colH - 32);
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

  const st = makeStyle(pack);
  const ordered = [...slides].sort((a, b) => a.ord - b.ord);

  ordered.forEach((s, idx) => {
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
      case "diagram": {
        // Есть описание структуры — рисуем фигурами, нет — текстом как теория.
        const spec = readDiagramSpec(s.diagramSpec);
        if (spec) addDiagram(doc, c, spec, st);
        else addTheory(doc, c, null, st, s.imageSide);
        break;
      }
      case "theory":
      default:
        addTheory(doc, c, img, st, s.imageSide);
    }
    // notes сюда не попадают намеренно: раздатка — то, что видит зал.
  });

  doc.end();
  return done;
}
