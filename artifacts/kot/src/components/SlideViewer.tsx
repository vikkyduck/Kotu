import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '@/lib/icons';
import { SlideStage } from './SlideStage';
import { MAX_CARDS, SLIDE_FIELDS } from '@workspace/db/slides';
import {
  FIELD_RU,
  LAYOUTS,
  deckWorking,
  fieldsOf,
  layoutHasImage,
  layoutName,
  layoutSided,
  lastImageBySlide,
  type DeckFull,
  type DeckSlide,
  type SlideContent,
  type SlideField,
} from '@/lib/deck';

/**
 * Слайд крупно: пластина 16:9 как в экспорте, под ней — правки руками и
 * указание нейронке. Пластина рисуется из ТЕКУЩЕЙ формы, а не из сохранённого
 * слайда: автор печатает и сразу видит, что получится.
 */

interface Card {
  title: string;
  body: string;
}

interface Form {
  layout: string;
  eyebrow: string;
  title: string;
  subtitle: string;
  quote: string;
  attribution: string;
  question: string;
  plate: string;
  /** Тезисы — по одному в строке: править список текстом привычнее, чем полями. */
  bullets: string;
  cards: Card[];
  notes: string;
  imageBrief: string;
}

function toForm(s: DeckSlide): Form {
  const c = s.content ?? {};
  return {
    layout: s.layout,
    eyebrow: c.eyebrow ?? '',
    title: c.title ?? '',
    subtitle: c.subtitle ?? '',
    quote: c.quote ?? '',
    attribution: c.attribution ?? '',
    question: c.question ?? '',
    plate: c.plate ?? '',
    bullets: (c.bullets ?? []).join('\n'),
    cards: Array.from({ length: MAX_CARDS }, (_, i) => ({
      title: c.cards?.[i]?.title ?? '',
      body: c.cards?.[i]?.body ?? '',
    })),
    notes: s.notes ?? '',
    imageBrief: s.imageBrief ?? '',
  };
}

/**
 * Из формы — content этого макета. Поля, которых на макете нет, переносим из
 * прежнего содержимого нетронутыми: смена функции слайда не должна стирать
 * тезисы насовсем — автор передумает и вернёт «Теорию», а текст на месте.
 */
function toContent(f: Form, base: SlideContent = {}): SlideContent {
  const fields = fieldsOf(f.layout);
  const out: SlideContent = {};
  for (const name of SLIDE_FIELDS) {
    if (fields.includes(name)) continue;
    const kept = (base as Record<string, unknown>)[name];
    if (kept !== undefined) (out as Record<string, unknown>)[name] = kept;
  }
  const put = (name: SlideField, value: string): void => {
    if (fields.includes(name) && value.trim() !== '') {
      (out as Record<string, unknown>)[name] = value.trim();
    }
  };
  put('eyebrow', f.eyebrow);
  put('title', f.title);
  put('subtitle', f.subtitle);
  put('quote', f.quote);
  put('attribution', f.attribution);
  put('question', f.question);
  put('plate', f.plate);

  if (fields.includes('bullets')) {
    const bullets = f.bullets
      .split('\n')
      .map((b) => b.trim())
      .filter((b) => b !== '');
    if (bullets.length > 0) out.bullets = bullets;
  }
  if (fields.includes('cards')) {
    const cards = f.cards
      .map((c) => ({ title: c.title.trim(), body: c.body.trim() }))
      .filter((c) => c.title !== '' || c.body !== '');
    if (cards.length > 0) out.cards = cards;
  }
  return out;
}

interface Props {
  deck: DeckFull;
  index: number;
  onIndex: (i: number) => void;
  onClose: () => void;
  /** Все три — true, если сервер принял; об отказе они уже сказали тостом сами. */
  patchSlide: (sid: number, body: Record<string, unknown>) => Promise<boolean>;
  redraw: (sid: number, instruction: string) => Promise<boolean>;
  rewrite: (sid: number, instruction: string) => Promise<boolean>;
  toast: (message: string) => void;
}

