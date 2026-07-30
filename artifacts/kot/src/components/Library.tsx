import { useState, useEffect, useRef, useCallback, type DragEvent } from 'react';
import { useApp } from '@/hooks/use-app';
import { Icon } from '@/lib/icons';

interface Doc {
  id: number;
  title: string;
  kind: string;
  pages: number | null;
  chunkCount: number;
  status: 'uploaded' | 'parsing' | 'ready' | 'error';
  statusMessage: string;
  error: string | null;
  createdAt: string;
}

const KIND_LABEL: Record<string, string> = {
  book: 'книга',
  article: 'статья',
  note: 'заметка',
  transcript: 'расшифровка',
};

export function Library() {
  const { screen, go, toast } = useApp();
  const [docs, setDocs] = useState<Doc[] | null>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState<string[]>([]);
  const [confirmId, setConfirmId] = useState<number | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/documents');
      if (res.ok) setDocs(await res.json());
    } catch {
      /* сеть моргнула — покажем то, что уже есть */
    }
  }, []);

  useEffect(() => {
    if (screen !== 's-library') return;
    void load();
  }, [screen, load]);

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
    const res = await fetch(`/api/documents/${id}`, { method: 'DELETE' });
    if (res.ok) {
      setConfirmId(null);
      toast('Документ удалён');
      await load();
    } else {
      toast('Не удалось удалить');
    }
  };

  if (screen !== 's-library') return null;

  const empty = docs !== null && docs.length === 0 && uploading.length === 0;

  return (
    <section className="screen active" id="s-library">
      <button className="btn ghost back-link" onClick={() => go('s-home')}>
        <Icon name="back" /> Назад
      </button>

      <h2 className="h2">Библиотека</h2>
      <p className="sub">Книги и статьи, на которые буду опираться, когда пишу лекции.</p>

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
        <p className="start-hint">
          Пока пусто. Загрузите первую книгу — и лекции начнут опираться на неё.
        </p>
      )}

      {docs && docs.length > 0 && (
        <div className="doc-list">
          {docs.map((d) => (
            <div key={d.id} className={`doc-card ${d.status}`}>
              <span className="doc-ico"><Icon name="book" /></span>

              <div className="doc-body">
                <b className="doc-title">{d.title}</b>
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

              {confirmId === d.id ? (
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
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
