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

echo "==> [1/5] Typecheck + сборка фронта"
BASE_PATH=/ PORT=3000 NODE_ENV=production pnpm --filter @workspace/kot run build

echo "==> [2/5] Сборка API-сервера"
pnpm --filter @workspace/api-server run build

echo "==> [3/5] Снимок данных перед выкаткой"
# Ночной бэкап хранит файлы одним зеркалом (rsync --delete): удаление, сделанное
# ошибкой в новой версии, следующей ночью ушло бы и из бэкапа. Поэтому перед
# каждой выкаткой — отдельный снимок: дамп базы kotu и ЖЁСТКИЕ ссылки на файлы
# (место почти не занимают, а удалённый оригинал остаётся жить в снимке).
# Плюс опись «данных платформы» — число файлов и строк главных таблиц; её же
# снимаем после рестарта и сравниваем. Не удался снимок — деплой не идёт
# дальше (set -e), прод не тронут.
SNAP=$(ssh "$SERVER" bash -s <<'REMOTE'
set -euo pipefail
umask 077
ROOT=/opt/backups/predeploy
DIR="$ROOT/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$DIR"

cat > "$DIR/inventory.sh" <<'INV'
set -euo pipefail
for d in library uploads decks; do
  n=0; [ -d "/opt/kotu/$d" ] && n=$(find "/opt/kotu/$d" -type f | wc -l)
  echo "файлы_$d $n"
done
cd /tmp
for t in transcriptions documents folders lectures decks users; do
  echo "строки_$t $(sudo -u postgres psql -d kotu -Atc "select count(*) from $t")"
done
INV
bash "$DIR/inventory.sh" > "$DIR/inventory.txt"
[ "$(wc -l < "$DIR/inventory.txt")" -eq 9 ] || { echo "опись неполная" >&2; exit 1; }

sudo -u postgres pg_dump -Fc kotu > "$DIR/kotu.dump.tmp"
mv "$DIR/kotu.dump.tmp" "$DIR/kotu.dump"
pg_restore --list "$DIR/kotu.dump" > /dev/null
for d in library uploads decks; do
  if [ -d "/opt/kotu/$d" ]; then cp -al "/opt/kotu/$d" "$DIR/$d"; fi
done

# Храним десять последних снимков: это копии-ссылки, оригиналы не трогаются.
ls -1d "$ROOT"/2* | head -n -10 | xargs -r rm -rf
echo "$DIR"
REMOTE
)
echo "   снимок: $SNAP"
ssh "$SERVER" "sed 's/^/   /' '$SNAP/inventory.txt'"

echo "==> [4/5] Заливка на $SERVER"
rsync -az --delete artifacts/kot/dist/public/ "$SERVER:/opt/kotu/public/"
rsync -az --delete artifacts/api-server/dist/ "$SERVER:/opt/kotu/server/"

echo "==> [5/5] Рестарт сервиса и проверка"
ssh "$SERVER" 'chown -R kotu:kotu /opt/kotu && systemctl restart kotu && sleep 2 && systemctl is-active kotu'
# Проверяем по настоящему адресу: старый :8091 теперь только редирект на него.
# --fail: ответ не-2xx (502 при упавшем API) обрывает скрипт, а не печатается как успех.
curl -sS --fail --retry 5 --retry-delay 2 --retry-all-errors "${PUBLIC_URL:-https://psy3107.ru}/api/healthz"; echo

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
