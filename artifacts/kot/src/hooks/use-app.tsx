import React, { createContext, useContext, useState, useEffect, useCallback, useRef, ReactNode } from 'react';

/**
 * 's-home' — библиотека: она же главная. Отдельного экрана библиотеки нет
 * с тех пор, как инструменты стали действиями над ней, а не соседями по меню.
 */
type ScreenId = 's-home' | 's-transcribe' | 's-lecture' | 's-slides' | 's-how' | 's-profile';
type Theme = 'light' | 'dark';

interface FixSheetState {
  isOpen: boolean;
  title: string;
  callback: ((text: string) => void) | null;
  /** Текст, с которым поле открывается (прежнее имя при переименовании). */
  initial: string;
}

interface AppContextType {
  screen: ScreenId;
  go: (id: ScreenId) => void;
  /** Открытого по адресу больше нет: его запись в истории становится библиотекой. */
  leaveMissing: () => void;
  toast: (msg: string) => void;
  toastMsg: string | null;
  sheet: FixSheetState;
  /** Окно «назовите»: одно поле для имени (папки, записи, лекции…). */
  openSheet: (title: string, cb: (text: string) => void, initial?: string) => void;
  closeSheet: () => void;
  theme: Theme;
  toggleTheme: () => void;
  activeTranscriptionId: number | null;
  openTranscription: (id: number) => void;
  newTranscription: () => void;
  activeLectureId: number | null;
  openLecture: (id: number) => void;
  newLecture: (seed?: LectureSeed) => void;
  /** Чем заполнить форму новой лекции — «написать на основе этого материала». */
  lectureSeed: LectureSeed | null;
  activeDeckId: number | null;
  openDeck: (id: number) => void;
  newDeck: (seed?: DeckSeed) => void;
  /** Из чего собирать презентацию — «сделать презентацию из этого». */
  deckSeed: DeckSeed | null;
}

/**
 * Заготовка для инструмента: с какого материала библиотеки начать. Так
 * документ «гуляет из элемента в элемент» — расшифровка становится лекцией,
 * лекция презентацией, — не заставляя автора искать её в списке заново.
 */
export interface DeckSeed {
  sourceKind: 'lecture' | 'document';
  sourceId: number;
}

export interface LectureSeed {
  documentIds: number[];
}

/**
 * Куда мы смотрим. Экран и «что именно открыто» — одно состояние, потому что
 * они всегда меняются вместе и вместе же попадают в адрес.
 */
interface Nav {
  screen: ScreenId;
  transcriptionId: number | null;
  lectureId: number | null;
  deckId: number | null;
}

const HOME: Nav = { screen: 's-home', transcriptionId: null, lectureId: null, deckId: null };

/**
 * Адрес страницы. Нужен ради трёх вещей: кнопка «назад» в браузере (на
 * телефоне это жест, которым выходят из приложения по привычке), перезагрузка
 * без потери места и возможность дать ссылку на конкретную лекцию.
 */
function hashOf(n: Nav): string {
  if (n.screen === 's-transcribe') return n.transcriptionId ? `#/record/${n.transcriptionId}` : '#/record';
  if (n.screen === 's-lecture') return n.lectureId ? `#/lecture/${n.lectureId}` : '#/lecture';
  if (n.screen === 's-slides') return n.deckId ? `#/deck/${n.deckId}` : '#/deck';
  if (n.screen === 's-profile') return '#/profile';
  if (n.screen === 's-how') return '#/how';
  return '#/';
}

