#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Kotu (Кот) — деплой на Timeweb VDS.
# Запуск с локальной машины:  ./deploy.sh
#
# Сборка локальная: фронт (vite) + API-бандл (esbuild, единый index.mjs).
# На сервер уезжают только артефакты:
#   /opt/kotu/public — статика фронта (nginx, сайт psy3107 → https://psy3107.ru)
#   /opt/kotu/server — бандл API (systemd-сервис kotu, 127.0.0.1:5010)
# Секреты живут в /opt/kotu/.env на сервере и НЕ трогаются деплоем.
# Схема БД деплоем не меняется — только вручную, см. комментарий в конце и
# DEPLOY.md («Миграция схемы»).
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")"

# pnpm стоит в ~/.local/bin, а этот каталог не прописан в профилях оболочки:
# из «голого» терминала скрипт падал на `pnpm: command not found`.
command -v pnpm >/dev/null || export PATH="$HOME/.local/bin:$HOME/Library/pnpm:$PATH"
command -v pnpm >/dev/null || { echo "❌ pnpm не найден (ищу в PATH, ~/.local/bin, ~/Library/pnpm)"; exit 1; }

SERVER="${SERVER_USER:-root}@${SERVER_HOST:-5.129.198.180}"

echo "==> [1/6] Проверка типов, тесты, сборка фронта"
pnpm run typecheck
pnpm test
NODE_ENV=production pnpm --filter @workspace/kot run build

echo "==> [2/6] Сборка API-сервера"
pnpm --filter @workspace/api-server run build

echo "==> [3/6] Снимок данных перед выкаткой"
# Ночной бэкап держит рабочие каталоги зеркалом (удалённое из них уходит и из
# бэкапа), а прежнее содержимое — в архиве файлов, но только то, что прошло
# через него: файл, удалённый ошибкой новой версии мимо archiveAndRemove,
# следующей ночью ушёл бы из зеркала без следа. Строки, испорченные мимо
# триггеров (drizzle push, ручной SQL), в archive.rows не попадут, а ночной
# дамп — раз в сутки. Поэтому перед каждой выкаткой — отдельный снимок,
# неподвижная точка «как было до»: дамп базы kotu и ЖЁСТКИЕ ссылки на файлы
# (место почти не занимают, а удалённый оригинал остаётся жить в снимке).
# Плюс опись «данных платформы» — число файлов и строк главных таблиц и
# архива; её же снимаем после рестарта и сравниваем. Не удался снимок — деплой
# не идёт дальше (set -e), прод не тронут. Снимки не удаляются никогда —
# решение владелицы 23.09.2026: система сама ничего не стирает.
SNAP=$(ssh "$SERVER" bash -s <<'REMOTE'
set -euo pipefail
umask 077
ROOT=/opt/backups/predeploy
DIR="$ROOT/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$DIR"

cat > "$DIR/inventory.sh" <<'INV'
set -euo pipefail
for d in library uploads decks archive; do
  n=0; [ -d "/opt/kotu/$d" ] && n=$(find "/opt/kotu/$d" -type f | wc -l)
  echo "файлы_$d $n"
done
cd /tmp
q() { sudo -u postgres psql -d kotu -v ON_ERROR_STOP=1 -Atc "$1"; }
# Тот же список таблиц — TABLES в ops/dump-counts.sh.
for t in transcriptions documents folders lectures decks users; do
  echo "строки_$t $(q "select count(*) from $t")"
done
# Таблиц архива до первой выкатки с ним нет — это ноль, а не сломанная опись.
for t in rows files; do
  n=0
  [ "$(q "select to_regclass('archive.$t') is not null")" = t ] && n=$(q "select count(*) from archive.$t")
  echo "архив_$t $n"
done
INV
bash "$DIR/inventory.sh" > "$DIR/inventory.txt"
# 4 каталога + 6 таблиц + 2 таблицы архива, и в каждой строке — число.
[ "$(wc -l < "$DIR/inventory.txt")" -eq 12 ] &&
  awk 'NF != 2 || $2 !~ /^[0-9]+$/ {bad=1} END {exit bad}' "$DIR/inventory.txt" ||
  { echo "опись неполная" >&2; exit 1; }

sudo -u postgres pg_dump -Fc kotu > "$DIR/kotu.dump.tmp"
mv "$DIR/kotu.dump.tmp" "$DIR/kotu.dump"
pg_restore --list "$DIR/kotu.dump" > /dev/null
for d in library uploads decks archive; do
  if [ -d "/opt/kotu/$d" ]; then cp -al "/opt/kotu/$d" "$DIR/$d"; fi
done
# Прежняя версия кода — для разбора, что именно работало до выкатки. Тоже
# жёсткими ссылками: rsync шага 5 (без --inplace) пишет каждый файл во
# временный и переименовывает поверх, так что старые версии в снимке не
# меняются, а место не удваивается. Откат — только по DEPLOY.md («Откат»).
mkdir -p "$DIR/code"
for d in server public; do
  if [ -d "/opt/kotu/$d" ]; then cp -al "/opt/kotu/$d" "$DIR/code/$d"; fi
done

# Ротации нет: снимки не удаляются. Файлы в них — жёсткие ссылки (место почти
# не занимают), растут только дампы базы.
echo "$DIR"
REMOTE
)
echo "   снимок: $SNAP"
ssh "$SERVER" "sed 's/^/   /' '$SNAP/inventory.txt'"
# Снимки, архив и бэкап только растут (ничего не удаляется) — место на диске
# надо видеть на каждой выкатке. Деплой при этом не останавливаем: без места
# встанет запись, а не данные пропадут, и решать, что делать, — владелице.
FREE_GB=$(ssh "$SERVER" "df -P -BG /opt | awk 'NR == 2 { sub(/G\$/, \"\", \$4); print \$4 }'" || true)
echo "   свободно на /opt: ${FREE_GB:-?} ГБ"
if ! [ "$FREE_GB" -ge 10 ] 2>/dev/null; then
  echo "⚠️  ВНИМАНИЕ: на /opt свободно меньше 10 ГБ (${FREE_GB:-не удалось узнать}). Архив, снимки и бэкап"
  echo "   ничего не удаляют сами — место кончится. Решите с владелицей, что вынести с сервера."
