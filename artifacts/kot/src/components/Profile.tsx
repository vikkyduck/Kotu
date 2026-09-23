import { useState, useEffect, type FormEvent } from 'react';
import { useApp } from '@/hooks/use-app';
import { Icon } from '@/lib/icons';
import { json, send } from '@/lib/http';

interface Me {
  name: string;
  email: string;
}

export function Profile() {
  const { screen, go, toast } = useApp();
  const [me, setMe] = useState<Me | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (screen !== 's-profile') return;
    void (async () => {
      try {
        const res = await fetch('/api/me');
        if (res.ok) setMe(await res.json());
      } catch {
        /* покажем без данных, ничего страшного */
      }
    })();
  }, [screen]);

  // Форма закрывается пустой — отменённые пароли не ждут следующего открытия.
  const closeForm = () => {
    setShowForm(false);
    setCurrent('');
    setNext('');
    setRepeat('');
    setError('');
  };

  useEffect(() => {
    if (screen !== 's-profile') closeForm();
  }, [screen]);

  const changePassword = async (e: FormEvent) => {
    e.preventDefault();
    setError('');

    if (next !== repeat) {
      setError('Новые пароли не совпадают');
      return;
    }

    setBusy(true);
    const r = await send('/api/auth/password', json('POST', { current, next }), 'Не удалось сменить пароль');
    setBusy(false);
    if (!r.ok) {
      setError(r.message);
      return;
    }
    closeForm();
    toast('Пароль изменён. На других устройствах нужно войти заново.');
  };

  const logout = async () => {
    const r = await send('/api/auth/logout', { method: 'POST' }, 'Не удалось выйти');
    if (!r.ok) {
      toast(r.message);
      return;
    }
    window.location.reload();
  };

  if (screen !== 's-profile') return null;

  return (
    <section className="screen active" id="s-profile">
      <button className="btn ghost back-link" onClick={() => go('s-home')}>
        <Icon name="back" /> Назад
      </button>

      <h2 className="h2">Профиль</h2>
      <p className="sub">Вход и безопасность.</p>

      <div className="panel profile-card">
        <span className="doc-ico"><Icon name="lock" /></span>
        <div className="doc-body">
          <b className="doc-title">{me?.name ?? '—'}</b>
          <span className="doc-meta">{me?.email ?? ''}</span>
        </div>
      </div>

      {!showForm && (
        <button className="btn big" onClick={() => setShowForm(true)}>
          <Icon name="lock" /> Сменить пароль
        </button>
      )}

      {showForm && (
        <form className="panel" onSubmit={changePassword}>
          <div className="fieldlbl">Текущий пароль</div>
          <input
            className="field"
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            required
          />

          <div className="fieldlbl">Новый пароль</div>
          <input
            className="field"
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            placeholder="не короче 10 символов"
            required
          />

          <div className="fieldlbl">Новый пароль ещё раз</div>
          <input
            className="field"
            type="password"
            autoComplete="new-password"
            value={repeat}
            onChange={(e) => setRepeat(e.target.value)}
            required
          />

          {error && <p className="login-err">{error}</p>}

          <button className="btn primary big" type="submit" disabled={busy} style={{ marginTop: 'var(--sp-2)' }}>
            {busy ? 'Меняю…' : 'Сохранить новый пароль'}
          </button>
          <button
            className="btn ghost"
            type="button"
            style={{ width: '100%', marginTop: 'var(--sp-1)' }}
            onClick={closeForm}
          >
            Отмена
          </button>
        </form>
      )}

      <button className="btn link-danger" onClick={() => void logout()} style={{ marginTop: 'var(--sp-2)' }}>
        <Icon name="lock" /> Выйти
      </button>
    </section>
  );
}
