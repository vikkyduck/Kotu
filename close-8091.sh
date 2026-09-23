#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Kotu — закрыть старый вход http://5.129.198.180:8091: оставить на порту
# только редирект на https://psy3107.ru.
#
# Запуск:  ~/kotu/close-8091.sh
#
# Зачем: по голому HTTP пароль, cookie сессии и расшифровки сеансов идут
# открытым текстом. Войти там и так нельзя — cookie помечена secure, на http
# браузер её не сохраняет, — так что рабочего входа редирект не отнимает.
# Перед записью — резервная копия конфига; если nginx -t не примет новый,
# скрипт вернёт старый сам и nginx не перезагрузит.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SERVER="${SERVER_USER:-root}@${SERVER_HOST:-5.129.198.180}"

# Удалённая часть идемпотентна (бэкап → запись → nginx -t → reload), поэтому
# при обрыве связи (код 255) просто пробуем ещё раз, до трёх попыток.
run_remote() {
  ssh -o ConnectTimeout=45 -o ServerAliveInterval=10 "$SERVER" bash -s <<'REMOTE'
set -euo pipefail
CONF=/etc/nginx/sites-available/kotu
BAK="/root/nginx-kotu.bak-$(date +%Y%m%d-%H%M%S)"
cp -a "$CONF" "$BAK"

cat > "$CONF" <<'EOF'
# Kotu — старый адрес http://5.129.198.180:8091.
# Платформа живёт на https://psy3107.ru (сайт psy3107). Здесь только редирект:
# по голому HTTP пароль, cookie сессии и расшифровки шли бы открытым текстом,
# а secure-cookie на http браузер всё равно не сохраняет — войти тут нельзя.
# Резервные копии прежнего конфига: /root/nginx-kotu.bak-*
server {
    listen 8091;
    listen [::]:8091;
    server_name _;
    return 301 https://psy3107.ru$request_uri;
}
EOF

if nginx -t 2>/dev/null; then
  systemctl reload nginx
  echo "   nginx перезагружен, резервная копия: $BAK"
else
  cp -a "$BAK" "$CONF"
  echo "❌ nginx -t не принял новый конфиг — вернула прежний, nginx не трогала"
  nginx -t || true
  exit 1
fi
REMOTE
}

for try in 1 2 3; do
  set +e; run_remote; code=$?; set -e
  [ "$code" -eq 0 ] && break
  if [ "$code" -ne 255 ] || [ "$try" -eq 3 ]; then exit "$code"; fi
  echo "   связь оборвалась, пробую ещё раз ($((try + 1))/3)…"; sleep 5
done

sleep 1
echo "==> Проверка"
old=$(curl -sS -o /dev/null -w '%{http_code} %{redirect_url}' "http://${SERVER_HOST:-5.129.198.180}:8091/api/healthz")
new=$(curl -sS https://psy3107.ru/api/healthz)
echo "   :8091           → $old"
echo "   psy3107.ru/api  → $new"
case "$old" in
  "301 https://psy3107.ru/api/healthz") echo "✅ Старый вход закрыт, платформа работает по https" ;;
  *) echo "⚠️  Редирект не тот, что ожидался — пришлите мне этот вывод"; exit 1 ;;
esac
