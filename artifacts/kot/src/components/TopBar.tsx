import { useEffect, useRef, useState } from 'react';
import { Icon } from '@/lib/icons';
import { CatMark } from '@/lib/cat';
import { useApp } from '@/hooks/use-app';

const TITLES: Record<string, string> = {
  's-home': '',
  's-transcribe': 'Расшифровка',
  's-lecture': 'Лекция',
  's-slides': 'Презентация',
  's-profile': 'Профиль',
  's-how': 'Как это работает'
};

export function TopBar() {
  const { screen, go, theme, toggleTheme } = useApp();
  // Дизайн Lovable: вместо трёх кнопок справа — одна кнопка-меню (.topmenu).
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  const isHome = screen === 's-home';

  // Клик мимо меню закрывает его — привычное поведение выпадающих списков.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const goFromMenu = (id: 's-how' | 's-profile') => {
    setMenuOpen(false);
    go(id);
  };

  return (
    <div className={`top ${!isHome ? 'sub' : ''}`} id="topbar">
      {/* Возврат всегда в библиотеку: она главная, а не «одна из страниц» */}
      <button className="back" id="backBtn" aria-label="В библиотеку" onClick={() => go('s-home')}>
        <span data-icon="back"><Icon name="back" /></span>
      </button>

      {isHome && (
        <span className="brand" id="brand" onClick={() => go('s-home')}>
          <CatMark className="brand-cat" /> текст и слайды
        </span>
      )}

      {!isHome && (
        <span className="ttl" id="topTitle">{TITLES[screen]}</span>
      )}

      <span className="sp"></span>

      <div className="topmenu" ref={menuRef}>
        <button
          className={`iconbtn ${menuOpen ? 'on' : ''}`}
          title="Меню"
          aria-label="Меню"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen(o => !o)}
        >
          <span data-icon="lock"><Icon name="lock" /></span>
        </button>

        {menuOpen && (
          <div className="topmenu-pop" role="menu">
            <button role="menuitem" onClick={() => goFromMenu('s-how')} disabled={screen === 's-how'}>
              <Icon name="info" /> Как это работает
            </button>
            <button role="menuitem" onClick={() => goFromMenu('s-profile')} disabled={screen === 's-profile'}>
              <Icon name="lock" /> Профиль и пароль
            </button>
            {/* Переключатель темы тоже живёт в меню — снаружи остаётся одна кнопка */}
            <button role="menuitem" onClick={() => { setMenuOpen(false); toggleTheme(); }}>
              <Icon name={theme === 'dark' ? 'sun' : 'moon'} /> Светлее / темнее
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
