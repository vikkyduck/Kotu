import { useApp } from '@/hooks/use-app';

/** Без значка: через тост идут и удачи, и отказы — текст говорит сам. */
export function Toast() {
  const { toastMsg } = useApp();

  return (
    <div className={`toast ${toastMsg ? 'show' : ''}`} id="toast">
      <span>{toastMsg}</span>
    </div>
  );
}
