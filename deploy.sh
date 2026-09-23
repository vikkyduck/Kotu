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
# Схема БД: pnpm --filter @workspace/db run push через ssh-туннель (см. README-заметку ниже).
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")"

# pnpm стоит в ~/.local/bin, а этот каталог не прописан в профилях оболочки:
# из «голого» терминала скрипт падал на `pnpm: command not found`.
command -v pnpm >/dev/null || export PATH="$HOME/.local/bin:$HOME/Library/pnpm:$PATH"
command -v pnpm >/dev/null || { echo "❌ pnpm не найден (ищу в PATH, ~/.local/bin, ~/Library/pnpm)"; exit 1; }

SERVER="${SERVER_USER:-root}@${SERVER_HOST:-5.129.198.180}"

echo "==> [1/6] Typecheck + сборка фронта"
BASE_PATH=/ PORT=3000 NODE_ENV=production pnpm --filter @workspace/kot run build

echo "==> [2/6] Сборка API-сервера"
pnpm --filter @workspace/api-server run build

echo "==> [3/6] Снимок данных перед выкаткой"
# Ночной бэкап хранит файлы одним зеркалом (rsync --delete): удаление, сделанное
# ошибкой в новой версии, следующей ночью ушло бы и из бэкапа. Поэтому перед
# каждой выкаткой — отдельный снимок: дамп базы kotu и ЖЁСТКИЕ ссылки на файлы
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
# Прежняя версия кода — для отката, если новая не включит архив (шаг 6).
mkdir -p "$DIR/code"
for d in server public; do
  if [ -d "/opt/kotu/$d" ]; then cp -a "/opt/kotu/$d" "$DIR/code/$d"; fi
done

# Ротации нет: снимки не удаляются. Файлы в них — жёсткие ссылки (место почти
# не занимают), растут только дампы базы.
echo "$DIR"
REMOTE
)
echo "   снимок: $SNAP"
ssh "$SERVER" "sed 's/^/   /' '$SNAP/inventory.txt'"

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
bad=$(sudo -u postgres psql -d kotu -v ON_ERROR_STOP=1 -Atq -v u="$app_user" <<'SQL'
WITH need(t) AS (
  VALUES ('transcriptions'), ('folders'), ('documents'), ('decks'), ('deck_slides'),
         ('deck_images'), ('style_packs'), ('lectures'), ('lecture_sections'), ('lecture_sources')
), problems AS (
  SELECT 'public.' || n.t || coalesce(' (владелец ' || c.tableowner || ')', ' (таблицы нет)') AS what
    FROM need n LEFT JOIN pg_tables c ON c.schemaname = 'public' AND c.tablename = n.t
   WHERE c.tableowner IS DISTINCT FROM :'u'
  UNION ALL
  SELECT 'archive.' || c.relname || ' (владелец ' || pg_get_userbyid(c.relowner) || ')'
    FROM pg_class c JOIN pg_namespace s ON s.oid = c.relnamespace
   WHERE s.nspname = 'archive' AND c.relkind IN ('r', 'p', 'S')
     AND pg_get_userbyid(c.relowner) <> :'u'
  UNION ALL
  SELECT 'функция archive.' || p.proname || ' (владелец ' || pg_get_userbyid(p.proowner) || ')'
    FROM pg_proc p JOIN pg_namespace s ON s.oid = p.pronamespace
   WHERE s.nspname = 'archive' AND pg_get_userbyid(p.proowner) <> :'u'
)
SELECT what FROM problems
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'u' AND rolsuper)
UNION ALL
SELECT 'роли ' || :'u' || ' в базе нет'
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'u');
SQL
)
if [ -n "$bad" ]; then
  echo "❌ Архив на новой версии не включится: владелец этих объектов базы kotu — не $app_user" >&2
  printf '%s\n' "$bad" | sed 's/^/   /' >&2
  echo "   Новая версия НЕ залита, прод работает как раньше. Починить от postgres:" >&2
  echo "   ALTER TABLE <таблица> OWNER TO \"$app_user\"; (функция — ALTER FUNCTION archive.<имя>() OWNER TO …)" >&2
  exit 1
fi
echo "   владелец таблиц данных и архива: $app_user"
sudo -u postgres psql -d kotu -v ON_ERROR_STOP=1 -q \
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
# на месте. Архив включается на старте асинхронно, поэтому ждём до ~2 минут;
# "off" — сразу стоп: такая выкатка не принимается.
HEALTH_URL="${PUBLIC_URL:-https://psy3107.ru}/api/healthz"
ARCHIVE=""
for _ in $(seq 1 40); do
  HEALTH=$(curl -sS --fail --max-time 10 "$HEALTH_URL" 2>/dev/null || true)
  ARCHIVE=$(printf '%s' "$HEALTH" | sed -nE 's/.*"archive":"([a-z]+)".*/\1/p')
  [ "$ARCHIVE" = ok ] || [ "$ARCHIVE" = off ] && break
  sleep 3
done
echo "   $HEALTH"
if [ "$ARCHIVE" != ok ]; then
  echo "❌ Архив на сервере не включился (healthz: archive=${ARCHIVE:-нет ответа})."
  echo "   Новая версия УЖЕ работает, но без архива строк: она только на чтение — очередь задач"
  echo "   стоит, изменения и удаления через интерфейс отклоняются, архив она пробует включить"
  echo "   раз в минуту. Данные до выкатки — в снимке $SNAP (kotu.dump + файлы)."
  echo "   Причина: ssh $SERVER \"journalctl -u kotu -n 200 | grep -i архив\""
  echo "   Откат на прежнюю версию кода (она без архива и удаляет аудио после расшифровки —"
  echo "   только если работа нужна срочно, лучше починить причину):"
  echo "   ssh $SERVER 'rsync -a --delete $SNAP/code/server/ /opt/kotu/server/ && rsync -a --delete $SNAP/code/public/ /opt/kotu/public/ && chown -R kotu:kotu /opt/kotu/server /opt/kotu/public && systemctl restart kotu'"
  exit 1
fi

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

# Миграция схемы БД (когда меняется lib/db/src/schema):
#   ssh -f -N -L 15432:localhost:5432 root@5.129.198.180
#   DATABASE_URL=postgres://kotu:<пароль из /opt/kotu/.env>@localhost:15432/kotu \
#     pnpm --filter @workspace/db run push
