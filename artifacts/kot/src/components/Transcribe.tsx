import React, { useState, useEffect, useRef } from 'react';
import {
  useTranscription,
  deleteTranscription as deleteTranscriptionRequest,
  type Transcription,
  type TranscriptSegment,
} from '@/hooks/use-transcription';
import { useApp } from '@/hooks/use-app';
import { Icon } from '@/lib/icons';
import { Celebrate } from '@/lib/celebrate';

const ACCEPT =
  'audio/*,video/*,.m4a,.m4b,.mp3,.wav,.mp4,.mov,.ogg,.opus,.webm,.mkv,.flac,.aac,.amr,.3gp,.wma,.aiff,.caf';
const MAX_UPLOAD_BYTES = 1024 * 1024 * 1024;

function formatSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} ГБ`;
}

export function Transcribe() {
  const { screen, go, toast, activeTranscriptionId, openTranscription, newTranscription } = useApp();
  const [deleting, setDeleting] = useState(false);

  const deleteActive = async (id: number) => {
    setDeleting(true);
    const ok = await deleteTranscriptionRequest(id);
    setDeleting(false);
    if (!ok) {
      toast('Не удалось удалить — попробуйте ещё раз');
      return;
    }
    justUploadedId.current = null;
    toast('Запись удалена');
    go('s-home');
  };

  const [view, setView] = useState<'tcUpload' | 'tcReady'>('tcUpload');
  const [sub, setSub] = useState<string | null>('Загрузите аудио — я переведу его в текст.');

  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [opts, setOpts] = useState({ names: 'on', spk: 'on' });

  // While the upload request itself is in flight (before we have a row to poll).
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const celebrated = useRef(false);
  // Tracks the id we just created via upload, so we celebrate it on completion
  // but never re-celebrate items reopened from the home screen.
  const justUploadedId = useRef<number | null>(null);

  // Запись опрашивается, пока сервер над ней работает, — прогресс на экране
  // движется сам. Останавливается опрос в хуке, как только работа закончена.
  const {
    data: active,
    loading: activeLoading,
    save,
    retry: retryOnServer,
  } = useTranscription(activeTranscriptionId);
  const [retrying, setRetrying] = useState(false);

  // React to opening an existing transcription or starting a new one.
  useEffect(() => {
    if (screen !== 's-transcribe') return;
    setError(null);
    if (activeTranscriptionId != null) {
      // Only celebrate the recording we just finished uploading in this session.
      if (activeTranscriptionId !== justUploadedId.current) {
        celebrated.current = true;
      }
      setSub(null);
    } else {
      setFile(null);
      setUploading(false);
      setView('tcUpload');
      setSub('Загрузите аудио — я переведу его в текст.');
    }
  }, [screen, activeTranscriptionId]);

  const acceptFile = (f: File) => {
    if (f.size > MAX_UPLOAD_BYTES) {
      setError('Файл слишком большой — максимум 1 ГБ.');
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
    setUploading(true);
    setSub('Идёт работа — можно не ждать у экрана.');
    setError(null);

    try {
      const form = new FormData();
      form.append('audio', file);
      form.append('hideNames', opts.names === 'on' ? 'true' : 'false');
      form.append('markSpeakers', opts.spk === 'on' ? 'true' : 'false');

      const res = await fetch('/api/transcriptions/upload', { method: 'POST', body: form });

      if (!res.ok) {
        let msg = 'Не удалось загрузить запись. Попробуйте ещё раз.';
        try {
          const data = await res.json();
          if (data?.error) msg = data.error;
        } catch {
          // keep default
        }
        throw new Error(msg);
      }

      const created = (await res.json()) as Transcription;

      // Celebrate this one when it finishes; hand off to the polling view.
      justUploadedId.current = created.id;
      celebrated.current = false;
      setUploading(false);
      openTranscription(created.id);
    } catch (err) {
      setUploading(false);
      setError(err instanceof Error ? err.message : 'Что-то пошло не так.');
      setSub('Можно попробовать ещё раз.');
    }
  };

  // Сначала повтор из аудио, что уже лежит на сервере: провал чаще про сбой
  // по дороге, чем про сам файл. Не вышло (аудио не сохранилось, записи нет,
  // нет сети) — тогда, как раньше, форма новой загрузки.
  const retry = async () => {
    if (activeTranscriptionId != null) {
      setRetrying(true);
      const ok = await retryOnServer();
      setRetrying(false);
      if (ok) return;
    }
    justUploadedId.current = null;
    newTranscription();
  };

  if (screen !== 's-transcribe') return null;

  // ---- Derive which phase to render -------------------------------------------
  const isActive = activeTranscriptionId != null;
  const status = active?.status;
  const showResult = isActive && status === 'done';
  const showError = isActive && status === 'error';
  const showProcessing =
    uploading || (isActive && (status === 'processing' || status === 'queued' || (!active && activeLoading)));

  const stepperView = showResult
    ? 'tcResult'
    : showProcessing || showError
      ? 'tcProc'
      : view;

  const procMessage = uploading
    ? 'Загружаю запись…'
    : active?.statusMessage || 'Готовлю запись…';
  const procProgress = uploading ? 4 : Math.max(4, active?.progress ?? 4);
  // Стадия считается из уже приходящего прогресса — без новых запросов к API.
  const procStage = uploading
    ? 'Шаг 1 из 3 · передаю файл'
    : procProgress < 35
      ? 'Шаг 1 из 3 · читаю запись'
      : procProgress < 80
        ? 'Шаг 2 из 3 · распознаю речь'
        : 'Шаг 3 из 3 · собираю текст';

  return (
    <section className="screen active" id="s-transcribe">
      <h2 className="h2">Расшифровать запись</h2>
      {sub && <p className="sub" id="tcSub">{sub}</p>}

      <Stepper view={stepperView} />

      {error && !isActive && (
        <p className="tnote" style={{ color: 'var(--danger-strong)' }}>
          <Icon name="info" /> {error}
        </p>
      )}

      {!isActive && !uploading && view === 'tcUpload' && (
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
            <div className="hint">или нажмите, чтобы выбрать файл · любая длина · запись остаётся у вас</div>
          </div>
        </div>
      )}

      {!isActive && !uploading && view === 'tcReady' && file && (
        <div id="tcReady">
          <div className="filecard" style={{ marginBottom: '16px' }}>
            <span className="fi"><Icon name="headphones" /></span>
            <div><b>{file.name}</b><span>{formatSize(file.size)}</span></div>
            <button className="chg" onClick={newTranscription}>заменить</button>
          </div>

          {/* Дизайн Lovable: тумблеры вместо текстовых ссылок «изменить» */}
          <div className="panel">
            <div className="setgroup-title">Настройки записи</div>

            <div className="setrow">
              <div className="st">
                <b>Скрыть имена и города</b>
                <p id="txtNames">
                  {opts.names === 'on'
                    ? 'В тексте будет «имя скрыто» — исходное можно посмотреть по клику.'
                    : 'Оставлю текст как есть — подходит для лекций.'}
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={opts.names === 'on'}
                aria-label="Скрыть имена и города"
                className={`switch ${opts.names === 'on' ? 'on' : ''}`}
                onClick={() => setOpts(s => ({ ...s, names: s.names === 'on' ? 'off' : 'on' }))}
              >
                <span className="knob" />
              </button>
            </div>

            <div className="setrow">
              <div className="st">
                <b>Помечать говорящих</b>
                <p id="txtSpk">
                  {opts.spk === 'on'
                    ? 'Отмечу, где говорите вы, а где собеседник.'
                    : 'Соберу сплошной текст без разметки реплик.'}
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={opts.spk === 'on'}
                aria-label="Помечать говорящих"
                className={`switch ${opts.spk === 'on' ? 'on' : ''}`}
                onClick={() => setOpts(s => ({ ...s, spk: s.spk === 'on' ? 'off' : 'on' }))}
              >
                <span className="knob" />
              </button>
            </div>
          </div>

          <button className="btn primary big" onClick={runTranscribe}>Расшифровать запись <Icon name="arrow" /></button>
          <p className="soon-note" style={{ margin: '12px 0 0' }}>
            Распознавание занимает немного времени. Длинные записи я разберу по частям — можно не ждать у экрана.
          </p>
        </div>
      )}

      {showProcessing && (
        <div id="tcProc">
          <div className="panel proc">
            <div className="orb"><span className="core"></span></div>
            <p className="pstat" id="procStat">{procMessage}</p>
            <div className="pbar"><i id="procBar" style={{ width: `${procProgress}%` }}></i></div>
            <p className="pstage">{procStage}</p>
            <p className="preassure">Можно закрыть страницу — я продолжу и соберу единый текст, он будет ждать вас здесь.</p>
          </div>
        </div>
      )}

      {showError && (
        /* Дизайн Lovable (.errblock); действия наши — повтор и удаление сохранены */
        <div id="tcError" className="errblock">
          <h3 className="errttl">Не получилось</h3>
          <p className="errwhy">
            {active?.error || 'Я не смогла распознать эту запись.'}
          </p>
          <div className="btnrow">
            <button
              className="btn primary"
              style={{ flex: 1 }}
              disabled={retrying || deleting}
              onClick={() => void retry()}
            >
              Попробовать снова <Icon name="arrow" />
            </button>
            <button
              className="btn danger"
              disabled={deleting || retrying}
              onClick={() => activeTranscriptionId != null && void deleteActive(activeTranscriptionId)}
            >
              <Icon name="trash" /> {deleting ? 'Удаляю…' : 'Удалить'}
            </button>
          </div>
        </div>
      )}

      {showResult && (
        <ResultView
          data={active}
          save={save}
          celebrated={celebrated}
          onDone={() => go('s-home')}
          toast={toast}
          onDelete={() => activeTranscriptionId != null && void deleteActive(activeTranscriptionId)}
          deleting={deleting}
        />
      )}
    </section>
  );
}

function Stepper({ view }: { view: string }) {
  // Четыре шага: Файл → Настройки → Расшифровка → Готово.
  const STEPS = ['Файл', 'Настройки', 'Расшифровка', 'Готово'];
  const n = view === 'tcUpload' ? 0 : view === 'tcReady' ? 1 : view === 'tcResult' ? 3 : 2;
  const loading = view === 'tcProc';
  const last = STEPS.length - 1;

  return (
    <div className="stepper" id="tcSteps">
      {STEPS.map((lbl, i) => {
        const done = i < n;
        const active = i === n;
        const isLoading = active && loading;
        return (
          <React.Fragment key={lbl}>
            <div className={`step ${done ? 'done' : ''} ${active ? 'active' : ''} ${isLoading ? 'loading' : ''}`}>
              <span className="sdot">{done ? <Icon name="check" /> : (i + 1)}</span>
              <span className="slbl">{lbl}</span>
            </div>
            {i < last && <div className={`sline ${i < n ? 'fill' : ''}`}></div>}
          </React.Fragment>
        );
      })}
    </div>
  );
}

/** Готовая расшифровка: текст, правки автора и выгрузка. */
function ResultView({
  data,
  save,
  celebrated,
  onDone,
  toast,
  onDelete,
  deleting,
}: {
  /** Запись приходит сверху: опрашивает её один экран, а не каждый блок свой. */
  data: Transcription | null;
  save: (patch: { segments?: TranscriptSegment[]; title?: string }) => Promise<boolean>;
  celebrated: React.MutableRefObject<boolean>;
  onDone: () => void;
  toast: (msg: string) => void;
  onDelete: () => void;
  deleting: boolean;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);

  const handleDelete = () => {
    if (!data) return;
    const ok = window.confirm(`Удалить «${data.title}»? Расшифровку нельзя будет вернуть.`);
    if (!ok) return;
    onDelete();
  };

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
    void save({ segments: next }).then((ok) => {
      if (!ok) toast('Правка не сохранилась — попробуйте ещё раз');
    });
  };

  const downloadText = () => {
    if (!data) return;
    const reveal = (t: string) =>
      t.replace(/\[\[([\s\S]+?)\]\]/g, data.hideNames ? 'имя скрыто' : '$1');
    const body = segments
      .map((s) => (s.who ? `${s.who}: ${reveal(s.text)}` : reveal(s.text)))
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

  if (!data) {
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
      {data.hideNames && (
        <p className="tnote"><Icon name="eye" /> Имена пациентов скрыты. Нажмите «имя скрыто», чтобы увидеть — это видно только вам.</p>
      )}

      <div className="panel" id="transcript">
        {segments.map((l, idx) => (
          <TranscriptLine
            key={idx}
            seg={l}
            index={idx}
            showWho={!!data.markSpeakers}
            hideNames={!!data.hideNames}
            onSave={saveSegment}
          />
        ))}
      </div>

      <div className="btnrow">
        <button className="btn primary" style={{ flex: 1 }} onClick={downloadText}>
          <Icon name="download" /> Сохранить текст
        </button>
        <button className="btn" onClick={onDone}>Готово</button>
        <button
          className="btn danger"
          onClick={handleDelete}
          disabled={deleting}
          title="Удалить расшифровку"
        >
          <Icon name="trash" /> Удалить
        </button>
      </div>

      {confirmDelete ? (
        <div className="del-confirm">
          <span>Удалить эту запись? Это нельзя отменить.</span>
          <div className="del-confirm-actions">
            <button className="btn danger" disabled={deleting} onClick={onDelete}>
              {deleting ? 'Удаляю…' : 'Удалить'}
            </button>
            <button className="btn" disabled={deleting} onClick={() => setConfirmDelete(false)}>
              Оставить
            </button>
          </div>
        </div>
      ) : (
        <button className="btn link-danger" onClick={() => setConfirmDelete(true)}>
          <Icon name="trash" /> Удалить запись
        </button>
      )}
    </div>
  );
}

type Token = { type: 'text'; value: string } | { type: 'name'; value: string };

// Split transcript text into plain runs and [[name]] markers (which carry the
// real, hideable personal data).
function parseTokens(text: string): Token[] {
  const tokens: Token[] = [];
  const re = /\[\[([\s\S]+?)\]\]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) tokens.push({ type: 'text', value: text.slice(last, m.index) });
    tokens.push({ type: 'name', value: m[1] });
    last = m.index + m[0].length;
  }
  if (last < text.length) tokens.push({ type: 'text', value: text.slice(last) });
  return tokens;
}

function TranscriptLine({
  seg,
  index,
  showWho,
  hideNames,
  onSave,
}: {
  seg: TranscriptSegment;
  index: number;
  showWho: boolean;
  hideNames: boolean;
  onSave: (index: number, text: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // Build the editable content imperatively so contentEditable stays uncontrolled
  // and the masked name chips render as atomic, non-editable elements.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.replaceChildren();
    for (const tok of parseTokens(seg.text)) {
      if (tok.type === 'text') {
        el.appendChild(document.createTextNode(tok.value));
      } else if (hideNames) {
        const span = document.createElement('span');
        span.className = 'hidden-name';
        span.setAttribute('contenteditable', 'false');
        span.dataset.name = tok.value;
        span.title = 'нажмите, чтобы увидеть — виден только вам';
        span.textContent = 'имя скрыто';
        span.addEventListener('click', () => {
          const shown = span.classList.toggle('shown');
          span.textContent = shown
            ? `${span.dataset.name} · виден только вам`
            : 'имя скрыто';
        });
        el.appendChild(span);
      } else {
        el.appendChild(document.createTextNode(tok.value));
      }
    }
  }, [seg.text, hideNames]);

  const serialize = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue ?? '';
    if (node instanceof HTMLElement) {
      if (node.classList.contains('hidden-name')) return `[[${node.dataset.name ?? ''}]]`;
      if (node.tagName === 'BR') return '\n';
      let inner = '';
      node.childNodes.forEach((c) => {
        inner += serialize(c);
      });
      return /^(DIV|P)$/.test(node.tagName) ? `\n${inner}` : inner;
    }
    return '';
  };

  const handleBlur = () => {
    const el = ref.current;
    if (!el) return;
    let text = '';
    el.childNodes.forEach((n) => {
      text += serialize(n);
    });
    onSave(index, text.replace(/^\n+/, ''));
  };

  return (
    <div className="tline">
      {showWho && seg.who && (
        <div className={`who ${seg.who !== 'Вы' ? 'b' : ''}`}>{seg.who}</div>
      )}
      <div
        ref={ref}
        className="txt"
        contentEditable
        suppressContentEditableWarning
        spellCheck={false}
        onBlur={handleBlur}
      />
    </div>
  );
}
