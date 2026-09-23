import { useState, useEffect, useCallback, useRef } from 'react';
import { useApp } from '@/hooks/use-app';
import { useDraft, useUnsavedWarning } from '@/hooks/use-draft';
import { Icon } from '@/lib/icons';
import { send, json, downloadFile } from '@/lib/http';
import { KIND_LABEL, docKind, type ItemKind } from '@/lib/library-items';

interface Doc {
  id: number;
  title: string;
  kind: string;
  status: string;
}

/** Подпись у материала — только у своих работ: они должны быть отличимы от книги. */
const OWN_WORK: ItemKind[] = ['transcript', 'lecture', 'deck'];

interface PlanItem {
  heading: string;
  abstract: string;
  concepts?: string[];
  hook?: string;
}

/** Спутники плана: что за скобками и где нужно решение автора. */
interface PlanNotes {
  outOfScope: string[];
  decisions: string[];
}

/** Литература двумя уровнями — истоки и современность. */
interface Bibliography {
  primary: string[];
  modern: string[];
}

interface Section {
  id: number;
  ord: number;
  heading: string;
  text: string;
  status: string;
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
  plan: PlanItem[] | null;
  planNotes: PlanNotes | null;
  bibliography: Bibliography | null;
  planApproved: boolean;
  status: 'planning' | 'plan_ready' | 'writing' | 'ready' | 'error';
  statusMessage: string;
  error: string | null;
  sections: Section[];
  sources: Source[];
}

const AUDIENCES = ['студенты', 'коллеги', 'смешанная'];
const FOCUS = [
  { value: 'theoretical', label: 'теоретический' },
  { value: 'clinical', label: 'клинический' },
  { value: 'historical', label: 'исторический' },
] as const;

const DURATIONS = [
  { label: '1 час', value: 60 },
  { label: '2–3 часа', value: 150 },
];

