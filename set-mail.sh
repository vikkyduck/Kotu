#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Kotu — подключить почту для писем о сбросе пароля.
# Запуск:  ~/kotu/set-mail.sh
#
# Нужен ПАРОЛЬ ПРИЛОЖЕНИЯ Яндекса, а не обычный пароль от ящика:
#   id.yandex.ru → Безопасность → Пароли приложений → Почта
# Обычный пароль Яндекс для SMTP не принимает.
#
# Пароль вводится вслепую, уходит на сервер через stdin, ложится в
# /opt/kotu/.env (права 600) и сразу проверяется живым письмом самому себе.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SERVER="${SERVER_USER:-root}@${SERVER_HOST:-5.129.198.180}"

read -rp "Адрес отправителя [vu@withoutwater.ru]: " FROM
FROM="${FROM:-vu@withoutwater.ru}"

printf "Пароль приложения Яндекса (не отображается): "
read -rs PASS
echo

[ ${#PASS} -ge 8 ] || { echo "❌ Слишком короткий — это точно пароль приложения? Ничего не изменено."; exit 1; }

printf '%s' "$PASS" | ssh "$SERVER" "
  set -euo pipefail
  PASS=\$(cat)
  ENV=/opt/kotu/.env
  set_var() {
    grep -v \"^\$1=\" \"\$ENV\" > \"\$ENV.tmp\" || true
    printf '%s=%s\n' \"\$1\" \"\$2\" >> \"\$ENV.tmp\"
    mv \"\$ENV.tmp\" \"\$ENV\"
  }
  set_var SMTP_HOST smtp.yandex.ru
  set_var SMTP_PORT 465
  set_var SMTP_USER '$FROM'
  set_var SMTP_PASS \"\$PASS\"
  set_var MAIL_FROM '$FROM'
  chmod 600 \"\$ENV\" && chown kotu:kotu \"\$ENV\"
  systemctl restart kotu
  sleep 3
  echo '   Отправляю пробное письмо самому себе…'
  curl -s -o /tmp/mailtest.json -w '   ответ сервера: %{http_code}\n' -m 60 \
    -X POST http://127.0.0.1:5010/api/auth/forgot \
    -H 'content-type: application/json' -d '{\"email\":\"__mail_selftest__\"}' || true
  rm -f /tmp/mailtest.json
  sleep 2
  if journalctl -u kotu --since '30 seconds ago' --no-pager | grep -qi 'почта не настроена'; then
    echo '   ❌ Сервис говорит, что почта не настроена'
  else
    echo '   ✅ Настройки записаны. Проверить по-настоящему: на экране входа'
    echo '      нажмите «Забыли пароль?» и введите свою почту.'
  fi
"
unset PASS
echo "Готово."
