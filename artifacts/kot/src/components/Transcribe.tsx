import React, { useState, useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  useGetTranscription,
  useUpdateTranscription,
  getGetTranscriptionQueryKey,
  getListTranscriptionsQueryKey,
  type Transcription,
  type TranscriptSegment,
} from '@workspace/api-client-react';
import { useApp } from '@/hooks/use-app';
import { Icon } from '@/lib/icons';
import { Celebrate } from '@/lib/celebrate';

const ACCEPT = 'audio/*,.m4a,.mp3,.wav,.mp4,.ogg,.webm,.flac';

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

export function Transcribe() {
  const { screen, go, toast, activeTranscriptionId, openTranscription, newTranscription } = useApp();
  const queryClient = useQueryClient();

  const [view, setView] = useState<'tcUpload' | 'tcReady' | 'tcProc' | 'tcResult'>('tcUpload');
  const [sub, setSub] = useState<string | null>('Загрузите аудио — я переведу его в текст.');

  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [opts, setOpts] = useState({ names: 'on', spk: 'on' });
  const [optsOpen, setOptsOpen] = useState({ names: false, spk: false });

  const [procStat, setProcStat] = useState('Слушаю запись…');
  const [procProgress, setProcProgress] = useState(6);
  const [error, setError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const celebrated = useRef(false);

  const clearTimers = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
  };
  const schedule = (fn: () => void, ms: number) => {
    const id = setTimeout(fn, ms);
    timers.current.push(id);
  };

  useEffect(() => () => clearTimers(), []);

  // React to opening an existing transcription or starting a new one.
  useEffect(() => {
    if (screen !== 's-transcribe') return;
    clearTimers();
    setError(null);
    if (activeTranscriptionId != null) {
      celebrated.current = true; // do not celebrate for already-saved items
      setView('tcResult');
      setSub(null);
    } else {
      setFile(null);
      setView('tcUpload');
      setSub('Загрузите аудио — я переведу его в текст.');
    }
  }, [screen, activeTranscriptionId]);

  const acceptFile = (f: File) => {
    if (f.size > 25 * 1024 * 1024) {
      setError('Файл слишком большой — максимум 25 МБ. Попробуйте сжать запись.');
      return;
    }
    setError(null);
    setFile(f);
    setView('tcReady');
    setSub('Всё настроено бережно. Проверьте — и начнём.');
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) acceptFile(f);
  };

  const runTranscribe = async () => {
    if (!file) return;
    clearTimers();
    setView('tcProc');
    setSub('Идёт работа — можно не ждать у экрана.');
    setError(null);

    // Reassuring progress animation while the request is in flight.
    const steps = ['Слушаю запись…', 'Записываю текст…'];
    if (opts.spk === 'on') steps.push('Различаю, кто говорит…');
    if (opts.names === 'on') steps.push('Скрываю имена пациентов…');
    steps.push('Навожу порядок…');

    let i = 0;
    setProcProgress(6);
    setProcStat(steps[0]);
    const tick = () => {
      i++;
      if (i < steps.length) {
        setProcProgress(Math.min(92, Math.round((i / steps.length) * 100)));
        setProcStat(steps[i]);
        schedule(tick, 1400);
      }
    };
    schedule(tick, 1400);

    try {
      const form = new FormData();
      form.append('audio', file);
      form.append('hideNames', opts.names === 'on' ? 'true' : 'false');
      form.append('markSpeakers', opts.spk === 'on' ? 'true' : 'false');

      const res = await fetch('/api/transcriptions/upload', { method: 'POST', body: form });
      clearTimers();

      if (!res.ok) {
        let msg = 'Не удалось расшифровать запись. Попробуйте ещё раз.';
        try {
          const data = await res.json();
          if (data?.error) msg = data.error;
        } catch {
          // keep default
        }
        throw new Error(msg);
      }

      const created = (await res.json()) as Transcription;
      setProcProgress(100);
      setProcStat('Готово');

      queryClient.setQueryData(getGetTranscriptionQueryKey(created.id), created);
      queryClient.invalidateQueries({ queryKey: getListTranscriptionsQueryKey() });

      celebrated.current = false;
      schedule(() => {
        openTranscription(created.id);
      }, 450);
    } catch (err) {
      clearTimers();
      setError(err instanceof Error ? err.message : 'Что-то пошло не так.');
      setView('tcReady');
      setSub('Можно попробовать ещё раз.');
    }
  };

  if (screen !== 's-transcribe') return null;

  return (
    <section className="screen active" id="s-transcribe">
      <h2 className="h2">Расшифровать запись</h2>
      {sub && <p className="sub" id="tcSub">{sub}</p>}

      <Stepper view={view} />

      {error && view !== 'tcResult' && (
        <p className="tnote" style={{ color: 'var(--danger, #c0392b)' }}>
          <Icon name="info" /> {error}
        </p>
      )}

      {view === 'tcUpload' && (
        <div id="tcUpload">
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPT}
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) acceptFile(f);
              e.target.value = '';
            }}
          />
          <div
            className={`drop ${dragOver ? 'over' : ''}`}
            id="dropZone"
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
          >
            <div className="dz"><Icon name="upload" /></div>
            <b>Перетащите запись сюда</b>
            <div className="hint">или нажмите, чтобы выбрать файл · запись остаётся у вас</div>
            <div className="hint">аудиофайл до 25 МБ — примерно час записи</div>
          </div>
        </div>
      )}

      {view === 'tcReady' && file && (
        <div id="tcReady">
          <div className="filecard" style={{ marginBottom: '16px' }}>
            <span className="fi"><Icon name="headphones" /></span>
            <div><b>{file.name}</b><span>{formatSize(file.size)}</span></div>
            <button className="chg" onClick={newTranscription}>заменить</button>
          </div>

          <div className="panel">
            <div style={{ fontSize: '14px', fontWeight: 600, marginBottom: '4px' }}>Я позабочусь об этом сама:</div>

            <div className="setrow">
              <span className={`si ${opts.names === 'off' ? 'off' : ''}`} id="iconNames">
                <Icon name="check" />
              </span>
              <div className="st">
                <p id="txtNames" dangerouslySetInnerHTML={{ __html: opts.names === 'on' ? 'Скрою имена и города пациентов — в тексте будет «<b>скрыто</b>».' : 'Оставлю текст как есть — имена скрывать не буду.' }} />
                <button className="chg" onClick={() => setOptsOpen(s => ({ ...s, names: !s.names }))}>
                  {opts.names === 'on' ? 'это моя лекция, скрывать не нужно' : 'скрыть имена'}
                </button>
                <div className={`opts ${optsOpen.names ? 'open' : ''}`} id="optNames">
                  <div className={`opt ${opts.names === 'on' ? 'sel' : ''}`} onClick={() => setOpts(s => ({ ...s, names: 'on' }))}>
                    <span className="rd"></span><div>Это сеанс с пациентом — скрыть имена <small>рекомендую для записей сеансов</small></div>
                  </div>
                  <div className={`opt ${opts.names === 'off' ? 'sel' : ''}`} onClick={() => setOpts(s => ({ ...s, names: 'off' }))}>
                    <span className="rd"></span><div>Это моя лекция — скрывать ничего не нужно</div>
                  </div>
                </div>
              </div>
            </div>

            <div className="setrow">
              <span className={`si ${opts.spk === 'off' ? 'off' : ''}`} id="iconSpk">
                <Icon name="check" />
              </span>
              <div className="st">
                <p id="txtSpk">{opts.spk === 'on' ? 'Помечу, где говорите вы, а где собеседник.' : 'Не буду помечать говорящих — просто сплошной текст.'}</p>
                <button className="chg" onClick={() => setOptsOpen(s => ({ ...s, spk: !s.spk }))}>
                  {opts.spk === 'on' ? 'не нужно помечать' : 'пометить говорящих'}
                </button>
                <div className={`opts ${optsOpen.spk ? 'open' : ''}`} id="optSpk">
                  <div className={`opt ${opts.spk === 'on' ? 'sel' : ''}`} onClick={() => setOpts(s => ({ ...s, spk: 'on' }))}>
                    <span className="rd"></span><div>Пометить, кто говорит</div>
                  </div>
                  <div className={`opt ${opts.spk === 'off' ? 'sel' : ''}`} onClick={() => setOpts(s => ({ ...s, spk: 'off' }))}>
                    <span className="rd"></span><div>Не нужно — это просто запись лекции</div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <button className="btn primary big" onClick={runTranscribe}>Расшифровать запись <Icon name="arrow" /></button>
          <p style={{ textAlign: 'center', fontSize: '13px', color: 'var(--muted)', margin: '12px 0 0' }}>
            Распознавание занимает немного времени — пара минут на запись сеанса.
          </p>
        </div>
      )}

      {view === 'tcProc' && (
        <div id="tcProc">
          <div className="panel proc">
            <div className="orb"><span className="core"></span></div>
            <p className="pstat" id="procStat">{procStat}</p>
            <div className="pbar"><i id="procBar" style={{ width: `${procProgress}%` }}></i></div>
            <p className="preassure">Идёт распознавание — это может занять минуту-другую. Я сохраню готовый текст, и он будет ждать вас здесь.</p>
          </div>
        </div>
      )}

      {view === 'tcResult' && (
        <ResultView celebrated={celebrated} onDone={() => go('s-home')} toast={toast} />
      )}
    </section>
  );
}

