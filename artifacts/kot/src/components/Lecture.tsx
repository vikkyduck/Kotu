import { useState, useEffect, useCallback } from 'react';
import { useApp } from '@/hooks/use-app';
import { Icon } from '@/lib/icons';

interface Doc {
  id: number;
  title: string;
  status: string;
}

interface PlanItem {
  heading: string;
  abstract: string;
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
  title: string;
  quote: string;
}

interface LectureFull {
  id: number;
  title: string;
  plan: PlanItem[] | null;
  planApproved: boolean;
  status: 'planning' | 'plan_ready' | 'writing' | 'ready' | 'error';
  statusMessage: string;
  error: string | null;
  sections: Section[];
  sources: Source[];
}

const AUDIENCES = ['студенты', 'коллеги', 'смешанная'];
const DURATIONS = [
  { label: '1 час', value: 60 },
  { label: '2–3 часа', value: 150 },
  { label: '5–6 часов', value: 330 },
];

export function Lecture() {
  // Какую лекцию открыть, решает библиотека: инструмент — это действие,
  // а не ещё один список сделанного.
  const { screen, go, toast, activeLectureId, openLecture } = useApp();
  const [docs, setDocs] = useState<Doc[]>([]);
  const openId = activeLectureId;
  const [lecture, setLecture] = useState<LectureFull | null>(null);

  const [topic, setTopic] = useState('');
  const [audience, setAudience] = useState('студенты');
  const [duration, setDuration] = useState(150);
  const [picked, setPicked] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState('');

  const loadDocs = useCallback(async () => {
    const d = await fetch('/api/documents').then((r) => (r.ok ? r.json() : []));
    setDocs((d as Doc[]).filter((x) => x.status === 'ready'));
  }, []);

  const loadOne = useCallback(async (id: number) => {
    const res = await fetch(`/api/lectures/${id}`);
    if (res.ok) setLecture(await res.json());
  }, []);

  useEffect(() => {
    if (screen !== 's-lecture') return;
    void loadDocs();
  }, [screen, loadDocs]);

  useEffect(() => {
    if (screen !== 's-lecture') setEditing(null);
  }, [screen]);

  useEffect(() => {
    if (openId === null) {
      setLecture(null);
      return;
    }
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
    if (picked.length === 0) {
      toast('Выберите, на что опереться из библиотеки');
      return;
    }
    setBusy(true);
    try {
      const res = await fetch('/api/lectures', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic, audience, durationMin: duration, documentIds: picked }),
      });
      if (res.ok) {
        const created = await res.json();
        setTopic('');
        setPicked([]);
        openLecture(created.id);
      } else {
        const data = await res.json().catch(() => ({}));
        toast(data.message ?? 'Не удалось начать лекцию');
      }
    } finally {
      setBusy(false);
    }
  };

  const approve = async () => {
    if (!lecture) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/lectures/${lecture.id}/plan/approve`, { method: 'POST' });
      if (res.ok) {
        toast('Пишу главы. Можно закрыть страницу.');
        await loadOne(lecture.id);
      } else {
        const data = await res.json().catch(() => ({}));
        toast(data.message ?? 'Не удалось запустить');
      }
    } finally {
      setBusy(false);
    }
  };

  const dropChapter = async (index: number) => {
    if (!lecture?.plan) return;
    const plan = lecture.plan.filter((_, i) => i !== index);
    const res = await fetch(`/api/lectures/${lecture.id}/plan`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plan }),
    });
    if (res.ok) await loadOne(lecture.id);
    else toast('Не удалось изменить план');
  };

  const saveSection = async (section: Section) => {
    if (!lecture) return;
    const res = await fetch(`/api/lectures/${lecture.id}/sections/${section.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: draft }),
    });
    if (res.ok) {
      setEditing(null);
      toast('Правка сохранена');
      await loadOne(lecture.id);
    } else {
      toast('Не удалось сохранить');
    }
  };

  if (screen !== 's-lecture') return null;

  // ── Открытая лекция ─────────────────────────────────────────────────────
  if (lecture) {
    const working = lecture.status === 'planning' || lecture.status === 'writing';

    return (
      <section className="screen active" id="s-lecture">
        <button className="btn ghost back-link" onClick={() => go('s-home')}>
          <Icon name="back" /> В библиотеку
        </button>

        <h2 className="h2">{lecture.title}</h2>

        {lecture.status === 'error' && (
          <div className="panel"><p className="doc-meta bad">{lecture.error}</p></div>
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
            <p className="sub">
              Посмотрите план. Лишние главы можно убрать — и только потом я напишу текст.
            </p>
            <div className="doc-list">
              {lecture.plan.map((p, i) => (
                <div key={i} className="doc-card">
                  <span className="plan-num">{i + 1}</span>
                  <div className="doc-body">
                    <b className="plan-head">{p.heading}</b>
                    <span className="doc-meta">{p.abstract}</span>
                  </div>
                  <button
                    className="btn ghost doc-del"
                    title="Убрать главу"
                    onClick={() => void dropChapter(i)}
                  >
                    <Icon name="trash" />
                  </button>
                </div>
              ))}
            </div>
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

        {/* Готовые главы */}
        {lecture.sections.length > 0 && lecture.status !== 'plan_ready' && (
          <div className="lec-body">
            {lecture.sections.map((s) => {
              const sources = lecture.sources.filter((x) => x.sectionId === s.id);
              return (
                <div key={s.id} className="lec-section">
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
                            <b>{src.title}</b>
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

        {lecture.status === 'ready' && (
          <a
            className="btn big"
            href={`/api/lectures/${lecture.id}/export`}
            style={{ marginTop: 18 }}
          >
            <Icon name="download" /> Скачать текстом
          </a>
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

        <div className="fieldlbl">На что опереться из библиотеки?</div>
        {docs.length === 0 ? (
          <p className="doc-meta">
            Библиотека пуста —{' '}
            <span className="inline-link" onClick={() => go('s-home')}>
              загрузите книги
            </span>
            , и лекция будет опираться на них.
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
              </span>
            ))}
          </div>
        )}
      </div>

      <button
        className="btn primary big"
        disabled={busy || docs.length === 0}
        onClick={() => void create()}
      >
        {busy ? 'Начинаю…' : 'Составить план'} <Icon name="arrow" />
      </button>
    </section>
  );
}
