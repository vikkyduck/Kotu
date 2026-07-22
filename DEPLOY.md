# Kotu — прод-топология (июль 2026)

- **Приложение**: Timeweb VDS `5.129.198.180`, порт **8091** (nginx: статика `/opt/kotu/public` + `/api` → systemd `kotu` на 127.0.0.1:5010). Секреты: `/opt/kotu/.env`.
- **Выкатка**: `./deploy.sh` (сборка локально, rsync артефактов, рестарт).
- **OpenAI**: api.openai.com блокирует РФ-IP, поэтому запросы идут через прокси на DigitalOcean-дроплете **vikky-ai-server** (`206.189.181.64`, NYC1):
  - systemd `openai-proxy`, `/opt/openai-proxy/proxy.mjs` (node, без зависимостей), порт **8443**, TLS самоподписанный (`NODE_EXTRA_CA_CERTS=/opt/kotu/openai-proxy-ca.pem` в юните kotu);
  - принимает соединения только с IP Timeweb VDS (allowlist в коде + ufw);
  - в `.env`: `AI_INTEGRATIONS_OPENAI_BASE_URL=https://206.189.181.64:8443/v1`.
- На том же дроплете живёт посторонний сервис `ai-agent` (порт 3000) — не трогать.
- БД: Postgres `kotu` на Timeweb VDS; миграции — drizzle push через ssh-туннель (см. deploy.sh).

## Локальный Whisper (2026-07-22)

Транскрибация переведена с облачного `gpt-4o-transcribe` на **локальный openai/whisper** на самом Timeweb VDS:

- `/opt/whisper` — venv (torch CPU), пакет `openai-whisper` с GitHub, `server.py` (FastAPI, OpenAI-совместимый `POST /v1/audio/transcriptions`), кэш модели в `/opt/whisper/cache`
- systemd **kotu-whisper** — uvicorn на 127.0.0.1:9010, модель из env `WHISPER_MODEL` (сейчас `base`), язык `ru`, MemoryMax=1400M (на VDS всего 2 ГБ + 2 ГБ своп)
- nginx **kotu-ai-router** (127.0.0.1:8444): `/v1/audio/*` → Whisper (таймаут 30 мин), остальные `/v1/*` (chat-структурирование) → по-прежнему OpenAI через DO-прокси
- `/opt/kotu/.env`: `AI_INTEGRATIONS_OPENAI_BASE_URL=http://127.0.0.1:8444/v1`

**Вернуться на облачную транскрибацию**: `AI_INTEGRATIONS_OPENAI_BASE_URL=https://206.189.181.64:8443/v1` + `systemctl restart kotu`.
**Качество/скорость**: base ≈ 0.5× длительности записи на этом CPU; точность ниже gpt-4o-transcribe. Модель покрупнее (`small`) в 2 ГБ RAM не влезает — нужен апгрейд тарифа.

## Апгрейд: faster-whisper large-v3-turbo (2026-07-22, вечер)

- Тариф VDS поднят до 8 CPU / 12 ГБ RAM / 100 ГБ NVMe (2900 ₽/мес, оплачен год)
- Движок заменён на **faster-whisper** (CTranslate2 int8) с моделью **large-v3-turbo** в БАТЧЕВОМ режиме (`BatchedInferencePipeline`, batch=8) — на QEMU-vCPU этой ноды батчинг даёт 4–5x против последовательного декодера (RTF 0.20 против ~1.0)
- Замер end-to-end через Кота: запись 63 мин → **15 мин 11 сек** (вкл. gpt-оформление); полтора часа ≈ 21–22 мин
- env сервиса: `WHISPER_MODEL=large-v3-turbo`, `WHISPER_BATCH=8`, `HF_HOME=/opt/whisper/cache` (модель с Hugging Face), MemoryMax=8G
- Прежний вариант (openai/whisper base) больше не используется; venv общий
