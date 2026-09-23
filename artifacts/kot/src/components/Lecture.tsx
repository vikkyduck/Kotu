import { useState, useEffect, useCallback, useRef } from 'react';
import { useApp } from '@/hooks/use-app';
import { useDraft, useUnsavedWarning } from '@/hooks/use-draft';
import { Icon } from '@/lib/icons';
import { OFFLINE, failText, send, json, downloadFile } from '@/lib/http';
import { KIND_LABEL, docKind, type ItemKind } from '@/lib/library-items';
import type {
  Bibliography,
  DocumentStatus,
  LectureFocus,
  LecturePlanNotes,
  LectureStatus,
  PlannedSection,
  SectionStatus,
} from '@workspace/db/schema';

interface Doc {
  id: number;
  title: string;
  kind: string;
  status: DocumentStatus;
  transcriptionId: number | null;
}

/** Подпись у материала — только у своих работ: они должны быть отличимы от книги. */
const OWN_WORK: ItemKind[] = ['transcript', 'lecture', 'deck'];

interface Section {
  id: number;
  ord: number;
  heading: string;
  text: string;
  status: SectionStatus;
  editedByHuman: boolean;
}

interface Source {
  id: number;
  sectionId: number | null;
  kind?: 'doc' | 'web' | 'model';
  url?: string | null;
  title: string;
  quote: string;
}

interface LectureFull {
  id: number;
  title: string;
  plan: PlannedSection[] | null;
  planNotes: LecturePlanNotes | null;
  bibliography: Bibliography | null;
  planApproved: boolean;
  status: LectureStatus;
  statusMessage: string;
  error: string | null;
  sections: Section[];
  sources: Source[];
}

const AUDIENCES = ['студенты', 'коллеги', 'смешанная'];
/** Подписи акцентов: Record требует подпись у каждого акцента схемы. */
const FOCUS_LABEL: Record<LectureFocus, string> = {
  theoretical: 'теоретический',
  clinical: 'клинический',
  historical: 'исторический',
};
const FOCI = Object.keys(FOCUS_LABEL) as LectureFocus[];

// Больше двух часов лекция не выйдет: восемь глав по 1800 слов — потолок
// handlers/lecture.ts.
const DURATIONS = [
  { label: '1 час', value: 60 },
  { label: '2 часа', value: 120 },
];

