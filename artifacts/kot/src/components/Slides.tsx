import { useState, useEffect, useCallback, useRef } from 'react';
import { useApp } from '@/hooks/use-app';
import { Icon } from '@/lib/icons';
import { SlideViewer } from './SlideViewer';
import { DeckForm } from './slides/DeckForm';
import { DiagramThumb } from './slides/DiagramThumb';
import { OFFLINE, failText, send, json, downloadFile } from '@/lib/http';
import {
  layoutName,
  layoutHasImage,
  layoutSided,
  deckWorking,
  lastImageBySlide,
  type DeckFull,
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
  const { screen, go, leaveMissing, toast, activeDeckId, openDeck } = useApp();
  const openId = activeDeckId;
  const [deck, setDeck] = useState<DeckFull | null>(null);
  /** Открытую колоду не удалось загрузить — текст причины для экрана. */
  const [failed, setFailed] = useState<string | null>(null);
  /** Какой слайд открыт крупно — индекс в колоде; null = просмотр закрыт. */
  const [openSlide, setOpenSlide] = useState<number | null>(null);

  const [busy, setBusy] = useState(false);

  // Имя стилевого пакета показывается на готовой колоде — за этим и список.
  const [packs, setPacks] = useState<{ id: number; name: string }[]>([]);

  // Какая колода открыта сейчас. Ответ опроса, начатого до ухода с колоды,
  // не должен вернуть её на экран: компонент живёт всегда, setDeck сработал бы.
  const openRef = useRef(openId);
  openRef.current = openId;

  const loadPacks = useCallback(async () => {
    try {
      const res = await fetch('/api/style-packs');
      if (res.ok) setPacks(await res.json());
    } catch { /* тихо: без списка стилей сервер сам возьмёт первый доступный */ }
  }, []);

  const loadOne = useCallback(async (id: number) => {
    let res: Response;
    try {
      res = await fetch(`/api/decks/${id}`);
    } catch {
      if (id === openRef.current) setFailed(OFFLINE);
      return;
    }
    if (id !== openRef.current) return;
    if (res.status === 404) {
      // Колоду удалили в другой вкладке — не опрашивать же её вечно.
      toast('Презентация не найдена');
      leaveMissing();
      return;
    }
    if (!res.ok) {
      setFailed(await failText(res, 'Не удалось открыть презентацию'));
      return;
    }
    const data = (await res.json()) as DeckFull;
    if (id !== openRef.current) return;
    setDeck(data);
    setFailed(null);
  }, [toast, leaveMissing]);

  // Форма новой презентации — то, что видно, когда ничего не открыто.
  const creating = openId === null;

  // Имя стиля показывается на готовой колоде.
  useEffect(() => {
    if (screen === 's-slides' && !creating) void loadPacks();
  }, [screen, creating, loadPacks]);

  useEffect(() => {
    // Прежняя колода не висит на экране, пока грузится другая.
    setDeck(null);
    setFailed(null);
    if (openId === null) return;
    setOpenSlide(null);
    void loadOne(openId);
  }, [openId, loadOne]);

  // Пока конвейер раскладывает или рисует — подтягиваем колоду, чтобы прогресс двигался сам.
  useEffect(() => {
    if (openId === null || !deck || !deckWorking(deck.status)) return;
    const t = setInterval(() => void loadOne(openId), 3000);
    return () => clearInterval(t);
  }, [openId, deck, loadOne]);

  /**
   * Запрос-действие над колодой: отказ сервера или обрыв сети — тост с
   * причиной и false; успех — колода перечитана и true. Вызывающему
   * (окну слайда) нужно знать, получилось ли, чтобы не сказать «Сохранила» зря.
   */
  const act = async (url: string, init: RequestInit, fail: string, done?: string): Promise<boolean> => {
    if (!deck) return false;
    const r = await send(url, init, fail);
    if (!r.ok) {
      toast(r.message);
      return false;
    }
    if (done) toast(done);
    await loadOne(deck.id);
    return true;
  };

  const base = deck ? `/api/decks/${deck.id}` : '';

  const patchSlide = (sid: number, body: Record<string, unknown>) =>
    act(`${base}/slides/${sid}`, json('PATCH', body), 'Не удалось сохранить');

  const redraw = (sid: number, instruction: string) =>
    act(`${base}/slides/${sid}/redraw`, json('POST', { instruction }), 'Не удалось запустить перерисовку');

  /** Переделать текст слайда словами автора — работает и до, и после рисования. */
  const rewrite = (sid: number, instruction: string) =>
    act(
      `${base}/slides/${sid}/rewrite`,
      json('POST', { instruction }),
      'Не удалось переделать слайд',
      'Переделываю слайд — покажу, когда будет готово',
    );

  const approve = async () => {
    if (!deck) return;
    const hasImages = deck.slides.some((s) => s.imageBrief !== null);
    setBusy(true);
    await act(
      `${base}/approve`,
      { method: 'POST' },
      'Не удалось запустить',
      hasImages ? 'Рисую образы. Можно закрыть страницу.' : 'Готово — презентация собрана',
    );
    setBusy(false);
  };

  // Тупика после ошибки быть не должно: конвейер можно перезапустить.
  const retry = async () => {
    setBusy(true);
    await act(`${base}/retry`, { method: 'POST' }, 'Не удалось перезапустить', 'Пробую ещё раз');
    setBusy(false);
  };

  /** Удалить можно на любом этапе — ждать окончания работы незачем. */
  const remove = async () => {
    if (!deck || !window.confirm('Удалить презентацию?')) return;
    const r = await send(base, { method: 'DELETE' }, 'Не удалось удалить');
    if (!r.ok) {
      toast(r.message);
      return;
    }
    toast('Презентация удалена');
    go('s-home');
  };

  const download = async (format: 'pptx' | 'pdf') => {
    const fail = await downloadFile(`${base}/export?format=${format}`, `презентация.${format}`);
    if (fail) toast(fail);
  };

  if (screen !== 's-slides') return null;

  // ── Открытая презентация ────────────────────────────────────────────────
  if (deck) {
    const working = deckWorking(deck.status);
    const briefCount = deck.slides.filter((s) => s.imageBrief !== null).length;
    // Имя стиля серии — из списка пакетов; не нашли — строку не показываем.
    const packName = packs.find((p) => p.id === deck.stylePackId)?.name;
    const lastImage = lastImageBySlide(deck.images);

    // Что показать под шапкой. Утверждённая колода остаётся колодой, пока
    // правится один слайд и даже когда образы не нарисовались: текст слайдов
    // цел, его можно смотреть и выгружать. Раскадровка — пока не утверждена.
    const body = deck.storyboardApproved
      ? 'ready'
      : deck.status === 'storyboard_ready' || (working && deck.slides.length > 0)
        ? 'storyboard'
        : null;

    return (
      <section className="screen active" id="s-slides">
        <button className="btn ghost back-link" onClick={() => go('s-home')}>
          <Icon name="back" /> В библиотеку
        </button>

        <h2 className="h2">{deck.title}</h2>

        {/* Удалить можно на любом этапе — ждать окончания работы незачем.
            Кнопка живёт рядом с заголовком, а не только на готовой колоде. */}
        <div className="deck-tools">
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
        {body === 'storyboard' && (
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
                      {/* Сторону слушают не все макеты — на остальных кнопка ничего бы не меняла */}
                      {layoutSided(s.layout) && (
                        <button
                          className="btn"
                          disabled={working}
                          onClick={() =>
                            void patchSlide(s.id, {
                              imageSide: s.imageSide === 'left' ? 'right' : 'left',
                            })
                          }
                        >
                          сторона: {s.imageSide === 'left' ? 'слева' : 'справа'}
                        </button>
                      )}
                      <button
                        className="btn danger"
                        disabled={working}
                        onClick={() => void patchSlide(s.id, { imageBrief: null })}
                      >
                        убрать образ
                      </button>
                    </div>
                  </div>
                ) : layoutHasImage(s.layout) ? (
                  <div className="sb-actions">
                    {/* Мысль образа пишется в окне слайда — там же видно, что выйдет */}
                    <button className="btn ghost" onClick={() => setOpenSlide(i)}>
                      добавить образ
                    </button>
                  </div>
                ) : null}
              </div>
            ))}
            <div className="sb-total">Образов: {briefCount}</div>
            <button className="btn primary big" disabled={busy || working} onClick={() => void approve()}>
              {busy ? 'Запускаю…' : 'Утвердить — рисуем'} <Icon name="arrow" />
            </button>
          </>
        )}

        {body === 'ready' && (
          <>
            {deck.status === 'ready' && (
              <div className="done-head">
                <span className="dh-ic"><Icon name="check" /></span>
                <div>
                  <h3>Готово — презентация собрана</h3>
                  <p>Слайдов: {deck.slides.length}. Можно скачать или доработать образы.</p>
                </div>
              </div>
            )}
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
                    {s.imageId !== null && layoutHasImage(s.layout) ? (
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
              <button
                className="btn primary"
                style={{ flex: 1 }}
                disabled={working}
                onClick={() => void download('pptx')}
              >
                <Icon name="download" /> Скачать PPTX
              </button>
              <button className="btn" disabled={working} onClick={() => void download('pdf')}>
                <Icon name="download" /> PDF
              </button>
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

  // ── Колода открыта по адресу, но ещё не пришла (или не пришла вовсе) ────
  // Форма новой презентации здесь была бы ложью: кнопка под ней завела бы дубль.
  if (openId !== null) {
    return (
      <section className="screen active" id="s-slides">
        <button className="btn ghost back-link" onClick={() => go('s-home')}>
          <Icon name="back" /> В библиотеку
        </button>
        {failed ? (
          <div className="errblock">
            <h3 className="errttl">Не удалось открыть</h3>
            <p className="errwhy">{failed}</p>
            <div className="btnrow">
              <button className="btn primary" style={{ flex: 1 }} onClick={() => void loadOne(openId)}>
                Ещё раз
              </button>
            </div>
          </div>
        ) : (
          <p className="doc-meta">Загружаю…</p>
        )}
      </section>
    );
  }

  // ── Новая презентация ───────────────────────────────────────────────────
  // Форма живёт отдельно и сама знает, из чего собирать колоду.
  return <DeckForm active={screen === 's-slides'} onCreated={openDeck} />;
}