fi

echo "==> [4/6] Архив на сервере: схема базы, каталог, ночной бэкап"
# До заливки: новый бандл не должен оказаться на сервере без схемы архива,
# даже на случай внепланового рестарта. Схему archive создаёт postgres,
# владелец — пользователь приложения из DATABASE_URL: у приложения может не
# быть права CREATE на базу, а таблицы и триггеры архива оно ставит само на
# старте (lib/archive.ts). Пароль из DATABASE_URL не выводится: печатаем
# только имя пользователя.
ssh "$SERVER" bash -s <<'REMOTE'
set -euo pipefail
url=$(sed -nE 's/^[[:space:]]*(export[[:space:]]+)?DATABASE_URL=//p' /opt/kotu/.env | tail -n 1 | tr -d "\"'")
app_user=$(printf '%s' "$url" | sed -nE 's#^postgres(ql)?://([^:@/]+)(:[^@]*)?@.*#\2#p')
unset url
if ! printf '%s' "$app_user" | grep -Eq '^[A-Za-z_][A-Za-z0-9_]*$'; then
  echo "❌ Не смог определить пользователя базы из DATABASE_URL в /opt/kotu/.env — деплой остановлен" >&2
  exit 1
fi
cd /tmp
# Триггер на таблицу и CREATE OR REPLACE для таблиц и функций архива может
# выполнить только владелец. Чужая таблица — и ensureArchive упадёт уже на
# новой версии, после рестарта. Поэтому проверяем здесь, до заливки: список
# таблиц — ARCHIVED_TABLES в artifacts/api-server/src/lib/archive-sql.ts.
# Суперпользователю владелец не важен — он гасит ТОЛЬКО строки про чужого
# владельца. «Таблицы нет» и «роли нет» выводятся всегда: их не починит
# никакое право (проверку прогоняет тест deploy-owner-check.test.ts на PGlite).
bad=$(sudo -u postgres psql -d kotu -v ON_ERROR_STOP=1 -Atq -v u="$app_user" <<'SQL'
WITH need(t) AS (
  VALUES ('transcriptions'), ('folders'), ('documents'), ('decks'), ('deck_slides'),
         ('deck_images'), ('style_packs'), ('lectures'), ('lecture_sections'), ('lecture_sources')
), owners AS (
  SELECT 'public.' || n.t || ' (владелец ' || c.tableowner || ')' AS what
    FROM need n JOIN pg_tables c ON c.schemaname = 'public' AND c.tablename = n.t
   WHERE c.tableowner <> :'u'
  UNION ALL
  -- Последовательность bigserial меняет владельца вместе со своей таблицей
  -- (ALTER SEQUENCE для неё запрещён). Если таблица уже в списке —
  -- последовательность не выводим; если таблица своя, а последовательность
  -- чужая — подсказываем, как её перевести через таблицу.
  SELECT 'archive.' || c.relname || ' (владелец ' || pg_get_userbyid(c.relowner) || ')'
         || CASE WHEN t.relname IS NOT NULL
                 THEN ' — последовательность таблицы archive.' || t.relname
                      || ', владелец меняется только вместе с ней: ALTER TABLE archive.' || t.relname
                      || ' OWNER TO postgres; ALTER TABLE archive.' || t.relname || ' OWNER TO ' || quote_ident(:'u')
                 ELSE '' END
    FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
    LEFT JOIN pg_depend d ON d.classid = 'pg_class'::regclass AND d.objid = c.oid
                         AND d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a', 'i')
    LEFT JOIN pg_class t ON t.oid = d.refobjid
   WHERE s.nspname = 'archive' AND c.relkind IN ('r', 'p', 'S')
     AND pg_get_userbyid(c.relowner) <> :'u'
     AND NOT (c.relkind = 'S' AND t.relname IS NOT NULL AND pg_get_userbyid(t.relowner) <> :'u')
  UNION ALL
  SELECT 'функция archive.' || p.proname || ' (владелец ' || pg_get_userbyid(p.proowner) || ')'
    FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace
   WHERE s.nspname = 'archive' AND pg_get_userbyid(p.proowner) <> :'u'
)
SELECT what FROM owners
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'u' AND rolsuper)
UNION ALL
SELECT 'public.' || n.t || ' (таблицы нет)'
  FROM need n
 WHERE NOT EXISTS (SELECT 1 FROM pg_tables c WHERE c.schemaname = 'public' AND c.tablename = n.t)
