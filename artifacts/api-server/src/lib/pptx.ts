import { existsSync } from "node:fs";
import PptxGenJS from "pptxgenjs";
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
  BRAND_PALETTE,
  SLIDE_TEXT,
  SLIDE_SEAM,
  MAX_CARDS,
  type BrandColor,
} from "@workspace/db/slides";

/**
 * Сборка PPTX по утверждённой раскадровке. Макеты — раздел 9 брендбука
 * Psy3107 «Архивный сон» (`brand/Psy3107_Presentation_Prompt_Pack.txt`):
 * функция слайда определяет композицию, текст живёт только на спокойном поле.
 */

const PAGE_W = 13.333;
const PAGE_H = 7.5;
/** Пункты общей таблицы → дюймы PowerPoint. */
const inch = (pt: number): number => pt / 72;
/** Музейное поле по краям: текст не прижимается к обрезу листа. */
const MARGIN = inch(SLIDE_SPEC.margin);

/** pptxgenjs ждёт hex без решётки — в базе цвета лежат как #RRGGBB. */
function hex(value: string): string {
  return value.replace(/^#/, "").toUpperCase();
}

/** Цвет букв и шва — из общей таблицы, как у PDF и предпросмотра. */
const TEXT = hex(SLIDE_TEXT);
const SEAM = hex(SLIDE_SEAM);

interface Style {
  display: string;
  body: string;
  color: (name: BrandColor) => string;
}

/**
 * Гарнитура — Manrope, как в PDF и предпросмотре; из пакета её не берём:
 * кегли общей таблицы подобраны под неё, и колода не должна выходить
 * в двух гарнитурах. Палитра пакета может прийти неполной — тогда брендбук.
 */
function makeStyle(pack: StylePack | null): Style {
  const palette = pack?.palette ?? {};
  return {
    display: "Manrope",
    body: "Manrope",
    color: (name) => hex(palette[name] ?? BRAND_PALETTE[name]),
  };
}

/** Арабский folio внизу листа (брендбук: римские — разделам, арабские — folio). */
function addFolio(out: PptxGenJS.Slide, st: Style, idx: number): void {
  out.addText(String(idx + 1).padStart(2, "0"), {
    x: MARGIN,
    y: PAGE_H - 0.6,
    w: 2,
    h: 0.35,
    fontFace: st.body,
    fontSize: T.folio,
    color: TEXT,
    charSpacing: 2,
  });
}

/** Полноростовая гравюра у края листа; cover — чтобы 16:9 не искажался. */
function addPlateImage(out: PptxGenJS.Slide, path: string, x: number, w: number): void {
  out.addImage({ path, x, y: 0, w, h: PAGE_H, sizing: { type: "cover", w, h: PAGE_H } });
}

// ── Макеты ──────────────────────────────────────────────────────────────

function addCover(out: PptxGenJS.Slide, c: SlideContent, img: string | null, st: Style, idx: number): void {
  out.background = { color: st.color("archiveBlack") };

  // Брендбук: текст слева 42%, образ справа 58%.
  const imgW = PAGE_W * SLIDE_SPEC.imageShare.cover;
  if (img) addPlateImage(out, img, PAGE_W - imgW, imgW);
  const textW = img ? PAGE_W - imgW - MARGIN - 0.35 : PAGE_W - MARGIN * 2;

  if (c.eyebrow) {
    out.addText(c.eyebrow.toUpperCase(), {
      x: MARGIN,
      y: 1.55,
      w: textW,
      h: 0.4,
      fontFace: st.body,
      fontSize: T.coverEyebrow,
      charSpacing: 2.5,
      color: TEXT,
    });
  }
  out.addText(c.title ?? "", {
    x: MARGIN,
    y: 2.0,
    w: textW,
    h: 2.7,
    fontFace: st.display, bold: true,
    fontSize: T.coverTitle,
    color: TEXT,
    valign: "top",
    lineSpacingMultiple: 1.05,
  });
  if (c.subtitle) {
    out.addText(c.subtitle, {
      x: MARGIN,
      y: 4.85,
      w: textW,
      h: 0.9,
      fontFace: st.body,
      fontSize: T.coverSubtitle,
      color: TEXT,
      valign: "top",
    });
  }
  addFolio(out, st, idx);
}

function addDivider(out: PptxGenJS.Slide, c: SlideContent, img: string | null, st: Style): void {
  out.background = { color: st.color("archiveBlack") };

  // Образ — узкий край архивной пластины; 60–70% листа остаются воздухом.
  const imgW = PAGE_W * SLIDE_SPEC.imageShare.divider;
  if (img) addPlateImage(out, img, PAGE_W - imgW, imgW);

  const runs: PptxGenJS.TextProps[] = [];
  if (c.eyebrow) {
    runs.push({
      text: c.eyebrow.toUpperCase(),
      options: {
        fontFace: st.body,
        fontSize: T.dividerEyebrow,
        charSpacing: 2.5,
        color: TEXT,
        breakLine: true,
        paraSpaceAfter: 14,
      },
    });
  }
  runs.push({
    text: c.title ?? "",
    options: { fontFace: st.display, bold: true, fontSize: T.dividerTitle, color: TEXT, lineSpacingMultiple: 1.05 },
  });
  // Один текстовый блок на всю высоту: имя части само встаёт по центру вертикали.
  out.addText(runs, {
    x: MARGIN,
    y: 0,
    w: img ? PAGE_W - imgW - MARGIN - 0.4 : PAGE_W - MARGIN * 2,
    h: PAGE_H,
    valign: "middle",
  });
}

function addTheory(out: PptxGenJS.Slide, c: SlideContent, img: string | null, st: Style, side: "left" | "right"): void {
  out.background = { color: st.color("archiveBlack") };

  const imgW = PAGE_W * SLIDE_SPEC.imageShare.theory;
  const imgX = side === "left" ? 0 : PAGE_W - imgW;
  if (img) addPlateImage(out, img, imgX, imgW);

  const textX = img && side === "left" ? imgW + 0.55 : MARGIN;
  // Без образа поле не растягиваем на весь лист: брендбук держит строку в 45–65 знаков.
  const textW = img ? PAGE_W - imgW - MARGIN - 0.55 : 9.5;

  out.addText(c.title ?? "", {
    x: textX,
    y: 0.75,
    w: textW,
    h: 1.35,
    fontFace: st.display, bold: true,
    fontSize: T.theoryTitle,
    color: TEXT,
    valign: "top",
    lineSpacingMultiple: 1.05,
  });

  if (c.bullets?.length) {
    // Лозенг вместо стандартного буллета — маркер серии, а не интерфейсная точка.
    const runs: PptxGenJS.TextProps[] = c.bullets.map((b) => ({
      text: `◊  ${b}`,
      options: { breakLine: true, paraSpaceAfter: 10 },
    }));
    out.addText(runs, {
      x: textX,
      y: 2.25,
      w: textW,
      h: 3.7,
      fontFace: st.body,
      fontSize: T.bullets,
      color: TEXT,
      valign: "top",
      lineSpacingMultiple: 1.1,
    });
  }

  if (c.question) {
    out.addText(c.question, {
      x: textX,
      y: 6.15,
      w: textW,
      h: 1.0,
      fontFace: st.body,
      fontSize: T.question,
      color: TEXT,
      valign: "top",
    });
  }

  if (img && c.plate) {
    // Музейная подпись капителью по нижнему краю пластины.
    out.addText(c.plate.toUpperCase(), {
      x: imgX + 0.3,
      y: PAGE_H - 0.5,
      w: imgW - 0.6,
      h: 0.32,
      fontFace: st.body,
      fontSize: T.plate,
      charSpacing: 2,
      color: TEXT,
      align: "center",
    });
  }
}

function addQuote(out: PptxGenJS.Slide, c: SlideContent, img: string | null, st: Style, side: "left" | "right"): void {
  out.background = { color: st.color("archiveBlack") };

  const imgW = PAGE_W * SLIDE_SPEC.imageShare.quote;
  if (img) addPlateImage(out, img, side === "left" ? 0 : PAGE_W - imgW, imgW);

  // Текст — на противоположном от образа краю, с воздухом.
  const textX = img ? (side === "left" ? imgW + 0.6 : MARGIN + 0.25) : 1.7;
  const textW = img ? PAGE_W - imgW - MARGIN - 0.85 : PAGE_W - 1.7 * 2;

  const runs: PptxGenJS.TextProps[] = [
    {
      text: c.quote ?? c.title ?? "",
      options: {
        fontFace: st.display, bold: true,
        fontSize: T.quote,
        color: TEXT,
        lineSpacingMultiple: 1.15,
        breakLine: true,
        paraSpaceAfter: 16,
      },
    },
  ];
  if (c.attribution) {
    runs.push({
      text: c.attribution,
      options: { fontFace: st.body, fontSize: T.attribution, color: TEXT },
    });
  }
  out.addText(runs, { x: textX, y: 0.9, w: textW, h: PAGE_H - 1.8, valign: "middle" });
}

function addClinical(out: PptxGenJS.Slide, c: SlideContent, img: string | null, st: Style, side: "left" | "right"): void {
  out.background = { color: st.color("archiveBlack") };
  const ink = TEXT;

  const imgW = PAGE_W * SLIDE_SPEC.imageShare.clinical;
  if (img) addPlateImage(out, img, side === "left" ? 0 : PAGE_W - imgW, imgW);

  const textX = img && side === "left" ? imgW + 0.55 : MARGIN;
  // Спокойная бумажная колонка ~55%; шире не делаем даже без образа — строка расползётся.
  const textW = img ? PAGE_W - imgW - MARGIN - 0.55 : 8.0;

  out.addText(c.title ?? "", {
    x: textX,
    y: 0.8,
    w: textW,
    h: 1.1,
    fontFace: st.display, bold: true,
    fontSize: T.clinicalTitle,
    color: ink,
    valign: "top",
  });

  const paragraphs = c.bullets?.length ? c.bullets : c.subtitle ? [c.subtitle] : [];
  if (paragraphs.length) {
    const runs: PptxGenJS.TextProps[] = paragraphs.map((p) => ({
      text: p,
      options: { breakLine: true, paraSpaceAfter: 12 },
    }));
    out.addText(runs, {
      x: textX,
      y: 2.0,
      w: textW,
      h: 3.9,
      fontFace: st.body,
      fontSize: T.clinicalBody,
      color: ink,
      valign: "top",
      lineSpacingMultiple: 1.15,
    });
  }

  if (c.question) {
    // Вопрос к материалу — вне «карточки», как велит брендбук.
    out.addText(c.question, {
      x: textX,
      y: 6.1,
      w: textW,
      h: 1.0,
      fontFace: st.body,
      fontSize: T.question,
      color: TEXT,
      valign: "top",
    });
  }
}

function addComparison(out: PptxGenJS.Slide, c: SlideContent, img: string | null, st: Style): void {
  out.background = { color: st.color("archiveBlack") };

  // Общая гравюра — полосой сверху, обе колонки остаются под одним образом.
  const imgH = PAGE_H * SLIDE_SPEC.comparisonBand;
  if (img) {
    out.addImage({ path: img, x: 0, y: 0, w: PAGE_W, h: imgH, sizing: { type: "cover", w: PAGE_W, h: imgH } });
  }
  const top = img ? imgH + 0.25 : 0.75;

  out.addText(c.title ?? "", {
    x: MARGIN,
    y: top,
    w: PAGE_W - MARGIN * 2,
    h: 0.8,
    fontFace: st.display, bold: true,
    fontSize: T.comparisonTitle,
    color: TEXT,
    valign: "top",
  });

  const colY = top + 0.95;
  const colH = PAGE_H - colY - 0.45;
  const colW = PAGE_W / 2 - MARGIN - 0.45;

  const cards = c.cards ?? [];
  cards.slice(0, MAX_CARDS).forEach((card, i) => {
    const runs: PptxGenJS.TextProps[] = [
      {
        text: card.title,
        options: { fontFace: st.display, bold: true, fontSize: T.cardTitle, color: TEXT, breakLine: true, paraSpaceAfter: 8 },
      },
      {
        text: card.body,
        options: { fontFace: st.body, fontSize: T.cardBody, color: TEXT, lineSpacingMultiple: 1.15 },
      },
    ];
    out.addText(runs, {
      x: i === 0 ? MARGIN : PAGE_W / 2 + 0.45,
      y: colY,
      w: colW,
      h: colH,
      valign: "top",
    });
  });

  // Шов — не интерфейсный разделитель, а волосяная линия старой сшивки.
  out.addShape("line", {
    x: PAGE_W / 2,
    y: colY + 0.05,
    w: 0,
    h: colH - 0.15,
    line: { color: SEAM, width: 0.75 },
  });
}

function addFinal(out: PptxGenJS.Slide, c: SlideContent, st: Style, idx: number): void {
  out.background = { color: st.color("archiveBlack") };

  // Один вывод по центру-слева; «спасибо за внимание» сюда не попадает
  // ещё на раскадровке — это правило брендбука, вёрстка ему доверяет.
  const runs: PptxGenJS.TextProps[] = [
    {
      text: c.title ?? c.quote ?? c.subtitle ?? "",
      options: { fontFace: st.display, bold: true, fontSize: T.finalTitle, color: TEXT, lineSpacingMultiple: 1.1 },
    },
  ];
  if (c.subtitle && c.title) {
    runs[0]!.options!.breakLine = true;
    runs[0]!.options!.paraSpaceAfter = 18;
    runs.push({
      text: c.subtitle,
      options: { fontFace: st.body, fontSize: T.finalSubtitle, color: TEXT },
    });
  }
  out.addText(runs, { x: MARGIN, y: 0, w: 9.8, h: PAGE_H, valign: "middle" });
  addFolio(out, st, idx);
}

/**
 * Схема фигурами: раскадровка отдала структуру (DiagramSpec), и слайд
 * рисуется кодом, без гравюры. Панели — deepIndigo с рамкой museumIndigo:
 * те же цвета пакета, которыми серия красит разделители и folio, — схема
 * читается листом атласа, а не офисным флоучартом.
 */
function addDiagram(out: PptxGenJS.Slide, c: SlideContent, spec: DiagramSpec, st: Style): void {
  out.background = { color: st.color("archiveBlack") };

  // Заголовок сверху — как в theory.
  out.addText(c.title ?? "", {
    x: MARGIN,
    y: 0.75,
    w: PAGE_W - MARGIN * 2,
    h: 1.1,
    fontFace: st.display, bold: true,
    fontSize: T.diagramTitle,
    color: TEXT,
    valign: "top",
    lineSpacingMultiple: 1.05,
  });

  const fill = { color: st.color("deepIndigo") };
  const border = { color: st.color("museumIndigo"), width: 1 };
  const top = 2.05;
  const bottom = PAGE_H - 0.55;

  if (spec.kind === "flow") {
    const n = spec.items.length;
    const gap = 0.42; // просвет под стрелку
    // Потолок высоты шага: два шага не должны раздуваться в плакаты.
    const boxH = Math.min((bottom - top - gap * (n - 1)) / n, 1.15);
    const boxW = 7.2;
    const x = (PAGE_W - boxW) / 2;
    // Колонка короче отведённого поля — вешаем её по центру вертикали.
    let y = top + (bottom - top - (boxH * n + gap * (n - 1))) / 2;

    spec.items.forEach((it, i) => {
      out.addShape("rect", { x, y, w: boxW, h: boxH, fill, line: border });
      const runs: PptxGenJS.TextProps[] = [
        { text: it.label, options: { fontFace: st.display, bold: true, fontSize: T.nodeLabel, color: TEXT } },
      ];
      if (it.sub) {
        runs[0]!.options!.breakLine = true;
        runs[0]!.options!.paraSpaceAfter = 4;
        runs.push({
          text: it.sub,
          options: { fontFace: st.body, fontSize: T.nodeSub, color: TEXT },
        });
      }
      out.addText(runs, { x: x + 0.25, y, w: boxW - 0.5, h: boxH, valign: "middle", align: "center" });

      if (i < n - 1) {
        // Стрелка — та же волосяная линия серии, только с наконечником.
        out.addShape("line", {
          x: PAGE_W / 2,
          y: y + boxH + 0.06,
          w: 0,
          h: gap - 0.12,
          line: { color: st.color("museumIndigo"), width: 1.5, endArrowType: "arrow" },
        });
      }
      y += boxH + gap;
    });
    return;
  }

  // pillars: колонки рядом. Больше maxItems в строку листа не влезает;
  // раскадровка столько и не даёт, а старые схемы режутся одинаково везде.
  const items = spec.items.slice(0, SLIDE_SPEC.diagram.maxItems);
  const gap = 0.45;
  const colW = (PAGE_W - MARGIN * 2 - gap * (items.length - 1)) / items.length;
  items.forEach((it, i) => {
    const x = MARGIN + i * (colW + gap);
    out.addShape("rect", { x, y: top, w: colW, h: bottom - top, fill, line: border });
    const runs: PptxGenJS.TextProps[] = [
      {
        text: it.label,
        options: { fontFace: st.display, bold: true, fontSize: T.nodeLabel, color: TEXT, breakLine: true, paraSpaceAfter: 8 },
      },
    ];
    if (it.sub) {
      runs.push({
        text: it.sub,
        options: { fontFace: st.body, fontSize: T.nodeSub, color: TEXT, lineSpacingMultiple: 1.2 },
      });
    }
    out.addText(runs, {
      x: x + 0.3,
      y: top + 0.35,
      w: colW - 0.6,
      h: bottom - top - 0.7,
      valign: "top",
    });
  });
}

// ── Сборка ──────────────────────────────────────────────────────────────

/**
 * Путь к готовой гравюре слайда. Файл могли снести руками на диске —
 * тогда слайд уходит текстовой пластиной, а не валит весь экспорт.
 */
function imagePath(s: DeckSlide, imagesById: Map<number, DeckImage>): string | null {
  if (!s.imageId) return null;
  const img = imagesById.get(s.imageId);
  if (!img?.path || !existsSync(img.path)) return null;
  return img.path;
}

export async function buildDeckPptx(
  deck: Deck,
  slides: DeckSlide[],
  imagesById: Map<number, DeckImage>,
  pack: StylePack | null,
): Promise<Buffer> {
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: "WIDE", width: PAGE_W, height: PAGE_H });
  pptx.layout = "WIDE";
  pptx.title = deck.title;
  pptx.author = "Psy3107";

  const st = makeStyle(pack);
  const ordered = [...slides].sort((a, b) => a.ord - b.ord);

  ordered.forEach((s, idx) => {
    const out = pptx.addSlide();
    const c = s.content ?? {};
    const img = imagePath(s, imagesById);
    const layout: SlideLayout = s.layout;

    switch (layout) {
      case "cover":
        addCover(out, c, img, st, idx);
        break;
      case "divider":
        addDivider(out, c, img, st);
        break;
      case "quote":
        addQuote(out, c, img, st, s.imageSide);
        break;
      case "clinical":
        addClinical(out, c, img, st, s.imageSide);
        break;
      case "comparison":
        addComparison(out, c, img, st);
        break;
      case "final":
        addFinal(out, c, st, idx);
        break;
      case "diagram":
        // Есть spec — рисуем структуру фигурами; без него прежнее
        // поведение: слайд идёт текстом как теория.
        if (s.diagramSpec) addDiagram(out, c, s.diagramSpec, st);
        else addTheory(out, c, null, st, s.imageSide);
        break;
      case "theory":
      default:
        addTheory(out, c, img, st, s.imageSide);
    }

    if (s.notes) out.addNotes(s.notes);
  });

  return (await pptx.write({ outputType: "nodebuffer" })) as Buffer;
}
