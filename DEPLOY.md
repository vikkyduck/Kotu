# Kotu — прод-топология (июль 2026)

- **Приложение**: Timeweb VDS `СТАРЫЙ`, порт **8091** (nginx: статика `/opt/kotu/public` + `/api` → systemd `kotu` на 127.0.0.1:5010). Секреты: `/opt/kotu/.env`.
- **Выкатка**: `./deploy.sh` (сборка локально, rsync артефактов, рестарт).
- **OpenAI**: api.openai.com блокирует РФ-IP, поэтому запросы идут через прокси на DigitalOcean-дроплете **vikky-ai-server** (`ТРАНЗИТ`, NYC1):
  - systemd `openai-proxy`, `/opt/openai-proxy/proxy.mjs` (node, без зависимостей), порт **8443**, TLS самоподписанный (`NODE_EXTRA_CA_CERTS=/opt/kotu/openai-proxy-ca.pem` в юните kotu);
  - принимает соединения только с IP Timeweb VDS (allowlist в коде + ufw);
  - в `.env`: `AI_INTEGRATIONS_OPENAI_BASE_URL=https://ТРАНЗИТ:8443/v1`.
- На том же дроплете живёт посторонний сервис `ai-agent` (порт 3000) — не трогать.
- БД: Postgres `kotu` на Timeweb VDS; миграции — drizzle push через ssh-туннель (см. deploy.sh).
