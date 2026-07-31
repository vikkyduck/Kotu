import { Icon } from '@/lib/icons';
import { CatMark } from '@/lib/cat';
import { useApp } from '@/hooks/use-app';

const TITLES: Record<string, string> = {
  's-home': '',
  's-transcribe': 'Расшифровка',
  's-lecture': 'Лекция',
  's-slides': 'Презентация',
  's-library': 'Библиотека',
  's-profile': 'Профиль',
  's-how': 'Как это работает'
};

export function TopBar() {
  const { screen, go, theme, toggleTheme } = useApp();
  
  const isHome = screen === 's-home';

  return (
    <div className={`top ${!isHome ? 'sub' : ''}`} id="topbar">
      <button className="back" id="backBtn" onClick={() => go('s-home')}>
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
      
      {screen !== 's-how' && (
        <button className="helpbtn" id="helpBtn" onClick={() => go('s-how')}>
          <span data-icon="info"><Icon name="info" /></span>
          <span className="lbl">Как это работает</span>
        </button>
      )}
      
      <button className="iconbtn" id="themeToggle" title="Светлее / темнее" onClick={toggleTheme}>
        <span id="themeIcon" data-icon="moon"><Icon name={theme === 'dark' ? 'sun' : 'moon'} /></span>
      </button>

      {screen !== 's-profile' && (
        <button className="iconbtn" title="Профиль и пароль" onClick={() => go('s-profile')}>
          <span data-icon="lock"><Icon name="lock" /></span>
        </button>
      )}
    </div>
  );
}
