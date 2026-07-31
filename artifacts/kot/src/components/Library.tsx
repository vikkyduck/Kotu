import { useState, useEffect, useRef, useCallback, type DragEvent } from 'react';
import { useApp } from '@/hooks/use-app';
import { Icon } from '@/lib/icons';
import { CatLine } from '@/lib/cat';

/**
 * Главный экран: библиотека — это и есть рабочее место, а расшифровка, лекция
 * и презентация — три действия НАД ней. Раньше библиотека была одной из плиток
 * в списке «другие инструменты», а материал автора лежал в четырёх разных
 * списках за четырьмя разными дверями: расшифровки на главной, лекции внутри
 * одного инструмента, презентации внутри другого, книги — здесь.
 *
 * Теперь всё, что закончено, лежит одним списком и раскладывается по общим
 * папкам; всё, что делается прямо сейчас, — в полосе «сейчас в работе» и
 * само уезжает вниз, в библиотеку, когда готово.
 */

interface Doc {
  id: number;
  title: string;
  kind: string;
  folderId: number | null;
  transcriptionId: number | null;
  deckId: number | null;
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

interface LectureRow {
  id: number;
  title: string;
  folderId: number | null;
  status: 'planning' | 'plan_ready' | 'writing' | 'ready' | 'error';
  statusMessage: string;
  createdAt: string;
}

interface DeckRow {
  id: number;
  title: string;
  folderId: number | null;
  status: 'storyboarding' | 'storyboard_ready' | 'drawing' | 'ready' | 'error';
  statusMessage: string;
  createdAt: string;
}

interface TranscriptionRow {
  id: number;
  title: string;
  status: string;
  statusMessage: string;
  progress: number;
  createdAt: string;
}

/** Что тащим мышкой: тип и номер внутри своего типа — «lecture:3». */
const ITEM_MIME = 'application/x-kotu-item';

type ItemKind = 'book' | 'article' | 'note' | 'transcript' | 'lecture' | 'deck';

/** Одна карточка библиотеки — общий язык для книги, лекции и презентации. */
interface Item {
  key: string;
  kind: ItemKind;
  id: number;
  title: string;
  folderId: number | null;
  meta: string;
  tone: '' | 'busy' | 'bad';
  createdAt: string;
  open?: () => void;
  /** Удаление: у расшифровки его нет — она удаляется вместе с записью. */
  del?: () => void;
}

const KIND_ICON: Record<ItemKind, string> = {
  book: 'book',
  article: 'book',
  note: 'book',
  transcript: 'mic',
  lecture: 'pen',
  deck: 'deck',
};

const KIND_LABEL: Record<ItemKind, string> = {
  book: 'книга',
  article: 'статья',
  note: 'заметка',
  transcript: 'расшифровка · имена скрыты',
  lecture: 'лекция',
  deck: 'презентация',
};

/** «3 документа» — с правильным окончанием, иначе интерфейс выглядит машинным. */
function countLabel(n: number): string {
  if (n === 0) return 'пусто';
  const last = n % 10;
  const teen = n % 100 >= 11 && n % 100 <= 14;
  if (!teen && last === 1) return `${n} материал`;
  if (!teen && last >= 2 && last <= 4) return `${n} материала`;
  return `${n} материалов`;
}

function greeting(): string {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 12) return 'Доброе утро, Кот';
  if (hour >= 12 && hour < 18) return 'Добрый день, Кот';
  if (hour >= 18 && hour < 23) return 'Добрый вечер, Кот';
  return 'Доброй ночи, Кот';
}