UNION ALL
SELECT 'роли ' || :'u' || ' в базе нет'
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'u');
SQL
)
if [ -n "$bad" ]; then
  echo "❌ Архив на новой версии не включится — в базе kotu не так (пользователь приложения: $app_user):" >&2
  printf '%s\n' "$bad" | sed 's/^/   /' >&2
  echo "   Новая версия НЕ залита, прод работает как раньше. Починить от postgres (sudo -u postgres psql -d kotu):" >&2
  echo "   чужой владелец таблицы — ALTER TABLE <схема>.<таблица> OWNER TO \"$app_user\";" >&2
  echo "     (последовательности archive.*_seq переходят к нему вместе со своей таблицей)" >&2
  echo "   чужой владелец функции — ALTER FUNCTION archive.<имя>() OWNER TO \"$app_user\";" >&2
  echo "   таблицы нет — схема базы не применена (DEPLOY.md, «Миграция схемы»)." >&2
  echo "   роли нет — DATABASE_URL в /opt/kotu/.env указывает не на ту роль." >&2
  exit 1
fi
echo "   владелец таблиц данных и архива: $app_user"
# client_min_messages: «schema already exists» на каждом деплое — не ошибка.
sudo -u postgres psql -d kotu -v ON_ERROR_STOP=1 -q \
  -c "SET client_min_messages = warning" \
  -c "CREATE SCHEMA IF NOT EXISTS archive AUTHORIZATION \"$app_user\"" \
  -c "ALTER SCHEMA archive OWNER TO \"$app_user\""