function navOf(hash: string): Nav {
  const [, what, rawId] = hash.replace(/^#\/?/, '/').split('/');
  const id = Number(rawId);
  const num = Number.isInteger(id) && id > 0 ? id : null;
  if (what === 'record') return { ...HOME, screen: 's-transcribe', transcriptionId: num };
  if (what === 'lecture') return { ...HOME, screen: 's-lecture', lectureId: num };
  if (what === 'deck') return { ...HOME, screen: 's-slides', deckId: num };
  if (what === 'profile') return { ...HOME, screen: 's-profile' };
  if (what === 'how') return { ...HOME, screen: 's-how' };
  return HOME;
}

/** Что открыто в инструменте; null — пустая форма «делаем новое». */
function idOf(n: Nav): number | null {
  return n.transcriptionId ?? n.lectureId ?? n.deckId;
}

function historyState(): (Nav & { fromHome?: boolean }) | null {
  return window.history.state as (Nav & { fromHome?: boolean }) | null;
}

const AppContext = createContext<AppContextType | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [nav, setNav] = useState<Nav>(() => navOf(window.location.hash));
  const screen = nav.screen;
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [sheet, setSheet] = useState<FixSheetState>({ isOpen: false, title: '', callback: null, initial: '' });
  const toastT = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Тему до загрузки уже выставил скрипт в index.html (по умолчанию — бумага),
  // здесь её только читаем: правило живёт в одном месте.
  const [theme, setThemeState] = useState<Theme>(() =>
    document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light',
  );
  // Что именно открыто в инструменте. null = «делаем новое»: инструмент
  // открывается формой, а список сделанного живёт в библиотеке.
  const activeTranscriptionId = nav.transcriptionId;
  // Заготовки живут вне адреса: это подсказка форме, а не место в приложении.
  const [lectureSeed, setLectureSeed] = useState<LectureSeed | null>(null);
  const [deckSeed, setDeckSeed] = useState<DeckSeed | null>(null);
  const activeLectureId = nav.lectureId;
  const activeDeckId = nav.deckId;

  const toggleTheme = useCallback(() => {
    setThemeState(prev => {
      const next: Theme = prev === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try {
        localStorage.setItem('kot-theme', next);
      } catch (e) {}
      return next;
    });
  }, []);

  const navRef = useRef(nav);
  navRef.current = nav;

  /**
   * Переход: состояние и адрес меняются вместе, иначе «назад» врёт.
   * fromHome в записи истории — пришли на неё из библиотеки: тогда возврат
   * в библиотеку — это шаг назад, а не новая запись (см. go).
   */
  const goTo = useCallback((next: Nav) => {
    const cur = navRef.current;
    const hash = hashOf(next);
    if (hash !== window.location.hash) {
      // Только что созданная запись встаёт на место пустой формы: «назад» с неё
      // не должен возвращать к форме, из которой она получилась.
      const created = next.screen === cur.screen && idOf(cur) === null && idOf(next) !== null;
      const fromHome = cur.screen === 's-home' || (created && Boolean(historyState()?.fromHome));
      const entry = { ...next, fromHome };
      if (created) window.history.replaceState(entry, '', hash);
      else window.history.pushState(entry, '', hash);
    }
    navRef.current = next;
    setNav(next);
    window.scrollTo({ top: 0 });
  }, []);

  // Кнопка «назад» браузера и жест «назад» на телефоне: возвращают туда, где
  // человек был, а не выкидывают из приложения.
  useEffect(() => {
    const onPop = (e: PopStateEvent) => {
      setNav((e.state as Nav | null) ?? navOf(window.location.hash));
      window.scrollTo({ top: 0 });
    };
    window.addEventListener('popstate', onPop);
    // Первая запись в истории должна знать своё место — иначе возврат на неё
    // оставил бы приложение на прежнем экране. fromHome переживает перезагрузку.
    const entry = { ...navOf(window.location.hash), fromHome: Boolean(historyState()?.fromHome) };
    window.history.replaceState(entry, '', window.location.hash || '#/');
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const go = useCallback((id: ScreenId) => {
    // В библиотеку, из которой сюда и пришли, — шагом назад: иначе жест
    // «назад» на телефоне снова открыл бы экран, с которого только что ушли.
    if (id === 's-home' && navRef.current.screen !== 's-home' && historyState()?.fromHome) {
      window.history.back();
      return;
    }
    goTo({ ...HOME, screen: id });
  }, [goTo]);

  // Не go('s-home'): новая запись поверх удалённой сделала бы из «назад»
  // ловушку — каждый шаг назад снова попадал бы на неё и уводил вперёд.
  const leaveMissing = useCallback(() => {
    window.history.replaceState({ ...HOME, fromHome: false }, '', '#/');
    navRef.current = HOME;
    setNav(HOME);
    window.scrollTo({ top: 0 });
  }, []);

  const openTranscription = useCallback((id: number) => {
    goTo({ ...HOME, screen: 's-transcribe', transcriptionId: id });
  }, [goTo]);

  const newTranscription = useCallback(() => {
    goTo({ ...HOME, screen: 's-transcribe' });
  }, [goTo]);

  const openLecture = useCallback((id: number) => {
    setLectureSeed(null);
    goTo({ ...HOME, screen: 's-lecture', lectureId: id });
  }, [goTo]);

  const newLecture = useCallback((seed?: LectureSeed) => {
    setLectureSeed(seed ?? null);
    goTo({ ...HOME, screen: 's-lecture' });
  }, [goTo]);

  const openDeck = useCallback((id: number) => {
    setDeckSeed(null);
    goTo({ ...HOME, screen: 's-slides', deckId: id });
  }, [goTo]);

  const newDeck = useCallback((seed?: DeckSeed) => {
    setDeckSeed(seed ?? null);
    goTo({ ...HOME, screen: 's-slides' });
  }, [goTo]);

  const toast = useCallback((msg: string) => {
    setToastMsg(msg);
    if (toastT.current) clearTimeout(toastT.current);
    toastT.current = setTimeout(() => setToastMsg(null), 2800);
  }, []);

  useEffect(() => {
    return () => {
      if (toastT.current) clearTimeout(toastT.current);
    };
  }, []);

  const openSheet = useCallback((title: string, cb: (text: string) => void, initial = '') => {
    setSheet({ isOpen: true, title, callback: cb, initial });
  }, []);

  const closeSheet = useCallback(() => {
    setSheet(s => ({ ...s, isOpen: false }));
  }, []);

  return (
    <AppContext.Provider value={{ screen, go, leaveMissing, toast, toastMsg, sheet, openSheet, closeSheet, theme, toggleTheme, activeTranscriptionId, openTranscription, newTranscription, activeLectureId, openLecture, newLecture, lectureSeed, activeDeckId, openDeck, newDeck, deckSeed }}>
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}
