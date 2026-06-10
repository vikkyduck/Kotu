import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppProvider } from '@/hooks/use-app';
import { useLiquidLight } from '@/hooks/use-liquid-light';
import { TopBar } from '@/components/TopBar';
import { Home } from '@/components/Home';
import { Transcribe } from '@/components/Transcribe';
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
        <Lecture />
        <Slides />
        <How />
      </div>
      <FixSheet />
      <Toast />
    </>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AppProvider>
        <AppContent />
      </AppProvider>
    </QueryClientProvider>
  );
}

export default App;
