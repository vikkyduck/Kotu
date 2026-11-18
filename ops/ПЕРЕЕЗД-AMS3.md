# Переезд платформы на сервер агента ПСИ (DigitalOcean AMS3)

Решение владелицы от 18 ноября 2026: платформа psy3107.ru переезжает со старого сервера в Москве
на сервер агента ПСИ в Амстердаме и работает по подписке Codex через мост агента. Работа из России
без ВПН больше не требуется.

Итог плана: 8 шагов, из них 2 с простоем. Бот стоит 5-10 минут на шаге 1, когда сервер
увеличивается. Сайт не принимает правки на шаге 6, пока копируется последняя разница данных
и меняется DNS. Старый сервер до приемки не трогаем и ничего на нем не удаляем: на нем живут
и другие проекты (в ночном дампе есть их базы).

Адресов в этом файле нет: репозиторий публичный. Старый и новый адреса - в ваших заметках,
новый - еще и в `ops/server.local` (строка `SERVER_HOST=...`, в git не попадает). Ниже они
обозначены `СТАРЫЙ` и `НОВЫЙ`.

## Как выполнять

Все команды запускаются с вашего Mac: на нем ключи SSH и копия бэкапа `~/kotu-backups`.
Удобнее всего открыть Claude Code на Mac в папке `~/kotu` и попросить выполнять этот файл по
шагам, показывая вывод. После каждого шага есть проверка. Если проверка не прошла, дальше не
идем.

## Что должно быть готово до начала

1. Влиты в main и не выложены на старый сервер:
   - vikkyduck/Kotu - перевод моделей на Codex, MCP, уведомления, защита выкладки
   - vikkyduck/psy - мост `psy-platform-bridge`
   Правило владелицы: на сервер уходит только влитое в main. `deploy.sh` сам откажет иначе.
2. Доступ SSH с Mac к обоим серверам.
3. Доступ к DNS домена psy3107.ru у регистратора.
4. В ChatGPT выключен переключатель "Improve the model for everyone" (Настройки, Управление
   данными), если данные платформы не должны идти на обучение моделей.

## Шаг 0. Замеры, только чтение

Размер данных и память на старом сервере:

```bash
ssh root@СТАРЫЙ 'df -h /; du -sh /opt/kotu/library /opt/kotu/uploads /opt/kotu/decks /opt/kotu/archive /opt/backups; sudo -u postgres psql -Atc "select pg_size_pretty(pg_database_size(current_database()))" kotu; nproc; free -h; systemctl show -p MemoryCurrent kotu kotu-whisper kotu-privacy kotu-embed postgresql'
```

Свободные порты и состояние бота на новом:

```bash
ssh root@НОВЫЙ 'nproc; free -h; df -h /; systemctl is-active hermes-gateway psy-upload psy-upload-worker psy-asr; ss -ltnp | grep -E ":(80|443|5010|5011|5432|8444|9010|9020|9030|9443)\b"; ufw status | head -5'
```

Проверка: на новом сервере порты 443, 5010, 5011, 5432, 8444, 9010, 9020 и 9030 свободны.
Порт 80 занят только во время продления сертификата бота (шаг 3 это меняет). Если что-то
занято постоянно - остановиться и разобраться.

Код трех локальных сервисов платформы (Whisper, скрытие имен, векторы) в репозитории не лежит,
а в ночной копии есть только настройки. Забрать код и список пакетов:

```bash
mkdir -p ~/kotu/ops/services && ssh root@СТАРЫЙ 'cd /opt && tar czf - --exclude="*/venv" --exclude="*/.venv" --exclude="*/cache" --exclude="*/__pycache__" whisper privacy embed 2>/dev/null; true' > ~/kotu/ops/services/opt-services.tgz && tar tzf ~/kotu/ops/services/opt-services.tgz
```

```bash
ssh root@СТАРЫЙ 'for s in whisper privacy embed; do echo "== $s"; ls /opt/$s; for v in venv .venv; do [ -x /opt/$s/$v/bin/pip ] && /opt/$s/$v/bin/pip freeze; done; done; systemctl cat kotu-whisper kotu-privacy kotu-embed kotu; cat /etc/nginx/sites-available/kotu-ai-router; node --version; which node'
```

Проверка: в архиве есть `server.py` каждого сервиса. Если каталог называется иначе, чем
`whisper`, `privacy`, `embed`, - поправить имена по выводу второй команды. Код сервисов и
список пакетов стоит сразу закоммитить в `ops/services` отдельной веткой: тогда сервер впервые
целиком воспроизводится из репозитория.

