import { useState, type FormEvent } from 'react';

interface LoginProps {
  onSuccess: () => void;
}

export function Login({ onSuccess }: LoginProps) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [forgot, setForgot] = useState(false);
  const [sent, setSent] = useState(false);

  const askReset = async () => {
    if (email.trim() === '') {
      setError('Сначала впишите почту — на неё придёт ссылка');
      return;
    }
    setBusy(true);
    setError('');
    try {
      await fetch('/api/auth/forgot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      setSent(true);
    } catch {
      setError('Нет связи с сервером');
    } finally {
      setBusy(false);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      if (res.ok) {
        onSuccess();
        return;
      }
      const data = await res.json().catch(() => ({}));
      setError(data.message ?? 'Не удалось войти');
    } catch {
      setError('Нет связи с сервером. Попробуйте ещё раз.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <h1 className="hello" style={{ textAlign: 'center' }}>Рабочая среда</h1>
      <p className="lead" style={{ textAlign: 'center' }}>Войдите, чтобы продолжить.</p>

      <form className="panel" onSubmit={submit}>
        <div className="fieldlbl">Почта</div>
        <input
          className="field"
          type="email"
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="почта"
          required
        />

        <div className="fieldlbl">Пароль</div>
        <input
          className="field"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="пароль"
          required
        />

        <button className="btn primary big" type="submit" disabled={busy} style={{ marginTop: 20 }}>
          {busy ? 'Проверяю…' : 'Войти'}
        </button>

        {error && <p className="login-err">{error}</p>}

        {!forgot && !sent && (
          <button
            className="btn ghost forgot-link"
            type="button"
            onClick={() => setForgot(true)}
          >
            Забыли пароль?
          </button>
        )}

        {forgot && !sent && (
          <div className="forgot-box">
            <p>
              Впишите почту выше и нажмите — пришлю ссылку, по которой можно задать
              новый пароль.
            </p>
            <button className="btn" type="button" disabled={busy} onClick={() => void askReset()}>
              {busy ? 'Отправляю…' : 'Прислать ссылку на почту'}
            </button>
          </div>
        )}

        {sent && (
          <div className="forgot-box">
            <p>
              Если такая почта есть в системе, письмо уже отправлено. Проверьте входящие
              и папку «Спам» — ссылка действует один час.
            </p>
          </div>
        )}
      </form>

      <p className="login-note">Записи и расшифровки видны только вам.</p>
    </div>
  );
}