export function SlideViewer({
  deck,
  index,
  onIndex,
  onClose,
  patchSlide,
  redraw,
  rewrite,
  toast,
}: Props) {
  const slide = deck.slides[index];
  const working = deckWorking(deck.status);

  const [form, setForm] = useState<Form | null>(slide ? toForm(slide) : null);
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState(false);
  // dirty в ref, а не в состоянии: он нужен эффекту синхронизации, а сам
  // эффект от него перезапускаться не должен.
  const dirty = useRef(false);
  const [dirtyView, setDirtyView] = useState(false);

  const sid = slide?.id;
  // Сменили слайд — незакрытые правки предыдущего с собой не тащим.
  useEffect(() => {
    dirty.current = false;
    setDirtyView(false);
    setInstruction('');
  }, [sid]);

  // Слайд обновился на сервере (сохранение, переделка нейронкой) — подхватываем,
  // но только если автор не набирает правку прямо сейчас.
  const stamp = slide ? `${slide.layout}|${JSON.stringify(slide.content)}|${slide.notes}|${slide.imageBrief}` : '';
  useEffect(() => {
    if (!slide || dirty.current) return;
    setForm(toForm(slide));
  }, [stamp, slide]);

  // Пока окно открыто, страница под ним не ездит: на телефоне иначе
  // прокручивается фон, а не список правок.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Уйти с несохранёнными правками — только переспросив: система сама
  // ничего не стирает. dirty в ref, поэтому эффекту клавиш он не зависимость.
  const leave = (fn: () => void): void => {
    if (dirty.current && !window.confirm('Правки не сохранены. Уйти без сохранения?')) return;
    fn();
  };
  const leaveRef = useRef(leave);
  leaveRef.current = leave;

  // Корень окна: пока поверх вход (сессия кончилась), окно спрятано вместе с
  // приложением — клавиши тогда не его, иначе Escape на экране входа закрыл бы
  // слайд с правками.
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!rootRef.current || rootRef.current.getClientRects().length === 0) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
      if (typing) return;
      if (e.key === 'Escape') leaveRef.current(onClose);
      if (e.key === 'ArrowLeft' && index > 0) leaveRef.current(() => onIndex(index - 1));
      if (e.key === 'ArrowRight' && index < deck.slides.length - 1) {
        leaveRef.current(() => onIndex(index + 1));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, deck.slides.length, onIndex, onClose]);

  if (!slide || !form) return null;

  const set = (patch: Partial<Form>): void => {
    dirty.current = true;
    setDirtyView(true);
    setForm((f) => (f ? { ...f, ...patch } : f));
  };

  const fields = fieldsOf(form.layout);
  const imageUrl = slide.imageId !== null ? `/api/decks/${deck.id}/images/${slide.imageId}/file` : null;
  // Судьба образа — по последней попытке; вердикт автору стоит видеть.
  const last = lastImageBySlide(deck.images).get(slide.id) ?? null;

  // Образ на схеме и финале сервер не принимает — и правильно делает.
  const brief = form.imageBrief.trim();
  let briefChange: string | null | undefined;
  if (layoutHasImage(form.layout)) {
    if (brief === '') briefChange = slide.imageBrief !== null ? null : undefined;
    else if (brief !== slide.imageBrief) briefChange = brief;
  }
  // Новый образ слайду без картинки на готовой колоде сервер начинает рисовать
  // прямо при сохранении — так же, как в раскадровке.
  const drawsOnSave =
    deck.status === 'ready' && slide.imageId === null && typeof briefChange === 'string';

  /**
   * Сохранить форму; true — сервер принял (об отказе patchSlide сказал сам).
   * instruction — замечание к образу, если сохранение само начнёт рисовать.
   */
  const save = async (instruction?: string): Promise<boolean> => {
    setBusy(true);
    try {
      const body: Record<string, unknown> = {
        content: toContent(form, slide.content),
        notes: form.notes,
        layout: form.layout,
      };
      if (briefChange !== undefined) body.imageBrief = briefChange;
      if (instruction) body.instruction = instruction;
      if (!(await patchSlide(slide.id, body))) return false;
      dirty.current = false;
      setDirtyView(false);
      toast('Сохранила');
      return true;
    } finally {
      setBusy(false);
    }
  };

  const askModel = async (what: 'text' | 'image'): Promise<void> => {
    const text = instruction.trim();
    // Перерисовать можно и без указания — «ещё раз», например после сбоя.
    if (what === 'text' && text === '') {
      toast('Напишите, что изменить');
      return;
    }
    // Несохранённые правки модель не видит, а её ответ под ними не показался бы
    // и затёрся бы следующим «Сохранить» — поэтому сначала сохраняем.
    if (dirty.current) {
      if (drawsOnSave) {
        // Сохранение уже начало рисовать — замечание уехало с ним; второй
        // запрос к занятой колоде получил бы отказ.
        if (!(await save(what === 'image' ? text : undefined))) return;
        if (what === 'image') setInstruction('');
        else toast('Рисую образ — о тексте попросите, когда дорисую');
        return;
      }
      if (!(await save())) return;
    }
    setBusy(true);
    try {
      if (await (what === 'text' ? rewrite : redraw)(slide.id, text)) setInstruction('');
    } finally {
      setBusy(false);
    }
  };

  const field = (name: SlideField, rows = 1) => {
    if (!fields.includes(name)) return null;
    const value = (form as unknown as Record<string, string>)[name] ?? '';
    return (
      <label className="vw-field" key={name}>
        <span className="fieldlbl">{FIELD_RU[name] ?? name}</span>
        {rows > 1 ? (
          <textarea
            className="topic"
            rows={rows}
            value={value}
            disabled={working}
            onChange={(e) => set({ [name]: e.target.value } as Partial<Form>)}
          />
        ) : (
          <input
            className="field"
            value={value}
            disabled={working}
            onChange={(e) => set({ [name]: e.target.value } as Partial<Form>)}
          />
        )}
      </label>
    );
  };

  // Портал вне .wrap: внутри неё (z-index 1) окно оказалось бы под шапкой —
  // fixed не спасает, стопка считается внутри своего контекста наложения.
  // #modal-root лежит в приложении и прячется с ним, когда поверх вход.
  return createPortal(
    <div ref={rootRef} className="vw" role="dialog" aria-modal="true" aria-label="Слайд крупно">
      <div className="vw-top">
        <button className="iconbtn" onClick={() => leave(onClose)} title="Закрыть">
          <Icon name="x" />
        </button>
        <span className="vw-count">
          Слайд {index + 1} из {deck.slides.length} · {layoutName(slide.layout)}
        </span>
        <div className="vw-nav">
          <button
            className="iconbtn"
            disabled={index === 0}
            onClick={() => leave(() => onIndex(index - 1))}
            title="Предыдущий слайд"
          >
            <Icon name="back" />
          </button>
          <button
            className="iconbtn"
            disabled={index >= deck.slides.length - 1}
            onClick={() => leave(() => onIndex(index + 1))}
            title="Следующий слайд"
          >
            <Icon name="arrow" />
          </button>
        </div>
      </div>

      <div className="vw-body">
        <div className="vw-stagewrap">
          <SlideStage
            slide={{ layout: form.layout, content: toContent(form, slide.content), imageSide: slide.imageSide }}
            index={index}
            imageUrl={imageUrl}
            diagram={slide.diagramSpec}
            palette={deck.palette}
          />
          {dirtyView && <span className="vw-mark">правки не сохранены</span>}
        </div>

        {working && (
          <p className="tnote">
            <Icon name="clock" /> {deck.statusMessage || 'Работаю над колодой'} — правки откроются,
            когда закончу.
          </p>
        )}

        <div className="panel vw-panel">
          <div className="fieldlbl">Скажите, что изменить</div>
          <textarea
            className="topic"
            rows={2}
            value={instruction}
            disabled={working}
            placeholder="Например: тезисы слишком длинные, оставьте три коротких."
            onChange={(e) => setInstruction(e.target.value)}
          />
          <div className="vw-actions">
            <button
              className="btn primary"
              disabled={busy || working || deck.status === 'error'}
              onClick={() => void askModel('text')}
            >
              <Icon name="loop" /> Переделать текст
            </button>
            {slide.imageBrief !== null && (
              <button
                className="btn"
                disabled={busy || working || deck.status !== 'ready'}
                onClick={() => void askModel('image')}
                title={deck.status !== 'ready' ? 'Образы ещё не нарисованы' : undefined}
              >
                <Icon name="loop" /> Перерисовать образ
              </button>
            )}
          </div>
          {last?.status === 'rejected' && last.verdict && (
            <p className="doc-meta" style={{ marginTop: 10 }}>
              Приёмка засомневалась: {last.verdict}
            </p>
          )}
        </div>

        <div className="panel vw-panel">
          <div className="vw-panel-h">Править руками</div>

          <label className="vw-field">
            <span className="fieldlbl">Функция слайда</span>
            <select
              className="field"
              value={form.layout}
              disabled={working}
              onChange={(e) => set({ layout: e.target.value })}
            >
              {/* Схему руками не завести — её состав даёт только раскадровка */}
              {LAYOUTS.filter(
                (l) => l !== 'diagram' || slide.diagramSpec || slide.layout === 'diagram',
              ).map((l) => (
                <option key={l} value={l}>
                  {layoutName(l)}
                </option>
              ))}
            </select>
          </label>

          {field('eyebrow')}
          {field('title', 2)}
          {field('subtitle', 2)}
          {field('quote', 3)}
          {field('attribution')}
          {field('bullets', 5)}
          {fields.includes('cards') &&
            form.cards.map((card, i) => (
              <div className="vw-card" key={i}>
                <span className="fieldlbl">Колонка {i + 1}</span>
                <input
                  className="field"
                  value={card.title}
                  disabled={working}
                  placeholder="Название"
                  onChange={(e) =>
                    set({
                      cards: form.cards.map((c, j) =>
                        j === i ? { ...c, title: e.target.value } : c,
                      ),
                    })
                  }
                />
                <textarea
                  className="topic"
                  rows={3}
                  value={card.body}
                  disabled={working}
                  placeholder="Текст колонки"
                  onChange={(e) =>
                    set({
                      cards: form.cards.map((c, j) => (j === i ? { ...c, body: e.target.value } : c)),
                    })
                  }
                />
              </div>
            ))}
          {field('question', 2)}
          {field('plate')}

          <label className="vw-field">
            <span className="fieldlbl">Заметки докладчику — их не видно на слайде</span>
            <textarea
              className="topic"
              rows={4}
              value={form.notes}
              disabled={working}
              onChange={(e) => set({ notes: e.target.value })}
            />
          </label>

          {layoutHasImage(form.layout) && (
            <>
              <label className="vw-field">
                <span className="fieldlbl">
                  Мысль образа — что должно быть понятно зрителю. Пусто = слайд без картинки
                </span>
                <textarea
                  className="topic"
                  rows={2}
                  value={form.imageBrief}
                  disabled={working}
                  onChange={(e) => set({ imageBrief: e.target.value })}
                />
              </label>
              {form.imageBrief.trim() !== '' && layoutSided(form.layout) && (
                <button
                  className="chg"
                  disabled={working}
                  onClick={() =>
                    void patchSlide(slide.id, {
                      imageSide: slide.imageSide === 'left' ? 'right' : 'left',
                    })
                  }
                >
                  образ {slide.imageSide === 'left' ? 'слева' : 'справа'} — переставить
                </button>
              )}
            </>
          )}
        </div>
      </div>

      <div className="vw-foot">
        <button className="btn" style={{ flex: 1 }} onClick={() => leave(onClose)}>
          Закрыть
        </button>
        <button
          className="btn primary"
          style={{ flex: 1.4 }}
          disabled={busy || working || !dirtyView}
          onClick={() => void save()}
        >
          {busy ? 'Сохраняю…' : 'Сохранить'}
        </button>
      </div>
    </div>,
    document.getElementById('modal-root') ?? document.body,
  );
}
