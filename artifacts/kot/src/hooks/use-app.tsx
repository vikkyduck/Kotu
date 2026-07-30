import React, { createContext, useContext, useState, useEffect, useCallback, useRef, ReactNode } from 'react';

type ScreenId = 's-home' | 's-transcribe' | 's-library' | 's-lecture' | 's-slides' | 's-how';
type Theme = 'light' | 'dark';

interface FixSheetState {
  isOpen: boolean;
  title: string;
  kind: 'A' | 'B' | 'C';
  callback: ((text: string) => void) | null;
}

interface AppContextType {
  screen: ScreenId;
  go: (id: ScreenId) => void;
  toast: (msg: string) => void;
  toastMsg: string | null;
  sheet: FixSheetState;
  openSheet: (title: string, kind: 'A' | 'B' | 'C', cb: (text: string) => void) => void;
  closeSheet: () => void;
  theme: Theme;
  toggleTheme: () => void;
  activeTranscriptionId: number | null;
  openTranscription: (id: number) => void;
  newTranscription: () => void;
}

const AppContext = createContext<AppContextType | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [screen, setScreen] = useState<ScreenId>('s-home');
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [sheet, setSheet] = useState<FixSheetState>({ isOpen: false, title: '', kind: 'A', callback: null });
  const toastT = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [theme, setThemeState] = useState<Theme>('light');
  const [activeTranscriptionId, setActiveTranscriptionId] = useState<number | null>(null);

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

  const go = useCallback((id: ScreenId) => {
    setScreen(id);
    window.scrollTo({ top: 0 });
  }, []);

  const openTranscription = useCallback((id: number) => {
    setActiveTranscriptionId(id);
    setScreen('s-transcribe');
    window.scrollTo({ top: 0 });
  }, []);

  const newTranscription = useCallback(() => {
    setActiveTranscriptionId(null);
    setScreen('s-transcribe');
    window.scrollTo({ top: 0 });
  }, []);

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

  const openSheet = useCallback((title: string, kind: 'A' | 'B' | 'C', cb: (text: string) => void) => {
    setSheet({ isOpen: true, title, kind, callback: cb });
  }, []);

  const closeSheet = useCallback(() => {
    setSheet(s => ({ ...s, isOpen: false }));
  }, []);

  return (
    <AppContext.Provider value={{ screen, go, toast, toastMsg, sheet, openSheet, closeSheet, theme, toggleTheme, activeTranscriptionId, openTranscription, newTranscription }}>
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used within AppProvider');
  return ctx;
}
