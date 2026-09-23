import { useState, type FormEvent } from 'react';
import { CatLine } from '@/lib/cat';
import { OFFLINE, failText, json, send } from '@/lib/http';

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
  // Своё «занято» у ссылки: пока она уходит, вход не притворяется, что проверяет пароль.
  const [sending, setSending] = useState(false);

  const askReset = async () => {
    if (email.trim() === '') {
      setError('Сначала впишите почту — на неё придёт ссылка');
      return;
    }
    setSending(true);
    setError('');
    // На отказ (429 «попробуйте через час», сбой сервера) — его причина, а не
    // «письмо отправлено»: иначе она ждала бы письмо, которого не будет.
    const r = await send('/api/auth/forgot', json('POST', { email }), 'Не удалось отправить ссылку');
    setSending(false);
    if (r.ok) setSent(true);
    else setError(r.message);
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/auth/login', json('POST', { email, password }));
      if (res.ok) {
        onSuccess();
        return;
      }
      // 5xx — сервер перезапускается, дело не в почте и пароле.
      setError(await failText(res, res.status >= 500 ? 'Сервер недоступен, попробуйте через минуту' : 'Не удалось войти'));
    } catch {
      setError(OFFLINE);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <CatLine className="login-cat" />
      <div className="login-mark" aria-hidden="true"><span></span></div>
      <p className="login-eyebrow">Psy3107</p>
      <h1 className="hello">Библиотека Кота</h1>
      <p className="lead">Войдите, чтобы продолжить.</p>

      <form className="panel" onSubmit={submit}>
        <div className="fieldlbl">Почта</div>
        <input
          className="field"
          type="email"
          autoComplete="username"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            // Почту поправили — ссылку можно запросить снова, уже на новый адрес.
            setSent(false);
          }}
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

        <button className="btn primary big login-submit" type="submit" disabled={busy}>
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
            <button className="btn" type="button" disabled={sending} onClick={() => void askReset()}>
              {sending ? 'Отправляю…' : 'Прислать ссылку на почту'}
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
