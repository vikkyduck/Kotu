import { useState, useEffect, useCallback } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppProvider } from '@/hooks/use-app';
import { Login } from '@/components/Login';
import { ResetPassword } from '@/components/ResetPassword';
import { TopBar } from '@/components/TopBar';
import { Home } from '@/components/Home';
import { Transcribe } from '@/components/Transcribe';
import { Library } from '@/components/Library';
import { Profile } from '@/components/Profile';
import { Lecture } from '@/components/Lecture';
import { Slides } from '@/components/Slides';
import { How } from '@/components/How';
import { FixSheet } from '@/components/FixSheet';
import { Toast } from '@/components/Toast';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

function AppContent() {
  return (
    <>
      <TopBar />
      <div className="wrap">
        <Home />
        <Transcribe />
        <Library />
        <Profile />
        <Lecture />
        <Slides />
        <How />
      </div>
      <FixSheet />
      <Toast />
    </>
  );
}

/**
 * Пускает в приложение только после входа. Пока идёт проверка сессии —
 * пустой экран: мигать формой входа перед уже залогиненным человеком незачем.
 */
function AuthGate() {
  const [state, setState] = useState<'checking' | 'in' | 'out'>('checking');
  // Ссылка из письма приходит как /?reset=<токен> — своего роутера в
  // приложении нет, поэтому читаем адрес напрямую.
  const [resetToken, setResetToken] = useState<string | null>(() =>
    new URLSearchParams(window.location.search).get('reset'),
  );

  const check = useCallback(async () => {
    try {
      const res = await fetch('/api/me');
      setState(res.ok ? 'in' : 'out');
    } catch {
      setState('out');
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

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
  return <AppContent />;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AppProvider>
        <AuthGate />
      </AppProvider>
    </QueryClientProvider>
  );
}

export default App;
