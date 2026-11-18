#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Kotu — подключить отправку писем через Yandex Cloud Postbox.
# Запуск:  ~/kotu/set-mail-postbox.sh
#
# Нужен статический ключ доступа сервисного аккаунта с ролью postbox.sender
# (консоль Yandex Cloud → сервисный аккаунт → «Создать новый ключ» →
# «Создать статический ключ доступа»). Сервисный аккаунт и адрес Postbox
# (домен отправителя) должны быть в одном каталоге.
#
# Идентификатор ключа и секрет вводятся вслепую, уходят на сервер через stdin
# по ssh и кладутся в /opt/kotu/.env (права 600). В историю команд, список
# процессов и чат они не попадают. Затем сервер шлёт пробное письмо на адрес
# симулятора Postbox (success@simulator.pstbx.ru): так проверяются ключ, роль
# и подтверждение домена, а письмо никому не приходит.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

. "$(dirname "$0")/ops/server-address.sh"
SERVER=$(kotu_server) || exit 1
FROM_DEFAULT=noreply@example.ru

read -rp "Адрес отправителя [$FROM_DEFAULT]: " FROM
FROM=${FROM:-$FROM_DEFAULT}
printf "Идентификатор статического ключа (не отображается): "
read -rs KEY_ID
echo
printf "Секретный ключ (не отображается): "
read -rs SECRET
echo

[[ "$FROM" =~ ^[^@[:space:]\"]+@[^@[:space:]\"]+\.[^@[:space:]\"]+$ ]] || { echo "❌ «$FROM» не похоже на почтовый адрес. Ничего не изменено."; exit 1; }
[[ "$KEY_ID" =~ ^[A-Za-z0-9_-]{10,}$ ]] || { echo "❌ Идентификатор ключа не похож на настоящий. Ничего не изменено."; exit 1; }
[ ${#SECRET} -ge 20 ] || { echo "❌ Секрет слишком короткий - скопирован не целиком? Ничего не изменено."; exit 1; }
case "$SECRET" in *[[:space:]\"\\]*) echo "❌ В секрете пробел, кавычка или обратная косая черта - скопирован лишний символ? Ничего не изменено."; exit 1 ;; esac

# read -d '' вместо $(cat <<...): bash 3.2 на Mac путается в case внутри $( ).
IFS= read -r -d '' REMOTE <<'R' || true
set -euo pipefail
umask 077
IFS= read -r KEY_ID
IFS= read -r SECRET
IFS= read -r FROM

ENV=/opt/kotu/.env
set_var() {
  grep -v "^$1=" "$ENV" > "$ENV.tmp" || true
  printf '%s=%s\n' "$1" "$2" >> "$ENV.tmp"
  mv "$ENV.tmp" "$ENV"
}
set_var POSTBOX_KEY_ID "$KEY_ID"
set_var POSTBOX_SECRET_KEY "$SECRET"
set_var MAIL_FROM "$FROM"
chmod 600 "$ENV" && chown kotu:kotu "$ENV"
echo "   Ключ сохранён в $ENV, отправитель $FROM"

echo "   Проверяю: пробное письмо на адрес симулятора Postbox..."
BODY=$(mktemp); CFG=$(mktemp); REPLY=$(mktemp)
printf '{"FromEmailAddress":"%s","Destination":{"ToAddresses":["success@simulator.pstbx.ru"]},"Content":{"Simple":{"Subject":{"Data":"Проверка почты платформы","Charset":"UTF-8"},"Body":{"Text":{"Data":"Проверка ключа Postbox.","Charset":"UTF-8"}}}}}' "$FROM" > "$BODY"
# Ключ - в файл настроек curl, не в командную строку: её видят все процессы.
printf 'user = "%s:%s"\n' "$KEY_ID" "$SECRET" > "$CFG"
unset SECRET
CODE=$(curl -s -o "$REPLY" -w '%{http_code}' -m 30 -K "$CFG" \
  --aws-sigv4 'aws:amz:ru-central1:ses' -H 'Content-Type: application/json' \
  --data-binary @"$BODY" https://postbox.cloud.yandex.net/v2/email/outbound-emails || echo 000)
rm -f "$CFG" "$BODY"
case "$CODE" in
  200) echo "   ✅ Postbox принял письмо - ключ, роль и домен в порядке" ;;
  403) echo "   ❌ Postbox не принял ключ (403): проверьте, что ключ статический, скопирован целиком и у сервисного аккаунта есть роль postbox.sender" ;;
  000) echo "   ⚠️  Нет ответа от Postbox - проверьте сеть сервера" ;;
  *)   echo "   ⚠️  Postbox ответил $CODE: $(head -c 300 "$REPLY")"
       echo "      Если речь о домене - подождите, пока Postbox подтвердит записи DKIM, и запустите скрипт снова" ;;
esac
rm -f "$REPLY"

systemctl restart kotu
echo "   Платформа перезапущена с новыми настройками почты"
R

printf '%s\n%s\n%s\n' "$KEY_ID" "$SECRET" "$FROM" | ssh "$SERVER" "$REMOTE"
unset KEY_ID SECRET
echo "Готово. Проверка по-настоящему: «Забыли пароль?» на сайте - письмо должно прийти в течение минуты."
