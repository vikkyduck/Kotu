#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Kotu — подключить почту, которая УЖЕ настроена у другого проекта на этом же
# сервере (по умолчанию — ящик hello@vi-utkina.ru из конфига Лунарио).
#
# Запуск:  ~/kotu/set-mail-shared.sh [путь к чужому .env] [адрес отправителя]
#
# Пароль приложения ни разу не выводится и не покидает сервер: он копируется
# там из одного .env в другой. Перед записью — резервная копия .env Kotu,
# после — перезапуск сервиса и настоящая SMTP-авторизация из нового конфига.
# Если Яндекс вход не примет, скрипт вернёт резервную копию сам.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SERVER="${SERVER_USER:-root}@${SERVER_HOST:-5.129.198.180}"
SRC="${1:-/opt/lunario-app/.env}"
FROM="${2:-hello@vi-utkina.ru}"

echo "Беру SMTP-настройки из $SRC, письма пойдут от $FROM"

# Timeweb иногда закрывает ssh на рукопожатии («Connection closed … port 22»).
# Удалённая часть идемпотентна (бэкап → запись → проверка → рестарт), поэтому
# при обрыве связи (код 255) просто пробуем ещё раз, до трёх попыток.
run_remote() {
  ssh -o ConnectTimeout=45 -o ServerAliveInterval=10 "$SERVER" "SRC='$SRC' FROM='$FROM' bash -s" <<'REMOTE'
set -euo pipefail
cd /opt/kotu
BAK=".env.bak-$(date +%Y%m%d-%H%M%S)"
cp -p .env "$BAK"

python3 - "$SRC" "$FROM" <<'PY'
import re, sys
src_path, frm = sys.argv[1], sys.argv[2]
src = dict(re.findall(r'^([A-Z_]+)=(.*)$', open(src_path).read(), re.M))
user, pw = src.get('SMTP_USER', '').strip(), src.get('SMTP_PASS', '').strip()
if not (user and pw):
    sys.exit(f"❌ В {src_path} нет SMTP_USER/SMTP_PASS. Ничего не изменено.")
new = {'SMTP_HOST': src.get('SMTP_HOST', 'smtp.yandex.ru').strip() or 'smtp.yandex.ru',
       'SMTP_PORT': src.get('SMTP_PORT', '465').strip() or '465',
       'SMTP_USER': user, 'SMTP_PASS': pw, 'MAIL_FROM': frm}
lines, out, seen = open('/opt/kotu/.env').read().splitlines(), [], set()
for l in lines:
    m = re.match(r'^([A-Z_]+)=', l)
    if m and m.group(1) in new:
        out.append(f"{m.group(1)}={new[m.group(1)]}"); seen.add(m.group(1))
    else:
        out.append(l)
for k, v in new.items():
    if k not in seen: out.append(f"{k}={v}")
# Запись в тот же файл: владелец и права остаются как были.
open('/opt/kotu/.env', 'w').write('\n'.join(out) + '\n')
print(f"   записано: логин {user}, отправитель {frm}, пароль {len(pw)} симв.")
PY

echo "   проверяю вход на SMTP из нового конфига…"
if python3 - <<'PY'
import re, smtplib, ssl, sys
d = dict(re.findall(r'^([A-Z_]+)=(.*)$', open('/opt/kotu/.env').read(), re.M))
try:
    s = smtplib.SMTP_SSL(d['SMTP_HOST'], int(d['SMTP_PORT']), timeout=20, context=ssl.create_default_context())
    s.login(d['SMTP_USER'], d['SMTP_PASS']); s.quit()
    print('   ✅ Яндекс принял вход для', d['SMTP_USER'])
except Exception as e:
    print('   ❌ SMTP отказал:', str(e)[:120]); sys.exit(1)
PY
then
  systemctl restart kotu
  sleep 3
  echo "   сервис kotu: $(systemctl is-active kotu)"
  echo "   ✅ Готово. Резервная копия прежнего конфига: /opt/kotu/$BAK"
else
  cp -p "$BAK" .env
  echo "   ↩ Конфиг возвращён из резервной копии, сервис не трогала."
  exit 1
fi
REMOTE
}

for attempt in 1 2 3; do
  run_remote && exit 0
  rc=$?
  # 255 — это обрыв самого ssh; любой другой код — настоящая ошибка на сервере,
  # её повторять нельзя (скрипт там уже сам откатил конфиг).
  [ "$rc" -eq 255 ] || exit "$rc"
  echo "   ssh оборвался на входе (попытка $attempt из 3), пробую снова через 5 с…"
  sleep 5
done
echo "❌ Сервер трижды закрыл ssh на входе. Ничего не изменено — повторите позже."
exit 255
