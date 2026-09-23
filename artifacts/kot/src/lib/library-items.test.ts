import { test, describe, expect, vi } from 'vitest';
import {
  buildItems,
  buildWorking,
  countLabel,
  isBusy,
  type Doc,
  type DeckRow,
  type LectureRow,
  type LibraryData,
  type ItemActions,
  type TranscriptionRow,
} from './library-items';

/**
 * Правила библиотеки: что попадает в ленту, что ждёт наверху и что не должно
 * показываться вовсе. Это смысл главного экрана, а не деталь вёрстки, —
 * поэтому проверяется отдельно от разметки.
 */

const act: ItemActions = {
  openTranscription: vi.fn(),
  openLecture: vi.fn(),
  openDeck: vi.fn(),
  newDeck: vi.fn(),
  newLecture: vi.fn(),
  remove: vi.fn(),
  rename: vi.fn(),
  retry: vi.fn(),
  openFile: vi.fn(),
};

const doc = (over: Partial<Doc> = {}): Doc => ({
  id: 1,
  title: 'Мак-Вильямс. Психоаналитическая диагностика',
  kind: 'book',
  folderId: null,
  transcriptionId: null,
  deckId: null,
  lectureId: null,
  pages: 412,
  chunkCount: 861,
  status: 'ready',
  statusMessage: '',
  error: null,
  createdAt: '2026-07-20T10:00:00Z',
  ...over,
});

const lecture = (over: Partial<LectureRow> = {}): LectureRow => ({
  id: 1,
  title: 'Работа негатива',
  folderId: null,
  status: 'ready',
  statusMessage: '',
  createdAt: '2026-07-28T10:00:00Z',
  ...over,
});

const deck = (over: Partial<DeckRow> = {}): DeckRow => ({
  id: 1,
  title: 'Работа негатива: слайды',
  folderId: null,
  status: 'ready',
  statusMessage: '',
  createdAt: '2026-07-29T10:00:00Z',
  ...over,
});

const transcription = (over: Partial<TranscriptionRow> = {}): TranscriptionRow => ({
  id: 1,
  title: 'Сеанс, вторник',
  status: 'processing',
  statusMessage: 'Расшифровываю 40-ю минуту из 63…',
  progress: 62,
  createdAt: '2026-07-31T08:00:00Z',
  ...over,
});

const data = (over: Partial<LibraryData> = {}): LibraryData => ({
  docs: [],
  lectures: [],
  decks: [],
  transcriptions: [],
  ...over,
});

describe('что лежит в библиотеке', () => {
  test('готовая работа в библиотеке, незаконченная — в работе', () => {
    const d = data({
      lectures: [lecture({ id: 1 }), lecture({ id: 2, status: 'writing' })],
      decks: [deck({ id: 1 }), deck({ id: 2, status: 'drawing' })],
    });

    expect(buildItems(d, act).map((i) => i.key)).toEqual(['deck:1', 'lecture:1']);
    expect(buildWorking(d, act).map((i) => i.key)).toEqual(['deck:2', 'lecture:2']);
  });

  test('поисковая копия своей работы отдельной карточкой не показывается', () => {
    const d = data({
      docs: [doc({ id: 5, kind: 'lecture', lectureId: 1 }), doc({ id: 6, kind: 'deck', deckId: 1 })],
      lectures: [lecture({ id: 1 })],
      decks: [deck({ id: 1 })],
    });

    const keys = buildItems(d, act).map((i) => i.key);
    expect(keys).toEqual(['deck:1', 'lecture:1']);
    expect(keys).not.toContain('doc:5');
  });

  test('копия в поиске видна подписью на самой карточке', () => {
    const withCopy = buildItems(
      data({ docs: [doc({ id: 5, kind: 'lecture', lectureId: 1 })], lectures: [lecture()] }),
      act,
    );
    const without = buildItems(data({ lectures: [lecture()] }), act);

    expect(withCopy[0]?.meta).toBe('лекция · текст в поиске');
    expect(without[0]?.meta).toBe('лекция · готова');
  });

  test('копия ещё без фрагментов — в поиске её нет, подпись этого не обещает', () => {
    const [item] = buildItems(
      data({
        docs: [doc({ id: 5, kind: 'lecture', lectureId: 1, status: 'parsing', chunkCount: 0 })],
        lectures: [lecture()],
      }),
      act,
    );
    expect(item?.meta).toBe('лекция · готова');
  });

  test('готовая запись без библиотечной копии всё равно видна — одной карточкой', () => {
    const done = transcription({ id: 3, status: 'done', title: 'Лекция о Винникотте' });
    const alone = buildItems(data({ transcriptions: [done] }), act);
    const withCopy = buildItems(
      data({ transcriptions: [done], docs: [doc({ id: 9, kind: 'transcript', transcriptionId: 3 })] }),
      act,
    );

    expect(alone.map((i) => i.key)).toEqual(['tr:3']);
    expect(alone[0]?.title).toBe('Лекция о Винникотте');
    // Строки в папке у неё нет — и перекладывать её некуда.
    expect(alone[0]?.api).toBeUndefined();
    expect(withCopy.map((i) => i.key)).toEqual(['doc:9']);
  });

  test('свежее сверху', () => {
    const d = data({
      docs: [doc({ id: 1, createdAt: '2026-07-01T00:00:00Z' })],
      lectures: [lecture({ id: 1, createdAt: '2026-07-30T00:00:00Z' })],
    });

    expect(buildItems(d, act).map((i) => i.key)).toEqual(['lecture:1', 'doc:1']);
  });
});

