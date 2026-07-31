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
  kind: 'A' | 'B' | 'C' | 'N';
  callback: ((text: string) => void) | null;
}

interface AppContextType {
  screen: ScreenId;
  go: (id: ScreenId) => void;
  toast: (msg: string) => void;
  toastMsg: string | null;
  sheet: FixSheetState;
  openSheet: (title: string, kind: 'A' | 'B' | 'C' | 'N', cb: (text: string) => void) => void;
  closeSheet: () => void;
  theme: Theme;
  toggleTheme: () => void;
  activeTranscriptionId: number | null;
  openTranscription: (id: number) => void;
  newTranscription: () => void;
  activeLectureId: number | null;
  openLecture: (id: number) => void;
  newLecture: () => void;
  activeDeckId: number | null;
  openDeck: (id: number) => void;
  newDeck: () => void;
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

const AppContext = createContext<AppContextType | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [nav, setNav] = useState<Nav>(() => navOf(window.location.hash));
  const screen = nav.screen;
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [sheet, setSheet] = useState<FixSheetState>({ isOpen: false, title: '', kind: 'A', callback: null });
  const toastT = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [theme, setThemeState] = useState<Theme>('light');
  // Что именно открыто в инструменте. null = «делаем новое»: инструмент
  // открывается формой, а список сделанного живёт в библиотеке.
  const activeTranscriptionId = nav.transcriptionId;
  const activeLectureId = nav.lectureId;
  const activeDeckId = nav.deckId;

  useEffect(() => {
    let t = '';
    try {
      t = localStorage.getItem('kot-theme') || '';
    } catch (e) {}
    if (!t) {
      t = (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-color-scheme:dark)').matches) ? 'dark' : 'light';
    }
    const next = (t === 'dark' ? 'dark' : 'light') as Theme;
    document.documentElement.setAttribute('data-theme', next);
    setThemeState(next);
  }, []);

  const setTheme = useCallback((t: Theme) => {
    document.documentElement.setAttribute('data-theme', t);
    setThemeState(t);
    try {
      localStorage.setItem('kot-theme', t);
    } catch (e) {}
  }, []);

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

  /** Переход: состояние и адрес меняются вместе, иначе «назад» врёт. */
  const goTo = useCallback((next: Nav) => {
    setNav(next);
    if (hashOf(next) !== window.location.hash) {
      window.history.pushState(next, '', hashOf(next));
    }
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
    // оставил бы приложение на прежнем экране.
    window.history.replaceState(navOf(window.location.hash), '', window.location.hash || '#/');
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const go = useCallback((id: ScreenId) => {
    goTo({ ...HOME, screen: id });
  }, [goTo]);

  const openTranscription = useCallback((id: number) => {
    goTo({ ...HOME, screen: 's-transcribe', transcriptionId: id });
  }, [goTo]);

  const newTranscription = useCallback(() => {
    goTo({ ...HOME, screen: 's-transcribe' });
  }, [goTo]);

  const openLecture = useCallback((id: number) => {
    goTo({ ...HOME, screen: 's-lecture', lectureId: id });
  }, [goTo]);

  const newLecture = useCallback(() => {
    goTo({ ...HOME, screen: 's-lecture' });
  }, [goTo]);

  const openDeck = useCallback((id: number) => {
    goTo({ ...HOME, screen: 's-slides', deckId: id });
  }, [goTo]);

  const newDeck = useCallback(() => {
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

  const openSheet = useCallback((title: string, kind: 'A' | 'B' | 'C' | 'N', cb: (text: string) => void) => {
    setSheet({ isOpen: true, title, kind, callback: cb });
  }, []);

  const closeSheet = useCallback(() => {
    setSheet(s => ({ ...s, isOpen: false }));
  }, []);

  return (
    <AppContext.Provider value={{ screen, go, toast, toastMsg, sheet, openSheet, closeSheet, theme, toggleTheme, activeTranscriptionId, openTranscription, newTranscription, activeLectureId, openLecture, newLecture, activeDeckId, openDeck, newDeck }}>
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}
