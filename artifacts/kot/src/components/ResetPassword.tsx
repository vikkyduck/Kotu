import { useState, useEffect, type FormEvent } from 'react';
import { json, send } from '@/lib/http';

/** Сервер не ответил толком (перезапуск, обрыв сети) — спросим снова. */
const RETRY_MS = 2000;

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

  // «Ссылка не работает» — только по ответу сервера. Сбой связи ссылку не
  // портит: иначе она запросила бы новую и упёрлась в лимит писем.
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      try {
        const res = await fetch(`/api/auth/reset/check?token=${encodeURIComponent(token)}`);
        if (res.ok) {
          const data = (await res.json()) as { valid?: boolean };
          if (alive) setState(data.valid ? 'valid' : 'invalid');
          return;
        }
      } catch {
        /* спросим ещё раз */
      }
      if (alive) timer = setTimeout(() => void check(), RETRY_MS);
    };
    void check();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
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
    const r = await send('/api/auth/reset', json('POST', { token, password }), 'Не удалось задать пароль');
    setBusy(false);
    if (r.ok) setState('done');
    else setError(r.message);
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