echo "   схема archive: владелец $app_user"
mkdir -p /opt/kotu/archive
REMOTE
# Скрипт бэкапа — из репозитория, иначе на сервере жила бы его старая копия
# (с зеркалом без архива). Проверяем синтаксис до установки.
ssh "$SERVER" 'set -e; t=$(mktemp); cat > "$t"; bash -n "$t"; install -m 0711 -o root -g root "$t" /usr/local/bin/kotu-backup.sh; rm -f "$t"; echo "   /usr/local/bin/kotu-backup.sh обновлён"' < ops/kotu-backup.sh

echo "==> [5/6] Заливка на $SERVER"
rsync -az --delete artifacts/kot/dist/public/ "$SERVER:/opt/kotu/public/"
rsync -az --delete artifacts/api-server/dist/ "$SERVER:/opt/kotu/server/"

echo "==> [6/6] Рестарт сервиса и проверка"
ssh "$SERVER" 'chown -R kotu:kotu /opt/kotu && systemctl restart kotu && sleep 2 && systemctl is-active kotu'
# Проверяем по настоящему адресу: старый :8091 теперь только редирект на него.
# Сервис должен не просто отвечать, а доложить archive:"ok" — триггеры архива
# на месте. Архив включается на старте асинхронно одной попыткой
# (lib/archive-state.ts): pending — она ещё идёт, off — она упала, и тогда
# стоп: такая выкатка не принимается.
#
# Обычно ok приходит за секунды. Долго pending бывает при первом включении:
# снимок всех таблиц (INITIAL). Ожидание блокировки попытка не тянет —
# lock_timeout 20 с, и она падает в off; а один оператор база обрывает через
# 10 минут (statement_timeout, lib/archive-sql.ts), и это тоже off. Поэтому:
# ~2 минуты ждём молча, а если всё ещё pending — ещё до ~11 минут: законный
# снимок базы одной пользовательницы (дамп — десятки мегабайт) заведомо
# успевает, а зависший оператор к этому времени оборвёт сама база.
HEALTH_URL="${PUBLIC_URL:-https://psy3107.ru}/api/healthz"
ARCHIVE=""
poll_health() {
  for _ in $(seq 1 "$1"); do
    HEALTH=$(curl -sS --fail --max-time 10 "$HEALTH_URL" 2>/dev/null || true)
    ARCHIVE=$(printf '%s' "$HEALTH" | sed -nE 's/.*"archive":"([a-z]+)".*/\1/p')
    { [ "$ARCHIVE" = ok ] || [ "$ARCHIVE" = off ]; } && return 0
    sleep 3
  done
  return 0
}
poll_health 40
if [ "$ARCHIVE" = pending ]; then
  echo "   ⏳ архив ещё включается (healthz: archive=pending) — скорее всего, первый снимок всех"
  echo "      таблиц. Сервер пока только на чтение, очередь стоит. Жду ещё до ~11 минут…"
  poll_health 220
