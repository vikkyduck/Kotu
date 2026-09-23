import type { DeckSeed, LectureSeed } from '@/hooks/use-app';

/**
 * Что показывает библиотека и в каком виде.
 *
 * Здесь только правила, без разметки и без запросов: пять списков с сервера
 * превращаются в две ленты — «сейчас в работе» и собственно библиотеку.
 * Правила стоило вынести отдельно, потому что они и есть смысл экрана:
 * законченное лежит в библиотеке, незаконченное ждёт наверху, а поисковые
 * копии своих же работ не показываются вовсе.
 */

export interface Doc {
  id: number;
  title: string;
  kind: string;
  folderId: number | null;
  transcriptionId: number | null;
  deckId: number | null;
  lectureId: number | null;
  pages: number | null;
  chunkCount: number;
  status: 'uploaded' | 'parsing' | 'ready' | 'error';
  statusMessage: string;
  error: string | null;
  createdAt: string;
}

export interface Folder {
  id: number;
  name: string;
}

export interface LectureRow {
  id: number;
  title: string;
  folderId: number | null;
  status: 'planning' | 'plan_ready' | 'writing' | 'ready' | 'error';
  statusMessage: string;
  createdAt: string;
}

export interface DeckRow {
  id: number;
  title: string;
  folderId: number | null;
  status: 'storyboarding' | 'storyboard_ready' | 'drawing' | 'ready' | 'error';
  statusMessage: string;
  createdAt: string;
}

export interface TranscriptionRow {
  id: number;
  title: string;
  status: string;
  statusMessage: string;
  progress: number;
  createdAt: string;
}

/** Находка поиска: материал и лучшие фрагменты из него. */
export interface Hit {
  documentId: number;
  title: string;
  kind: string;
  lectureId: number | null;
  deckId: number | null;
  transcriptionId: number | null;
  quotes: { text: string; heading: string | null }[];
}

export type ItemKind = 'book' | 'article' | 'note' | 'transcript' | 'lecture' | 'deck';

/** Одна карточка библиотеки — общий язык для книги, лекции и презентации. */
export interface Item {
  key: string;
  kind: ItemKind;
  id: number;
  title: string;
  folderId: number | null;
  meta: string;
  tone: '' | 'busy' | 'bad';
  createdAt: string;
  /**
   * Ручка материала: туда уходит перекладывание в папку. Нет — карточку не
   * перекладывают: незаконченная работа ещё не материал, а у расшифровки без
   * библиотечной копии нет строки, которая лежала бы в папке.
   */
  api?: string;
  open?: () => void;
  rename?: () => void;
  /** Удаление: у расшифровки его нет — она удаляется вместе с записью. */
  del?: () => void;
  /** «Сделать из этого»: материал переходит в следующий инструмент. */
  makeDeck?: () => void;
  makeLecture?: () => void;
}

export const KIND_ICON: Record<ItemKind, string> = {
  book: 'book',
  article: 'book',
  note: 'book',
  transcript: 'mic',
  lecture: 'pen',
  deck: 'deck',
};

export const KIND_LABEL: Record<ItemKind, string> = {
  book: 'книга',
  article: 'статья',
  note: 'заметка',
  transcript: 'расшифровка',
  lecture: 'лекция',
  deck: 'презентация',
};

const KINDS: readonly ItemKind[] = ['book', 'article', 'note', 'transcript', 'lecture', 'deck'];

/** Вид материала из строки базы — одно правило для библиотеки, поиска и форм. */
export function docKind(kind: string): ItemKind {
  return (KINDS as readonly string[]).includes(kind) ? (kind as ItemKind) : 'book';
}

/** «3 материала» — с правильным окончанием, иначе интерфейс выглядит машинным. */
export function countLabel(n: number): string {
  if (n === 0) return 'пусто';
  const last = n % 10;
  const teen = n % 100 >= 11 && n % 100 <= 14;
  if (!teen && last === 1) return `${n} материал`;
  if (!teen && last >= 2 && last <= 4) return `${n} материала`;
  return `${n} материалов`;
}

