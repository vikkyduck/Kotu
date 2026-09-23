import { useState, useEffect, useRef, useMemo, type DragEvent } from 'react';
import { useApp } from '@/hooks/use-app';
import { useLibraryData } from '@/hooks/use-library-data';
import { useLibrarySearch, MIN_QUERY } from '@/hooks/use-library-search';
import { Icon } from '@/lib/icons';
import { CatLine } from '@/lib/cat';
import { ITEM_MIME, dropZone, type DropTarget } from '@/lib/dnd';
import { json, send } from '@/lib/http';
import {
  buildItems,
  buildWorking,
  countLabel,
  titleOf,
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
    go,
    openFolderId,
    openFolder,
    leaveMissing,
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
  const { data, folders, loaded, failed, reload } = useLibraryData(active);

  const [uploading, setUploading] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  /** Раскрытый ряд кнопок — у одной карточки за раз. */
  const [menu, setMenu] = useState<{ key: string; menu: CardMenu } | null>(null);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget>(null);
  const [query, setQuery] = useState('');
  const { hits, searching, error: searchError } = useLibrarySearch(query);
  const fileInput = useRef<HTMLInputElement>(null);
  /**
   * Ручки, по которым запрос уже ушёл. Второй щелчок по «Точно удалить?» или
   * по названию для повтора — не второй запрос: он вернул бы 404 или 409, и
   * тост с ошибкой лёг бы поверх удачного.
   */
  const pending = useRef(new Set<string>());

  // Открытую папку при уходе не закрываем: из материала возвращаются туда,
  // откуда пришли. В корень ведёт крошка «Библиотека».
  useEffect(() => {
    if (active) return;
    setMenu(null);
  }, [active]);

  // Папку могли удалить в другой вкладке — тогда выходим наружу, а не показываем
  // пустой экран несуществующей папки. Только когда список уже пришёл: до него
  // папки нет ни одной, и открытая по адресу выкинула бы в корень.
  useEffect(() => {
    if (!loaded || openFolderId === null) return;
    if (folders.some((f) => f.id === openFolderId)) return;
    leaveMissing();
  }, [loaded, folders, openFolderId, leaveMissing]);

  // ── Действия над материалом ─────────────────────────────────────────────

  const upload = async (files: FileList | File[], folderId?: number | null) => {
    const list = Array.from(files);
    if (list.length === 0) return;
    // Вторую пачку могут бросить, пока грузится первая: список общий, поэтому
    // дописываем в него и убираем по одному файлу, а не заменяем целиком.
    setUploading((u) => [...u, ...list.map((f) => f.name)]);

    for (const file of list) {
      const form = new FormData();
      form.append('file', file);
      // Файл, брошенный на папку (или загруженный внутри неё), сразу в неё и ложится.
      if (folderId != null) form.append('folderId', String(folderId));
      const r = await send('/api/documents', { method: 'POST', body: form }, `Не удалось загрузить «${file.name}»`);
      if (!r.ok) toast(r.message);
      // Ровно одно вхождение: два одноимённых файла — две строки.
      setUploading((u) => {
        const i = u.indexOf(file.name);
        return i < 0 ? u : [...u.slice(0, i), ...u.slice(i + 1)];
      });
    }

    await reload();
  };

  /**
   * Один путь перекладывания для всех типов — ручку знает сама карточка.
   * name — имя папки, которой ещё нет в списке (только что создана).
   */
  const moveTo = async (item: Item, folderId: number | null, name?: string): Promise<boolean> => {
    if (!item.api) return false;
    const r = await send(item.api, json('PATCH', { folderId }), 'Не удалось переложить');
    if (!r.ok) {
      toast(r.message);
      return false;
    }
    setMenu(null);
    await reload();
    const where =
      folderId === null
        ? 'из папки'
        : `в «${name ?? folders.find((f) => f.id === folderId)?.name ?? 'папку'}»`;
    toast(`Переложила ${where}`);
    return true;
  };

  /** Запрос по ручке, пока предыдущий по ней же не закончился, не отправляем. */
  const once = async (url: string, run: () => Promise<void>) => {
    if (pending.current.has(url)) return;
    pending.current.add(url);
    try {
      await run();
    } finally {
      pending.current.delete(url);
    }
  };

  const removeAt = (url: string, done: string) =>
    once(url, async () => {
      const r = await send(url, { method: 'DELETE' }, 'Не удалось удалить');
      if (!r.ok) {
        toast(r.message);
        return;
      }
      toast(done);
      await reload();
    });

  /** Переименование чего угодно: окно открывается с прежним именем. */
  const renameAt = (url: string, current: string, field: 'title' | 'name' = 'title') => {
    openSheet(
      `Как переименовать «${current}»?`,
      (next) => {
        if (next === current) return;
        void (async () => {
          const r = await send(url, json('PATCH', { [field]: next }), 'Не удалось переименовать');
          if (r.ok) await reload();
          else toast(r.message);
        })();
      },
      current,
    );
  };

  const retryAt = (url: string) =>
    once(url, async () => {
      const r = await send(url, { method: 'POST' }, 'Не удалось запустить заново');
      if (r.ok) await reload();
      else toast(r.message);
    });

  /** item — если папку создают из меню «переложить»: материал сразу ложится в неё. */
  const createFolder = (item?: Item) => {
    openSheet('Как назвать папку?', (name) => {
      void (async () => {
        const r = await send('/api/folders', json('POST', { name }), 'Не удалось создать папку');
        if (!r.ok) {
          toast(r.message);
          return;
        }
        const created = (await r.res.json().catch(() => null)) as Folder | null;
        if (item && created?.id && (await moveTo(item, created.id, created.name))) return;
        await reload();
        // Создал папку сверху — сразу внутри неё: дальше человек кладёт туда материал.
        if (!item && created?.id) openFolder(created.id);
      })();
    });
  };

  const removeFolder = async (f: Folder, insideCount: number) => {
    const question =
      insideCount > 0
        ? `Удалить папку «${f.name}»? ${countLabel(insideCount)} останутся в библиотеке — просто без папки.`
        : `Удалить пустую папку «${f.name}»?`;
    if (!window.confirm(question)) return;
    const r = await send(`/api/folders/${f.id}`, { method: 'DELETE' }, 'Не удалось удалить папку');
    if (!r.ok) {
      toast(r.message);
      return;
    }
    leaveMissing();
    await reload();
    toast('Папка удалена');
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
      rename: (url, title) => renameAt(url, title),
      retry: (url) => void retryAt(url),
      openFile: (url) => void window.open(url, '_blank', 'noopener'),
    }),
    // removeAt, renameAt и retryAt пересоздаются каждый рендер, но замыкают
    // только toast, openSheet и reload — они стабильны, поэтому в зависимости
    // их не берём.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [openTranscription, openLecture, openDeck, newDeck, newLecture],
  );

  // Работа из папки, которой больше нет (так терялись лекции и презентации
  // до починки удаления папки), лежит в корне, а не нигде.
  const items = buildItems(data, act).map((i) =>
    i.folderId === null || folders.some((f) => f.id === i.folderId) ? i : { ...i, folderId: null },
  );
  const working = buildWorking(data, act);

  const countIn = (folderId: number) => items.filter((i) => i.folderId === folderId).length;
  const folder = folders.find((f) => f.id === openFolderId) ?? null;
  const visible = items.filter((i) => i.folderId === (folder ? folder.id : null));

  // ── Перетаскивание ──────────────────────────────────────────────────────

  const onDropTo = (e: DragEvent, folderId: number | null) => {
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(null);
    setDragging(false);

    if (e.dataTransfer.files.length > 0) {
      void upload(e.dataTransfer.files, folderId);
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

  const cards = (list: Item[]) =>
    list.map((i) => (
      <ItemCard
        key={i.key}
        item={i}
        folders={folders}
        menu={menu?.key === i.key ? menu.menu : null}
        onMenu={(m) => setMenu(m ? { key: i.key, menu: m } : null)}
        onMove={(item, folderId) => void moveTo(item, folderId)}
        onCreateFolder={() => createFolder(i)}
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
      onDragLeave={(e) => {
        // Уход к дочернему элементу — не уход из зоны: иначе подсветка мигает.
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        // Зона может лежать внутри «вне папок» — та тоже приняла бы файл.
        e.stopPropagation();
        setDragging(false);
        setDropTarget(null);
        void upload(e.dataTransfer.files, folderId);
      }}
      onClick={() => fileInput.current?.click()}
    >
      <span className="dz-icon"><Icon name="book" /></span>
      <div className="dz-text">
        <b>{folderId === null ? 'Перетащите книги сюда' : 'Перетащите книги в эту папку'}</b>
        <span>или нажмите, чтобы выбрать. PDF, DOCX, EPUB, TXT, MD, HTML</span>
      </div>
    </div>
  );

  /** Скрытый выбор файла: кнопка «загрузить книгу» есть и там, где нет зоны. */
  const filePicker = (folderId: number | null) => (
    <input
      ref={fileInput}
      type="file"
      multiple
      accept=".pdf,.docx,.epub,.txt,.md,.markdown,.html,.htm"
      hidden
      onChange={(e) => {
        if (e.target.files) void upload(e.target.files, folderId);
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

  if (folder) {
    const inside = countIn(folder.id);
    return (
      <section className="screen active" id="s-home">
        {/* Хлебная крошка — тоже цель: перетащил на неё, материал вышел из папки */}
        <button
          className={`btn ghost back-link crumb-drop ${dropTarget === 'root' ? 'drop-over' : ''}`}
          onClick={() => go('s-home')}
          {...dropZone('root', setDropTarget, (e) => onDropTo(e, null))}
        >
          <Icon name="back" /> Библиотека
        </button>

        <div className="folder-head">
          <h2 className="h2">{folder.name}</h2>
          <button
            className="chg"
            onClick={() => renameAt(`/api/folders/${folder.id}`, folder.name, 'name')}
          >
            переименовать
          </button>
        </div>
        {inside > 0 && <p className="sub">{countLabel(inside)} в папке</p>}

        {filePicker(folder.id)}
        {dropzone(folder.id)}
        {uploadingNote}

        {visible.length > 0 && <div className="doc-list">{cards(visible)}</div>}

        <button
          className="btn danger folder-remove"
          onClick={() => void removeFolder(folder, inside)}
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
  const startZone = (
    <>
      {dropzone(null)}
      <p className="start-hint">
        Пока пусто. Загрузите первую книгу — или расшифруйте запись, она придёт сюда сама.
      </p>
    </>
  );

  return (
    <section className="screen active" id="s-home">
      <h1 className="hello">{greeting()}</h1>

      {/* Три действия над библиотекой. Раньше главным был один инструмент,
          а остальные лежали под заголовком «другие» — хотя работа идёт всеми. */}
      <div className="tools">
        <button className="tool" onClick={() => newTranscription()}>
          <span className="tool-ic"><Icon name="mic" /></span>
          <b>Расшифровать</b>
          <span>запись лекции или воркшопа</span>
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
          <div className="doc-list work-list">{cards(working)}</div>
        </>
      )}

      <div className="lib-head">
        <h2 className="h2">Библиотека</h2>
        <button className="chg" onClick={() => createFolder()}>новая папка</button>
        <button className="chg" onClick={() => fileInput.current?.click()}>загрузить книгу</button>
      </div>

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
      {searchOpen && (
        <SearchResults
          hits={hits?.map((h) => ({ ...h, title: titleOf(h, data.transcriptions) })) ?? null}
          searching={searching}
          error={searchError}
          act={act}
        />
      )}

      {!loaded &&
        (failed ? (
          <div className="errblock">
            <h3 className="errttl">Библиотека не открылась</h3>
            <div className="btnrow">
              <button className="btn primary" onClick={() => void reload()}>
                Попробовать ещё раз
              </button>
            </div>
          </div>
        ) : (
          <p className="lead dim">Открываю библиотеку…</p>
        ))}

      {emptyAll && startZone}

      {uploadingNote}

      {loaded && !emptyAll && !searchOpen && (
        <>
          <FolderTiles
            folders={folders}
            countIn={countIn}
            dropTarget={dropTarget}
            setDropTarget={setDropTarget}
            onDropTo={onDropTo}
            onOpen={openFolder}
            onCreate={() => createFolder()}
          />

          <div
            className={`root-docs ${dropTarget === 'root' ? 'drop-over' : ''}`}
            {...dropZone('root', setDropTarget, (e) => onDropTo(e, null))}
          >
            {folders.length > 0 && visible.length > 0 && <div className="label">Вне папок</div>}
            {visible.length > 0 ? (
              <div className="doc-list">{cards(visible)}</div>
            ) : items.length === 0 ? (
              // Материалов ещё нет — только работа в процессе или пустые папки.
              startZone
            ) : null}
          </div>
        </>
      )}

      {/* Кот свернулся в конце страницы — фирменный штрих автора */}
      <CatLine className="home-cat" />
    </section>
  );
}
