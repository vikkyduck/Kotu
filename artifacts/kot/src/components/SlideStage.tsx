/**
 * Слайд крупно — таким, каким он уедет в PPTX и PDF.
 *
 * Вёрстка повторяет макеты из lib/pdf.ts (лист 960×540): те же доли образа,
 * те же кегли, та же палитра. Все размеры — в cqw (1% ширины контейнера),
 * поэтому пластина одинаково верна и на телефоне, и на весь экран: меняется
 * только множитель. Это предпросмотр, а не второй движок вёрстки — длинный
 * текст здесь переносится по правилам браузера, в экспорте по правилам pdfkit.
 */
import type { CSSProperties } from 'react';
import { SLIDE_TYPE as T, SLIDE_SPEC, SHEET } from '@workspace/db/slides';

export interface StageContent {
  eyebrow?: string;
  title?: string;
  subtitle?: string;
  bullets?: string[];
  cards?: { title: string; body: string }[];
  quote?: string;
  attribution?: string;
  question?: string;
  plate?: string;
}

export interface StageDiagram {
  kind: 'flow' | 'pillars';
  items: { label: string; sub?: string }[];
}

export interface StageSlide {
  layout: string;
  content: StageContent;
  imageSide: 'left' | 'right';
}

/** Палитра брендбука «Архивный сон» — на случай, когда пакет её не задал. */
const FALLBACK: Record<string, string> = {
  archiveBlack: '#1D1E24',
  deepIndigo: '#232638',
  agedPaper: '#D8C7A7',
  deepSepia: '#C4AD87',
  etchingInk: '#302B27',
  burntUmber: '#7B432F',
  museumIndigo: '#677184',
};

/** Светлый пергамент для текста на тёмных фонах — как VELLUM в экспорте. */
const VELLUM = '#E5D8C1';
const SEAM = '#65594E';