/** Всё, что экран получает с сервера. */
export interface LibraryData {
  docs: Doc[];
  lectures: LectureRow[];
  decks: DeckRow[];
  transcriptions: TranscriptionRow[];
}

/** Что карточка умеет делать. Экран подставляет сюда переходы и удаление. */
export interface ItemActions {
  openTranscription: (id: number) => void;
  openLecture: (id: number) => void;
  openDeck: (id: number) => void;
  newDeck: (seed?: DeckSeed) => void;
  newLecture: (seed?: LectureSeed) => void;
  remove: (url: string, done: string) => void;
  rename: (url: string, title: string) => void;
  retry: (url: string) => void;
  openFile: (url: string) => void;
}

/** Свежее сверху: работа идёт от последнего, а не от первой загруженной книги. */
const newestFirst = (a: Item, b: Item) => (a.createdAt < b.createdAt ? 1 : -1);

/**
 * Библиотека: всё законченное. Незаконченное живёт выше, в полосе «сейчас
 * в работе», — так у работы виден путь: сделал → лежит в библиотеке.
 */
export function buildItems(data: LibraryData, act: ItemActions): Item[] {
  const { docs, lectures, decks, transcriptions } = data;

  const fromDocs = docs
    // Текстовая копия лекции и презентации — не отдельный материал, а их
    // поисковый след: показывать второй карточкой значило бы двоить вещь.
    .filter((d) => d.kind !== 'deck' && d.kind !== 'lecture')
    .map<Item>((d) => {
      const kind = docKind(d.kind);
      const api = `/api/documents/${d.id}`;
      // У копии расшифровки своё имя нейтральное (оно уходит в модели), а
      // автору показываем и переименовываем настоящее — имя самой записи.
      const record =
        d.transcriptionId !== null ? transcriptions.find((t) => t.id === d.transcriptionId) : undefined;
      const title = record?.title ?? d.title;
      const meta =
        d.status === 'ready'
          ? // У расшифровки счёт фрагментов ничего не говорит автору — только
            // вид. У книги наоборот: объём и разбор по делу.
            kind === 'transcript'
            ? KIND_LABEL[kind]
            : `${KIND_LABEL[kind]}${d.pages ? ` · ${d.pages} с.` : ''} · ${d.chunkCount} фрагментов`
          : d.status === 'error'
            ? (d.error ?? 'не удалось разобрать')
            : d.statusMessage || 'В очереди…';

      return {
        key: `doc:${d.id}`,
        kind,
        id: d.id,
        title,
        folderId: d.folderId,
        meta,
        tone: d.status === 'error' ? 'bad' : d.status === 'ready' ? '' : 'busy',
        createdAt: d.createdAt,
        api,
        open:
          kind === 'transcript'
            ? d.transcriptionId !== null
              ? () => act.openTranscription(d.transcriptionId!)
              : undefined
            : d.status === 'error'
              ? () => act.retry(`${api}/retry`)
              : () => act.openFile(`${api}/file`),
        rename:
          kind !== 'transcript'
            ? () => act.rename(api, title)
            : d.transcriptionId !== null
              ? () => act.rename(`/api/transcriptions/${d.transcriptionId}`, title)
              : undefined,
        // Разобранный материал годится и для слайдов, и как опора лекции.
        makeDeck:
          d.status === 'ready'
            ? () => act.newDeck({ sourceKind: 'document', sourceId: d.id })
            : undefined,
        makeLecture:
          d.status === 'ready' ? () => act.newLecture({ documentIds: [d.id] }) : undefined,
        // Расшифровку удаляют вместе с записью — на её экране, там же, где аудио.
        del: kind === 'transcript' ? undefined : () => act.remove(api, 'Документ удалён'),
      };
    });

  // Готовая запись без библиотечной копии: текст короче порога или копия ещё
  // не записана. Без этой карточки она не видна нигде — ни в работе, ни здесь.
  const fromRecords = transcriptions
    .filter((t) => t.status === 'done' && !docs.some((d) => d.transcriptionId === t.id))
    .map<Item>((t) => ({
      key: `tr:${t.id}`,
      kind: 'transcript',
      id: t.id,
      title: t.title,
      folderId: null,
      meta: KIND_LABEL.transcript,
      tone: '',
      createdAt: t.createdAt,
      open: () => act.openTranscription(t.id),
      rename: () => act.rename(`/api/transcriptions/${t.id}`, t.title),
    }));

  /** В поиске текст работы, только когда у её копии уже есть фрагменты. */
  const searchable = (match: (d: Doc) => boolean) => docs.some((d) => match(d) && d.chunkCount > 0);

  /** Опереться на свою работу можно через её текст в поиске. */
  const copyOf = (match: (d: Doc) => boolean): (() => void) | undefined => {
    const copy = docs.find((d) => match(d) && d.status === 'ready');
    return copy ? () => act.newLecture({ documentIds: [copy.id] }) : undefined;
  };

  const fromLectures = lectures
    .filter((l) => l.status === 'ready')
    .map<Item>((l) => ({
      key: `lecture:${l.id}`,
      kind: 'lecture',
      id: l.id,
      title: l.title,
      folderId: l.folderId,
      meta: searchable((d) => d.lectureId === l.id) ? 'лекция · текст в поиске' : 'лекция · готова',
      tone: '',
      createdAt: l.createdAt,
      api: `/api/lectures/${l.id}`,
      open: () => act.openLecture(l.id),
      rename: () => act.rename(`/api/lectures/${l.id}`, l.title),
      del: () => act.remove(`/api/lectures/${l.id}`, 'Лекция удалена'),
      makeDeck: () => act.newDeck({ sourceKind: 'lecture', sourceId: l.id }),
      makeLecture: copyOf((d) => d.lectureId === l.id),
    }));

  const fromDecks = decks
    .filter((k) => k.status === 'ready')
    .map<Item>((k) => ({
      key: `deck:${k.id}`,
      kind: 'deck',
      id: k.id,
      title: k.title,
      folderId: k.folderId,
      meta: searchable((d) => d.deckId === k.id)
        ? 'презентация · текст в поиске'
        : 'презентация · готова',
      tone: '',
      createdAt: k.createdAt,
      api: `/api/decks/${k.id}`,
      open: () => act.openDeck(k.id),
      rename: () => act.rename(`/api/decks/${k.id}`, k.title),
      del: () => act.remove(`/api/decks/${k.id}`, 'Презентация удалена'),
      makeLecture: copyOf((d) => d.deckId === k.id),
    }));

  return [...fromDocs, ...fromRecords, ...fromLectures, ...fromDecks].sort(newestFirst);
}

