#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Kotu — создать пользователя или сменить пароль.
# Запуск:  ~/kotu/set-user.sh
#
# Пароль вводится вслепую и уходит на сервер через stdin по ssh. Там он
# превращается в scrypt-хеш и в открытом виде не сохраняется нигде:
# ни в истории команд, ни в списке процессов, ни в логах, ни в этом чате.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SERVER="${SERVER_USER:-root}@${SERVER_HOST:-5.129.198.180}"

read -rp "Почта (это будет логин): " EMAIL
read -rp "Имя: " NAME
printf "Пароль (не отображается): "
read -rs PASS
echo
printf "Пароль ещё раз: "
read -rs PASS2
echo

[ -n "$EMAIL" ]        || { echo "❌ Пустая почта. Ничего не изменено."; exit 1; }
[ "$PASS" = "$PASS2" ] || { echo "❌ Пароли не совпали. Ничего не изменено."; exit 1; }
[ ${#PASS} -ge 10 ]    || { echo "❌ Пароль короче 10 символов. Ничего не изменено."; exit 1; }

printf '%s' "$PASS" | ssh "$SERVER" "
  set -euo pipefail
  # scrypt из встроенного node:crypto; пароль читается со stdin и не попадает в argv.
  # Формат хеша повторён из artifacts/api-server/src/lib/auth.ts — менять вместе
  # (смена ломает и старые хеши)
  HASH=\$(node -e '
    const { randomBytes, scryptSync } = require(\"node:crypto\");
    let pw = \"\";
    process.stdin.on(\"data\", c => pw += c);
    process.stdin.on(\"end\", () => {
      const salt = randomBytes(16).toString(\"hex\");
      process.stdout.write(salt + \":\" + scryptSync(pw, salt, 64).toString(\"hex\"));
    });
  ')
  sudo -u postgres psql -d kotu -q \
    -v email=\"\$(echo '$EMAIL' | tr 'A-Z' 'a-z')\" \
    -v name=\"${NAME:-Кот}\" \
    -v hash=\"\$HASH\" <<'SQL'
INSERT INTO users (email, password_hash, name, role)
VALUES (:'email', :'hash', :'name', 'owner')
ON CONFLICT (email) DO UPDATE
  SET password_hash = EXCLUDED.password_hash, name = EXCLUDED.name;
DELETE FROM sessions;
SQL
  echo '   ✅ Пользователь сохранён. Прежние сессии сброшены.'
"
unset PASS PASS2
echo "Готово — войдите на сайте этой почтой и паролем."
