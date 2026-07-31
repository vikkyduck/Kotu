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

/** Свой тип перетаскивания: отличает карточку документа от файлов из системы. */
const DOC_MIME = 'application/x-kotu-doc';

const KIND_LABEL: Record<string, string> = {
  book: 'книга',
  article: 'статья',
  note: 'заметка',
  transcript: 'расшифровка',
  deck: 'из презентации',
};

/** «3 документа» — с правильным окончанием, иначе интерфейс выглядит машинным. */
function countLabel(n: number): string {
  if (n === 0) return 'пусто';
  const last = n % 10;
  const teen = n % 100 >= 11 && n % 100 <= 14;
  if (!teen && last === 1) return `${n} документ`;
  if (!teen && last >= 2 && last <= 4) return `${n} документа`;
  return `${n} документов`;
}

export function Library() {
  const { screen, go, toast, openSheet, openTranscription } = useApp();
  const [docs, setDocs] = useState<Doc[] | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState<string[]>([]);
  const [confirmId, setConfirmId] = useState<number | null>(null);
  /**
   * Открытая папка. Папка — место, куда ЗАХОДЯТ: содержимое остальных не
   * мешается под ногами, а действия над папкой живут внутри неё, а не висят
   * глаголами в общем списке.
   */
  const [openFolderId, setOpenFolderId] = useState<number | null>(null);
  /** Документ, у которого раскрыт ряд чипов «в какую папку» (путь для тача). */
  const [movingId, setMovingId] = useState<number | null>(null);
  /** Перетаскивание мышкой: что тащим и на какую плитку нацелились. */
  const [dragDocId, setDragDocId] = useState<number | null>(null);
  /**
   * Карточка «берётся» только когда указатель на иконке-грипе. Иначе
   * draggable на всей карточке перехватывал бы нажатия на кнопки и на
   * название: браузер ищет источник перетаскивания вверх по дереву и
   * всё равно упирался бы в карточку, а клик пропадал.
   */
  const [grabbable, setGrabbable] = useState<number | null>(null);
  const [dropTarget, setDropTarget] = useState<number | 'root' | null>(null);
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
    if (screen !== 's-library') {
      setMovingId(null);
      setOpenFolderId(null);
    }
  }, [screen]);

  // Папку могли удалить в другой вкладке — тогда выходим наружу, а не показываем
  // пустой экран несуществующей папки.
  useEffect(() => {
    if (openFolderId === null) return;
    if (folders.some((f) => f.id === openFolderId)) return;
    setOpenFolderId(null);
  }, [folders, openFolderId]);

  // Пока хоть один документ разбирается — обновляем список, чтобы
  // прогресс двигался сам, без кнопки «обновить».
  useEffect(() => {
    if (screen !== 's-library') return;
    const busy = docs?.some((d) => d.status === 'parsing' || d.status === 'uploaded');
    if (!busy && uploading.length === 0) return;
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [screen, docs, uploading, load]);

  const send = async (files: FileList | File[], folderId?: number | null) => {
    const list = Array.from(files);
    if (list.length === 0) return;
    setUploading(list.map((f) => f.name));

    for (const file of list) {
      const form = new FormData();
      form.append('file', file);
      // Файл, брошенный на папку (или загруженный внутри неё), сразу в неё и ложится.
      if (folderId != null) form.append('folderId', String(folderId));
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
        const where = folderId === null ? 'из папки' : `в «${folders.find((f) => f.id === folderId)?.name ?? 'папку'}»`;
        toast(`Переложила ${where}`);
      } else {
        toast('Не удалось переложить');
      }
    } catch {
      toast('Нет связи с сервером. Попробуйте ещё раз.');
    }
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

  const createFolder = () => {
    openSheet('Как назвать папку?', 'N', (name) => {
      void (async () => {
        try {
          const res = await fetch('/api/folders', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name }),
          });
          if (res.ok) {
            const created = await res.json().catch(() => null);
            await load();
            // Создал папку — сразу внутри неё: дальше человек кладёт туда книги.
            if (created?.id) setOpenFolderId(created.id);
          } else {
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

  const removeFolder = async (f: Folder, insideCount: number) => {
    const question =
      insideCount > 0
        ? `Удалить папку «${f.name}»? ${countLabel(insideCount)} останутся в библиотеке — просто без папки.`
        : `Удалить пустую папку «${f.name}»?`;
    if (!window.confirm(question)) return;
    try {
      const res = await fetch(`/api/folders/${f.id}`, { method: 'DELETE' });
      if (res.ok) {
        setOpenFolderId(null);
        await load();
        toast('Папка удалена');
      } else toast('Не удалось удалить папку');
    } catch {
      toast('Нет связи с сервером. Попробуйте ещё раз.');
    }
  };

  /** Сброс на плитку папки: карточка документа переезжает, файл — загружается. */
  const onFolderDrop = (e: DragEvent, folderId: number | null) => {
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(null);
    setDragging(false);

    if (e.dataTransfer.files.length > 0) {
      void send(e.dataTransfer.files, folderId);
      return;
    }
    const docId = Number(e.dataTransfer.getData(DOC_MIME));
    setDragDocId(null);
    if (!Number.isInteger(docId)) return;
    const doc = docs?.find((d) => d.id === docId);
    if (!doc || doc.folderId === folderId) return;
    void moveTo(docId, folderId);
  };

  const dropProps = (folderId: number | null, key: number | 'root') => ({
    onDragOver: (e: DragEvent) => {
      // Смотрим на сам dataTransfer, а не на состояние React: первый dragover
      // прилетает раньше, чем доедет setState.
      const types = e.dataTransfer.types;
      const isDoc = types.indexOf(DOC_MIME) !== -1;
      const isFile = types.indexOf('Files') !== -1;
      if (!isDoc && !isFile) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = isDoc ? 'move' : 'copy';
      setDropTarget(key);
    },
    onDragLeave: (e: DragEvent) => {
      // Уход к дочернему элементу — не уход из зоны.
      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
      setDropTarget((t) => (t === key ? null : t));
    },
    onDrop: (e: DragEvent) => onFolderDrop(e, folderId),
  });

  if (screen !== 's-library') return null;

  const allDocs = docs ?? [];
  const countIn = (folderId: number) => allDocs.filter((d) => d.folderId === folderId).length;
  const openFolder = folders.find((f) => f.id === openFolderId) ?? null;

  const visibleDocs = openFolder
    ? allDocs.filter((d) => d.folderId === openFolder.id)
    : allDocs.filter((d) => d.folderId === null);

  const renderDoc = (d: Doc) => (
    <div key={d.id}>
      <div
        className={`doc-card ${d.status} ${dragDocId === d.id ? 'dragging' : ''}`}
        draggable={grabbable === d.id}
        onDragStart={(e) => {
          e.dataTransfer.setData(DOC_MIME, String(d.id));
          e.dataTransfer.effectAllowed = 'move';
          setDragDocId(d.id);
        }}
        onDragEnd={() => {
          setDragDocId(null);
          setDropTarget(null);
        }}
      >
        <span
          className="doc-ico grip"
          title="Потяните, чтобы переложить в папку"
          onMouseEnter={() => setGrabbable(d.id)}
          onMouseLeave={() => setGrabbable((g) => (g === d.id ? null : g))}
        >
          <Icon name={d.kind === 'transcript' ? 'mic' : 'book'} />
        </span>

        <div className="doc-body">
          {d.kind === 'transcript' && d.transcriptionId !== null ? (
            <b className="doc-title doc-link" onClick={() => openTranscription(d.transcriptionId!)}>
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
          title="Переложить в папку"
          onClick={() => setMovingId((m) => (m === d.id ? null : d.id))}
        >
          <Icon name="folder" />
        </button>

        {d.kind === 'transcript' && d.transcriptionId !== null && (
          <button
            className="btn ghost doc-del"
            title="Удалить можно на экране записи"
            onClick={() => openTranscription(d.transcriptionId!)}
          >
            <Icon name="trash" />
          </button>
        )}

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
              вынуть из папки
            </button>
          )}
          {folders.length === 0 && (
            <button className="pill-opt" onClick={createFolder}>
              создать папку
            </button>
          )}
        </div>
      )}
    </div>
  );

  const dropzone = (folderId: number | null) => (
    <div
      className={`dropzone ${dragging ? 'over' : ''}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.indexOf('Files') === -1) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        void send(e.dataTransfer.files, folderId);
      }}
      onClick={() => fileInput.current?.click()}
    >
      <span className="dz-icon"><Icon name="book" /></span>
      <div className="dz-text">
        <b>{folderId === null ? 'Перетащите книги сюда' : 'Перетащите книги в эту папку'}</b>
        <span>или нажмите, чтобы выбрать. PDF, DOCX, EPUB, TXT</span>
      </div>
      <input
        ref={fileInput}
        type="file"
        multiple
        accept=".pdf,.docx,.epub,.txt,.md,.html,.htm"
        hidden
        onChange={(e) => {
          if (e.target.files) void send(e.target.files, folderId);
          e.target.value = '';
        }}
      />
    </div>
  );

  // ── Внутри папки ────────────────────────────────────────────────────────
  if (openFolder) {
    const inside = countIn(openFolder.id);
    return (
      <section className="screen active" id="s-library">
        {/* Хлебная крошка — тоже цель: перетащил на неё, документ вышел из папки */}
        <button
          className={`btn ghost back-link crumb-drop ${dropTarget === 'root' ? 'drop-over' : ''}`}
          onClick={() => setOpenFolderId(null)}
          {...dropProps(null, 'root')}
        >
          <Icon name="back" /> Библиотека
        </button>

        <div className="folder-head">
          <h2 className="h2">{openFolder.name}</h2>
          <button className="chg" onClick={() => renameFolder(openFolder)}>переименовать</button>
        </div>
        <p className="sub">{countLabel(inside)} в папке.</p>

        {dropzone(openFolder.id)}

        {uploading.length > 0 && (
          <div className="panel doc-uploading">
            <Icon name="upload" /> Загружаю: {uploading.join(', ')}
          </div>
        )}

        {visibleDocs.length > 0 ? (
          <div className="doc-list">{visibleDocs.map(renderDoc)}</div>
        ) : (
          <div className="emptybox">
            <p className="start-hint">
              В папке пока пусто. Перетащите сюда книгу — из компьютера или из библиотеки.
            </p>
            <button className="btn primary" onClick={() => fileInput.current?.click()}>
              Выбрать файл <Icon name="arrow" />
            </button>
          </div>
        )}

        <button
          className="btn danger folder-remove"
          onClick={() => void removeFolder(openFolder, inside)}
        >
          <Icon name="trash" /> Удалить папку
        </button>
      </section>
    );
  }

  // ── Корень библиотеки ───────────────────────────────────────────────────
  const emptyAll = docs !== null && allDocs.length === 0 && folders.length === 0 && uploading.length === 0;

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

      {dropzone(null)}

      {uploading.length > 0 && (
        <div className="panel doc-uploading">
          <Icon name="upload" /> Загружаю: {uploading.join(', ')}
        </div>
      )}

      {docs === null && <p className="lead dim">Открываю библиотеку…</p>}

      {emptyAll && (
        <div className="emptybox">
          <p className="start-hint">
            Пока пусто. Загрузите первую книгу — и лекции начнут опираться на неё.
          </p>
          <button className="btn primary" onClick={() => fileInput.current?.click()}>
            Выбрать файл <Icon name="arrow" />
          </button>
        </div>
      )}

      {docs !== null && (
        <>
          {/* Папки — плитки, в которые заходят и на которые перетаскивают */}
          <div className="folder-grid">
            {folders.map((f) => (
              <button
                key={f.id}
                className={`folder-tile ${dropTarget === f.id ? 'drop-over' : ''}`}
                onClick={() => setOpenFolderId(f.id)}
                {...dropProps(f.id, f.id)}
              >
                <span className="folder-tile-ico"><Icon name="folder" /></span>
                <span className="folder-tile-body">
                  <b>{f.name}</b>
                  <span>{countLabel(countIn(f.id))}</span>
                </span>
                <span className="folder-tile-chev"><Icon name="chevron" /></span>
              </button>
            ))}

            <button className="folder-tile folder-tile-add" onClick={createFolder}>
              <span className="folder-tile-ico"><Icon name="folder" /></span>
              <span className="folder-tile-body"><b>Новая папка</b><span>разложить по темам</span></span>
            </button>
          </div>

          {(visibleDocs.length > 0 || folders.length > 0) && (
            <div
              className={`root-docs ${dropTarget === 'root' ? 'drop-over' : ''}`}
              {...dropProps(null, 'root')}
            >
              {folders.length > 0 && <div className="label">Вне папок</div>}
              {visibleDocs.length > 0 ? (
                <div className="doc-list">{visibleDocs.map(renderDoc)}</div>
              ) : (
                // Пустая зона остаётся целью: сюда возвращают документ из папки.
                <p className="doc-meta root-empty">
                  Всё разложено по папкам. Перетащите сюда документ, чтобы вынуть его.
                </p>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