function Stepper({ view }: { view: string }) {
  const n = view === 'tcUpload' ? 0 : view === 'tcReady' ? 1 : 2;
  const allDone = view === 'tcResult';
  const loading = view === 'tcProc';

  return (
    <div className="stepper" id="tcSteps">
      {[{ lbl: 'Запись' }, { lbl: 'Проверка' }, { lbl: 'Готово' }].map((s, i) => {
        const done = allDone || i < n;
        const active = allDone ? i === 2 : i === n;
        const isLoading = active && loading;
        return (
          <React.Fragment key={i}>
            <div className={`step ${done ? 'done' : ''} ${active ? 'active' : ''} ${isLoading ? 'loading' : ''}`}>
              <span className="sdot">{done ? <Icon name="check" /> : (i + 1)}</span>
              <span className="slbl">{s.lbl}</span>
            </div>
            {i < 2 && <div className={`sline ${allDone || i < n ? 'fill' : ''}`}></div>}
          </React.Fragment>
        );
      })}
    </div>
  );
}

function ResultView({
  celebrated,
  onDone,
  toast,
}: {
  celebrated: React.MutableRefObject<boolean>;
  onDone: () => void;
  toast: (msg: string) => void;
}) {
  const { activeTranscriptionId } = useApp();
  const id = activeTranscriptionId ?? 0;
  const { data, isLoading } = useGetTranscription(id, {
    query: { enabled: id > 0, queryKey: getGetTranscriptionQueryKey(id) },
  });
  const update = useUpdateTranscription();

  const [segments, setSegments] = useState<TranscriptSegment[]>([]);

  useEffect(() => {
    if (data?.segments) setSegments(data.segments);
  }, [data]);

  useEffect(() => {
    if (data && !celebrated.current) {
      celebrated.current = true;
      const head = document.querySelector('#tcResult .done-head');
      if (head) {
        const r = head.getBoundingClientRect();
        Celebrate.success(window.innerWidth / 2, Math.max(150, r.top + 30));
      }
    }
  }, [data, celebrated]);

  const saveSegment = (index: number, text: string) => {
    if (!data) return;
    const current = segments[index]?.text ?? '';
    if (text === current) return;
    const next = segments.map((s, i) => (i === index ? { ...s, text } : s));
    setSegments(next);
    update.mutate({ id, data: { segments: next } });
  };

  const downloadText = () => {
    if (!data) return;
    const body = segments
      .map((s) => (s.who ? `${s.who}: ${s.text}` : s.text))
      .join('\n\n');
    const blob = new Blob([body], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${data.title || 'расшифровка'}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    toast('Текст сохранён в файл');
  };

  if (isLoading || !data) {
    return (
      <div id="tcResult">
        <div className="panel proc">
          <div className="orb"><span className="core"></span></div>
          <p className="pstat">Открываю расшифровку…</p>
        </div>
      </div>
    );
  }

  return (
    <div id="tcResult">
      <div className="done-head">
        <span className="dh-ic"><Icon name="check" /></span>
        <div><h3>Готово — вот ваша расшифровка</h3><p>Уже сохранена. Можно спокойно читать и править.</p></div>
      </div>
      <p className="tnote"><Icon name="info" /> Если слово распознано неверно — просто исправьте его прямо в тексте, как в обычном документе. Всё сохраняется само.</p>

      <div className="panel" id="transcript">
        {segments.map((l, idx) => (
          <div className="tline" key={idx}>
            {data.markSpeakers && l.who && (
              <div className={`who ${l.who !== 'Вы' ? 'b' : ''}`}>{l.who}</div>
            )}
            <div
              className="txt"
              contentEditable
              suppressContentEditableWarning
              spellCheck={false}
              onBlur={(e) => saveSegment(idx, e.currentTarget.textContent ?? '')}
            >
              {l.text}
            </div>
          </div>
        ))}
      </div>

      <div className="btnrow">
        <button className="btn primary" style={{ flex: 1 }} onClick={downloadText}>
          <Icon name="download" /> Сохранить текст
        </button>
        <button className="btn" onClick={onDone}>Готово</button>
      </div>
    </div>
  );
}
