import { useState, useEffect } from 'react';
import { AppProvider } from '@/hooks/use-app';
import { Login } from '@/components/Login';
import { ResetPassword } from '@/components/ResetPassword';
import { TopBar } from '@/components/TopBar';
import { Transcribe } from '@/components/Transcribe';
import { Library } from '@/components/Library';
import { Profile } from '@/components/Profile';
import { Lecture } from '@/components/Lecture';
import { Slides } from '@/components/Slides';
import { How } from '@/components/How';
import { FixSheet } from '@/components/FixSheet';
import { Toast } from '@/components/Toast';

function AppContent() {
  return (
    <>
      <TopBar />
      <div className="wrap">
        <Library />
        <Transcribe />
        <Profile />
        <Lecture />
        <Slides />
        <How />
      </div>
      {/* Сюда, а не в body, открываются окна-порталы (просмотр слайда): так
          они прячутся вместе с приложением, когда сессия кончилась. */}
      <div id="modal-root" />
      <FixSheet />
      <Toast />
    </>
  );
}

/** Пока сервер не ответил ни «да», ни «нет» (перезапуск, обрыв сети) — спрашиваем снова. */
const RETRY_MS = 2000;

/**
 * Пускает в приложение только после входа. Пока идёт проверка сессии —
 * пустой экран: мигать формой входа перед уже залогиненным человеком незачем.
 * Форма входа — только на явное 401: сбой сервера сессию не отменяет.
 */
function AuthGate() {
  // 'expired' — сессия кончилась посреди работы: вход поверх, приложение под
  // ним не размонтируется, чтобы несохранённая правка дождалась повторного входа.
  const [state, setState] = useState<'checking' | 'in' | 'out' | 'expired'>('checking');
  // Ссылка из письма приходит как /?reset=<токен> — своего роутера в
  // приложении нет, поэтому читаем адрес напрямую.
  const [resetToken, setResetToken] = useState<string | null>(() =>
    new URLSearchParams(window.location.search).get('reset'),
  );

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      try {
        const res = await fetch('/api/me');
        if (res.ok || res.status === 401) {
          if (alive) setState(res.ok ? 'in' : 'out');
          return;
        }
      } catch {
        /* сети нет — спросим ещё раз */
      }
      if (alive) timer = setTimeout(() => void check(), RETRY_MS);
    };
    void check();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);

  // Сессия кончилась посреди работы (30 дней прошло, пароль сменили на
  // другом устройстве) — любой запрос к API получит 401, и вместо «не удалось»
  // на каждой кнопке показываем вход. Экран и недописанный текст сохранятся:
  // приложение только прячется (см. 'expired'). Под /api/auth/ 401
  // значит другое — «неверный пароль», — его разбирают сами формы.
  useEffect(() => {
    const original = window.fetch;
    window.fetch = async (input, init) => {
      const res = await original.call(window, input, init);
      if (res.status === 401) {
        const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const url = new URL(raw, window.location.href);
        if (
          url.origin === window.location.origin &&
          url.pathname.startsWith('/api/') &&
          !url.pathname.startsWith('/api/auth/')
        ) {
          setState((s) => (s === 'in' || s === 'expired' ? 'expired' : 'out'));
        }
      }
      return res;
    };
    return () => {
      window.fetch = original;
    };
  }, []);

  // Открытое окно (просмотр слайда) запирает прокрутку body; пока поверх
  // вход, она ему нужнее. После входа запрет возвращается, только если окно
  // всё ещё открыто: жестом «назад» его могли закрыть, пока шёл вход.
  useEffect(() => {
    if (state !== 'expired') return;
    document.body.style.overflow = '';
    return () => {
      document.body.style.overflow = document.querySelector('#modal-root .vw') ? 'hidden' : '';
    };
  }, [state]);

  if (resetToken) {
    return (
      <ResetPassword
        token={resetToken}
        onDone={() => {
          // Убираем токен из адресной строки, чтобы он не остался в истории.
          window.history.replaceState(null, '', window.location.pathname);
          setResetToken(null);
          setState('out');
        }}
      />
    );
  }

  if (state === 'checking') return null;
  if (state === 'out') return <Login onSuccess={() => setState('in')} />;
  return (
    <>
      {state === 'expired' && <Login onSuccess={() => setState('in')} />}
      <div hidden={state === 'expired'}>
        <AppContent />
      </div>
    </>
  );
}

function App() {
  return (
    <AppProvider>
      <AuthGate />
    </AppProvider>
  );
}

export default App;