/** Сейчас в работе: то, что делается или ждёт решения автора. */
export function buildWorking(data: LibraryData, act: ItemActions): Item[] {
  const { lectures, decks, transcriptions } = data;

  const fromTranscriptions = transcriptions
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
      open: () => act.openTranscription(t.id),
    }));

  const fromLectures = lectures
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
      open: () => act.openLecture(l.id),
      // План не понравился или лекция упала — убрать её можно прямо отсюда.
      del: () => act.remove(`/api/lectures/${l.id}`, 'Лекция удалена'),
    }));

  const fromDecks = decks
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
      open: () => act.openDeck(k.id),
      del: () => act.remove(`/api/decks/${k.id}`, 'Презентация удалена'),
    }));

  return [...fromTranscriptions, ...fromLectures, ...fromDecks].sort(newestFirst);
}

/** Что-то делается прямо сейчас — значит, список нужно обновлять самому. */
export function isBusy(data: LibraryData): boolean {
  return (
    data.docs.some((d) => d.status === 'parsing' || d.status === 'uploaded') ||
    data.lectures.some((l) => l.status === 'planning' || l.status === 'writing') ||
    data.decks.some((k) => k.status === 'storyboarding' || k.status === 'drawing') ||
    data.transcriptions.some((t) => t.status === 'processing')
  );
}
