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

echo "==> [1/4] Typecheck + сборка фронта"
BASE_PATH=/ PORT=3000 NODE_ENV=production pnpm --filter @workspace/kot run build

echo "==> [2/4] Сборка API-сервера"
pnpm --filter @workspace/api-server run build

echo "==> [3/4] Заливка на $SERVER"
rsync -az --delete artifacts/kot/dist/public/ "$SERVER:/opt/kotu/public/"
rsync -az --delete artifacts/api-server/dist/ "$SERVER:/opt/kotu/server/"

echo "==> [4/4] Рестарт сервиса и проверка"
ssh "$SERVER" 'chown -R kotu:kotu /opt/kotu && systemctl restart kotu && sleep 2 && systemctl is-active kotu'
# Проверяем по настоящему адресу: старый :8091 теперь только редирект на него.
# --fail: ответ не-2xx (502 при упавшем API) обрывает скрипт, а не печатается как успех.
curl -sS --fail --retry 5 --retry-delay 2 --retry-all-errors "${PUBLIC_URL:-https://psy3107.ru}/api/healthz"; echo
echo "✅ Готово: ${PUBLIC_URL:-https://psy3107.ru}/"

# Миграция схемы БД (когда меняется lib/db/src/schema):
#   ssh -f -N -L 15432:localhost:5432 root@5.129.198.180
#   DATABASE_URL=postgres://kotu:<пароль из /opt/kotu/.env>@localhost:15432/kotu \
#     pnpm --filter @workspace/db run push
