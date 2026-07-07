#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Kotu (Кот) — деплой на Timeweb VDS.
# Запуск с локальной машины:  ./deploy.sh
#
# Сборка локальная: фронт (vite) + API-бандл (esbuild, единый index.mjs).
# На сервер уезжают только артефакты:
#   /opt/kotu/public — статика фронта (nginx, порт 8091)
#   /opt/kotu/server — бандл API (systemd-сервис kotu, 127.0.0.1:5010)
# Секреты живут в /opt/kotu/.env на сервере и НЕ трогаются деплоем.
# Схема БД: pnpm --filter @workspace/db run push через ssh-туннель (см. README-заметку ниже).
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")"

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
curl -sS "http://${SERVER_HOST:-5.129.198.180}:8091/api/healthz"; echo
echo "✅ Готово: http://${SERVER_HOST:-5.129.198.180}:8091/"

# Миграция схемы БД (когда меняется lib/db/src/schema):
#   ssh -f -N -L 15432:localhost:5432 root@5.129.198.180
#   DATABASE_URL=postgres://kotu:<пароль из /opt/kotu/.env>@localhost:15432/kotu \
#     pnpm --filter @workspace/db run push