## Шаг 1. Увеличить сервер ПСИ

В панели DigitalOcean: Droplet `psy-agent-ams3`, Resize. Нужно не меньше 8 vCPU и 16 ГБ памяти:
платформа сейчас работает на 8 vCPU и 12 ГБ, бот - на 1 CPU и 2 ГБ. Если замер шага 0 показал
что Whisper и векторы вместе занимают больше 8 ГБ, берите 32 ГБ. Диск увеличить вместе с
процессором и памятью: архив платформы только растет. Увеличение диска в DigitalOcean
необратимо, уменьшить сервер потом нельзя. Цену покажет панель при выборе размера, по
сторонним агрегаторам Basic 8 vCPU и 16 ГБ стоит около 96-104 долларов в месяц.

Сервер на время увеличения выключается, бот не отвечает 5-10 минут. Лучше делать ночью.

Проверка после включения:

```bash
ssh root@НОВЫЙ 'nproc; free -h; df -h /; systemctl is-active hermes-gateway psy-upload psy-upload-worker psy-asr'
```

Все 4 службы `active`, процессоров и памяти столько, сколько выбрали.

## Шаг 2. Пакеты, пользователь и база на новом сервере

```bash
ssh root@НОВЫЙ 'set -e
apt-get update
apt-get install -y nginx postgresql-16 postgresql-16-pgvector ffmpeg rsync
id kotu >/dev/null 2>&1 || useradd --system --home-dir /opt/kotu --shell /usr/sbin/nologin kotu
install -d -o kotu -g kotu -m 750 /opt/kotu /opt/kotu/server /opt/kotu/public /opt/kotu/uploads /opt/kotu/library /opt/kotu/decks /opt/kotu/archive
install -d -m 700 /opt/backups'
```

Node ставится той же версии, что на старом сервере (вывод шага 0). Пример для Node 22 из
пакетов NodeSource:

```bash
ssh root@НОВЫЙ 'curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs && node --version'
```

Три сервиса Python: распаковать код из шага 0, создать окружения по списку пакетов и
поставить unit-файлы со старого сервера (они в `config-ДАТА.tar.gz` ночной копии). Модели
Whisper large-v3-turbo и multilingual-e5-large скачаются при первом старте сервисов, если в
unit-файлах тот же `HF_HOME`. Проверка:

```bash
ssh root@НОВЫЙ 'systemctl is-active kotu-whisper kotu-privacy kotu-embed; curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:9010/docs; curl -s -X POST -H "content-type: application/json" -d "{\"text\":\"Анна живет в Москве\"}" http://127.0.0.1:9020/ner | head -c 300; echo'
```

Маршрутизатор nginx `kotu-ai-router` переносится только с одним маршрутом: `/v1/audio/` в
Whisper на 127.0.0.1:9010. Маршруты в транзит DigitalOcean больше не нужны.

## Шаг 3. Порт 80 общий: сертификат бота через nginx

Бот продлевает короткий сертификат Mini App раз в несколько дней и для этого сам открывает
порт 80 (`certbot --standalone`). Когда на сервере есть nginx, порт 80 занят, и продление
сломается. Поэтому продление переводится на общий каталог, который отдает nginx:

```bash
ssh root@НОВЫЙ 'set -e
install -d -m 755 /var/www/acme
cat > /etc/nginx/sites-available/acme <<"NGINX"
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    location /.well-known/acme-challenge/ { root /var/www/acme; }
    location / { return 301 https://psy3107.ru$request_uri; }
}
NGINX
ln -sf /etc/nginx/sites-available/acme /etc/nginx/sites-enabled/acme
rm -f /etc/nginx/sites-enabled/default
nginx -t && systemctl reload nginx'
```

Затем выпустить сертификат бота заново тем же именем, но через каталог. Адрес - тот же IP,
что в `PSY_PUBLIC_URL`:

```bash
ssh root@НОВЫЙ '/opt/psy-upload-venv/bin/certbot certonly --webroot -w /var/www/acme --cert-name psy-upload-ip --preferred-profile shortlived --ip-address НОВЫЙ --deploy-hook /usr/local/libexec/psy-upload-deploy-cert --non-interactive && /opt/psy-upload-venv/bin/certbot renew --cert-name psy-upload-ip --dry-run'
```

Проверка: `--dry-run` завершился без ошибок, Mini App "Записи" в Telegram открывается. Таймер
`psy-upload-cert-renew` менять не нужно: certbot помнит способ продления в своей настройке.

## Шаг 4. Мост ПСИ и группа доступа

Из влитого main репозитория psy, по `ops/README.md` (раздел о мосте платформы):

