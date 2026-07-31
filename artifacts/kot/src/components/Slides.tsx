import { useState, useEffect, useCallback } from 'react';
import { useApp } from '@/hooks/use-app';
import { Icon } from '@/lib/icons';
import { SlideViewer } from './SlideViewer';
import {
  LAYOUT_RU,
  type DeckStatus,
  type DeckFull,
  type DeckImage,
  type DiagramSpec,
} from '@/lib/deck';

interface DeckListItem {
  id: number;
  title: string;
  status: DeckStatus;
}

/** Стилевой пакет из GET /style-packs — фронту нужны только id и имя. */
interface StylePackItem {
  id: number;
  name: string;
}

interface LectureItem {
  id: number;
  title: string;
  status: string;
}

/** Документ библиотеки — тоже законный источник презентации. */
interface DocItem {
  id: number;
  title: string;
  kind: string;
  status: string;
}

const DOC_KIND_RU: Record<string, string> = {
  book: 'книга',
  article: 'статья',
  note: 'заметка',
  transcript: 'расшифровка · имена скрыты',
};

const STATUS_RU: Record<DeckStatus, string> = {
  storyboarding: 'Раскладываю по слайдам…',
  storyboard_ready: 'раскадровка ждёт вашего решения',
  drawing: 'рисую образы…',
  ready: 'готова',
  error: 'ошибка',
};

/**
 * Мини-схема на пластине готовой колоды: пиктограмма структуры без подписей —
 * с плитки читается состав (сколько шагов и как они стоят), текст есть в
 * раскадровке и в самом PPTX. stroke currentColor, чтобы схема писалась
 * тем же пером, что рамка серии.
 */
function DiagramThumb({ spec }: { spec: DiagramSpec }) {
  const pad = 18;
  if (spec.kind === 'flow') {
    const n = spec.items.length;
    const gap = 11;
    const h = (180 - pad * 2 - gap * (n - 1)) / n;
    const w = 150;
    const x = (320 - w) / 2;
    return (
      <svg viewBox="0 0 320 180" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
        {spec.items.map((_, i) => {
          const y = pad + i * (h + gap);
          return (
            <g key={i}>
              <rect x={x} y={y} width={w} height={h} />
              {/* стрелка вниз: линия в просвете + шеврон на конце */}
              {i < n - 1 && <path d={`M160 ${y + h + 2} v${gap - 5} m-4 -4 l4 4 l4 -4`} />}
            </g>
          );
        })}
      </svg>
    );
  }
  // Колонны: как в экспорте, больше четырёх рядом не ставим.
  const cols = spec.items.slice(0, 4);
  const gap = 12;
  const w = (320 - pad * 2 - gap * (cols.length - 1)) / cols.length;
  return (
    <svg viewBox="0 0 320 180" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      {cols.map((_, i) => (
        <rect key={i} x={pad + i * (w + gap)} y={pad} width={w} height={180 - pad * 2} />
      ))}
    </svg>
  );
}

