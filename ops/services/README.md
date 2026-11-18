# Что стоит на сервере помимо приложения

Всё, что на сервере есть помимо самого приложения: локальные сервисы Python, unit-файлы,
скрипты оповещений и сайты nginx - в том виде, в каком они работают после переезда 18.11.2026
(`ops/ПЕРЕЕЗД-AMS3.md`). По этой папке сервер можно собрать заново.

`deploy.sh` (шаг 4b) сам ставит отсюда unit-файлы `kotu*`, скрипты из `bin/` и сайты nginx -
только изменённые, сайты с проверкой `nginx -t` и возвратом прежних при ошибке. Руками ставятся
только сервисы Python (окружения и модели), раз на новый сервер - см. ниже.

Адресов и секретов здесь нет: репозиторий публичный. Секреты живут в `/opt/kotu/.env` на сервере.

## Два локальных сервиса Python

| Служба | Порт (127.0.0.1) | Код | Окружение | Что делает |
|---|---|---|---|---|
| `kotu-whisper` | 9010 | `/opt/whisper/server.py` | `/opt/whisper/venv` | распознавание речи, faster-whisper large-v3-turbo |
| `kotu-embed` | 9030 | `/opt/embed/server.py` | `/opt/whisper/venv` | векторы для библиотеки, multilingual-e5-large |

У `kotu-embed` своего окружения нет: он запускается из окружения Whisper и берёт модели из того же
кэша `/opt/whisper/cache`. Модели (около 3,7 ГБ) скачиваются с Hugging Face при первом старте.

Установка на чистый сервер (Ubuntu 24.04, Python 3.12), из корня репозитория, от root:

```bash
id kotu >/dev/null 2>&1 || useradd --system --home-dir /opt/kotu --shell /usr/sbin/nologin kotu
for s in whisper embed; do install -d /opt/$s && install -m 644 ops/services/$s/server.py /opt/$s/; done
install -d /opt/whisper/cache
python3 -m venv /opt/whisper/venv
/opt/whisper/venv/bin/pip install --extra-index-url https://download.pytorch.org/whl/cpu -r ops/services/whisper/requirements.txt
chown -R kotu:kotu /opt/whisper /opt/embed
install -m 644 ops/services/systemd/kotu-whisper.service ops/services/systemd/kotu-embed.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now kotu-whisper kotu-embed
```

Проверка:

```bash
for p in 9010 9030; do curl -s http://127.0.0.1:$p/healthz; echo; done
```

Списки пакетов сняты командой `pip freeze` с рабочего сервера. В списке Whisper `torch` в сборке
`+cpu`, поэтому нужен дополнительный индекс из команды выше.

## Unit-файлы (`systemd/`)

| Файл | Зачем |
|---|---|
| `kotu.service` | само приложение: `node /opt/kotu/server/index.mjs`, настройки из `/opt/kotu/.env` |
| `kotu-whisper.service`, `kotu-embed.service` | два сервиса выше |
| `kotu-backup.service`, `kotu-backup.timer` | ночная копия в 04:20 UTC, запускает `/usr/local/bin/kotu-backup.sh` |
| `kotu-cert-renew.service`, `kotu-cert-renew.timer` | раз в сутки проверяет и продлевает сертификат сайта |
| `kotu-health.service`, `kotu-health.timer` | каждые 5 минут проверяет сайт (`bin/kotu-health`) |
| `kotu-alert@.service` | сообщение владелице, когда служба упала (`bin/kotu-alert`) |

У `kotu`, `kotu-whisper`, `kotu-embed`, `kotu-backup` и `kotu-cert-renew` стоит
`OnFailure=kotu-alert@%n.service`: служба завершилась ошибкой - сообщение владелице.

`kotu-cert-renew` пользуется `certbot` из окружения агента ПСИ (`/opt/psy-upload-venv`): своего
certbot у платформы нет. Таймер агента продлевает только сертификат Mini App, сертификат сайта он
не трогает, поэтому у сайта свой таймер. Сертификат выпущен через общий каталог `/var/www/acme`.

## Сайты nginx (`nginx/`)

| Файл | Зачем |
|---|---|
| `psy3107` | сайт: статика из `/opt/kotu/public`, `/api/` в приложение на 127.0.0.1:5010, порт 443 |
| `kotu-ai-router` | внутренний адрес 127.0.0.1:8444, отправляет `/v1/audio/` в локальный Whisper |
| `acme` | общий порт 80: проверка сертификатов через `/var/www/acme` и перенаправление на https |

Порт 80 на сервере один на платформу и на агента ПСИ, поэтому в сайте `psy3107` блока на порту 80
нет: его обслуживает `acme`. Файлы кладутся в `/etc/nginx/sites-available` со ссылкой из
`sites-enabled`, затем `nginx -t && systemctl reload nginx`.

## Сообщения владелице (`bin/`)

Все сообщения идут в личку владелицы от бота ПСИ через мост (`/run/psy-platform-bridge.sock`,
путь `/notify`) - тот же путь, что у уведомлений о готовых задачах. Мост пускает только root и
пользователя `kotu`.

| Скрипт | Когда пишет |
|---|---|
| `kotu-notify "текст"` | общий: отправить одно сообщение (повтор того же за 10 минут мост отбрасывает) |
| `kotu-alert <служба>` | служба `kotu*` завершилась ошибкой (вызывается из `kotu-alert@.service`) |
| `kotu-health` | сайт не отвечает или архив выключен две проверки подряд; затем один раз - «снова отвечает» |

Самопроверка в самом приложении (`artifacts/api-server/src/lib/self-check.ts`): через минуту после
запуска и раз в 12 часов - каждая модель из `.env` коротким запросом через мост, Whisper, векторы
и почта (письмо на адрес симулятора Postbox `success@simulator.pstbx.ru`, никому не приходит).
О той же проблеме повторно не пишет, о восстановлении - один раз. `SELF_CHECK=off` выключает.

Проверить путь сообщений руками: `sudo -u kotu /usr/local/bin/kotu-notify "Проверка"`.

## Вторая копия вне сервера

Ночная копия (`ops/kotu-backup.sh`) после проверки отправляет `/opt/backups` на другой сервер, если
есть `/etc/kotu/offsite.env`:

```
OFFSITE_TARGET=kotu-offsite@<адрес>
OFFSITE_KEY=/root/.ssh/kotu_offsite
```

Сейчас это старый сервер Timeweb, папка `/srv/kotu-offsite-backup`. На том сервере пользователь
`kotu-offsite` заперт так же, как пользователь копий агента ПСИ, в `authorized_keys`:

```
from="<адрес сервера платформы>",restrict,command="/usr/bin/rrsync -wo -no-del -munge /srv/kotu-offsite-backup" ssh-ed25519 ...
```

Он может только дописывать в одну папку: удалить, прочитать или войти в оболочку нельзя. Поэтому
порча копии на сервере платформы не сотрёт копию там. Ещё одна копия каждый день забирается на
Mac владелицы (`ops/pull-backup.sh`).
