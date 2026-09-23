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
import {
  SLIDE_TYPE as T,
  SLIDE_SPEC,
  SHEET,
  BRAND_PALETTE,
  SLIDE_TEXT as TEXT,
  SLIDE_SEAM as SEAM,
  MAX_CARDS,
  layoutHasImage,
  type BrandColor,
  type DiagramSpec,
  type SlideContent,
} from '@workspace/db/slides';

export interface StageSlide {
  layout: string;
  content: SlideContent;
  imageSide: 'left' | 'right';
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
  diagram?: DiagramSpec | null;
  palette?: Record<string, string> | null;
}

export function SlideStage({ slide, index, imageUrl, diagram, palette }: Props) {
  const color = (name: BrandColor): string => {
    const v = palette?.[name] ?? BRAND_PALETTE[name];
    return v.startsWith('#') ? v : `#${v}`;
  };
  // Фон листа и музейное поле (--m для .stg-pad и .stg-folio) — у всех макетов одни.
  const sheet = {
    background: color('archiveBlack'),
    '--m': pt(SLIDE_SPEC.margin),
  } as CSSProperties;

  const c = slide.content;
  // Как в выгрузке: на схеме и финале образа нет, даже если картинка осталась.
  const img = layoutHasImage(slide.layout) ? imageUrl : null;
  const side = slide.imageSide;

  const folio = (
    <span className="stg-folio" style={{ color: TEXT, fontSize: pt(T.folio) }}>
      {String(index + 1).padStart(2, '0')}
    </span>
  );

  const plate = (
    <img className="stg-img" src={img ?? ''} alt="" />
  );

  /** Обложка: текст слева 42%, гравюра справа 58%. */
  if (slide.layout === 'cover') {
    return (
      <div className="stg" style={sheet}>
        <div className="stg-row">
          <div className="stg-col stg-pad">
            {c.eyebrow && (
              <div
                className="stg-eyebrow"
                style={{ color: TEXT, fontSize: pt(T.coverEyebrow) }}
              >
                {c.eyebrow}
              </div>
            )}
            <div className="stg-display" style={{ color: TEXT, fontSize: pt(T.coverTitle) }}>
              {c.title}
            </div>
            {c.subtitle && (
              <div className="stg-body" style={{ color: TEXT, fontSize: pt(T.coverSubtitle) }}>
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
      <div className="stg" style={sheet}>
        <div className="stg-row">
          <div className="stg-col stg-pad stg-mid">
            {c.eyebrow && (
              <div
                className="stg-eyebrow"
                style={{ color: TEXT, fontSize: pt(T.dividerEyebrow) }}
              >
                {c.eyebrow}
              </div>
            )}
            <div className="stg-display" style={{ color: TEXT, fontSize: pt(T.dividerTitle) }}>
              {c.title}
            </div>
          </div>
          {img && <div className="stg-plate" style={{ flex: share(SLIDE_SPEC.imageShare.divider) }}>{plate}</div>}
        </div>
      </div>
    );
  }

  /** Цитата: крупный набор по центру вертикали. */
  if (slide.layout === 'quote') {
    return (
      <div className="stg" style={sheet}>
        <div className={`stg-row ${side === 'left' ? 'rev' : ''}`}>
          <div className="stg-col stg-pad stg-mid stg-quote">
            <div
              className="stg-display"
              style={{ color: TEXT, fontSize: pt(T.quote), lineHeight: 1.15 }}
            >
              {c.quote ?? c.title}
            </div>
            {c.attribution && (
              <div
                className="stg-body"
                style={{ color: TEXT, fontSize: pt(T.attribution) }}
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

  /** Клинический фрагмент: спокойная колонка абзацев. */
  if (slide.layout === 'clinical') {
    const paragraphs = c.bullets?.length ? c.bullets : c.subtitle ? [c.subtitle] : [];
    const ink = TEXT;
    return (
      <div className="stg" style={sheet}>
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
              <div className="stg-body" style={{ color: TEXT, fontSize: pt(T.question) }}>
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
      <div className="stg stg-vert" style={sheet}>
        {img && (
          <div className="stg-band" style={{ flex: share(SLIDE_SPEC.comparisonBand) }}>
            {plate}
          </div>
        )}
        <div className="stg-col stg-pad" style={{ flex: 1 }}>
          <div className="stg-display" style={{ color: TEXT, fontSize: pt(T.comparisonTitle) }}>
            {c.title}
          </div>
          <div className="stg-cols" style={{ borderColor: SEAM }}>
            {cards.slice(0, MAX_CARDS).map((card, i) => (
              <div key={i} className="stg-cell">
                <div className="stg-display" style={{ color: TEXT, fontSize: pt(T.cardTitle) }}>
                  {card.title}
                </div>
                <div className="stg-body" style={{ color: TEXT, fontSize: pt(T.cardBody) }}>
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
      <div className="stg" style={sheet}>
        <div className="stg-col stg-pad stg-mid" style={{ width: '82%' }}>
          <div
            className="stg-display"
            style={{ color: TEXT, fontSize: pt(T.finalTitle), lineHeight: 1.1 }}
          >
            {c.title ?? c.quote ?? c.subtitle}
          </div>
          {c.subtitle && c.title && (
            <div className="stg-body" style={{ color: TEXT, fontSize: pt(T.finalSubtitle) }}>
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
        <div className="stg-display" style={{ color: TEXT, fontSize: pt(T.nodeLabel) }}>
          {item.label}
        </div>
        {item.sub && (
          <div className="stg-body" style={{ color: TEXT, fontSize: pt(T.nodeSub) }}>
            {item.sub}
          </div>
        )}
      </div>
    );
    return (
      <div className="stg stg-vert" style={sheet}>
        <div className="stg-col stg-pad" style={{ flex: 1 }}>
          <div className="stg-display" style={{ color: TEXT, fontSize: pt(T.diagramTitle) }}>
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
            <div className="stg-pillars">
              {diagram.items.slice(0, SLIDE_SPEC.diagram.maxItems).map(node)}
            </div>
          )}
        </div>
      </div>
    );
  }

  /** Теория и всё остальное: тезис, пункты, рабочий вопрос. */
  const plateCap: CSSProperties = { color: TEXT, fontSize: pt(T.plate) };
  return (
    <div className="stg" style={sheet}>
      <div className={`stg-row ${side === 'left' ? 'rev' : ''}`}>
        <div className="stg-col stg-pad">
          <div className="stg-display" style={{ color: TEXT, fontSize: pt(T.theoryTitle) }}>
            {c.title}
          </div>
          <div className="stg-flow">
            {(c.bullets ?? []).map((b, i) => (
              <div key={i} className="stg-bullet" style={{ color: TEXT, fontSize: pt(T.bullets) }}>
                <span className="stg-dia">◊</span>
                <span>{b}</span>
              </div>
            ))}
          </div>
          {c.question && (
            <div className="stg-body" style={{ color: TEXT, fontSize: pt(T.question) }}>
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
