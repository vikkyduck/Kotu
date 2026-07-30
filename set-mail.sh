#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Kotu — подключить почту для писем о сбросе пароля.
# Запуск:  ~/kotu/set-mail.sh
#
# Нужен ПАРОЛЬ ПРИЛОЖЕНИЯ Яндекса, а не обычный пароль от ящика:
#   id.yandex.ru → Безопасность → Пароли приложений → Почта
#
# Пароль вводится вслепую и СНАЧАЛА проверяется настоящей SMTP-авторизацией.
# В конфигурацию он попадает только если Яндекс его принял: лучше отказать
# сразу, чем записать нерабочий и узнать об этом, когда пароль понадобится.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SERVER="${SERVER_USER:-root}@${SERVER_HOST:-5.129.198.180}"

read -rp "Адрес отправителя [vu@withoutwater.ru]: " FROM
FROM="${FROM:-vu@withoutwater.ru}"

printf "Пароль приложения Яндекса (не отображается): "
read -rs PASS
echo

[ ${#PASS} -ge 8 ] || { echo "❌ Слишком короткий — это точно пароль приложения? Ничего не изменено."; exit 1; }

echo "==> Проверяю авторизацию на smtp.yandex.ru"

printf '%s' "$PASS" | ssh "$SERVER" "
  set -uo pipefail
  PASS=\$(cat)
  FROM='$FROM'

  # Пробное письмо самому себе: единственный честный способ проверить,
  # что Яндекс примет эти логин и пароль.
  BODY=/tmp/mailcheck.\$\$
  {
    printf 'From: %s\r\n' \"\$FROM\"
    printf 'To: %s\r\n' \"\$FROM\"
    printf 'Subject: Проверка почты рабочей среды\r\n'
    printf 'Content-Type: text/plain; charset=utf-8\r\n'
    printf '\r\n'
    printf 'Если вы видите это письмо — отправка настроена верно.\r\n'
  } > \"\$BODY\"

  OUT=\$(curl -s --show-error --url 'smtps://smtp.yandex.ru:465' \
        --user \"\$FROM:\$PASS\" --mail-from \"\$FROM\" --mail-rcpt \"\$FROM\" \
        --upload-file \"\$BODY\" 2>&1)
  RC=\$?
  rm -f \"\$BODY\"

  if [ \$RC -ne 0 ]; then
    echo '   ❌ Яндекс не принял логин или пароль. Настройки НЕ сохранены.'
    echo \"      ответ сервера: \$(echo \"\$OUT\" | tail -1)\"
    echo ''
    echo '   Что проверить:'
    echo '      • это именно ПАРОЛЬ ПРИЛОЖЕНИЯ (id.yandex.ru → Безопасность →'
    echo '        Пароли приложений → Почта), а не обычный пароль от ящика;'
    echo \"      • \$FROM — это отдельный ящик, а не псевдоним другого адреса:\"
    echo '        для псевдонима логин SMTP должен быть основным ящиком;'
    echo '      • в Яндекс 360 у организации разрешён доступ по IMAP/SMTP.'
    exit 1
  fi

  ENV=/opt/kotu/.env
  set_var() {
    grep -v \"^\$1=\" \"\$ENV\" > \"\$ENV.tmp\" || true
    printf '%s=%s\n' \"\$1\" \"\$2\" >> \"\$ENV.tmp\"
    mv \"\$ENV.tmp\" \"\$ENV\"
  }
  set_var SMTP_HOST smtp.yandex.ru
  set_var SMTP_PORT 465
  set_var SMTP_USER \"\$FROM\"
  set_var SMTP_PASS \"\$PASS\"
  set_var MAIL_FROM \"\$FROM\"
  chmod 600 \"\$ENV\" && chown kotu:kotu \"\$ENV\"
  systemctl restart kotu

  echo '   ✅ Яндекс принял пароль, настройки сохранены.'
  echo \"      На \$FROM должно прийти пробное письмо «Проверка почты рабочей среды».\"
"
unset PASS
