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

## Локальная маскировка персональных данных (2026-07-30)

Расшифровки больше не уходят за границу с настоящими именами (ARCHITECTURE.md §10, дефект 1).

- `/opt/privacy` — venv с **natasha**, `server.py` (FastAPI, `POST /ner` → спаны PER/LOC), systemd **kotu-privacy** на 127.0.0.1:9020
- `artifacts/api-server/src/lib/privacy.ts` — маскирует текст ДО отправки в модель (`[[PER1]]`, `[[LOC1]]`), после ответа подставляет настоящие имена локально. Карта соответствий живёт только в памяти процесса, в БД не пишется
- Если сервис NER недоступен — работает запасная эвристика (прячет слова с заглавной буквы в середине предложения). Открытым текстом имена не уходят никогда
- Удалён прежний `maskPersonalData`: он делал ВТОРОЙ запрос за границу с сырым текстом

## Очередь задач (2026-07-30)

Фоновая работа больше не гибнет при перезапуске сервера.

- Таблица `jobs` (kind, entity_id, payload, status, attempts, run_after, last_error). Выдача задач — `FOR UPDATE SKIP LOCKED`, без Redis и брокеров
- Воркер живёт в процессе api-server: при старте `requeueOrphans()` возвращает в очередь задачи, оборванные прошлым рестартом, дальше — цикл `claimNext → run → finish`
- Повторы: до 3 попыток, паузы 30 с и 120 с; после исчерпания запись помечается ошибкой с человеческой формулировкой
- Загруженное аудио теперь в `/opt/kotu/uploads` (переживает рестарт и чистку /tmp), удаляется после успеха или окончательного провала
- Грабли: сырой SQL в drizzle возвращает колонки как есть (`entity_id`), camelCase не появляется — поэтому claimNext берёт только id, а объект читается через query builder

## HTTPS и домен (2026-07-30)

- Платформа переехала на **https://psy3107.ru** (и www), сертификат Let's Encrypt до 28.10.2026, автопродление настроено certbot'ом
- nginx-сайт `psy3107`: статика + `/api` → 127.0.0.1:5010, редирект http → https, лимит загрузки 1 ГБ
- `PUBLIC_BASE_URL=https://psy3107.ru` в `/opt/kotu/.env` — от него зависит флаг `secure` у cookie сессии
- Старый адрес `http://5.129.198.180:8091` продолжает работать (оставлен как запасной вход)
- Грабля: `dig +short @сервер-реестра домен NS` НЕ показывает делегирование — записи приходят в секции AUTHORITY, короткий формат её не печатает. Проверять полным `dig` или через публичный резолвер

## Каналы к моделям (2026-07-30)

Транзит на дроплете стал многоканальным — через него доступны три поставщика:

| Путь на сервере (127.0.0.1:8444) | Куда идёт |
|---|---|
| `/v1/audio/*` | локальный Whisper — аудио не покидает РФ |
| `/v1/*` | OpenAI (обратная совместимость, так настроено приложение) |
| `/anthropic/*` | Claude — тексты лекций |
| `/gemini/*` | Gemini — длинные документы, картинки |
| `/perplexity/*` | Perplexity — поиск источников |

Ключи: `AI_INTEGRATIONS_OPENAI_API_KEY` (есть), `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` — вводятся
скриптом `./set-ai-key.sh` (вслепую, с живой проверкой). Правило двух зон не меняется:
в эти каналы уходит только текст без персональных данных.
