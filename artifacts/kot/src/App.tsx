import { useState, useEffect, useCallback } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppProvider } from '@/hooks/use-app';
import { Login } from '@/components/Login';
import { useLiquidLight } from '@/hooks/use-liquid-light';
import { TopBar } from '@/components/TopBar';
import { Home } from '@/components/Home';
import { Transcribe } from '@/components/Transcribe';
import { Library } from '@/components/Library';
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
  useLiquidLight();

  return (
    <>
      <TopBar />
      <div className="wrap">
        <Home />
        <Transcribe />
        <Library />
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