/** Подмешать белого: умбра на чёрном тонет (та же поправка, что в pdf.ts). */
function lighten(color: string, amount: number): string {
  const n = parseInt(color.replace(/^#/, ''), 16);
  if (Number.isNaN(n)) return color;
  const mix = (c: number) => Math.round(c + (255 - c) * amount);
  const rgb = (mix((n >> 16) & 0xff) << 16) | (mix((n >> 8) & 0xff) << 8) | mix(n & 0xff);
  return `#${rgb.toString(16).padStart(6, '0')}`;
}

/** Кегль из пунктов общей таблицы в доли ширины пластины. */
const pt = (size: number) => `${(size / SHEET.width) * 100}cqw`;

/** Доля ширины под образ — из той же таблицы, что и выгрузка. */
const share = (v: number) => `0 0 ${v * 100}%`;

interface Props {
  slide: StageSlide;
  /** Номер слайда с нуля — для арабского фолио на обложке и финале. */
  index: number;
  imageUrl: string | null;
  diagram?: StageDiagram | null;
  palette?: Record<string, string> | null;
}

export function SlideStage({ slide, index, imageUrl, diagram, palette }: Props) {
  const color = (name: string): string => {
    const v = palette?.[name] ?? FALLBACK[name] ?? '#1D1E24';
    return v.startsWith('#') ? v : `#${v}`;
  };

  const c = slide.content;
  const img = imageUrl;
  const side = slide.imageSide;

  const folio = (
    <span className="stg-folio" style={{ color: color('museumIndigo'), fontSize: pt(T.folio) }}>
      {String(index + 1).padStart(2, '0')}
    </span>
  );

  const plate = (
    <img className="stg-img" src={img ?? ''} alt="" />
  );

  /** Обложка: текст слева 42%, гравюра справа 58%. */
  if (slide.layout === 'cover') {
    return (
      <div className="stg" style={{ background: color('archiveBlack') }}>
        <div className="stg-row">
          <div className="stg-col stg-pad" style={{ flex: img ? '0 0 42%' : '1' }}>
            {c.eyebrow && (
              <div
                className="stg-eyebrow"
                style={{ color: lighten(color('burntUmber'), 0.3), fontSize: pt(T.coverEyebrow) }}
              >
                {c.eyebrow}
              </div>
            )}
            <div className="stg-display" style={{ color: VELLUM, fontSize: pt(T.coverTitle) }}>
              {c.title}
            </div>
            {c.subtitle && (
              <div className="stg-body" style={{ color: color('deepSepia'), fontSize: pt(T.coverSubtitle) }}>
                {c.subtitle}
              </div>
            )}
          </div>
          {img && <div className="stg-plate" style={{ flex: share(SLIDE_SPEC.imageShare.cover) }}>{plate}</div>}
        </div>
        {folio}
      </div>
    );
  }

  /** Разделитель: имя части, 60–70% листа — спокойное поле. */
  if (slide.layout === 'divider') {
    return (
      <div className="stg" style={{ background: color('deepIndigo') }}>
        <div className="stg-row">
          <div className="stg-col stg-pad stg-mid" style={{ flex: img ? '0 0 70%' : '1' }}>
            {c.eyebrow && (
              <div
                className="stg-eyebrow"
                style={{ color: lighten(color('burntUmber'), 0.3), fontSize: pt(T.dividerEyebrow) }}
              >
                {c.eyebrow}
              </div>
            )}
            <div className="stg-display" style={{ color: VELLUM, fontSize: pt(T.dividerTitle) }}>
              {c.title}
            </div>
          </div>
          {img && <div className="stg-plate" style={{ flex: share(SLIDE_SPEC.imageShare.divider) }}>{plate}</div>}
        </div>
      </div>
    );
  }

  /** Цитата: бумажная пластина, текст тушью по центру вертикали. */
  if (slide.layout === 'quote') {
    return (
      <div className="stg" style={{ background: color('agedPaper') }}>
        <div className={`stg-row ${side === 'left' ? 'rev' : ''}`}>
          <div className="stg-col stg-pad stg-mid stg-quote">
            <div
              className="stg-display"
              style={{ color: color('etchingInk'), fontSize: pt(T.quote), lineHeight: 1.15 }}
            >
              {c.quote ?? c.title}
            </div>
            {c.attribution && (
              <div
                className="stg-body"
                style={{ color: color('etchingInk'), opacity: 0.6, fontSize: pt(T.attribution) }}
              >
                {c.attribution}
              </div>
            )}
          </div>
          {img && <div className="stg-plate" style={{ flex: share(SLIDE_SPEC.imageShare.quote) }}>{plate}</div>}
        </div>
      </div>
    );
  }

  /** Клинический фрагмент: бумага, спокойная колонка абзацев. */
  if (slide.layout === 'clinical') {
    const paragraphs = c.bullets?.length ? c.bullets : c.subtitle ? [c.subtitle] : [];
    const ink = color('etchingInk');
    return (
      <div className="stg" style={{ background: color('agedPaper') }}>
        <div className={`stg-row ${side === 'left' ? 'rev' : ''}`}>
          <div className="stg-col stg-pad">
            <div className="stg-display" style={{ color: ink, fontSize: pt(T.clinicalTitle) }}>
              {c.title}
            </div>
            <div className="stg-flow">
              {paragraphs.map((p, i) => (
                <p key={i} className="stg-body" style={{ color: ink, fontSize: pt(T.clinicalBody) }}>
                  {p}
                </p>
              ))}
            </div>
            {c.question && (
              <div className="stg-body" style={{ color: color('burntUmber'), fontSize: pt(T.question) }}>
                {c.question}
              </div>
            )}
          </div>
          {img && <div className="stg-plate" style={{ flex: share(SLIDE_SPEC.imageShare.clinical) }}>{plate}</div>}
        </div>
      </div>
    );
  }

  /** Сопоставление: общая гравюра полосой сверху, два столбца со швом. */
  if (slide.layout === 'comparison') {
    const cards = c.cards ?? [];
    return (
      <div className="stg stg-vert" style={{ background: color('archiveBlack') }}>
        {img && (
          <div className="stg-band" style={{ flex: share(SLIDE_SPEC.comparisonBand) }}>
            {plate}
          </div>
        )}
        <div className="stg-col stg-pad" style={{ flex: 1 }}>
          <div className="stg-display" style={{ color: VELLUM, fontSize: pt(T.comparisonTitle) }}>
            {c.title}
          </div>
          <div className="stg-cols" style={{ borderColor: SEAM }}>
            {cards.slice(0, 2).map((card, i) => (
              <div key={i} className="stg-cell">
                <div className="stg-display" style={{ color: VELLUM, fontSize: pt(T.cardTitle) }}>
                  {card.title}
                </div>
                <div className="stg-body" style={{ color: color('deepSepia'), fontSize: pt(T.cardBody) }}>
                  {card.body}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  /** Финал: один вывод по центру вертикали. */
  if (slide.layout === 'final') {
    return (
      <div className="stg" style={{ background: color('archiveBlack') }}>
        <div className="stg-col stg-pad stg-mid" style={{ width: '82%' }}>
          <div
            className="stg-display"
            style={{ color: VELLUM, fontSize: pt(T.finalTitle), lineHeight: 1.1 }}
          >
            {c.title ?? c.quote ?? c.subtitle}
          </div>
          {c.subtitle && c.title && (
            <div className="stg-body" style={{ color: color('deepSepia'), fontSize: pt(T.finalSubtitle) }}>
              {c.subtitle}
            </div>
          )}
        </div>
        {folio}
      </div>
    );
  }

  /** Схема: лист атласа — рисует код, не художник. */
  if (slide.layout === 'diagram' && diagram) {
    const panel = color('deepIndigo');
    const line = color('museumIndigo');
    const node = (item: { label: string; sub?: string }, i: number) => (
      <div key={i} className="stg-node" style={{ background: panel, borderColor: line }}>
        <div className="stg-display" style={{ color: VELLUM, fontSize: pt(T.nodeLabel) }}>
          {item.label}
        </div>
        {item.sub && (
          <div className="stg-body" style={{ color: color('deepSepia'), fontSize: pt(T.nodeSub) }}>
            {item.sub}
          </div>
        )}
      </div>
    );
    return (
      <div className="stg stg-vert" style={{ background: color('archiveBlack') }}>
        <div className="stg-col stg-pad" style={{ flex: 1 }}>
          <div className="stg-display" style={{ color: VELLUM, fontSize: pt(T.theoryTitle) }}>
            {c.title}
          </div>
          {diagram.kind === 'flow' ? (
            <div className="stg-flowbox">
              {diagram.items.map((item, i) => (
                <div key={i} className="stg-step">
                  {node(item, i)}
                  {i < diagram.items.length - 1 && (
                    <span className="stg-arrow" style={{ color: line }}>
                      ↓
                    </span>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="stg-pillars">{diagram.items.map(node)}</div>
          )}
        </div>
      </div>
    );
  }

  /** Теория и всё остальное: тезис, пункты, рабочий вопрос. */
  const plateCap: CSSProperties = { color: VELLUM, opacity: 0.75, fontSize: pt(T.folio) };
  return (
    <div className="stg" style={{ background: color('archiveBlack') }}>
      <div className={`stg-row ${side === 'left' ? 'rev' : ''}`}>
        <div className="stg-col stg-pad">
          <div className="stg-display" style={{ color: VELLUM, fontSize: pt(T.theoryTitle) }}>
            {c.title}
          </div>
          <div className="stg-flow">
            {(c.bullets ?? []).map((b, i) => (
              <div key={i} className="stg-bullet" style={{ color: VELLUM, fontSize: pt(T.bullets) }}>
                <span className="stg-dia">◇</span>
                <span>{b}</span>
              </div>
            ))}
          </div>
          {c.question && (
            <div className="stg-body" style={{ color: color('burntUmber'), fontSize: pt(T.question) }}>
              {c.question}
            </div>
          )}
        </div>
        {img && (
          <div className="stg-plate" style={{ flex: share(SLIDE_SPEC.imageShare.theory) }}>
            {plate}
            {c.plate && (
              <span className="stg-cap" style={plateCap}>
                {c.plate}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
