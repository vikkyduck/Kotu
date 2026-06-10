import { useApp } from '@/hooks/use-app';
import { Icon } from '@/lib/icons';

export function Toast() {
  const { toastMsg } = useApp();
  
  return (
    <div className={`toast ${toastMsg ? 'show' : ''}`} id="toast">
      <Icon name="check" />
      <span>{toastMsg}</span>
    </div>
  );
}