Порядок и команды обновления живого экземпляра - в `ops/README.md` репозитория psy. Коротко:
проверенный релиз в `/opt/psy-source`, установка изменений в Hermes от владельца checkout,
установщик моста, включение сокета, перезапуск шлюза в спокойное время:

```bash
ssh root@НОВЫЙ 'set -e
cd /opt/psy-source && git pull --ff-only
sudo -u hermes -H python3 gateway/apply.py apply /home/hermes/.hermes/hermes-agent
sudo -u hermes -H python3 gateway/apply.py verify /home/hermes/.hermes/hermes-agent
bash ops/install-platform-bridge
systemctl enable --now psy-platform-bridge.socket
systemctl restart hermes-gateway'
```

Проверка от имени пользователя платформы:

```bash
ssh root@НОВЫЙ 'id kotu; sudo -u kotu curl -s --unix-socket /run/psy-platform-bridge.sock "http://bridge/health?deep=1"; echo'
```

Ответ `{"ok": true, "codex": "ready"}`, а в `id kotu` есть группа `psy-platform`.

## Шаг 5. Пробный запуск с копией данных, сайт еще на старом сервере

1. Свежая копия на Mac: `./ops/pull-backup.sh`.
2. `.env`: взять из `config-ДАТА.tar.gz` ночной копии, положить в `/opt/kotu/.env` (владелец
   kotu, права 600) и привести к новому образцу `.env.example`:
   - удалить `ANTHROPIC_*`, `GEMINI_*`, `PERPLEXITY_*`, `IMAGE_FALLBACK_*`
   - `AI_INTEGRATIONS_OPENAI_BASE_URL=https://api.openai.com/v1`
   - `WHISPER_BASE_URL=http://127.0.0.1:8444/v1`
   - добавить `CODEX_BRIDGE_SOCKET`, `MODEL_*` и `MODEL_ON_LIMIT` из образца
3. База. Роль kotu получает тот же пароль, что в `DATABASE_URL` из `.env`:

```bash
scp ~/kotu-backups/db/kotu-$(ls ~/kotu-backups/db | sed -n 's/^kotu-\(.*\)\.dump$/\1/p' | sort | tail -n 1).dump root@НОВЫЙ:/opt/backups/kotu-latest.dump
ssh root@НОВЫЙ 'set -e
pw=$(sed -n "s#^DATABASE_URL=postgres://kotu:\([^@]*\)@.*#\1#p" /opt/kotu/.env)
sudo -u postgres psql -Atc "select 1 from pg_roles where rolname = '"'"'kotu'"'"'" | grep -q 1 || sudo -u postgres createuser kotu
printf "ALTER ROLE kotu LOGIN PASSWORD '"'"'%s'"'"';\n" "$(printf %s "$pw" | sed "s/'"'"'/'"'"''"'"'/g")" | sudo -u postgres psql -q
unset pw
sudo -u postgres createdb -O kotu kotu
sudo -u postgres psql -d kotu -c "create extension if not exists vector"
sudo -u postgres pg_restore -d kotu --no-owner --role=kotu /opt/backups/kotu-latest.dump'
```

   Владельцы таблиц и схемы `archive` - как в `ops/ВОССТАНОВЛЕНИЕ.md`, шаг 4: приложение
   должно владеть своими таблицами, иначе архив не включится.
4. Файлы, архив делит с рабочими каталогами одну копию (`-H`):

```bash
rsync -aH --info=progress2 ~/kotu-backups/data/ root@НОВЫЙ:/opt/kotu/ && ssh root@НОВЫЙ 'chown -R kotu:kotu /opt/kotu'
```

5. Токен MCP для агента: сам токен кладется в профиль агента, в платформу - только его хеш.
   Номер пользователя - ваш `id` в таблице `users`.

```bash
ssh root@НОВЫЙ 'set -e
t=$(openssl rand -hex 32)
grep -q "^KOTU_MCP_TOKEN=" /home/hermes/.hermes/.env || printf "KOTU_MCP_TOKEN=%s\n" "$t" >> /home/hermes/.hermes/.env
t=$(sed -n "s/^KOTU_MCP_TOKEN=//p" /home/hermes/.hermes/.env | tail -n 1)
grep -q "^AGENT_MCP_TOKEN_SHA256=." /opt/kotu/.env || printf "AGENT_MCP_TOKEN_SHA256=%s\n" "$(printf %s "$t" | sha256sum | cut -d" " -f1)" >> /opt/kotu/.env
unset t
sudo -u postgres psql -d kotu -Atc "select id, email from users order by id"'
```

   Затем в `/opt/kotu/.env` строка `AGENT_MCP_USER_ID=<ваш id>`, а в `config.yaml` профиля
   агента - сервер `kotu` по `ops/README.md` репозитория psy.