export function Lecture() {
  // Какую лекцию открыть, решает библиотека: инструмент — это действие,
  // а не ещё один список сделанного.
  const { screen, go, leaveMissing, setLeaveGuard, toast, activeLectureId, openLecture, lectureSeed, newDeck } = useApp();
  /** null — список ещё не пришёл: «пусто» до ответа было бы неправдой. */
  const [docs, setDocs] = useState<Doc[] | null>(null);
  const [docsFailed, setDocsFailed] = useState(false);
  /** Имена записей: у расшифровки в библиотеке обезличенная копия — в выборе нужно имя записи. */
  const [records, setRecords] = useState<{ id: number; title: string }[]>([]);
  const openId = activeLectureId;
  const openRef = useRef(openId);
  openRef.current = openId;
  const [lecture, setLecture] = useState<LectureFull | null>(null);
  /** Открытую лекцию не удалось загрузить — текст причины для экрана. */
  const [failed, setFailed] = useState<string | null>(null);

  // Бриф — тоже черновик: он ценнее всего, что есть на этом экране.
  const [topic, setTopic, clearTopic] = useDraft('lecture-topic', screen === 's-lecture');
  const [audience, setAudience] = useState('студенты');
  const [duration, setDuration] = useState(120);
  const [picked, setPicked] = useState<number[]>([]);
  /** Откуда материал: из выбранных документов или собственное исследование ИИ. */
  /** Источники независимы: можно оба, один или ни одного. */
  const [useLibrary, setUseLibrary] = useState(false);
  const [useResearch, setUseResearch] = useState(false);
  /** Акцентов может быть несколько — или ни одного. */
  const [focus, setFocus] = useState<LectureFocus[]>([]);
  const [busy, setBusy] = useState(false);
  /**
   * Правка главы: id главы, черновик и текст, с которого начали. Уход с
   * экрана правку не закрывает — вернулась, и черновик на месте.
   */
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [draftFrom, setDraftFrom] = useState('');
  /** Чья глава в правке: лекцию удалили — её правка уходит вместе с ней. */
  const editOf = useRef<number | null>(null);
  /** Правка блока плана: индекс и черновики заголовка с тезисом. */
  const [planEdit, setPlanEdit] = useState<number | null>(null);
  const [planHead, setPlanHead] = useState('');
  const [planAbstract, setPlanAbstract] = useState('');
  const [planFrom, setPlanFrom] = useState({ heading: '', abstract: '' });
  /** Чья правка плана открыта: вернулась к той же лекции — правка цела. */
  const planOf = useRef<number | null>(null);

  // Правка без изменений — не повод спрашивать.
  const unsaved =
    (editing !== null && draft !== draftFrom) ||
    (planEdit !== null && (planHead !== planFrom.heading || planAbstract !== planFrom.abstract));
  useUnsavedWarning(unsaved || (screen === 's-lecture' && openId === null && topic.trim() !== ''));

  // Уход внутри приложения: правка главы чужой лекции сейчас не на экране и
  // с уходом не пропадает. Сохранила — сторож молчит сразу, не дожидаясь
  // перерисовки.
  const guard = useRef<() => boolean>(() => false);
  guard.current = () =>
    (editing !== null && editOf.current === openId && draft !== draftFrom) ||
    (planEdit !== null && (planHead !== planFrom.heading || planAbstract !== planFrom.abstract));
  useEffect(() => {
    if (screen !== 's-lecture') return;
    setLeaveGuard(() => guard.current());
    return () => setLeaveGuard(null);
  }, [screen, setLeaveGuard]);

  const loadDocs = useCallback(async () => {
    // Тихий запрос: без имён записей остаются заголовки копий.
    void fetch('/api/transcriptions')
      .then((r) => (r.ok ? (r.json() as Promise<{ id: number; title: string }[]>) : null))
      .then((rows) => {
        if (rows) setRecords(rows);
      })
      .catch(() => {});
    try {
      const res = await fetch('/api/documents');
      if (!res.ok) throw new Error();
      const all = (await res.json()) as Doc[];
      setDocs(all.filter((x) => x.status === 'ready'));
      setDocsFailed(false);
    } catch {
      // Прежний список (если был) остаётся: сбой — не повод объявить библиотеку пустой.
      setDocsFailed(true);
    }
  }, []);

  /** Лекции больше нет — её открытые правки сохранять некуда. */
  const dropEdits = useCallback((id: number) => {
    if (editOf.current === id) setEditing(null);
    if (planOf.current === id) setPlanEdit(null);
  }, []);

  const loadOne = useCallback(async (id: number) => {
    let res: Response;
    try {
      res = await fetch(`/api/lectures/${id}`);
    } catch {
      if (id === openRef.current) setFailed(OFFLINE);
      return;
    }
    // Ответ мог прийти, когда она уже ушла с этой лекции: чужой экран не трогаем.
    if (id !== openRef.current) return;
    if (res.status === 404) {
      // Лекцию удалили (другая вкладка, старая ссылка, «назад») — не
      // показывать же под её адресом форму новой.
      toast('Лекция не найдена');
      dropEdits(id);
      leaveMissing();
      return;
    }
    if (!res.ok) {
      setFailed(await failText(res, 'Не удалось открыть лекцию'));
      return;
    }
    const data = (await res.json()) as LectureFull;
    if (id !== openRef.current) return;
    setLecture(data);
    setFailed(null);
  }, [toast, leaveMissing, dropEdits]);

  useEffect(() => {
    if (screen !== 's-lecture') return;
    void loadDocs();
  }, [screen, loadDocs]);

  // Пришли из библиотеки («написать лекцию на основе этого») — материал
  // в опоре уже отмечен; пришли просто так — выбор прошлого захода не тянется.
  useEffect(() => {
    if (screen !== 's-lecture' || openId !== null) return;
    setUseLibrary(!!lectureSeed);
    setPicked(lectureSeed?.documentIds ?? []);
  }, [screen, openId, lectureSeed]);

  useEffect(() => {
    setLecture(null);
    setFailed(null);
    if (openId === null) return;
    // Индекс правки плана относится к своей лекции — в другой он чужой.
    if (openId !== planOf.current) setPlanEdit(null);
    planOf.current = openId;
    void loadOne(openId);
  }, [openId, loadOne]);

  // Пока идёт работа — подтягиваем состояние, чтобы прогресс двигался сам.
  useEffect(() => {
    if (openId === null || !lecture) return;
    if (lecture.status !== 'planning' && lecture.status !== 'writing') return;
    const t = setInterval(() => void loadOne(openId), 4000);
    return () => clearInterval(t);
  }, [openId, lecture, loadOne]);

  const create = async () => {
    if (topic.trim() === '') {
      toast('Расскажите в двух словах, о чём лекция');
      return;
    }
    if (useLibrary && picked.length === 0) {
      toast('Библиотека включена — отметьте документы или выключите её');
      return;
    }
    setBusy(true);
    const r = await send(
      '/api/lectures',
      json('POST', {
        topic,
        audience,
        durationMin: duration,
        focus,
        useLibrary,
        useResearch,
        documentIds: useLibrary ? picked : [],
      }),
      'Не удалось начать лекцию',
    );
    setBusy(false);
    if (!r.ok) {
      toast(r.message);
      return;
    }
    const created = await r.res.json();
    clearTopic();
    setPicked([]);
    openLecture(created.id);
  };

  /**
   * Запрос-действие над открытой лекцией: отказ сервера или обрыв сети —
   * тост с причиной и false; успех — лекция перечитана и true.
   */
  const act = async (url: string, init: RequestInit, fail: string, done?: string): Promise<boolean> => {
    if (!lecture) return false;
    const r = await send(url, init, fail);
    if (!r.ok) {
      toast(r.message);
      return false;
    }
    if (done) toast(done);
    await loadOne(lecture.id);
    return true;
  };

  const approve = async () => {
    if (!lecture) return;
    setBusy(true);
    // Правка блока, открытая на экране, — часть плана, который она утверждает.
    if (planEdit === null || (await savePlanEdit())) {
      await act(`/api/lectures/${lecture.id}/plan/approve`, { method: 'POST' }, 'Не удалось запустить',
        'Пишу главы. Можно закрыть страницу.');
    }
    setBusy(false);
  };

  // Тупика после ошибки быть не должно: план составляется заново, а главы
  // дописываются с того места, где письмо оборвалось.
  const retry = async () => {
    if (!lecture) return;
    setBusy(true);
    await act(`/api/lectures/${lecture.id}/retry`, { method: 'POST' }, 'Не удалось перезапустить', 'Пробую ещё раз');
    setBusy(false);
  };

  const remove = async () => {
    if (!lecture || !window.confirm('Удалить лекцию?')) return;
    const r = await send(`/api/lectures/${lecture.id}`, { method: 'DELETE' }, 'Не удалось удалить');
    if (!r.ok) {
      toast(r.message);
      return;
    }
    toast('Лекция удалена');
    dropEdits(lecture.id);
    go('s-home');
  };

  const download = async (url: string, fallbackName: string) => {
    const err = await downloadFile(url, fallbackName);
    if (err) toast(err);
  };

  // Сервер заменяет план целиком, а lecture.plan обновится только после
  // перечитывания: пока запрос идёт, действия с планом закрыты (busy) —
  // иначе второй клик отправил бы план с уже убранным блоком.
  const patchPlan = (plan: PlannedSection[]) =>
    act(`/api/lectures/${lecture?.id}/plan`, json('PATCH', { plan }), 'Не удалось изменить план');

  const dropChapter = async (index: number) => {
    if (!lecture?.plan) return;
    // Индексы сдвинутся — открытая правка другого блока попала бы не туда.
    setPlanEdit(null);
    setBusy(true);
    await patchPlan(lecture.plan.filter((_, i) => i !== index));
    setBusy(false);
  };

  /** Сохранить правку блока: заголовок и тезис; концепции и крючок остаются. */
  const savePlanEdit = async (): Promise<boolean> => {
    if (!lecture?.plan || planEdit === null) return true;
    if (planHead.trim() === '') {
      toast('У блока должно быть название');
      return false;
    }
    const plan = lecture.plan.map((b, i) =>
      i === planEdit ? { ...b, heading: planHead.trim(), abstract: planAbstract.trim() } : b,
    );
    if (!(await patchPlan(plan))) return false;
    guard.current = () => false;
    setPlanEdit(null);
    return true;
  };

  const saveOnePlanBlock = async () => {
    setBusy(true);
    if (await savePlanEdit()) toast('План обновлён');
    setBusy(false);
  };

  const saveSection = async (section: Section) => {
    if (!lecture) return;
    if (await act(`/api/lectures/${lecture.id}/sections/${section.id}`, json('PATCH', { text: draft }),
      'Не удалось сохранить', 'Правка сохранена')) {
      guard.current = () => false;
      setEditing(null);
    }
  };

  if (screen !== 's-lecture') return null;

  // Лекция по адресу ещё не пришла (или не пришла вовсе) — форму новой под
  // её адресом не показываем: кнопка под ней завела бы дубль.
  if (openId !== null && lecture?.id !== openId) {
    return (
      <section className="screen active" id="s-lecture">
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

  // ── Открытая лекция ─────────────────────────────────────────────────────
  if (lecture) {
    const working = lecture.status === 'planning' || lecture.status === 'writing';

    return (
      <section className="screen active" id="s-lecture">
        <button className="btn ghost back-link" onClick={() => go('s-home')}>
          <Icon name="back" /> В библиотеку
        </button>

        <h2 className="h2">{lecture.title}</h2>

        {/* Удалить можно на любом этапе — как презентацию; у ошибки кнопка
            удаления — в её блоке. */}
        {lecture.status !== 'error' && (
          <div className="deck-tools">
            <button className="chg deck-drop" onClick={() => void remove()}>
              удалить лекцию
            </button>
          </div>
        )}

        {lecture.status === 'error' && (
          <div className="errblock">
            <h3 className="errttl">Не получилось</h3>
            <p className="errwhy">{lecture.error ?? 'Что-то пошло не так.'}</p>
            <div className="btnrow">
              <button className="btn primary" style={{ flex: 1 }} disabled={busy} onClick={() => void retry()}>
                {busy ? 'Запускаю…' : 'Попробовать ещё раз'}
              </button>
              <button className="btn danger" disabled={busy} onClick={() => void remove()}>
                <Icon name="trash" /> Удалить
              </button>
            </div>
          </div>
        )}

        {working && (
          <div className="panel bigjob">
            <div className="bi"><Icon name="clock" /></div>
            <p className="pstat">{lecture.statusMessage || 'Работаю…'}</p>
            <p className="preassure">
              Это займёт время. <b>Можно закрыть страницу</b> — работа не пропадёт.
            </p>
          </div>
        )}

        {/* План на утверждение — точка, где автор остаётся автором */}
        {lecture.status === 'plan_ready' && lecture.plan && (
          <>
            <div className="doc-list">
              {lecture.plan.map((p, i) =>
                planEdit === i ? (
                  <div key={i} className="doc-card plan-editing">
                    <span className="plan-num">{i + 1}</span>
                    <div className="doc-body">
                      <input
                        className="field"
                        value={planHead}
                        placeholder="Название блока"
                        onChange={(e) => setPlanHead(e.target.value)}
                      />
                      <textarea
                        className="topic"
                        rows={3}
                        value={planAbstract}
                        placeholder="Тезис блока: о чём он"
                        onChange={(e) => setPlanAbstract(e.target.value)}
                      />
                      <div className="lec-actions">
                        <button className="btn primary" disabled={busy} onClick={() => void saveOnePlanBlock()}>
                          Сохранить
                        </button>
                        <button className="btn ghost" disabled={busy} onClick={() => setPlanEdit(null)}>
                          Отмена
                        </button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div key={i} className="doc-card">
                    <span className="plan-num">{i + 1}</span>
                    <div className="doc-body">
                      <b className="plan-head">{p.heading}</b>
                      <span className="doc-meta">{p.abstract}</span>
                      {(p.concepts?.length ?? 0) > 0 && (
                        <span className="plan-concepts">{p.concepts!.join(' · ')}</span>
                      )}
                      {p.hook && <span className="plan-hook">{p.hook}</span>}
                    </div>
                    <button
                      className="btn ghost doc-move"
                      title="Править блок"
                      disabled={busy}
                      onClick={() => {
                        setPlanEdit(i);
                        setPlanHead(p.heading);
                        setPlanAbstract(p.abstract);
                        setPlanFrom({ heading: p.heading, abstract: p.abstract });
                      }}
                    >
                      <Icon name="edit" />
                    </button>
                    <button
                      className="btn ghost doc-del"
                      title="Убрать главу"
                      disabled={busy}
                      onClick={() => void dropChapter(i)}
                    >
                      <Icon name="trash" />
                    </button>
                  </div>
                ),
              )}
            </div>
            {/* Спутники плана: их автор решает ДО того, как написан текст */}
            {(lecture.planNotes?.decisions.length ?? 0) > 0 && (
              <div className="panel plan-notes">
                <div className="fieldlbl" style={{ marginTop: 0 }}>Требуют вашего решения</div>
                <ul>
                  {lecture.planNotes!.decisions.map((d, i) => <li key={i}>{d}</li>)}
                </ul>
              </div>
            )}
            {(lecture.planNotes?.outOfScope.length ?? 0) > 0 && (
              <div className="panel plan-notes">
                <div className="fieldlbl" style={{ marginTop: 0 }}>Сознательно за скобками</div>
                <ul>
                  {lecture.planNotes!.outOfScope.map((d, i) => <li key={i}>{d}</li>)}
                </ul>
              </div>
            )}

            <button
              className="btn primary big"
              disabled={busy}
              onClick={() => void approve()}
              style={{ marginTop: 18 }}
            >
              {busy ? 'Запускаю…' : 'Утвердить и написать'} <Icon name="arrow" />
            </button>
          </>
        )}

        {/* Оглавление: текст читается частями, а не простынёй */}
        {lecture.sections.length > 1 && lecture.status === 'ready' && (
          <nav className="lec-toc panel">
            <div className="fieldlbl" style={{ marginTop: 0 }}>Части лекции</div>
            <ol>
              {lecture.sections.map((s) => (
                <li key={s.id}>
                  <a
                    href={`#part-${s.ord + 1}`}
                    onClick={(e) => {
                      // Переход по якорю — запись в истории, и приложение
                      // приняло бы её за адрес экрана и ушло в библиотеку.
                      e.preventDefault();
                      document.getElementById(`part-${s.ord + 1}`)?.scrollIntoView({ behavior: 'smooth' });
                    }}
                  >
                    {s.heading}
                  </a>
                </li>
              ))}
            </ol>
          </nav>
        )}

        {/* Готовые главы */}
        {lecture.sections.length > 0 && lecture.status !== 'plan_ready' && (
          <div className="lec-body">
            {lecture.sections.map((s) => {
              const sources = lecture.sources.filter((x) => x.sectionId === s.id);
              return (
                <div key={s.id} className="lec-section" id={`part-${s.ord + 1}`}>
                  <h3 className="lec-head">
                    {s.ord + 1}. {s.heading}
                    {s.editedByHuman && <span className="lec-edited">правлено вами</span>}
                  </h3>

                  {/* После ошибки глава не «пишется»: работа стоит до повтора. */}
                  {lecture.status === 'writing' && s.status === 'writing' && (
                    <p className="doc-meta busy">пишется…</p>
                  )}
                  {lecture.status === 'writing' && s.status === 'pending' && (
                    <p className="doc-meta">в очереди</p>
                  )}

                  {editing === s.id ? (
                    <>
                      <textarea
                        className="topic lec-edit"
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                      />
                      <div className="lec-actions">
                        <button className="btn primary" onClick={() => void saveSection(s)}>
                          Сохранить
                        </button>
                        <button className="btn ghost" onClick={() => setEditing(null)}>
                          Отмена
                        </button>
                      </div>
                    </>
                  ) : (
                    s.text !== '' && (
                      <>
                        {s.text.split(/\n\s*\n/).map((para, i) => (
                          <p key={i} className="lec-para">{para}</p>
                        ))}
                        <div className="lec-actions">
                          <button
                            className="btn ghost"
                            onClick={() => {
                              setEditing(s.id);
                              editOf.current = lecture.id;
                              setDraft(s.text);
                              setDraftFrom(s.text);
                            }}
                          >
                            <Icon name="edit" /> Править
                          </button>
                        </div>
                      </>
                    )
                  )}

                  {sources.length > 0 && (
                    <details className="lec-sources">
                      <summary>Источники ({sources.length})</summary>
                      <ol>
                        {sources.map((src) => (
                          <li key={src.id}>
                            {/* Веб-источник открывается по ссылке — его можно сверить */}
                            {src.url ? (
                              <a href={src.url} target="_blank" rel="noreferrer noopener">
                                <b>{src.title}</b>
                              </a>
                            ) : (
                              <b>{src.title}</b>
                            )}
                            <span>{src.quote.length > 220 ? `${src.quote.slice(0, 220)}…` : src.quote}</span>
                          </li>
                        ))}
                      </ol>
                    </details>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Литература двумя уровнями — хвост методики: истоки и современность */}
        {lecture.status === 'ready' && lecture.bibliography &&
          (lecture.bibliography.primary.length > 0 || lecture.bibliography.modern.length > 0) && (
          <div className="panel biblio">
            <div className="fieldlbl" style={{ marginTop: 0 }}>Литература</div>
            {lecture.bibliography.primary.length > 0 && (
              <>
                <p className="biblio-lvl">Первоисточники</p>
                <ol>{lecture.bibliography.primary.map((b, i) => <li key={i}>{b}</li>)}</ol>
              </>
            )}
            {lecture.bibliography.modern.length > 0 && (
              <>
                <p className="biblio-lvl">Современные работы для углубления</p>
                <ol>{lecture.bibliography.modern.map((b, i) => <li key={i}>{b}</li>)}</ol>
              </>
            )}
          </div>
        )}

        {/* Лекция готова: что с ней можно сделать дальше */}
        {lecture.status === 'ready' && (
          <div className="lec-next panel">
            <div className="fieldlbl" style={{ marginTop: 0 }}>Лекция готова — что дальше?</div>
            <div className="btnrow" style={{ flexWrap: 'wrap' }}>
              <button
                className="btn primary"
                onClick={() => newDeck({ sourceKind: 'lecture', sourceId: lecture.id })}
              >
                <Icon name="deck" /> Собрать презентацию
              </button>
            </div>
            <div className="btnrow" style={{ flexWrap: 'wrap', marginTop: 10 }}>
              <button
                className="btn"
                onClick={() => void download(`/api/lectures/${lecture.id}/export?format=docx`, 'лекция.docx')}
              >
                <Icon name="download" /> Скачать Word
              </button>
              <button
                className="btn"
                onClick={() => void download(`/api/lectures/${lecture.id}/export`, 'лекция.md')}
              >
                <Icon name="download" /> Скачать Markdown
              </button>
            </div>
          </div>
        )}
      </section>
    );
  }

  // ── Список и форма ──────────────────────────────────────────────────────
  return (
    <section className="screen active" id="s-lecture">
      <button className="btn ghost back-link" onClick={() => go('s-home')}>
        <Icon name="back" /> В библиотеку
      </button>

      <h2 className="h2">Написать лекцию</h2>
      <p className="sub">Расскажите своими словами, о чём лекция — остальное я возьму на себя.</p>

      <div className="panel">
        <div className="fieldlbl">О чём будет лекция?</div>
        <textarea
          className="topic"
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          placeholder="Например: защитные механизмы личности — для студентов второго курса. Начать с Фрейда и дойти до современных взглядов, с клиническими примерами."
        />

        <div className="fieldlbl">Для кого?</div>
        <div className="pills">
          {AUDIENCES.map((a) => (
            <button
              type="button"
              key={a}
              className={`pill-opt ${audience === a ? 'on' : ''}`}
              aria-pressed={audience === a}
              onClick={() => setAudience(a)}
            >
              {a}
            </button>
          ))}
        </div>

        <div className="fieldlbl">Примерно на сколько часов?</div>
        <div className="pills">
          {DURATIONS.map((d) => (
            <button
              type="button"
              key={d.value}
              className={`pill-opt ${duration === d.value ? 'on' : ''}`}
              aria-pressed={duration === d.value}
              onClick={() => setDuration(d.value)}
            >
              {d.label}
            </button>
          ))}
        </div>

        <div className="fieldlbl">Что важнее в этой лекции? Можно несколько — или ничего</div>
        <div className="pills">
          {FOCI.map((f) => (
            <button
              type="button"
              key={f}
              className={`pill-opt ${focus.includes(f) ? 'on' : ''}`}
              aria-pressed={focus.includes(f)}
              onClick={() => setFocus((p) => (p.includes(f) ? p.filter((x) => x !== f) : [...p, f]))}
            >
              {FOCUS_LABEL[f]}
            </button>
          ))}
        </div>

        <div className="fieldlbl">Откуда взять материал? Можно оба источника — или ни одного</div>
        <div className="pills">
          <button
            type="button"
            className={`pill-opt ${useLibrary ? 'on' : ''}`}
            aria-pressed={useLibrary}
            onClick={() => {
              // Книга могла разобраться, пока форма открыта, — список освежаем.
              if (!useLibrary) void loadDocs();
              setUseLibrary(!useLibrary);
            }}
          >
            Из моей библиотеки
          </button>
          <button
            type="button"
            className={`pill-opt ${useResearch ? 'on' : ''}`}
            aria-pressed={useResearch}
            onClick={() => setUseResearch((v) => !v)}
          >
            Исследование ИИ
          </button>
        </div>

        {useLibrary && (
          <>
            <div className="fieldlbl">На что опереться из библиотеки?</div>
            {docs === null ? (
              docsFailed && (
                <p className="doc-meta">
                  Список не загрузился —{' '}
                  <button type="button" className="chg" onClick={() => void loadDocs()}>
                    ещё раз
                  </button>
                </p>
              )
            ) : docs.length === 0 ? (
              <p className="doc-meta">
                В библиотеке пока нет разобранных документов —{' '}
                <button type="button" className="chg" onClick={() => go('s-home')}>
                  загрузить книгу
                </button>
              </p>
            ) : (
              <div className="pills">
                {docs.map((d) => (
                  <button
                    type="button"
                    key={d.id}
                    className={`pill-opt ${picked.includes(d.id) ? 'on' : ''}`}
                    aria-pressed={picked.includes(d.id)}
                    onClick={() =>
                      setPicked((p) => (p.includes(d.id) ? p.filter((x) => x !== d.id) : [...p, d.id]))
                    }
                  >
                    {records.find((t) => t.id === d.transcriptionId)?.title ?? d.title}
                    {OWN_WORK.includes(docKind(d.kind)) ? ` · ${KIND_LABEL[docKind(d.kind)]}` : ''}
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>

      {/* Подпись вплотную к кнопке и с её именем — см. Slides.tsx */}
      {topic.trim() !== '' && (
        <p className="draft-note">
          <Icon name="check" /> Чтобы сохранить, нажмите «Составить план».
          Пока бриф только в этом браузере.
        </p>
      )}
      <button
        className="btn primary big"
        disabled={busy}
        onClick={() => void create()}
      >
        {busy ? 'Начинаю…' : 'Составить план'} <Icon name="arrow" />
      </button>
    </section>
  );
}