export function Lecture() {
  // Какую лекцию открыть, решает библиотека: инструмент — это действие,
  // а не ещё один список сделанного.
  const { screen, go, leaveMissing, toast, activeLectureId, openLecture, lectureSeed, newDeck } = useApp();
  const [docs, setDocs] = useState<Doc[]>([]);
  const openId = activeLectureId;
  // Ответ мог прийти, когда она уже ушла с этой лекции: чужой экран не трогаем.
  const openRef = useRef(openId);
  openRef.current = openId;
  const [lecture, setLecture] = useState<LectureFull | null>(null);

  // Бриф — тоже черновик: он ценнее всего, что есть на этом экране.
  const [topic, setTopic, clearTopic] = useDraft('lecture-topic', screen === 's-lecture');
  const [audience, setAudience] = useState('студенты');
  const [duration, setDuration] = useState(150);
  const [picked, setPicked] = useState<number[]>([]);
  /** Откуда материал: из выбранных документов или собственное исследование ИИ. */
  /** Источники независимы: можно оба, один или ни одного. */
  const [useLibrary, setUseLibrary] = useState(false);
  const [useResearch, setUseResearch] = useState(false);
  /** Акцентов может быть несколько — или ни одного. */
  const [focus, setFocus] = useState<('clinical' | 'theoretical' | 'historical')[]>([]);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  /** Правка блока плана: индекс и черновики заголовка с тезисом. */
  const [planEdit, setPlanEdit] = useState<number | null>(null);
  const [planHead, setPlanHead] = useState('');
  const [planAbstract, setPlanAbstract] = useState('');

  useUnsavedWarning(screen === 's-lecture' && openId === null && topic.trim() !== '');

  const loadDocs = useCallback(async () => {
    const d = await fetch('/api/documents')
      .then((r) => (r.ok ? r.json() : []))
      .catch(() => []);
    setDocs((d as Doc[]).filter((x) => x.status === 'ready'));
  }, []);

  const loadOne = useCallback(async (id: number) => {
    try {
      const res = await fetch(`/api/lectures/${id}`);
      if (res.ok) {
        setLecture(await res.json());
      } else if (res.status === 404 && id === openRef.current) {
        // Лекцию удалили (другая вкладка, старая ссылка, «назад») — не
        // показывать же под её адресом форму новой.
        toast('Лекция не найдена');
        leaveMissing();
      }
    } catch { /* тихо: поллинг повторит */ }
  }, [toast, leaveMissing]);

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
    if (screen !== 's-lecture') setEditing(null);
  }, [screen]);

  useEffect(() => {
    // Индекс правки плана относится к прежней лекции — в новой он чужой.
    setPlanEdit(null);
    setLecture(null);
    if (openId !== null) void loadOne(openId);
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

  const approve = async () => {
    if (!lecture) return;
    setBusy(true);
    const r = await send(`/api/lectures/${lecture.id}/plan/approve`, { method: 'POST' }, 'Не удалось запустить');
    if (r.ok) {
      toast('Пишу главы. Можно закрыть страницу.');
      await loadOne(lecture.id);
    } else {
      toast(r.message);
    }
    setBusy(false);
  };

  // Тупика после ошибки быть не должно: план составляется заново, а главы
  // дописываются с того места, где письмо оборвалось.
  const retry = async () => {
    if (!lecture) return;
    setBusy(true);
    const r = await send(`/api/lectures/${lecture.id}/retry`, { method: 'POST' }, 'Не удалось перезапустить');
    if (r.ok) {
      toast('Пробую ещё раз');
      await loadOne(lecture.id);
    } else {
      toast(r.message);
    }
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
    go('s-home');
  };

  const download = async (url: string, fallbackName: string) => {
    const err = await downloadFile(url, fallbackName);
    if (err) toast(err);
  };

  const patchPlan = async (plan: PlanItem[]) => {
    if (!lecture) return false;
    const r = await send(`/api/lectures/${lecture.id}/plan`, json('PATCH', { plan }), 'Не удалось изменить план');
    if (!r.ok) {
      toast(r.message);
      return false;
    }
    await loadOne(lecture.id);
    return true;
  };

  const dropChapter = async (index: number) => {
    if (!lecture?.plan) return;
    // Индексы сдвинутся — открытая правка другого блока попала бы не туда.
    setPlanEdit(null);
    await patchPlan(lecture.plan.filter((_, i) => i !== index));
  };

  /** Сохранить правку блока: заголовок и тезис; концепции и крючок остаются. */
  const savePlanEdit = async () => {
    if (!lecture?.plan || planEdit === null) return;
    if (planHead.trim() === '') {
      toast('У блока должно быть название');
      return;
    }
    const plan = lecture.plan.map((b, i) =>
      i === planEdit ? { ...b, heading: planHead.trim(), abstract: planAbstract.trim() } : b,
    );
    if (await patchPlan(plan)) {
      setPlanEdit(null);
      toast('План обновлён');
    }
  };

  const saveSection = async (section: Section) => {
    if (!lecture) return;
    const r = await send(
      `/api/lectures/${lecture.id}/sections/${section.id}`,
      json('PATCH', { text: draft }),
      'Не удалось сохранить',
    );
    if (!r.ok) {
      toast(r.message);
      return;
    }
    setEditing(null);
    toast('Правка сохранена');
    await loadOne(lecture.id);
  };

  if (screen !== 's-lecture') return null;

  // Лекция по адресу ещё грузится — форму новой под её адресом не показываем.
  if (openId !== null && lecture?.id !== openId) {
    return <section className="screen active" id="s-lecture" />;
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

        {/* План, который писать не будут, и готовую лекцию можно удалить прямо
            здесь; у ошибки кнопка удаления — в её блоке. */}
        {(lecture.status === 'plan_ready' || lecture.status === 'ready') && (
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
              <button className="btn danger" onClick={() => void remove()}>
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
                        <button className="btn primary" onClick={() => void savePlanEdit()}>
                          Сохранить
                        </button>
                        <button className="btn ghost" onClick={() => setPlanEdit(null)}>
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
                      onClick={() => {
                        setPlanEdit(i);
                        setPlanHead(p.heading);
                        setPlanAbstract(p.abstract);
                      }}
                    >
                      <Icon name="edit" />
                    </button>
                    <button
                      className="btn ghost doc-del"
                      title="Убрать главу"
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

                  {s.status === 'writing' && <p className="doc-meta busy">пишется…</p>}
                  {s.status === 'pending' && <p className="doc-meta">в очереди</p>}

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
                              setDraft(s.text);
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
                            <span>{src.quote.slice(0, 220)}…</span>
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
            <span
              key={a}
              className={`pill-opt ${audience === a ? 'on' : ''}`}
              onClick={() => setAudience(a)}
            >
              {a}
            </span>
          ))}
        </div>

        <div className="fieldlbl">Примерно на сколько часов?</div>
        <div className="pills">
          {DURATIONS.map((d) => (
            <span
              key={d.value}
              className={`pill-opt ${duration === d.value ? 'on' : ''}`}
              onClick={() => setDuration(d.value)}
            >
              {d.label}
            </span>
          ))}
        </div>

        <div className="fieldlbl">Что важнее в этой лекции? Можно несколько — или ничего</div>
        <div className="pills">
          {FOCUS.map((f) => (
            <span
              key={f.value}
              className={`pill-opt ${focus.includes(f.value) ? 'on' : ''}`}
              onClick={() =>
                setFocus((p) =>
                  p.includes(f.value) ? p.filter((x) => x !== f.value) : [...p, f.value],
                )
              }
            >
              {f.label}
            </span>
          ))}
        </div>

        <div className="fieldlbl">Откуда взять материал? Можно оба источника — или ни одного</div>
        <div className="pills">
          <span
            className={`pill-opt ${useLibrary ? 'on' : ''}`}
            onClick={() => setUseLibrary((v) => !v)}
          >
            Из моей библиотеки
          </span>
          <span
            className={`pill-opt ${useResearch ? 'on' : ''}`}
            onClick={() => setUseResearch((v) => !v)}
          >
            Исследование ИИ
          </span>
        </div>

        {useLibrary && (
          <>
            <div className="fieldlbl">На что опереться из библиотеки?</div>
            {docs.length === 0 ? (
              <p className="doc-meta">
                Библиотека пуста —{' '}
                <span className="inline-link" onClick={() => go('s-home')}>
                  загрузите книги
                </span>
              </p>
            ) : (
              <div className="pills">
                {docs.map((d) => (
                  <span
                    key={d.id}
                    className={`pill-opt ${picked.includes(d.id) ? 'on' : ''}`}
                    onClick={() =>
                      setPicked((p) => (p.includes(d.id) ? p.filter((x) => x !== d.id) : [...p, d.id]))
                    }
                  >
                    {d.title}
                    {OWN_WORK.includes(docKind(d.kind)) ? ` · ${KIND_LABEL[docKind(d.kind)]}` : ''}
                  </span>
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
