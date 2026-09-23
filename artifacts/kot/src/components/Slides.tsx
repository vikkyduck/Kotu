import { useState, useEffect, useCallback } from 'react';
import { useApp } from '@/hooks/use-app';
import { Icon } from '@/lib/icons';
import { SlideViewer } from './SlideViewer';
import { DeckForm } from './slides/DeckForm';
import { DiagramThumb } from './slides/DiagramThumb';
import {
  layoutName,
  type DeckFull,
  type DeckImage,
  type DiagramSpec,
  type SlideContent,
} from '@/lib/deck';

/**
 * Вторая строка плитки в сетке слайдов без образа — иначе плитка несёт
 * только заголовок, и слайд с богатым содержимым выглядит пустым словом
 * или фразой на фоне, хотя на деле полон текста (см. открытый слайд крупно).
 */
function tilePreview(c: SlideContent): string | undefined {
  if (c.bullets?.length) return c.bullets.slice(0, 2).join(' · ');
  return c.subtitle || c.cards?.[0]?.body || c.question || c.attribution;
}

export function Slides() {
  // Какую колоду открыть, решает библиотека: инструмент — это действие,
  // а список сделанного лежит там же, где книги и лекции.
  const { screen, go, toast, openSheet, activeDeckId, openDeck } = useApp();
  const openId = activeDeckId;
  const [deck, setDeck] = useState<DeckFull | null>(null);
  /** Какой слайд открыт крупно — индекс в колоде; null = просмотр закрыт. */
  const [openSlide, setOpenSlide] = useState<number | null>(null);

  const [busy, setBusy] = useState(false);

  // Имя стилевого пакета показывается на готовой колоде — за этим и список.
  const [packs, setPacks] = useState<{ id: number; name: string }[]>([]);

  const loadPacks = useCallback(async () => {
    try {
      const res = await fetch('/api/style-packs');
      if (res.ok) setPacks(await res.json());
    } catch { /* тихо: без списка стилей сервер сам возьмёт первый доступный */ }
  }, []);

  const loadOne = useCallback(async (id: number) => {
    try {
      const res = await fetch(`/api/decks/${id}`);
      if (res.ok) {
        setDeck(await res.json());
      } else if (res.status === 404) {
        // Колоду удалили в другой вкладке — не опрашивать же её вечно.
        toast('Презентация не найдена');
        go('s-home');
      }
    } catch { /* тихо: поллинг повторит */ }
  }, [toast, go]);

  // Форма новой презентации — то, что видно, когда ничего не открыто.
  const creating = openId === null;

  // Имя стиля показывается на готовой колоде.
  useEffect(() => {
    if (screen === 's-slides' && !creating) void loadPacks();
  }, [screen, creating, loadPacks]);

  useEffect(() => {
    if (openId === null) {
      setDeck(null);
      return;
    }
    setOpenSlide(null);
    void loadOne(openId);
  }, [openId, loadOne]);

  // Пока конвейер раскладывает или рисует — подтягиваем колоду, чтобы прогресс двигался сам.
  useEffect(() => {
    if (openId === null || !deck) return;
    if (deck.status !== 'storyboarding' && deck.status !== 'drawing') return;
    const t = setInterval(() => void loadOne(openId), 3000);
    return () => clearInterval(t);
  }, [openId, deck, loadOne]);

  const patchSlide = async (sid: number, body: Record<string, unknown>) => {
    if (!deck) return;
    try {
      const res = await fetch(`/api/decks/${deck.id}/slides/${sid}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) await loadOne(deck.id);
      else {
        const data = await res.json().catch(() => ({}));
        toast(data.message ?? 'Не удалось сохранить');
      }
    } catch {
      toast('Нет связи с сервером. Попробуйте ещё раз.');
    }
  };

  const approve = async () => {
    if (!deck) return;
    const hasImages = deck.slides.some((s) => s.imageBrief !== null);
    setBusy(true);
    try {
      const res = await fetch(`/api/decks/${deck.id}/approve`, { method: 'POST' });
      if (res.ok) {
        toast(hasImages ? 'Рисую образы. Можно закрыть страницу.' : 'Готово — презентация собрана');
        await loadOne(deck.id);
      } else {
        const data = await res.json().catch(() => ({}));
        toast(data.message ?? 'Не удалось запустить');
      }
    } catch {
      toast('Нет связи с сервером. Попробуйте ещё раз.');
    } finally {
      setBusy(false);
    }
  };

  const redraw = async (sid: number, instruction: string) => {
    if (!deck) return;
    try {
      const res = await fetch(`/api/decks/${deck.id}/slides/${sid}/redraw`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instruction }),
      });
      if (res.ok) {
        await loadOne(deck.id);
      } else {
        const data = await res.json().catch(() => ({}));
        toast(data.message ?? 'Не удалось запустить перерисовку');
      }
    } catch {
      toast('Нет связи с сервером. Попробуйте ещё раз.');
    }
  };

  /** Переделать текст слайда словами автора — работает и до, и после рисования. */
  const rewrite = async (sid: number, instruction: string) => {
    if (!deck) return;
    try {
      const res = await fetch(`/api/decks/${deck.id}/slides/${sid}/rewrite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instruction }),
      });
      if (res.ok) {
        toast('Переделываю слайд — покажу, когда будет готово');
        await loadOne(deck.id);
      } else {
        const data = await res.json().catch(() => ({}));
        toast(data.message ?? 'Не удалось переделать слайд');
      }
    } catch {
      toast('Нет связи с сервером. Попробуйте ещё раз.');
    }
  };

  const toLibrary = async () => {
    if (!deck) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/decks/${deck.id}/to-library`, { method: 'POST' });
      if (res.ok) toast('Сохранила в библиотеку — можно опираться в лекциях');
      else {
        const data = await res.json().catch(() => ({}));
        toast(data.message ?? 'Не удалось сохранить');
      }
    } catch {
      toast('Нет связи с сервером. Попробуйте ещё раз.');
    } finally {
      setBusy(false);
    }
  };

  // Тупика после ошибки быть не должно: конвейер можно перезапустить.
  const retry = async () => {
    if (!deck) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/decks/${deck.id}/retry`, { method: 'POST' });
      if (res.ok) {
        toast('Пробую ещё раз');
        await loadOne(deck.id);
      } else {
        const data = await res.json().catch(() => ({}));
        toast(data.message ?? 'Не удалось перезапустить');
      }
    } catch {
      toast('Нет связи с сервером. Попробуйте ещё раз.');
    } finally {
      setBusy(false);
    }
  };

  /** Удалить можно на любом этапе — ждать окончания работы незачем. */
  const removeDeck = async (id: number) => {
    if (!window.confirm('Удалить презентацию?')) return;
    try {
      const res = await fetch(`/api/decks/${id}`, { method: 'DELETE' });
      if (res.ok) {
        toast('Презентация удалена');
        if (openId === id) go('s-home');
      } else {
        const data = await res.json().catch(() => ({}));
        toast(data.message ?? 'Не удалось удалить');
      }
    } catch {
      toast('Нет связи с сервером. Попробуйте ещё раз.');
    }
  };
  const remove = async () => { if (deck) await removeDeck(deck.id); };

  if (screen !== 's-slides') return null;

  // ── Открытая презентация ────────────────────────────────────────────────
  if (deck) {
    const working = deck.status === 'storyboarding' || deck.status === 'drawing';
    const briefCount = deck.slides.filter((s) => s.imageBrief !== null).length;
    // Имя стиля серии — из списка пакетов; не нашли — строку не показываем.
    const packName = packs.find((p) => p.id === deck.stylePackId)?.name;

    // Судьбу картинки решает последняя попытка. «Последняя» — по id, а не по
    // attempt: перерисовка начинает счёт попыток заново с 1.
    const lastImage = new Map<number, DeckImage>();
    for (const im of deck.images) {
      const prev = lastImage.get(im.slideId);
      if (!prev || im.id > prev.id) lastImage.set(im.slideId, im);
    }

    return (
      <section className="screen active" id="s-slides">
        <button className="btn ghost back-link" onClick={() => go('s-home')}>
          <Icon name="back" /> В библиотеку
        </button>

        <h2 className="h2">{deck.title}</h2>

        {/* Удалить можно на любом этапе — ждать окончания работы незачем.
            Кнопка живёт рядом с заголовком, а не только на готовой колоде. */}
        <div className="deck-tools">
          {deck.status !== 'storyboarding' && (
            <button className="chg" disabled={busy} onClick={() => void toLibrary()}>
              сохранить в библиотеку
            </button>
          )}
          <button className="chg deck-drop" onClick={() => void remove()}>
            удалить презентацию
          </button>
        </div>

        {deck.status === 'error' && (
          <div className="errblock">
            <h3 className="errttl">Не получилось</h3>
            <p className="errwhy">{deck.error ?? 'Что-то пошло не так.'}</p>
            <div className="btnrow">
              <button className="btn primary" style={{ flex: 1 }} disabled={busy} onClick={() => void retry()}>
                {busy ? 'Запускаю…' : 'Попробовать ещё раз'}
              </button>
              <button className="btn danger" onClick={() => void remove()}>
                <Icon name="trash" /> Удалить
              </button>
            </div>
          </div>
        )}

        {/* Ошибка правки колоду не роняет: статус остаётся рабочим, но сказать
            автору, что не вышло, надо — иначе указание пропадает молча. */}
        {deck.status !== 'error' && deck.error && (
          <p className="tnote bad"><Icon name="info" /> {deck.error}</p>
        )}

        {working && (
          <div className="panel bigjob">
            <div className="bi"><Icon name="clock" /></div>
            {/* Заголовок — из сообщения о ходе работы: «рисую образ 2 из 5»
                и «переделываю слайд» точнее общей фразы про раскладку. */}
            <p className="pstat">
              {deck.statusMessage ||
                (deck.status === 'drawing' ? 'Рисую образы' : 'Раскладываю по слайдам')}
            </p>
            <p className="preassure">
              <b>Можно закрыть страницу.</b> Работа не пропадёт.
            </p>
          </div>
        )}

        {/* Раскадровка на утверждение: рисование стоит денег, поэтому — человек в цикле */}
        {deck.status === 'storyboard_ready' && (
          <>
            <p className="sub">
              Посмотрите раскадровку. Любой слайд можно открыть крупно и переделать —
              руками или словами. Рисовать начну только после утверждения.
            </p>
            {deck.slides.map((s, i) => (
              <div key={s.id} className="panel sb-slide">
                <div className="sb-num">
                  {String(i + 1).padStart(2, '0')} · {layoutName(s.layout)}
                  <button className="sb-open" onClick={() => setOpenSlide(i)}>
                    <Icon name="eye" /> открыть слайд
                  </button>
                </div>
                {(s.content.title || s.content.quote) && (
                  <h3 className="sb-title">{s.content.title || s.content.quote}</h3>
                )}
                {/* Схема — не образ: показываем состав, рисовать её будет код */}
                {s.layout === 'diagram' && s.diagramSpec && (
                  <div className="sb-diagram">
                    Схема: {s.diagramSpec.items.length}{' '}
                    {s.diagramSpec.items.length < 5 ? 'шага' : 'шагов'}
                    <span className="sb-diagram-items">
                      {s.diagramSpec.items
                        .map((it) => it.label)
                        .join(s.diagramSpec.kind === 'flow' ? ' → ' : ' · ')}
                    </span>
                  </div>
                )}
                {s.content.bullets && s.content.bullets.length > 0 && (
                  <ul className="sb-bullets">
                    {s.content.bullets.map((b, j) => (
                      <li key={j}>{b}</li>
                    ))}
                  </ul>
                )}
                {s.imageBrief !== null ? (
                  <div className="sb-brief">
                    <span className="sb-brief-lbl">Образ</span>
                    {s.imageBrief}
                    <div className="sb-actions">
                      <button
                        className="btn"
                        onClick={() =>
                          void patchSlide(s.id, {
                            imageSide: s.imageSide === 'left' ? 'right' : 'left',
                          })
                        }
                      >
                        сторона: {s.imageSide === 'left' ? 'слева' : 'справа'}
                      </button>
                      <button
                        className="btn"
                        onClick={() =>
                          openSheet('Каким должен быть образ?', 'C', (txt) =>
                            void patchSlide(s.id, { imageBrief: txt }),
                          )
                        }
                      >
                        <Icon name="edit" /> править
                      </button>
                      <button
                        className="btn danger"
                        onClick={() => void patchSlide(s.id, { imageBrief: null })}
                      >
                        убрать образ
                      </button>
                    </div>
                  </div>
                ) : s.layout !== 'diagram' ? (
                  <div className="sb-actions">
                    <button
                      className="btn ghost"
                      onClick={() =>
                        openSheet('Каким должен быть образ?', 'C', (txt) =>
                          void patchSlide(s.id, { imageBrief: txt }),
                        )
                      }
                    >
                      добавить образ
                    </button>
                  </div>
                ) : null}
              </div>
            ))}
            <div className="sb-total">Образов: {briefCount}</div>
            <button className="btn primary big" disabled={busy} onClick={() => void approve()}>
              {busy ? 'Запускаю…' : 'Утвердить — рисуем'} <Icon name="arrow" />
            </button>
          </>
        )}

        {deck.status === 'ready' && (
          <>
            <div className="done-head">
              <span className="dh-ic"><Icon name="check" /></span>
              <div>
                <h3>Готово — презентация собрана</h3>
                <p>Слайдов: {deck.slides.length}. Можно скачать или доработать образы.</p>
              </div>
            </div>
            {packName && (
              <p className="doc-meta" style={{ marginBottom: 10 }}>Стиль: {packName}</p>
            )}
            <p className="tnote">
              <Icon name="info" /> Нажмите на слайд — он откроется крупно. Там можно
              править текст руками или сказать словами, что переделать.
            </p>

            <div className="sgrid">
              {deck.slides.map((s, i) => {
                const doubted = lastImage.get(s.id)?.status === 'rejected';
                const canRedraw = s.imageBrief !== null;
                return (
                  <div key={s.id} className="slide" onClick={() => setOpenSlide(i)}>
                    {s.imageId !== null ? (
                      <div className="th th-img">
                        <img
                          src={`/api/decks/${deck.id}/images/${s.imageId}/file`}
                          alt={s.content.title || ''}
                        />
                        {doubted && <span className="tag-draft">стоит посмотреть</span>}
                      </div>
                    ) : s.layout === 'diagram' && s.diagramSpec ? (
                      /* Схема на пластине — мини-SVG вместо текстовой заглушки */
                      <div className={`th th-p${i % 4} th-diagram`}>
                        <DiagramThumb spec={s.diagramSpec} />
                      </div>
                    ) : (
                      <div className={`th th-p${i % 4}`}>
                        <span className="st">
                          <b className="st-title">
                            {s.content.title || s.content.quote || layoutName(s.layout)}
                          </b>
                          {tilePreview(s.content) && (
                            <span className="st-sub">{tilePreview(s.content)}</span>
                          )}
                        </span>
                      </div>
                    )}
                    <div className={`cap ${doubted || s.imageStatus === 'error' ? 'busy' : ''}`}>
                      {s.imageStatus === 'error' ? (
                        <><Icon name="loop" /> образ не нарисовался — нажмите</>
                      ) : canRedraw ? (
                        <><Icon name="eye" /> открыть и изменить</>
                      ) : (
                        <><Icon name="eye" /> {layoutName(s.layout)}</>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="btnrow">
              <a
                className="btn primary"
                style={{ flex: 1 }}
                href={`/api/decks/${deck.id}/export?format=pptx`}
              >
                <Icon name="download" /> Скачать PPTX
              </a>
              <a className="btn" href={`/api/decks/${deck.id}/export?format=pdf`}>
                <Icon name="download" /> PDF
              </a>
            </div>
          </>
        )}

        {/* Слайд крупно — поверх экрана: правки руками и указание нейронке.
            Индекс, а не id: стрелками автор ходит по колоде, не закрывая окно. */}
        {openSlide !== null && deck.slides[openSlide] && (
          <SlideViewer
            deck={deck}
            index={openSlide}
            onIndex={setOpenSlide}
            onClose={() => setOpenSlide(null)}
            patchSlide={patchSlide}
            redraw={redraw}
            rewrite={rewrite}
            toast={toast}
          />
        )}
      </section>
    );
  }

  // ── Новая презентация ───────────────────────────────────────────────────
  // Форма живёт отдельно и сама знает, из чего собирать колоду.
  return <DeckForm active={screen === 's-slides'} onCreated={openDeck} />;
}
