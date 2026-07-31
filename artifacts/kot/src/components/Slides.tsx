import { useState, useEffect, useCallback } from 'react';
import { useApp } from '@/hooks/use-app';
import { Icon } from '@/lib/icons';

type DeckStatus = 'storyboarding' | 'storyboard_ready' | 'drawing' | 'ready' | 'error';

interface DeckListItem {
  id: number;
  title: string;
  status: DeckStatus;
}

interface SlideContent {
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

interface DeckSlide {
  id: number;
  ord: number;
  layout: string;
  content: SlideContent;
  notes: string;
  imageBrief: string | null;
  imageSide: 'left' | 'right';
  imageId: number | null;
  imageStatus: 'none' | 'queued' | 'drawing' | 'ready' | 'error';
}

interface DeckImage {
  id: number;
  slideId: number;
  attempt: number;
  status: 'drawing' | 'ready' | 'rejected' | 'error';
  verdict: string | null;
}

interface DeckFull {
  id: number;
  title: string;
  status: DeckStatus;
  statusMessage: string;
  error: string | null;
  slides: DeckSlide[];
  images: DeckImage[];
}

interface LectureItem {
  id: number;
  title: string;
  status: string;
}

const LAYOUT_RU: Record<string, string> = {
  cover: 'Обложка',
  divider: 'Разделитель',
  theory: 'Теория',
  quote: 'Цитата',
  clinical: 'Клинический фрагмент',
  comparison: 'Сопоставление',
  final: 'Финал',
  diagram: 'Схема',
};

const STATUS_RU: Record<DeckStatus, string> = {
  storyboarding: 'Раскладываю по слайдам…',
  storyboard_ready: 'раскадровка ждёт вашего решения',
  drawing: 'рисую образы…',
  ready: 'готова',
  error: 'ошибка',
};

export function Slides() {
  const { screen, go, toast, openSheet } = useApp();
  const [list, setList] = useState<DeckListItem[]>([]);
  const [lectures, setLectures] = useState<LectureItem[]>([]);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);
  const [deck, setDeck] = useState<DeckFull | null>(null);

  const [pickedLecture, setPickedLecture] = useState<number | null>(null);
  const [rawText, setRawText] = useState('');
  const [busy, setBusy] = useState(false);

  // Сеть моргнула — показываем то, что уже есть; поллинг сам догонит.
  const loadList = useCallback(async () => {
    try {
      const res = await fetch('/api/decks');
      if (res.ok) setList(await res.json());
    } catch { /* тихо */ }
  }, []);