describe('подписи под названием', () => {
  test('у книги — объём и разбор', () => {
    const [item] = buildItems(data({ docs: [doc()] }), act);
    expect(item?.meta).toBe('книга · 412 с. · 861 фрагментов');
  });

  test('у расшифровки — только вид, без счёта фрагментов', () => {
    const [item] = buildItems(data({ docs: [doc({ kind: 'transcript', transcriptionId: 3 })] }), act);
    expect(item?.meta).toBe('расшифровка');
  });

  test('неразобранная книга показывает ход работы, а не пустоту', () => {
    const [item] = buildItems(
      data({ docs: [doc({ status: 'parsing', statusMessage: 'Разбираю главу 4…' })] }),
      act,
    );
    expect(item?.meta).toBe('Разбираю главу 4…');
    expect(item?.tone).toBe('busy');
  });

  test('сломанный файл объясняет причину', () => {
    const [item] = buildItems(
      data({ docs: [doc({ status: 'error', error: 'Файл пуст — в нём не нашлось текста' })] }),
      act,
    );
    expect(item?.meta).toBe('Файл пуст — в нём не нашлось текста');
    expect(item?.tone).toBe('bad');
  });

  test('работа, которая ждёт решения автора, так и говорит', () => {
    const items = buildWorking(
      data({ lectures: [lecture({ status: 'plan_ready' })], decks: [deck({ status: 'storyboard_ready' })] }),
      act,
    );
    expect(items.map((i) => i.meta)).toEqual([
      'раскадровка ждёт вашего решения',
      'план ждёт вашего решения',
    ]);
  });
});

describe('что можно сделать с материалом', () => {
  test('из разобранной книги — и презентация, и лекция', () => {
    const [item] = buildItems(data({ docs: [doc()] }), act);
    expect(item?.makeDeck).toBeTypeOf('function');
    expect(item?.makeLecture).toBeTypeOf('function');
  });

  test('из неразобранной — ничего: опираться пока не на что', () => {
    const [item] = buildItems(data({ docs: [doc({ status: 'parsing' })] }), act);
    expect(item?.makeDeck).toBeUndefined();
    expect(item?.makeLecture).toBeUndefined();
  });

  test('лекция без текста в поиске не годится в опору следующей', () => {
    const [withCopy] = buildItems(
      data({ docs: [doc({ id: 5, kind: 'lecture', lectureId: 1 })], lectures: [lecture()] }),
      act,
    );
    const [without] = buildItems(data({ lectures: [lecture()] }), act);

    expect(withCopy?.makeLecture).toBeTypeOf('function');
    expect(without?.makeLecture).toBeUndefined();
    // Презентацию из лекции собирают напрямую — там главы целиком.
    expect(without?.makeDeck).toBeTypeOf('function');
  });

  test('книгу открывают файлом, а сломанную — разбирают заново', () => {
    const [book] = buildItems(data({ docs: [doc({ id: 4 })] }), act);
    const [broken] = buildItems(data({ docs: [doc({ id: 4, status: 'error' })] }), act);
    book?.open?.();
    broken?.open?.();
    expect(act.openFile).toHaveBeenCalledWith('/api/documents/4/file');
    expect(act.retry).toHaveBeenCalledWith('/api/documents/4/retry');
  });

  test('расшифровку переименовывают как запись — под её настоящим именем', () => {
    const [item] = buildItems(
      data({
        docs: [doc({ kind: 'transcript', transcriptionId: 3, title: 'Расшифровка от 1 июля' })],
        transcriptions: [transcription({ id: 3, status: 'done', title: 'Семинар, вторник' })],
      }),
      act,
    );
    expect(item?.title).toBe('Семинар, вторник');
    item?.rename?.();
    expect(act.rename).toHaveBeenCalledWith('/api/transcriptions/3', 'Семинар, вторник');
  });

  test('незаконченную лекцию можно убрать прямо из «в работе»', () => {
    const [item] = buildWorking(data({ lectures: [lecture({ id: 2, status: 'error' })] }), act);
    item?.del?.();
    expect(act.remove).toHaveBeenCalledWith('/api/lectures/2', 'Лекция удалена');
    expect(item?.api).toBeUndefined();
  });

  test('расшифровку удаляют вместе с записью, а не из библиотеки', () => {
    const [item] = buildItems(data({ docs: [doc({ kind: 'transcript', transcriptionId: 3 })] }), act);
    expect(item?.del).toBeUndefined();
    expect(item?.open).toBeTypeOf('function');
  });
});

describe('живой список', () => {
  test('пока что-то делается, экран обновляет себя сам', () => {
    expect(isBusy(data({ transcriptions: [transcription()] }))).toBe(true);
    expect(isBusy(data({ docs: [doc({ status: 'parsing' })] }))).toBe(true);
    expect(isBusy(data({ decks: [deck({ status: 'drawing' })] }))).toBe(true);
  });

  test('когда всё готово — перестаёт', () => {
    expect(isBusy(data({ docs: [doc()], lectures: [lecture()], decks: [deck()] }))).toBe(false);
    // Запись, которая ждёт решения автора, не «делается»: сервер не занят.
    expect(isBusy(data({ decks: [deck({ status: 'storyboard_ready' })] }))).toBe(false);
  });
});

describe('счёт материалов', () => {
  test('окончания по-русски', () => {
    expect(countLabel(0)).toBe('пусто');
    expect(countLabel(1)).toBe('1 материал');
    expect(countLabel(3)).toBe('3 материала');
    expect(countLabel(11)).toBe('11 материалов');
    expect(countLabel(21)).toBe('21 материал');
  });
});
