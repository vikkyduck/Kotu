import { useState, useEffect, type FormEvent } from 'react';

interface ResetPasswordProps {
  token: string;
  onDone: () => void;
}

export function ResetPassword({ token, onDone }: ResetPasswordProps) {
  const [state, setState] = useState<'checking' | 'valid' | 'invalid' | 'done'>('checking');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch(`/api/auth/reset/check?token=${encodeURIComponent(token)}`);
        const data = await res.json();
        setState(data.valid ? 'valid' : 'invalid');
      } catch {
        setState('invalid');
      }
    })();
  }, [token]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');

    if (password !== repeat) {
      setError('Пароли не совпадают');
      return;
    }
    if (password.length < 10) {
      setError('Пароль должен быть не короче 10 символов');
      return;
    }

    setBusy(true);
    try {
      const res = await fetch('/api/auth/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, password }),
      });
      if (res.ok) {
        setState('done');
        return;
      }
      const data = await res.json().catch(() => ({}));
      setError(data.message ?? 'Не удалось задать пароль');
    } catch {
      setError('Нет связи с сервером');
    } finally {
      setBusy(false);
    }
  };

  if (state === 'checking') return null;

  if (state === 'invalid') {
    return (
      <div className="login-wrap">
        <h1 className="hello">Ссылка не работает</h1>
        <p className="lead">
          Скорее всего, она устарела или её уже использовали.
        </p>
        <button className="btn primary big" onClick={onDone}>
          Вернуться ко входу
        </button>
        <p className="login-note">Запросите новую ссылку — она действует один час.</p>
      </div>
    );
  }

  if (state === 'done') {
    return (
      <div className="login-wrap">
        <h1 className="hello">Пароль изменён</h1>
        <p className="lead">Теперь войдите с новым паролем.</p>
        <button className="btn primary big" onClick={onDone}>
          Войти
        </button>
      </div>
    );
  }

  return (
    <div className="login-wrap">
      <h1 className="hello">Новый пароль</h1>
      <p className="lead">Придумайте пароль — и снова в работу.</p>

      <form className="panel" onSubmit={submit}>
        <div className="fieldlbl">Новый пароль</div>
        <input
          className="field"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="не короче 10 символов"
          required
        />

        <div className="fieldlbl">Ещё раз</div>
        <input
          className="field"
          type="password"
          autoComplete="new-password"
          value={repeat}
          onChange={(e) => setRepeat(e.target.value)}
          required
        />

        <button className="btn primary big login-submit" type="submit" disabled={busy}>
          {busy ? 'Сохраняю…' : 'Сохранить и войти'}
        </button>

        {error && <p className="login-err">{error}</p>}
      </form>
    </div>
  );
}