  const loadLectures = useCallback(async () => {
    try {
      const res = await fetch('/api/lectures');
      if (res.ok) setLectures(((await res.json()) as LectureItem[]).filter((x) => x.status === 'ready'));
    } catch { /* тихо */ }
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

  useEffect(() => {
    if (screen !== 's-slides') {
      setOpenId(null);
      setCreating(false);
      setPickedLecture(null);
    }
  }, [screen]);

  useEffect(() => {
    if (openId === null) {
      setDeck(null);
      return;
    }
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
    if (pickedLecture === null && raw === '') {
      toast('Выберите лекцию или вставьте текст выступления');
      return;
    }
    setBusy(true);
    try {
      const body =
        pickedLecture !== null
          ? { sourceKind: 'lecture', sourceId: pickedLecture }
          : { sourceKind: 'raw', rawText: raw };
      const res = await fetch('/api/decks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const created = await res.json();
        setRawText('');
        setPickedLecture(null);
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

  const remove = async () => {
    if (!deck) return;
    if (!window.confirm('Удалить презентацию? Вернуть её будет нельзя.')) return;
    const res = await fetch(`/api/decks/${deck.id}`, { method: 'DELETE' });
    if (res.ok) {
      toast('Презентация удалена');
      setOpenId(null);
      await loadList();
    } else {
      toast('Не удалось удалить');
    }
  };

  if (screen !== 's-slides') return null;

  // ── Открытая презентация ────────────────────────────────────────────────
  if (deck) {
    const working = deck.status === 'storyboarding' || deck.status === 'drawing';
    const briefCount = deck.slides.filter((s) => s.imageBrief !== null).length;

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

        {deck.status === 'error' && (
          <>
            <div className="wip-note">
              <Icon name="info" /> {deck.error ?? 'Что-то пошло не так.'}
            </div>
            <div className="btnrow">
              <button className="btn primary" style={{ flex: 1 }} disabled={busy} onClick={() => void retry()}>
                {busy ? 'Запускаю…' : 'Попробовать ещё раз'}
              </button>
              <button className="btn danger" onClick={() => void remove()}>
                <Icon name="trash" /> Удалить
              </button>
            </div>
          </>
        )}

        {working && (
          <div className="panel bigjob">
            <div className="bi"><Icon name="clock" /></div>
            <p className="pstat">
              {deck.status === 'drawing' ? 'Рисую образы' : 'Раскладываю по слайдам'}
            </p>
            {deck.statusMessage !== '' && (
              <p className="preassure" style={{ marginBottom: 6 }}>{deck.statusMessage}</p>
            )}
            <p className="preassure">
              <b>Можно закрыть страницу.</b> Работа не пропадёт.
            </p>
          </div>
        )}

        {/* Раскадровка на утверждение: рисование стоит денег, поэтому — человек в цикле */}
        {deck.status === 'storyboard_ready' && (
          <>
            <p className="sub">
              Посмотрите раскадровку. Образы можно править, убирать и добавлять —
              рисовать начну только после утверждения.
            </p>
            {deck.slides.map((s, i) => (
              <div key={s.id} className="panel sb-slide">
                <div className="sb-num">
                  {String(i + 1).padStart(2, '0')} · {LAYOUT_RU[s.layout] ?? s.layout}
                </div>
                {(s.content.title || s.content.quote) && (
                  <h3 className="sb-title">{s.content.title || s.content.quote}</h3>
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
                ) : (
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
                )}
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
            <p className="tnote">
              <Icon name="info" /> Не нравится образ — нажмите на слайд и скажите своими
              словами, что изменить.
            </p>

            <div className="sgrid">
              {deck.slides.map((s, i) => {
                const doubted = lastImage.get(s.id)?.status === 'rejected';
                const canRedraw = s.imageBrief !== null;
                return (
                  <div
                    key={s.id}
                    className={`slide ${canRedraw ? '' : 'still'}`}
                    onClick={
                      canRedraw
                        ? () =>
                            openSheet('Что изменить в этом образе?', 'C', (txt) =>
                              void redraw(s.id, txt),
                            )
                        : undefined
                    }
                  >
                    {s.imageId !== null ? (
                      <div className="th th-img">
                        <img
                          src={`/api/decks/${deck.id}/images/${s.imageId}/file`}
                          alt={s.content.title || ''}
                        />
                        {doubted && <span className="tag-draft">стоит посмотреть</span>}
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
                        <><Icon name="edit" /> нажмите, чтобы изменить</>
                      ) : (
                        <>{LAYOUT_RU[s.layout] ?? s.layout}</>
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
              <button className="btn danger" onClick={() => void remove()}>
                <Icon name="trash" /> Удалить
              </button>
            </div>
          </>
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
        <p className="sub">Выберите готовую лекцию или вставьте текст выступления.</p>

        <div className="panel">
          <div className="fieldlbl">Из готовой лекции</div>
          {lectures.length === 0 ? (
            <p className="doc-meta">Готовых лекций пока нет — можно вставить текст ниже.</p>
          ) : (
            <div className="resume" style={{ marginBottom: 6 }}>
              {lectures.map((l) => (
                <div
                  key={l.id}
                  className="r sel-lec"
                  onClick={() => setPickedLecture((p) => (p === l.id ? null : l.id))}
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

          <div className="fieldlbl">Или вставьте текст</div>
          <textarea
            className="topic"
            value={rawText}
            onChange={(e) => setRawText(e.target.value)}
            placeholder="Вставьте текст выступления — хотя бы пару абзацев."
          />
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
            <button key={d.id} className="doc-card lec-item" onClick={() => setOpenId(d.id)}>
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
              <span className="chev"><Icon name="chevron" /></span>
            </button>
          ))}
        </div>
      )}

      <button className="btn primary big" onClick={() => setCreating(true)}>
        Новая презентация <Icon name="arrow" />
      </button>
    </section>
  );
}