export function Slides() {
  const { screen, go, toast, openSheet } = useApp();
  const [list, setList] = useState<DeckListItem[]>([]);
  const [lectures, setLectures] = useState<LectureItem[]>([]);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);
  const [deck, setDeck] = useState<DeckFull | null>(null);
  /** Какой слайд открыт крупно — индекс в колоде; null = просмотр закрыт. */
  const [openSlide, setOpenSlide] = useState<number | null>(null);

  const [pickedLecture, setPickedLecture] = useState<number | null>(null);
  const [docsList, setDocsList] = useState<DocItem[]>([]);
  const [pickedDoc, setPickedDoc] = useState<number | null>(null);
  const [rawText, setRawText] = useState('');
  const [busy, setBusy] = useState(false);

  // Стиль серии: список доступных пакетов и явный выбор автора.
  // null в pickedPack = «не выбирал», тогда действует первый из списка.
  const [packs, setPacks] = useState<StylePackItem[]>([]);
  const [pickedPack, setPickedPack] = useState<number | null>(null);

  // Сеть моргнула — показываем то, что уже есть; поллинг сам догонит.
  const loadList = useCallback(async () => {
    try {
      const res = await fetch('/api/decks');
      if (res.ok) setList(await res.json());
    } catch { /* тихо */ }
  }, []);

  const loadLectures = useCallback(async () => {
    try {
      const [l, d] = await Promise.all([
        fetch('/api/lectures').then((r) => (r.ok ? r.json() : null)),
        fetch('/api/documents').then((r) => (r.ok ? r.json() : null)),
      ]);
      if (l) setLectures((l as LectureItem[]).filter((x) => x.status === 'ready'));
      // Разобранный документ библиотеки — такой же материал, как лекция.
      if (d) setDocsList((d as DocItem[]).filter((x) => x.status === 'ready'));
    } catch { /* тихо */ }
  }, []);

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
        setOpenId(null);
      }
    } catch { /* тихо: поллинг повторит */ }
  }, [toast]);

  useEffect(() => {
    if (screen !== 's-slides') return;
    void loadList();
  }, [screen, loadList]);

  useEffect(() => {
    if (creating) void loadLectures();
  }, [creating, loadLectures]);

  // Список стилей нужен и форме создания (выбор), и открытой колоде (имя стиля).
  useEffect(() => {
    if (creating || openId !== null) void loadPacks();
  }, [creating, openId, loadPacks]);

  useEffect(() => {
    if (screen !== 's-slides') {
      setOpenId(null);
      setCreating(false);
      setPickedLecture(null);
      setPickedDoc(null);
      setPickedPack(null);
    }
  }, [screen]);

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

  // Список тоже живой: статусы «в работе» должны доехать до «готова» без перезагрузки.
  useEffect(() => {
    if (screen !== 's-slides' || openId !== null) return;
    if (!list.some((d) => d.status === 'storyboarding' || d.status === 'drawing')) return;
    const t = setInterval(() => void loadList(), 3000);
    return () => clearInterval(t);
  }, [screen, openId, list, loadList]);

  const create = async () => {
    const raw = rawText.trim();
    if (pickedLecture === null && pickedDoc === null && raw === '') {
      toast('Выберите лекцию, документ из библиотеки или вставьте текст');
      return;
    }
    setBusy(true);
    try {
      // Явный выбор либо первый из списка; список пуст (сеть моргнула) —
      // поле не шлём, сервер возьмёт первый доступный сам.
      const stylePackId = pickedPack ?? packs[0]?.id;
      const body = {
        ...(pickedLecture !== null
          ? { sourceKind: 'lecture', sourceId: pickedLecture }
          : pickedDoc !== null
            ? { sourceKind: 'document', sourceId: pickedDoc }
            : { sourceKind: 'raw', rawText: raw }),
        ...(stylePackId !== undefined ? { stylePackId } : {}),
      };
      const res = await fetch('/api/decks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const created = await res.json();
        setRawText('');
        setPickedLecture(null);
        setPickedPack(null);
        setCreating(false);
        await loadList();
        setOpenId(created.id);
      } else {
        const data = await res.json().catch(() => ({}));
        toast(data.message ?? 'Не удалось создать презентацию');
      }
    } catch {
      toast('Нет связи с сервером. Попробуйте ещё раз.');
    } finally {
      setBusy(false);
    }
  };

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

  /** Удалить можно на любом этапе — в том числе прямо из списка. */
  const removeDeck = async (id: number, ask = true) => {
    if (ask && !window.confirm('Удалить презентацию? Вернуть её будет нельзя.')) return;
    try {
      const res = await fetch(`/api/decks/${id}`, { method: 'DELETE' });
      if (res.ok) {
        toast('Презентация удалена');
        if (openId === id) setOpenId(null);
        await loadList();
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
        <button
          className="btn ghost back-link"
          onClick={() => {
            setOpenId(null);
            void loadList();
          }}
        >
          <Icon name="back" /> К списку презентаций
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
                  {String(i + 1).padStart(2, '0')} · {LAYOUT_RU[s.layout] ?? s.layout}
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
                          {s.content.title || s.content.quote || LAYOUT_RU[s.layout] || s.layout}
                        </span>
                      </div>
                    )}
                    <div className={`cap ${doubted || s.imageStatus === 'error' ? 'busy' : ''}`}>
                      {s.imageStatus === 'error' ? (
                        <><Icon name="loop" /> образ не нарисовался — нажмите</>
                      ) : canRedraw ? (
                        <><Icon name="eye" /> открыть и изменить</>
                      ) : (
                        <><Icon name="eye" /> {LAYOUT_RU[s.layout] ?? s.layout}</>
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
  if (creating) {
    return (
      <section className="screen active" id="s-slides">
        <button className="btn ghost back-link" onClick={() => setCreating(false)}>
          <Icon name="back" /> К списку презентаций
        </button>

        <h2 className="h2">Новая презентация</h2>
        <p className="sub">
          Возьму за основу готовую лекцию, документ из библиотеки — или текст, который вставите.
        </p>

        <div className="panel">
          <div className="fieldlbl">Из готовой лекции</div>
          {lectures.length === 0 ? (
            <p className="doc-meta">Готовых лекций пока нет.</p>
          ) : (
            <div className="resume" style={{ marginBottom: 6 }}>
              {lectures.map((l) => (
                <div
                  key={l.id}
                  className="r sel-lec"
                  onClick={() => {
                    setPickedDoc(null);
                    setPickedLecture((p) => (p === l.id ? null : l.id));
                  }}
                >
                  <span className="ri"><Icon name="pen" /></span>
                  <span className="rt">
                    <b>{l.title}</b>
                    <span>Лекция готова</span>
                  </span>
                  {pickedLecture === l.id && (
                    <span className="chev sel-mark"><Icon name="check" /></span>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Книга, статья или расшифровка — материал для слайдов не хуже лекции */}
          <div className="fieldlbl">Из библиотеки</div>
          {docsList.length === 0 ? (
            <p className="doc-meta">В библиотеке пока нет разобранных документов.</p>
          ) : (
            <div className="resume" style={{ marginBottom: 6 }}>
              {docsList.map((d) => (
                <div
                  key={d.id}
                  className="r sel-lec"
                  onClick={() => {
                    setPickedLecture(null);
                    setPickedDoc((p) => (p === d.id ? null : d.id));
                  }}
                >
                  <span className="ri">
                    <Icon name={d.kind === 'transcript' ? 'mic' : 'book'} />
                  </span>
                  <span className="rt">
                    <b>{d.title}</b>
                    <span>{DOC_KIND_RU[d.kind] ?? 'документ'}</span>
                  </span>
                  {pickedDoc === d.id && (
                    <span className="chev sel-mark"><Icon name="check" /></span>
                  )}
                </div>
              ))}
            </div>
          )}

          <div className="fieldlbl">Или вставьте текст</div>
          <textarea
            className="topic"
            value={rawText}
            onChange={(e) => setRawText(e.target.value)}
            placeholder="Вставьте текст выступления — хотя бы пару абзацев."
          />

          {/* Стиль серии показываем, только когда есть из чего выбирать */}
          {packs.length > 1 && (
            <>
              <div className="fieldlbl">Стиль серии</div>
              <div className="pills">
                {packs.map((p) => (
                  <span
                    key={p.id}
                    className={`pill-opt ${(pickedPack ?? packs[0].id) === p.id ? 'on' : ''}`}
                    onClick={() => setPickedPack(p.id)}
                  >
                    {p.name}
                  </span>
                ))}
              </div>
            </>
          )}
        </div>

        <button className="btn primary big" disabled={busy} onClick={() => void create()}>
          {busy ? 'Начинаю…' : 'Разложить по слайдам'} <Icon name="arrow" />
        </button>
      </section>
    );
  }

  // ── Список ──────────────────────────────────────────────────────────────
  return (
    <section className="screen active" id="s-slides">
      <button className="btn ghost back-link" onClick={() => go('s-home')}>
        <Icon name="back" /> Назад
      </button>

      <h2 className="h2">Собрать презентацию</h2>
      <p className="sub">
        Из лекции или текста выступления — слайды с образами в едином стиле серии.
      </p>

      {list.length > 0 && (
        <div className="doc-list" style={{ marginBottom: 22 }}>
          {list.map((d) => (
            <div key={d.id} className="doc-card lec-item deck-row" onClick={() => setOpenId(d.id)}>
              <span className="doc-ico"><Icon name="deck" /></span>
              <div className="doc-body">
                <b className="doc-title">{d.title}</b>
                <span
                  className={`doc-meta ${
                    d.status === 'storyboarding' || d.status === 'drawing'
                      ? 'busy'
                      : d.status === 'error'
                        ? 'bad'
                        : ''
                  }`}
                >
                  {STATUS_RU[d.status]}
                </span>
              </div>
              <button
                className="btn ghost doc-del"
                title="Удалить презентацию"
                onClick={(e) => {
                  e.stopPropagation();
                  void removeDeck(d.id);
                }}
              >
                <Icon name="trash" />
              </button>
              <span className="chev"><Icon name="chevron" /></span>
            </div>
          ))}
        </div>
      )}

      <button className="btn primary big" onClick={() => setCreating(true)}>
        Новая презентация <Icon name="arrow" />
      </button>
    </section>
  );
}