fi
echo "   $HEALTH"
# Никаких команд отката здесь нет намеренно: прежний код без архива удаляет
# аудио после расшифровки, чистит каталоги колод и пишет файлы на месте, то
# есть сам ведёт к потере данных. Откат — только по DEPLOY.md («Откат»).
JOURNAL="ssh $SERVER \"journalctl -u kotu -n 200 --no-pager | grep -i архив\""
# Сервис не ответил — причина может быть любой (стек падения при запуске и
# т. п.), поэтому журнал целиком, без фильтра по слову «архив».
JOURNAL_ALL="ssh $SERVER \"journalctl -u kotu -n 200 --no-pager\""
case "$ARCHIVE" in
  ok) ;;
  pending)
    # Попытка идёт дольше, чем может длиться законный снимок, — что-то не так,
    # но данные не меняются: сервер только на чтение. Сама она кончится:
    # станет ok или off (и тогда повтор раз в минуту).
    echo "⏳ Архив всё ещё включается спустя ~13 минут (healthz: archive=pending)."
    echo "   Сервер только на чтение, очередь стоит — данные не меняются. Ничего не откатывайте и не чистите."
    echo "   Проверять: curl -s $HEALTH_URL — ждём \"archive\":\"ok\"; \"off\" — пришлите этот вывод."
    echo "   Журнал: $JOURNAL  (строка «Архив включается дольше обычного» — попытка ещё идёт)"
    echo "   Сверку описи этот запуск не сделал. Когда станет ok — сверить вручную (меньше, чем было, — стоп):"
    echo "     ssh $SERVER \"bash $SNAP/inventory.sh | diff $SNAP/inventory.txt -\""
    exit 2
    ;;
  off)
    echo "❌ Архив на сервере не включился (healthz: archive=off)."
    echo "   Сервер работает только на чтение, очередь стоит — данные не меняются."
    echo "   Ничего не откатывайте и не чистите — пришлите этот вывод."
    echo "   Журнал: $JOURNAL"
    echo "   Данные до выкатки — в снимке $SNAP."
    exit 1
    ;;
  *)
    echo "❌ Сервис не ответил на $HEALTH_URL (или ответил без поля archive)."
    echo "   Ничего не откатывайте и не чистите — пришлите этот вывод."
    echo "   Журнал: $JOURNAL_ALL"
    echo "   Состояние: ssh $SERVER \"systemctl status kotu --no-pager\""
    echo "   Данные до выкатки — в снимке $SNAP."
    exit 1
    ;;
esac

# Сверка описи: стартовые сверки нового кода уже отработали (сервис отвечает).
# Меньше файлов или строк, чем в снимке (или опись не снялась вовсе), —
# повод остановиться и разобраться.
sleep 5
LOST=$(ssh "$SERVER" "SNAP='$SNAP' bash -s" <<'REMOTE'
export LC_ALL=C
if ! bash "$SNAP/inventory.sh" > "$SNAP/inventory-after.txt"; then
  echo "   опись после выкатки не снялась"; exit 0
fi
join -a1 -e НЕТ -o 0,1.2,2.2 <(sort "$SNAP/inventory.txt") <(sort "$SNAP/inventory-after.txt") |
  awk '$3 == "НЕТ" || $3 + 0 < $2 + 0 {print "   " $1 ": было " $2 ", стало " $3}'
REMOTE
)
if [ -n "$LOST" ]; then
  echo "⚠️  ПОСЛЕ ВЫКАТКИ ДАННЫХ СТАЛО МЕНЬШЕ:"; echo "$LOST"
  echo "   Всё прежнее — в снимке $SNAP (kotu.dump + файлы). Ничего не чистите, напишите мне."
  exit 1
fi
echo "   опись данных после выкатки: ничего не пропало"
echo "✅ Готово: ${PUBLIC_URL:-https://psy3107.ru}/"

# Миграция схемы БД (когда меняется lib/db/src/schema) — вручную, по DEPLOY.md:
#   0. Дамп ДО push: ./deploy.sh (снимок в /opt/backups/predeploy) или на сервере
#      sudo -u postgres pg_dump -Fc kotu > /opt/backups/predeploy/push-$(date +%Y%m%d-%H%M%S).dump
#      push может сделать DROP COLUMN или пересоздать таблицу — мимо архива строк.
#   1. ssh -f -N -L 15432:localhost:5432 root@5.129.198.180
#      DATABASE_URL=postgres://kotu:<пароль из /opt/kotu/.env>@localhost:15432/kotu \
#        pnpm --filter @workspace/db run push
#      Предлагает truncate — отказаться (TRUNCATE таблиц данных запрещён триггером).
#   2. СРАЗУ: ssh root@5.129.198.180 systemctl restart kotu — ensureArchive вернёт
#      триггеры пересозданным таблицам. До рестарта их правки не архивируются
#      (сам сервер заметит пропажу лишь при сверке, раз в 6 ч).