export function Library() {
  const {
    screen,
    toast,
    openSheet,
    openTranscription,
    newTranscription,
    openLecture,
    newLecture,
    openDeck,
    newDeck,
  } = useApp();

  const [docs, setDocs] = useState<Doc[] | null>(null);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [lectures, setLectures] = useState<LectureRow[]>([]);
  const [decks, setDecks] = useState<DeckRow[]>([]);
  const [transcriptions, setTranscriptions] = useState<TranscriptionRow[]>([]);

  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState<string[]>([]);
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  /**
   * Открытая папка. Папка — место, куда ЗАХОДЯТ: содержимое остальных не
   * мешается под ногами, а действия над папкой живут внутри неё.
   */
  const [openFolderId, setOpenFolderId] = useState<number | null>(null);
  /** Карточка, у которой раскрыт ряд чипов «в какую папку» (путь для тача). */
  const [movingKey, setMovingKey] = useState<string | null>(null);
  const [dragKey, setDragKey] = useState<string | null>(null);
  /**
   * Карточка «берётся» только когда указатель на грипе: draggable на всей
   * карточке перехватывал бы нажатия на кнопки и на название.
   */
  const [grabbable, setGrabbable] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<number | 'root' | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const [d, f, l, k, t] = await Promise.all([
        fetch('/api/documents').then((r) => (r.ok ? r.json() : null)),
        fetch('/api/folders').then((r) => (r.ok ? r.json() : null)),
        fetch('/api/lectures').then((r) => (r.ok ? r.json() : null)),
        fetch('/api/decks').then((r) => (r.ok ? r.json() : null)),
        fetch('/api/transcriptions').then((r) => (r.ok ? r.json() : null)),
      ]);
      if (d) setDocs(d);
      if (f) setFolders(f);
      if (l) setLectures(l);
      if (k) setDecks(k);
      if (t) setTranscriptions(t);
    } catch {
      /* сеть моргнула — покажем то, что уже есть */
    }
  }, []);

  useEffect(() => {
    if (screen !== 's-home') return;
    void load();
  }, [screen, load]);

  useEffect(() => {
    if (screen !== 's-home') {
      setMovingKey(null);
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

  // Пока хоть что-то делается — список живой: прогресс двигается сам,
  // и готовая работа сама переезжает из «в работе» в библиотеку.
  const busyNow =
    (docs?.some((d) => d.status === 'parsing' || d.status === 'uploaded') ?? false) ||
    lectures.some((l) => l.status === 'planning' || l.status === 'writing') ||
    decks.some((k) => k.status === 'storyboarding' || k.status === 'drawing') ||
    transcriptions.some((t) => t.status === 'processing' || t.status === 'queued');

  useEffect(() => {
    if (screen !== 's-home') return;
    if (!busyNow && uploading.length === 0) return;
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [screen, busyNow, uploading, load]);

  // ── Действия ────────────────────────────────────────────────────────────

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

  /** Один путь перекладывания для всех типов — меняется только ручка. */
  const moveTo = async (item: Item, folderId: number | null) => {
    const url =
      item.kind === 'lecture'
        ? `/api/lectures/${item.id}`
        : item.kind === 'deck'
          ? `/api/decks/${item.id}`
          : `/api/documents/${item.id}`;
    try {
      const res = await fetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderId }),
      });
      if (res.ok) {
        setMovingKey(null);
        await load();
        const where =
          folderId === null
            ? 'из папки'
            : `в «${folders.find((f) => f.id === folderId)?.name ?? 'папку'}»`;
        toast(`Переложила ${where}`);
      } else {
        toast('Не удалось переложить');
      }
    } catch {
      toast('Нет связи с сервером. Попробуйте ещё раз.');
    }
  };

  const removeAt = async (url: string, done: string) => {
    try {
      const res = await fetch(url, { method: 'DELETE' });
      if (res.ok) {
        setConfirmKey(null);
        toast(done);
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
            // Создал папку — сразу внутри неё: дальше человек кладёт туда материал.
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

  // ── Сбор карточек ───────────────────────────────────────────────────────

  const allDocs = docs ?? [];

  /**
   * Библиотека: всё законченное. Незаконченное живёт выше, в полосе «сейчас
   * в работе», — так у работы виден путь: сделал → лежит в библиотеке.
   */
  const items: Item[] = [
    ...allDocs
      // Текстовая копия презентации — не отдельный материал, а её поисковый
      // след: показывать её второй карточкой значило бы двоить одну вещь.
      .filter((d) => d.kind !== 'deck')
      .map<Item>((d) => {
        const kind = (['book', 'article', 'note', 'transcript'].includes(d.kind)
          ? d.kind
          : 'book') as ItemKind;
        const meta =
          d.status === 'ready'
            // У расшифровки счёт фрагментов ничего не говорит автору: важно
            // одно — имена скрыты. У книги наоборот: объём и разбор по делу.
            ? kind === 'transcript'
              ? KIND_LABEL[kind]
              : `${KIND_LABEL[kind]}${d.pages ? ` · ${d.pages} с.` : ''} · ${d.chunkCount} фрагментов`
            : d.status === 'error'
              ? (d.error ?? 'не удалось разобрать')
              : d.statusMessage || 'В очереди…';
        return {
          key: `doc:${d.id}`,
          kind,
          id: d.id,
          title: d.title,
          folderId: d.folderId,
          meta,
          tone: d.status === 'error' ? 'bad' : d.status === 'ready' ? '' : 'busy',
          createdAt: d.createdAt,
          open:
            d.kind === 'transcript' && d.transcriptionId !== null
              ? () => openTranscription(d.transcriptionId!)
              : undefined,
          // Расшифровку удаляют вместе с записью — на её экране, там же, где аудио.
          del:
            d.kind === 'transcript'
              ? undefined
              : () => void removeAt(`/api/documents/${d.id}`, 'Документ удалён'),
        };
      }),
    ...lectures
      .filter((l) => l.status === 'ready')
      .map<Item>((l) => ({
        key: `lecture:${l.id}`,
        kind: 'lecture',
        id: l.id,
        title: l.title,
        folderId: l.folderId,
        meta: 'лекция · готова',
        tone: '',
        createdAt: l.createdAt,
        open: () => openLecture(l.id),
        del: () => void removeAt(`/api/lectures/${l.id}`, 'Лекция удалена'),
      })),
    ...decks
      .filter((k) => k.status === 'ready')
      .map<Item>((k) => ({
        key: `deck:${k.id}`,
        kind: 'deck',
        id: k.id,
        title: k.title,
        folderId: k.folderId,
        meta: allDocs.some((d) => d.deckId === k.id)
          ? 'презентация · текст в поиске'
          : 'презентация · готова',
        tone: '',
        createdAt: k.createdAt,
        open: () => openDeck(k.id),
        del: () => void removeAt(`/api/decks/${k.id}`, 'Презентация удалена'),
      })),
  ].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  /** Сейчас в работе: то, что делается или ждёт решения автора. */
  const working: Item[] = [
    ...transcriptions
      .filter((t) => t.status !== 'done')
      .map<Item>((t) => ({
        key: `tr:${t.id}`,
        kind: 'transcript',
        id: t.id,
        title: t.title,
        folderId: null,
        meta:
          t.status === 'error'
            ? 'не удалось — откройте, чтобы повторить'
            : t.statusMessage || 'расшифровываю…',
        tone: t.status === 'error' ? 'bad' : 'busy',
        createdAt: t.createdAt,
        open: () => openTranscription(t.id),
      })),
    ...lectures
      .filter((l) => l.status !== 'ready')
      .map<Item>((l) => ({
        key: `lecture:${l.id}`,
        kind: 'lecture',
        id: l.id,
        title: l.title,
        folderId: l.folderId,
        meta:
          l.status === 'plan_ready'
            ? 'план ждёт вашего решения'
            : l.status === 'error'
              ? 'ошибка — откройте, чтобы повторить'
              : l.statusMessage || 'пишу…',
        tone: l.status === 'error' ? 'bad' : 'busy',
        createdAt: l.createdAt,
        open: () => openLecture(l.id),
      })),
    ...decks
      .filter((k) => k.status !== 'ready')
      .map<Item>((k) => ({
        key: `deck:${k.id}`,
        kind: 'deck',
        id: k.id,
        title: k.title,
        folderId: k.folderId,
        meta:
          k.status === 'storyboard_ready'
            ? 'раскадровка ждёт вашего решения'
            : k.status === 'error'
              ? 'ошибка — откройте, чтобы повторить'
              : k.statusMessage || 'собираю…',
        tone: k.status === 'error' ? 'bad' : 'busy',
        createdAt: k.createdAt,
        open: () => openDeck(k.id),
      })),
  ].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

  const countIn = (folderId: number) => items.filter((i) => i.folderId === folderId).length;
  const openFolder = folders.find((f) => f.id === openFolderId) ?? null;
  const visible = items.filter((i) => i.folderId === (openFolder ? openFolder.id : null));

  // ── Перетаскивание ──────────────────────────────────────────────────────

  const onFolderDrop = (e: DragEvent, folderId: number | null) => {
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(null);
    setDragging(false);

    if (e.dataTransfer.files.length > 0) {
      void send(e.dataTransfer.files, folderId);
      return;
    }
    const key = e.dataTransfer.getData(ITEM_MIME);
    setDragKey(null);
    const item = items.find((i) => i.key === key);
    if (!item || item.folderId === folderId) return;
    void moveTo(item, folderId);
  };

  const dropProps = (folderId: number | null, key: number | 'root') => ({
    onDragOver: (e: DragEvent) => {
      // Смотрим на сам dataTransfer, а не на состояние React: первый dragover
      // прилетает раньше, чем доедет setState.
      const types = e.dataTransfer.types;
      const isItem = types.indexOf(ITEM_MIME) !== -1;
      const isFile = types.indexOf('Files') !== -1;
      if (!isItem && !isFile) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = isItem ? 'move' : 'copy';
      setDropTarget(key);
    },
    onDragLeave: (e: DragEvent) => {
      // Уход к дочернему элементу — не уход из зоны.
      if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
      setDropTarget((t) => (t === key ? null : t));
    },
    onDrop: (e: DragEvent) => onFolderDrop(e, folderId),
  });

  if (screen !== 's-home') return null;

  // ── Кусочки разметки ────────────────────────────────────────────────────

  const card = (i: Item, movable: boolean) => (
    <div key={i.key}>
      <div
        className={`doc-card ${i.tone === 'bad' ? 'error' : ''} ${dragKey === i.key ? 'dragging' : ''}`}
        draggable={movable && grabbable === i.key}
        onDragStart={(e) => {
          e.dataTransfer.setData(ITEM_MIME, i.key);
          e.dataTransfer.effectAllowed = 'move';
          setDragKey(i.key);
        }}
        onDragEnd={() => {
          setDragKey(null);
          setDropTarget(null);
        }}
      >
        <span
          className={`doc-ico ${movable ? 'grip' : ''}`}
          title={movable ? 'Потяните, чтобы переложить в папку' : undefined}
          onMouseEnter={() => movable && setGrabbable(i.key)}
          onMouseLeave={() => setGrabbable((g) => (g === i.key ? null : g))}
        >
          <Icon name={KIND_ICON[i.kind]} />
        </span>

        <div className="doc-body">
          {i.open ? (
            <b className="doc-title doc-link" onClick={i.open}>
              {i.title}
            </b>
          ) : (
            <b className="doc-title">{i.title}</b>
          )}
          <span className={`doc-meta ${i.tone}`}>{i.meta}</span>
        </div>

        {movable && (
          <button
            className="btn ghost doc-move"
            title="Переложить в папку"
            onClick={() => setMovingKey((m) => (m === i.key ? null : i.key))}
          >
            <Icon name="folder" />
          </button>
        )}

        {i.del ? (
          confirmKey === i.key ? (
            <button className="btn danger doc-del" onClick={i.del}>
              Точно удалить?
            </button>
          ) : (
            <button
              className="btn ghost doc-del"
              title="Удалить"
              onClick={() => {
                setConfirmKey(i.key);
                setTimeout(() => setConfirmKey((c) => (c === i.key ? null : c)), 4000);
              }}
            >
              <Icon name="trash" />
            </button>
          )
        ) : i.kind === 'transcript' && i.open ? (
          <button className="btn ghost doc-del" title="Удалить можно на экране записи" onClick={i.open}>
            <Icon name="trash" />
          </button>
        ) : null}
      </div>

      {movingKey === i.key && (
        <div className="pills folder-pills">
          {folders
            .filter((f) => f.id !== i.folderId)
            .map((f) => (
              <button key={f.id} className="pill-opt" onClick={() => void moveTo(i, f.id)}>
                {f.name}
              </button>
            ))}
          {i.folderId !== null && (
            <button className="pill-opt" onClick={() => void moveTo(i, null)}>
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
    </div>
  );

  /** Скрытый выбор файла: кнопка «загрузить книгу» есть и там, где нет зоны. */
  const filePicker = (folderId: number | null) => (
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
  );

  // ── Внутри папки ────────────────────────────────────────────────────────

  if (openFolder) {
    const inside = countIn(openFolder.id);
    return (
      <section className="screen active" id="s-home">
        {/* Хлебная крошка — тоже цель: перетащил на неё, материал вышел из папки */}
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

        {filePicker(openFolder.id)}
        {dropzone(openFolder.id)}

        {uploading.length > 0 && (
          <div className="panel doc-uploading">
            <Icon name="upload" /> Загружаю: {uploading.join(', ')}
          </div>
        )}

        {visible.length > 0 ? (
          <div className="doc-list">{visible.map((i) => card(i, true))}</div>
        ) : (
          <div className="emptybox">
            <p className="start-hint">
              В папке пока пусто. Перетащите сюда книгу, лекцию или презентацию — из
              компьютера или из библиотеки.
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

  // ── Главный экран ───────────────────────────────────────────────────────

  const emptyAll =
    docs !== null && items.length === 0 && working.length === 0 && folders.length === 0 &&
    uploading.length === 0;

  return (
    <section className="screen active" id="s-home">
      <h1 className="hello">{greeting()}</h1>

      {/* Три действия над библиотекой. Раньше главным был один инструмент,
          а остальные лежали под заголовком «другие» — хотя работа идёт всеми. */}
      <div className="tools">
        <button className="tool" onClick={() => newTranscription()}>
          <span className="tool-ic"><Icon name="mic" /></span>
          <b>Расшифровать</b>
          <span>запись сеанса или лекции</span>
        </button>
        <button className="tool" onClick={() => newLecture()}>
          <span className="tool-ic"><Icon name="pen" /></span>
          <b>Написать лекцию</b>
          <span>по материалам библиотеки</span>
        </button>
        <button className="tool" onClick={() => newDeck()}>
          <span className="tool-ic"><Icon name="deck" /></span>
          <b>Собрать презентацию</b>
          <span>слайды с образами</span>
        </button>
      </div>

      {working.length > 0 && (
        <>
          <div className="label">Сейчас в работе</div>
          <div className="doc-list work-list">{working.map((i) => card(i, false))}</div>
        </>
      )}

      <div className="lib-head">
        <h2 className="h2">Библиотека</h2>
        <button className="chg" onClick={createFolder}>новая папка</button>
        <button className="chg" onClick={() => fileInput.current?.click()}>загрузить книгу</button>
      </div>
      <p className="sub">
        Всё в одном месте: книги, расшифровки, лекции и презентации. Разложите по папкам —
        перетаскиванием или кнопкой-папкой на карточке.
      </p>

      {filePicker(null)}
      {docs === null && <p className="lead dim">Открываю библиотеку…</p>}

      {emptyAll && (
        <>
          {dropzone(null)}
          <p className="start-hint">
            Пока пусто. Загрузите первую книгу — или расшифруйте запись, она придёт сюда сама.
          </p>
        </>
      )}

      {uploading.length > 0 && (
        <div className="panel doc-uploading">
          <Icon name="upload" /> Загружаю: {uploading.join(', ')}
        </div>
      )}

      {docs !== null && !emptyAll && (
        <>
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

          <div
            className={`root-docs ${dropTarget === 'root' ? 'drop-over' : ''}`}
            {...dropProps(null, 'root')}
          >
            {folders.length > 0 && <div className="label">Вне папок</div>}
            {visible.length > 0 ? (
              <div className="doc-list">{visible.map((i) => card(i, true))}</div>
            ) : (
              // Пустая зона остаётся целью: сюда возвращают материал из папки.
              <p className="doc-meta root-empty">
                Всё разложено по папкам. Перетащите сюда материал, чтобы вынуть его.
              </p>
            )}
          </div>
        </>
      )}

      {/* Кот свернулся в конце страницы — фирменный штрих автора */}
      <CatLine className="home-cat" />
    </section>
  );
}
