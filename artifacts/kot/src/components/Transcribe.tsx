import React, { useState, useEffect, useRef } from 'react';
import {
  useTranscription,
  deleteTranscription as deleteTranscriptionRequest,
  type Transcription,
  type TranscriptSegment,
} from '@/hooks/use-transcription';
import type { Document } from '@workspace/db/schema';
import { useApp } from '@/hooks/use-app';
import { useUnsavedWarning } from '@/hooks/use-draft';
import { failText } from '@/lib/http';
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
  const { screen, go, leaveMissing, toast, activeTranscriptionId, openTranscription, newTranscription } = useApp();
  const [deleting, setDeleting] = useState(false);

  const deleteActive = async (id: number) => {
    setDeleting(true);
    const err = await deleteTranscriptionRequest(id);
    setDeleting(false);
    if (err) {
      toast(err);
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
  // Скрытие имён по умолчанию выключено: на платформе лекции и воркшопы, а не
  // сеансы (решение владелицы 23.09.2026) — включает сама, когда нужно.
  const [opts, setOpts] = useState({ names: 'off', spk: 'on' });

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
    failed: activeFailed,
    reload: reloadActive,
    save,
    retry: retryOnServer,
  } = useTranscription(activeTranscriptionId);
  const [retrying, setRetrying] = useState(false);

  // Где человек сейчас — чтобы по окончании загрузки не выдёргивать его
  // с другого экрана. И идёт ли передача файла: эффект ниже её не сбрасывает.
  const here = useRef({ screen, activeTranscriptionId });
  here.current = { screen, activeTranscriptionId };
  const uploadingRef = useRef(uploading);
  uploadingRef.current = uploading;

  // Закрытая вкладка обрывает передачу файла — записи на сервере не будет.
  useUnsavedWarning(uploading);

  const resetUpload = () => {
    setFile(null);
    setView('tcUpload');
    setSub('Загрузите аудио — я переведу его в текст.');
  };

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
    } else if (!uploadingRef.current) {
      resetUpload();
    }
  }, [screen, activeTranscriptionId]);

  // Удалённая или чужая запись по адресу («назад» после удаления, старая ссылка).
  useEffect(() => {
    if (screen === 's-transcribe' && activeTranscriptionId != null && activeFailed === 'missing') {
      toast('Запись не найдена');
      leaveMissing();
    }
  }, [screen, activeTranscriptionId, activeFailed, toast, leaveMissing]);

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
    setSub(null);
    setError(null);

    try {
      const form = new FormData();
      form.append('audio', file);
      form.append('hideNames', opts.names === 'on' ? 'true' : 'false');
      form.append('markSpeakers', opts.spk === 'on' ? 'true' : 'false');

      const res = await fetch('/api/transcriptions/upload', { method: 'POST', body: form });

      if (!res.ok) throw new Error(await failText(res, 'Не удалось загрузить запись. Попробуйте ещё раз.'));

      const created = (await res.json()) as Transcription;
      setUploading(false);
      // Ушла с экрана, пока шла передача, — не выдёргиваем, а сообщаем.
      if (here.current.screen !== 's-transcribe' || here.current.activeTranscriptionId != null) {
        toast('Запись загружена — расшифровываю');
        return;
      }
      // Celebrate this one when it finishes; hand off to the polling view.
      justUploadedId.current = created.id;
      celebrated.current = false;
      openTranscription(created.id);
    } catch (err) {
      setUploading(false);
      const msg = err instanceof Error ? err.message : 'Что-то пошло не так.';
      if (here.current.screen !== 's-transcribe') toast(msg);
      setError(msg);
      setSub('Можно попробовать ещё раз.');
    }
  };

  // Повтор из аудио, что уже лежит на сервере: провал чаще про сбой по
  // дороге, чем про сам файл. Причину отказа показываем; на новую загрузку
  // уводим только при 409 — аудио не сохранилось или повторять нечего.
  // Нет сети, архив недоступен — остаёмся здесь, повтор ещё сработает.
  const retry = async () => {
    setRetrying(true);
    const fail = await retryOnServer();
    setRetrying(false);
    if (!fail) return;
    toast(fail.message);
    if (fail.status !== 409) return;
    justUploadedId.current = null;
    newTranscription();
  };

  const removeActive = () => {
    if (activeTranscriptionId == null) return;
    if (!window.confirm(active ? `Удалить «${active.title}»?` : 'Удалить запись?')) return;
    void deleteActive(activeTranscriptionId);
  };

  if (screen !== 's-transcribe') return null;

  // ---- Derive which phase to render -------------------------------------------
  const isActive = activeTranscriptionId != null;
  // Передача файла относится к форме новой записи, а не к открытой из библиотеки.
  const sending = uploading && !isActive;
  const status = active?.status;
  const showResult = isActive && status === 'done';
  const showError = isActive && status === 'error';
  const showLoadError = isActive && !active && !activeLoading && activeFailed === 'error';
  const showProcessing =
    sending || (isActive && (status === 'processing' || (!active && activeLoading)));

  const stepperView = showResult
    ? 'tcResult'
    : showError || showLoadError
      ? 'tcError'
      : showProcessing
        ? 'tcProc'
        : view;

  const procMessage = sending
    ? 'Загружаю запись…'
    : active?.statusMessage || 'Готовлю запись…';
  const procProgress = sending ? 4 : Math.max(4, active?.progress ?? 4);

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
            <div className="hint">или нажмите, чтобы выбрать файл</div>
          </div>
        </div>
      )}

      {!isActive && !uploading && view === 'tcReady' && file && (
        <div id="tcReady">
          <div className="filecard" style={{ marginBottom: '16px' }}>
            <span className="fi"><Icon name="headphones" /></span>
            <div><b>{file.name}</b><span>{formatSize(file.size)}</span></div>
            <button className="chg" onClick={resetUpload}>заменить</button>
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
                    ? 'Помечу реплики: Speaker 1, Speaker 2…'
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
            {!sending && (
              <p className="preassure">Можно закрыть страницу — я продолжу и соберу единый текст, он будет ждать вас здесь.</p>
            )}
          </div>
          {!sending && active && (
            <div className="btnrow">
              <button className="btn danger" disabled={deleting} onClick={removeActive}>
                <Icon name="trash" /> {deleting ? 'Удаляю…' : 'Удалить'}
              </button>
            </div>
          )}
        </div>
      )}

      {showLoadError && (
        <div className="errblock">
          <h3 className="errttl">Не удалось открыть запись</h3>
          <div className="btnrow">
            <button className="btn primary" style={{ flex: 1 }} onClick={() => void reloadActive()}>
              Обновить
            </button>
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
              onClick={removeActive}
            >
              <Icon name="trash" /> {deleting ? 'Удаляю…' : 'Удалить'}
            </button>
          </div>
        </div>
      )}

      {showResult && active && (
        <ResultView
          data={active}
          save={save}
          celebrated={celebrated}
          onDelete={removeActive}
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
  onDelete,
  deleting,
}: {
  /** Запись приходит сверху: опрашивает её один экран, а не каждый блок свой. */
  data: Transcription;
  save: (patch: { segments?: TranscriptSegment[]; title?: string }) => Promise<string | null>;
  celebrated: React.MutableRefObject<boolean>;
  onDelete: () => void;
  deleting: boolean;
}) {
  const { go, toast, openSheet, newLecture, newDeck } = useApp();
  const [segments, setSegments] = useState<TranscriptSegment[]>([]);

  useEffect(() => {
    setSegments(data.segments);
  }, [data]);

  useEffect(() => {
    if (!celebrated.current) {
      celebrated.current = true;
      const head = document.querySelector('#tcResult .done-head');
      if (head) {
        const r = head.getBoundingClientRect();
        Celebrate.success(window.innerWidth / 2, Math.max(150, r.top + 30));
      }
    }
  }, [data, celebrated]);

  // Копия в библиотеке — из неё делают лекцию и презентацию. Сразу после
  // расшифровки и после каждой правки она переразбирается: ждём готовности.
  const docId = useLibraryCopy(data.id, data.updatedAt);

  const rename = () => {
    openSheet(`Как переименовать «${data.title}»?`, (name) => {
      const title = name.slice(0, 200);
      if (!title || title === data.title) return;
      // Непринятая правка текста едет вместе с названием: иначе ответ сервера
      // перерисует строки его копией, и правка исчезнет с экрана.
      void save(unsaved ? { title, segments } : { title }).then((err) => {
        if (err) toast(err);
        else setUnsaved(false);
      });
    }, data.title);
  };

  // Правка, которую сервер не принял (сессия истекла, нет сети). Не тостом:
  // он гаснет за вход поверх приложения, а правка на экране выглядит целой.
  const [unsaved, setUnsaved] = useState(false);

  const saveSegments = (next: TranscriptSegment[]) => {
    void save({ segments: next }).then((err) => setUnsaved(err !== null));
  };

  const saveSegment = (index: number, text: string) => {
    // Сверка и с экраном, и с сервером: несохранённая правка уйдёт со следующим
    // уходом из строки, даже если текст в ней с тех пор не менялся.
    if (text === (segments[index]?.text ?? '') && text === (data.segments[index]?.text ?? '')) return;
    const next = segments.map((s, i) => (i === index ? { ...s, text } : s));
    setSegments(next);
    saveSegments(next);
  };

  const downloadText = () => {
    const reveal = (t: string) =>
      parseTokens(t)
        .map((k) => (k.type === 'name' && data.hideNames ? 'имя скрыто' : k.value))
        .join('');
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

  return (
    <div id="tcResult">
      <div className="done-head">
        <span className="dh-ic"><Icon name="check" /></span>
        <div><h3>{data.title}</h3><p>Уже сохранена. Можно спокойно читать и править.</p></div>
        <button className="chg" onClick={rename}>переименовать</button>
      </div>
      {unsaved ? (
        <p className="tnote bad">
          <Icon name="info" />
          <span>
            Правка не сохранилась —{' '}
            <span className="inline-link" onClick={() => saveSegments(segments)}>
              сохранить ещё раз
            </span>
          </span>
        </p>
      ) : (
        <p className="tnote"><Icon name="info" /> Если слово распознано неверно — просто исправьте его прямо в тексте, как в обычном документе. Всё сохраняется само.</p>
      )}
      {data.hideNames && (
        <p className="tnote"><Icon name="eye" /> Имена скрыты. Нажмите «имя скрыто», чтобы увидеть — это видно только вам.</p>
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

      <div className="btnrow" style={{ flexWrap: 'wrap' }}>
        <button className="btn primary" style={{ flex: 1 }} onClick={downloadText}>
          <Icon name="download" /> Сохранить текст
        </button>
        {docId !== null && (
          <>
            <button className="btn" onClick={() => newLecture({ documentIds: [docId] })}>
              <Icon name="pen" /> Написать лекцию
            </button>
            <button className="btn" onClick={() => newDeck({ sourceKind: 'document', sourceId: docId })}>
              <Icon name="deck" /> Собрать презентацию
            </button>
          </>
        )}
        <button className="btn" onClick={() => go('s-home')}>Готово</button>
        <button
          className="btn danger"
          onClick={onDelete}
          disabled={deleting}
          title="Удалить расшифровку"
        >
          <Icon name="trash" /> {deleting ? 'Удаляю…' : 'Удалить'}
        </button>
      </div>
    </div>
  );
}

/** Сколько раз заглянуть в библиотеку, если копии там пока нет (её пишут сразу после «готово»). */
const COPY_LOOKS = 3;
const COPY_POLL_MS = 4000;

/**
 * id готовой копии записи в библиотеке или null. Копии может не быть вовсе
 * (слишком короткий текст) — тогда после нескольких попыток просто перестаём искать.
 */
function useLibraryCopy(transcriptionId: number, updatedAt: string): number | null {
  const [docId, setDocId] = useState<number | null>(null);
  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let misses = 0;
    setDocId(null);
    const look = async () => {
      try {
        const res = await fetch('/api/documents');
        if (!res.ok || stop) return;
        const docs = (await res.json()) as Pick<Document, 'id' | 'transcriptionId' | 'status'>[];
        const doc = docs.find((d) => d.transcriptionId === transcriptionId);
        if (stop) return;
        if (doc?.status === 'ready') setDocId(doc.id);
        else if (doc ? doc.status !== 'error' : ++misses < COPY_LOOKS) timer = setTimeout(look, COPY_POLL_MS);
      } catch {
        /* без кнопок «лекция / презентация» — не беда */
      }
    };
    void look();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [transcriptionId, updatedAt]);
  return docId;
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

/**
 * Цвет пометки говорящего: чётные Speaker — вторым цветом, чтобы соседние
 * реплики разных людей различались. Старые записи с «Вы / Собеседник»
 * выглядят как раньше.
 */
function speakerTone(who: string): string {
  if (who === 'Вы') return '';
  const n = Number(who.match(/\d+/)?.[0]);
  return Number.isInteger(n) && n % 2 === 1 ? '' : 'b';
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
        <div className={`who ${speakerTone(seg.who)}`}>{seg.who}</div>
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