6. Unit `kotu.service` со старого сервера (из `config-ДАТА.tar.gz`). Если в нем
   `NODE_EXTRA_CA_CERTS` для транзита - строку удалить.
7. Выложить main: `./deploy.sh` (адрес берется из `ops/server.local`).
8. Сайт nginx `psy3107` из `config-ДАТА.tar.gz` и сертификат psy3107.ru со старого сервера:
   до смены DNS новый сертификат на новом сервере не выпустить, а старый действует до
   27 декабря 2026. Блок `server` на порту 80 из старого сайта убрать: порт 80 обслуживает
   общий сайт `acme` из шага 3. Если на сервере включен ufw, открыть 443: `ufw allow 443/tcp`.

```bash
ssh root@СТАРЫЙ 'tar czf - -C / etc/letsencrypt/live/psy3107.ru etc/letsencrypt/archive/psy3107.ru etc/letsencrypt/renewal/psy3107.ru.conf' | ssh root@НОВЫЙ 'tar xzf - -C / && nginx -t && systemctl reload nginx'
```

Проверка пробного запуска, сайт открывается на новом сервере по подмене адреса только у вас:

```bash
curl -s --resolve psy3107.ru:443:НОВЫЙ https://psy3107.ru/api/healthz
```

Ответ `{"status":"ok","archive":"ok"}`. Затем там же в браузере (через `/etc/hosts` на Mac)
войти, открыть лекцию и расшифровку, сделать пробную правку слайда - она пойдет через Codex.
Сообщения о задаче и, если лимит кончится, о запасном ключе приходят в личку от бота. Задачи,
которые стояли в очереди в момент копии, на пробном сервере тоже выполнятся и пришлют
сообщения: это ожидаемо. Правки на пробном сервере в рабочую базу не попадут.

## Шаг 6. Переключение, единственный простой сайта

1. На старом сервере остановить платформу, чтобы не было правок мимо копии:
   `ssh root@СТАРЫЙ 'systemctl stop kotu'`. Другие проекты на нем продолжают работать.
2. Последняя разница: снова `./ops/pull-backup.sh`. Пробную базу на НОВОМ не удаляем, а
   переименовываем, затем восстанавливаем заново (шаг 5.3 без создания роли), файлы - как в
   шаге 5.4:

```bash
ssh root@НОВЫЙ 'systemctl stop kotu && sudo -u postgres psql -c "ALTER DATABASE kotu RENAME TO kotu_trial_$(date +%Y%m%d)"'
```
3. В DNS у регистратора: запись A для psy3107.ru - на НОВЫЙ. Время обновления зависит от TTL
   записи.
4. После обновления DNS - собственный сертификат на новом сервере тем же certbot, что у бота:
   `/opt/psy-upload-venv/bin/certbot certonly --webroot -w /var/www/acme --cert-name psy3107.ru -d psy3107.ru --deploy-hook "systemctl reload nginx" --non-interactive`.

Проверка: `curl -s https://psy3107.ru/api/healthz` отвечает с нового сервера, вход и данные на
месте, `systemctl is-active hermes-gateway` - бот работает.

## Шаг 7. Ночная копия и наблюдение на новом сервере

- `deploy.sh` уже ставит `kotu-backup.sh` и таймер. Проверить первый ночной запуск и
  `./ops/pull-backup.sh` с Mac.
- В ночной дамп всего кластера на новом сервере попадет только база kotu: других баз там нет.
- Наблюдатель ПСИ на втором узле проверяет Mini App. Сайт psy3107.ru стоит добавить в ту же
  внешнюю проверку.

## Шаг 8. Приемка и старый сервер

Через неделю работы без сбоев:

- старый сервер: `systemctl disable kotu kotu-whisper kotu-privacy kotu-embed` - только
  выключение служб платформы, данные и другие проекты остаются
- дроплет транзита DigitalOcean в Нью-Йорке больше не нужен платформе
- удалять старый сервер, дроплет транзита или их данные - только по прямому решению владелицы

## Откат

До шага 6 откатывать нечего: сайт работает на старом сервере. После шага 6 откат - обратная
запись A в DNS и `systemctl start kotu` на старом сервере. Правки, сделанные на новом сервере
после переключения, на старом будут отсутствовать: их нужно перенести обратно дампом.
Старая версия кода на старом сервере работает с прежними ключами и транзитом, мост ей не нужен.
