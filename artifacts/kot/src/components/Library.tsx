import { useState, useEffect, useRef, useMemo, type DragEvent } from 'react';
import { useApp } from '@/hooks/use-app';
import { useLibraryData } from '@/hooks/use-library-data';
import { useLibrarySearch, MIN_QUERY } from '@/hooks/use-library-search';
import { Icon } from '@/lib/icons';
import { CatLine } from '@/lib/cat';
import { ITEM_MIME, dropZone, type DropTarget } from '@/lib/dnd';
import {
  buildItems,
  buildWorking,
  countLabel,
  type Folder,
  type Item,
  type ItemActions,
} from '@/lib/library-items';
import { ItemCard, type CardMenu } from './library/ItemCard';
import { FolderTiles } from './library/FolderTiles';
import { SearchResults } from './library/SearchResults';

/**
 * Главный экран: библиотека — это и есть рабочее место, а расшифровка, лекция
 * и презентация — три действия НАД ней.
 *
 * Здесь только сборка экрана и то, что меняет состояние на сервере. Правила
 * «что куда попадает» живут в lib/library-items, загрузка — в hooks, а вид
 * карточки, полки папок и выдачи поиска — в components/library.
 */

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

  const active = screen === 's-home';
  const { data, folders, loaded, reload } = useLibraryData(active);

  const [uploading, setUploading] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  /**
   * Открытая папка. Папка — место, куда ЗАХОДЯТ: содержимое остальных не
   * мешается под ногами, а действия над папкой живут внутри неё.
   */
  const [openFolderId, setOpenFolderId] = useState<number | null>(null);
  /** Раскрытый ряд кнопок — у одной карточки за раз. */
  const [menu, setMenu] = useState<{ key: string; menu: CardMenu } | null>(null);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget>(null);
  const [query, setQuery] = useState('');
  const { hits, searching } = useLibrarySearch(query);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (active) return;
    setMenu(null);
    setOpenFolderId(null);
  }, [active]);

  // Папку могли удалить в другой вкладке — тогда выходим наружу, а не показываем
  // пустой экран несуществующей папки.
  useEffect(() => {
    if (openFolderId === null) return;
    if (folders.some((f) => f.id === openFolderId)) return;
    setOpenFolderId(null);
  }, [folders, openFolderId]);

  // ── Действия над материалом ─────────────────────────────────────────────

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
          const body = await res.json().catch(() => ({}));
          toast(body.message ?? `Не удалось загрузить «${file.name}»`);
        }
      } catch {
        toast(`Не удалось загрузить «${file.name}»`);
      }
    }

    setUploading([]);
    await reload();
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
        setMenu(null);
        await reload();
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
        toast(done);
        await reload();
      } else {
        const body = await res.json().catch(() => ({}));
        toast(body.message ?? 'Не удалось удалить');
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
            await reload();
            // Создал папку — сразу внутри неё: дальше человек кладёт туда материал.
            if (created?.id) setOpenFolderId(created.id);
          } else {
            const body = await res.json().catch(() => ({}));
            toast(body.message ?? 'Не удалось создать папку');
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
          if (res.ok) await reload();
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
        await reload();
        toast('Папка удалена');
      } else toast('Не удалось удалить папку');
    } catch {
      toast('Нет связи с сервером. Попробуйте ещё раз.');
    }
  };

  // ── Что показываем ──────────────────────────────────────────────────────

  const act: ItemActions = useMemo(
    () => ({
      openTranscription,
      openLecture,
      openDeck,
      newDeck,
      newLecture,
      remove: (url, done) => void removeAt(url, done),
    }),
    // removeAt пересоздаётся каждый рендер, но замыкает только toast и reload —
    // оба стабильны, поэтому в зависимости его не берём.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [openTranscription, openLecture, openDeck, newDeck, newLecture],
  );

  const items = buildItems(data, act);
  const working = buildWorking(data, act);

  const countIn = (folderId: number) => items.filter((i) => i.folderId === folderId).length;
  const openFolder = folders.find((f) => f.id === openFolderId) ?? null;
  const visible = items.filter((i) => i.folderId === (openFolder ? openFolder.id : null));

  // ── Перетаскивание ──────────────────────────────────────────────────────

  const onDropTo = (e: DragEvent, folderId: number | null) => {
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

  if (!active) return null;

  // ── Кусочки разметки ────────────────────────────────────────────────────

  const cards = (list: Item[], movable: boolean) =>
    list.map((i) => (
      <ItemCard
        key={i.key}
        item={i}
        movable={movable}
        folders={folders}
        menu={menu?.key === i.key ? menu.menu : null}
        onMenu={(m) => setMenu(m ? { key: i.key, menu: m } : null)}
        onMove={(item, folderId) => void moveTo(item, folderId)}
        onCreateFolder={createFolder}
        dragging={dragKey === i.key}
        onDragStart={() => setDragKey(i.key)}
        onDragEnd={() => {
          setDragKey(null);
          setDropTarget(null);
        }}
      />
    ));

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

  const uploadingNote = uploading.length > 0 && (
    <div className="panel doc-uploading">
      <Icon name="upload" /> Загружаю: {uploading.join(', ')}
    </div>
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
          {...dropZone('root', setDropTarget, (e) => onDropTo(e, null))}
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
        {uploadingNote}

        {visible.length > 0 ? (
          <div className="doc-list">{cards(visible, true)}</div>
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

  const searchOpen = query.trim().length >= MIN_QUERY;
  const emptyAll =
    loaded && items.length === 0 && working.length === 0 && folders.length === 0 &&
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
          <div className="doc-list work-list">{cards(working, false)}</div>
        </>
      )}

      <div className="lib-head">
        <h2 className="h2">Библиотека</h2>
        <button className="chg" onClick={createFolder}>новая папка</button>
        <button className="chg" onClick={() => fileInput.current?.click()}>загрузить книгу</button>
      </div>
      <p className="sub">
        Всё в одном месте: книги, расшифровки, лекции и презентации. Из любого материала
        можно собрать презентацию или написать лекцию — кнопка ◊ на карточке.
      </p>

      {/* Поиск по смыслу, а не по названию: находит нужное место внутри книги,
          расшифровки или своей же прошлой лекции. */}
      <input
        className="field lib-search"
        type="search"
        value={query}
        placeholder="Найти по смыслу — во всех материалах"
        onChange={(e) => setQuery(e.target.value)}
      />

      {filePicker(null)}
      {searchOpen && <SearchResults hits={hits} searching={searching} act={act} />}

      {!loaded && <p className="lead dim">Открываю библиотеку…</p>}

      {emptyAll && (
        <>
          {dropzone(null)}
          <p className="start-hint">
            Пока пусто. Загрузите первую книгу — или расшифруйте запись, она придёт сюда сама.
          </p>
        </>
      )}

      {uploadingNote}

      {loaded && !emptyAll && !searchOpen && (
        <>
          <FolderTiles
            folders={folders}
            countIn={countIn}
            dropTarget={dropTarget}
            setDropTarget={setDropTarget}
            onDropTo={onDropTo}
            onOpen={setOpenFolderId}
            onCreate={createFolder}
          />

          <div
            className={`root-docs ${dropTarget === 'root' ? 'drop-over' : ''}`}
            {...dropZone('root', setDropTarget, (e) => onDropTo(e, null))}
          >
            {folders.length > 0 && <div className="label">Вне папок</div>}
            {visible.length > 0 ? (
              <div className="doc-list">{cards(visible, true)}</div>
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
