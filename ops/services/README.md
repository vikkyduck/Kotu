# Что стоит на сервере помимо приложения

`deploy.sh` выкладывает только фронт и API (`/opt/kotu/public`, `/opt/kotu/server`) и обновляет
скрипт ночной копии. Всё остальное на сервере ставилось руками и раньше жило только там и в
ночном архиве настроек. Здесь лежит это «остальное» в том виде, в каком оно работает после
переезда 18.11.2026 (`ops/ПЕРЕЕЗД-AMS3.md`): по этой папке сервер можно собрать заново.

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

`deploy.sh` unit-файлы не ставит и не обновляет. После правки файла здесь его нужно положить на
сервер руками:

```bash
install -m 644 ops/services/systemd/<файл> /etc/systemd/system/ && systemctl daemon-reload
systemctl enable --now kotu-backup.timer kotu-cert-renew.timer
```

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
