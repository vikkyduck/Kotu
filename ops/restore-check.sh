#!/usr/bin/env bash
# Репетиция восстановления: разворачивает свежий бэкап в отдельную базу,
# сверяет, что данные на месте, и убирает её за собой.
#
# Зачем: «бэкап есть» и «бэкап восстанавливается» — разные утверждения, и
# узнавать разницу в день аварии поздно. Скрипт ничего не трогает в рабочей
# базе: он создаёт временную kotu_restore_check и удаляет её в конце.
#
# Запуск с компьютера:  ssh root@5.129.198.180 bash -s < ~/kotu/ops/restore-check.sh
set -euo pipefail
DB_DIR=/opt/backups/db
TEST_DB=kotu_restore_check

DUMP=$(ls -1t "$DB_DIR"/kotu-*.dump 2>/dev/null | head -1 || true)
[ -n "$DUMP" ] || { echo "Дампов не найдено в $DB_DIR" >&2; exit 1; }
echo "==> Проверяю $(basename "$DUMP") от $(date -r "$DUMP" '+%d.%m %H:%M')"

# Каталог бэкапов закрыт от всех, кроме root, а разворачивает дамп postgres.
# Поэтому на время проверки делаем копию, читаемую только им.
TMP=/tmp/kotu-restore-check.dump
cleanup() {
  sudo -u postgres psql -qc "DROP DATABASE IF EXISTS $TEST_DB;" >/dev/null 2>&1 || true
  rm -f "$TMP"
}
trap cleanup EXIT

cleanup
install -o postgres -g postgres -m 600 "$DUMP" "$TMP"
sudo -u postgres psql -qc "CREATE DATABASE $TEST_DB;" >/dev/null
# Права и владельцы на чистой машине другие — эти ошибки не в счёт;
# важно, доехали ли данные.
sudo -u postgres pg_restore -d "$TEST_DB" --no-owner --no-privileges "$TMP" 2>&1 |
  grep -v "must be owner\|does not exist" || true

echo "==> Что восстановилось:"
sudo -u postgres psql -d "$TEST_DB" -tAc "
  SELECT '  ' || table_name || ': ' ||
         (xpath('/row/c/text()', query_to_xml('SELECT count(*) AS c FROM public.' ||
          quote_ident(table_name), false, true, '')))[1]::text || ' строк'
  FROM information_schema.tables
  WHERE table_schema='public' AND table_type='BASE TABLE'
  ORDER BY table_name;"

USERS=$(sudo -u postgres psql -d "$TEST_DB" -tAc "SELECT count(*) FROM users;")
[ "$USERS" -ge 1 ] || { echo "!!! В восстановленной базе нет пользователей" >&2; exit 1; }
echo "==> Восстановление работает: пользователей $USERS"
