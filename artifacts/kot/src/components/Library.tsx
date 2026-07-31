import { useState, useEffect, useRef, useCallback, type DragEvent } from 'react';
import { useApp } from '@/hooks/use-app';
import { Icon } from '@/lib/icons';

interface Doc {
  id: number;
  title: string;
  kind: string;
  folderId: number | null;
  transcriptionId: number | null;
  pages: number | null;
  chunkCount: number;
  status: 'uploaded' | 'parsing' | 'ready' | 'error';
  statusMessage: string;
  error: string | null;
  createdAt: string;
}

interface Folder {
  id: number;
  name: string;
}

const KIND_LABEL: Record<string, string> = {
  book: 'книга',
  article: 'статья',
  note: 'заметка',
  transcript: 'расшифровка',
};

export function Library() {
  const { screen, go, toast, openSheet, openTranscription } = useApp();
  const [docs, setDocs] = useState<Doc[] | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState<string[]>([]);
  const [confirmId, setConfirmId] = useState<number | null>(null);
  /** Документ, у которого раскрыт ряд чипов «в какую папку». */
  const [movingId, setMovingId] = useState<number | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const [d, f] = await Promise.all([
        fetch('/api/documents').then((r) => (r.ok ? r.json() : null)),
        fetch('/api/folders').then((r) => (r.ok ? r.json() : null)),
      ]);
      if (d) setDocs(d);
      if (f) setFolders(f);
    } catch {
      /* сеть моргнула — покажем то, что уже есть */
    }
  }, []);

  useEffect(() => {
    if (screen !== 's-library') return;
    void load();
  }, [screen, load]);

  useEffect(() => {
    if (screen !== 's-library') setMovingId(null);
  }, [screen]);

  // Пока хоть один документ разбирается — обновляем список, чтобы
  // прогресс двигался сам, без кнопки «обновить».
  useEffect(() => {
    if (screen !== 's-library') return;
    const busy = docs?.some((d) => d.status === 'parsing' || d.status === 'uploaded');
    if (!busy && uploading.length === 0) return;
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [screen, docs, uploading, load]);

  const send = async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (list.length === 0) return;
    setUploading(list.map((f) => f.name));

    for (const file of list) {
      const form = new FormData();
      form.append('file', file);
      try {
        const res = await fetch('/api/documents', { method: 'POST', body: form });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          toast(data.message ?? `Не удалось загрузить «${file.name}»`);
        }
      } catch {
        toast(`Не удалось загрузить «${file.name}»`);
      }
    }

    setUploading([]);
    await load();
  };

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    void send(e.dataTransfer.files);
  };

  const remove = async (id: number) => {
    try {
      const res = await fetch(`/api/documents/${id}`, { method: 'DELETE' });
      if (res.ok) {
        setConfirmId(null);
        toast('Документ удалён');
        await load();
      } else {
        const data = await res.json().catch(() => ({}));
        toast(data.message ?? 'Не удалось удалить');
      }
    } catch {
      toast('Нет связи с сервером. Попробуйте ещё раз.');
    }
  };

  const moveTo = async (docId: number, folderId: number | null) => {
    try {
      const res = await fetch(`/api/documents/${docId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderId }),
      });
      if (res.ok) {
        setMovingId(null);
        await load();
      } else {
        toast('Не удалось переложить');
      }
    } catch {
      toast('Нет связи с сервером. Попробуйте ещё раз.');
    }
  };

  const createFolder = () => {
    openSheet('Как назвать папку?', 'N', (name) => {
      void (async () => {
        try {
          const res = await fetch('/api/folders', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name }),
          });
          if (res.ok) await load();
          else {
            const data = await res.json().catch(() => ({}));
            toast(data.message ?? 'Не удалось создать папку');
          }
        } catch {
          toast('Нет связи с сервером. Попробуйте ещё раз.');
        }
      })();
    });
  };

  const renameFolder = (f: Folder) => {
    openSheet(`Как переименовать «${f.name}»?`, 'N', (name) => {
      void (async () => {
        try {
          const res = await fetch(`/api/folders/${f.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name }),
          });
          if (res.ok) await load();
          else toast('Не удалось переименовать');
        } catch {
          toast('Нет связи с сервером. Попробуйте ещё раз.');
        }
      })();
    });
  };

  const removeFolder = async (f: Folder) => {
    if (!window.confirm(`Удалить папку «${f.name}»? Документы останутся — просто без папки.`)) return;
    try {
      const res = await fetch(`/api/folders/${f.id}`, { method: 'DELETE' });
      if (res.ok) await load();
      else toast('Не удалось удалить папку');
    } catch {
      toast('Нет связи с сервером. Попробуйте ещё раз.');
    }
  };

  if (screen !== 's-library') return null;

  const empty = docs !== null && docs.length === 0 && uploading.length === 0;

  const renderDoc = (d: Doc) => (
    <div key={d.id}>
      <div className={`doc-card ${d.status}`}>
        <span className="doc-ico"><Icon name={d.kind === 'transcript' ? 'mic' : 'book'} /></span>

        <div className="doc-body">
          {d.kind === 'transcript' && d.transcriptionId !== null ? (
            <b
              className="doc-title doc-link"
              onClick={() => openTranscription(d.transcriptionId!)}
            >
              {d.title}
            </b>
          ) : (
            <b className="doc-title">{d.title}</b>
          )}
          {d.status === 'ready' && (
            <span className="doc-meta">
              {KIND_LABEL[d.kind] ?? d.kind}
              {d.pages ? ` · ${d.pages} с.` : ''} · {d.chunkCount} фрагментов
            </span>
          )}
          {(d.status === 'parsing' || d.status === 'uploaded') && (
            <span className="doc-meta busy">{d.statusMessage || 'В очереди…'}</span>
          )}
          {d.status === 'error' && <span className="doc-meta bad">{d.error}</span>}
        </div>

        <button
          className="btn ghost doc-move"
          title="В папку"
          onClick={() => setMovingId((m) => (m === d.id ? null : d.id))}
        >
          <Icon name="folder" />
        </button>

        {d.kind !== 'transcript' &&
          (confirmId === d.id ? (
            <button className="btn danger doc-del" onClick={() => void remove(d.id)}>
              Точно удалить?
            </button>
          ) : (
            <button
              className="btn ghost doc-del"
              title="Удалить"
              onClick={() => {
                setConfirmId(d.id);
                setTimeout(() => setConfirmId((c) => (c === d.id ? null : c)), 4000);
              }}
            >
              <Icon name="trash" />
            </button>
          ))}
      </div>

      {movingId === d.id && (
        <div className="pills folder-pills">
          {folders
            .filter((f) => f.id !== d.folderId)
            .map((f) => (
              <button key={f.id} className="pill-opt" onClick={() => void moveTo(d.id, f.id)}>
                {f.name}
              </button>
            ))}
          {d.folderId !== null && (
            <button className="pill-opt" onClick={() => void moveTo(d.id, null)}>
              без папки
            </button>
          )}
          {folders.length === 0 && (
            <span className="doc-meta">Папок ещё нет — создайте первую кнопкой ниже.</span>
          )}
        </div>
      )}
    </div>
  );

  const sections = [
    ...folders.map((f) => ({ folder: f as Folder | null, docs: (docs ?? []).filter((d) => d.folderId === f.id) })),
    { folder: null as Folder | null, docs: (docs ?? []).filter((d) => d.folderId === null) },
  ];

  return (
    <section className="screen active" id="s-library">
      <button className="btn ghost back-link" onClick={() => go('s-home')}>
        <Icon name="back" /> Назад
      </button>

      <h2 className="h2">Библиотека</h2>
      <p className="sub">
        Книги, статьи и расшифровки, на которые буду опираться, когда пишу лекции.
        Расшифровки попадают сюда сами — со скрытыми именами.
      </p>

      <div
        className={`dropzone ${dragging ? 'over' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => fileInput.current?.click()}
      >
        <span className="dz-icon"><Icon name="book" /></span>
        <div className="dz-text">
          <b>Перетащите книги сюда</b>
          <span>или нажмите, чтобы выбрать. PDF, DOCX, EPUB, TXT</span>
        </div>
        <input
          ref={fileInput}
          type="file"
          multiple
          accept=".pdf,.docx,.epub,.txt,.md,.html,.htm"
          hidden
          onChange={(e) => {
            if (e.target.files) void send(e.target.files);
            e.target.value = '';
          }}
        />
      </div>

      {uploading.length > 0 && (
        <div className="panel doc-uploading">
          <Icon name="upload" /> Загружаю: {uploading.join(', ')}
        </div>
      )}

      {docs === null && <p className="lead dim">Открываю библиотеку…</p>}

      {empty && (
        <div className="emptybox">
          <p className="start-hint">
            Пока пусто. Загрузите первую книгу — и лекции начнут опираться на неё.
          </p>
          {/* Дублирует клик по дропзоне: с пустого экрана путь к действию должен быть очевиден */}
          <button className="btn primary" onClick={() => fileInput.current?.click()}>
            Выбрать файл <Icon name="arrow" />
          </button>
        </div>
      )}

      {docs !== null && (docs.length > 0 || folders.length > 0) && (
        <>
          {sections.map(
            ({ folder, docs: sectionDocs }) =>
              (folder !== null || sectionDocs.length > 0) && (
                <div key={folder?.id ?? 'root'}>
                  {(folders.length > 0 || folder !== null) && (
                    <div className="label folder-label">
                      {folder ? folder.name : 'Без папки'}
                      {folder && (
                        <span className="folder-tools">
                          <button className="chg" onClick={() => renameFolder(folder)}>
                            переименовать
                          </button>
                          <button className="chg" onClick={() => void removeFolder(folder)}>
                            удалить
                          </button>
                        </span>
                      )}
                    </div>
                  )}
                  {sectionDocs.length > 0 ? (
                    <div className="doc-list">{sectionDocs.map(renderDoc)}</div>
                  ) : (
                    <p className="doc-meta folder-empty">Папка пуста — переложите сюда документы.</p>
                  )}
                </div>
              ),
          )}
        </>
      )}

      <button className="btn big folder-add" onClick={createFolder}>
        <Icon name="folder" /> Новая папка
      </button>
    </section>
  );
}
