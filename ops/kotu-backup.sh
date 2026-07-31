#!/usr/bin/env bash
# Ночной бэкап: базы Postgres, секреты/конфиги и ФАЙЛЫ приложения.
#
# Хранение только на этом сервере (РФ) — см. ARCHITECTURE.md §10: в бэкапе
# лежат аудио сеансов и настоящие имена, это зона А. Копию наружу можно
# делать только в российское хранилище или на компьютер автора
# (ops/pull-backup.sh), но НИКОГДА не на зарубежный сервер.
#
# Базы — по дампу в день, 14 дней. Файлы — одним зеркалом, а не копией в
# день: они почти не меняются, а аудио весит сотни мегабайт, и четырнадцать
# копий забили бы диск.
set -euo pipefail
STAMP=$(date +%Y-%m-%d)
DB_DIR=/opt/backups/db
FILES_DIR=/opt/backups/files
DATA_DIR=/opt/backups/data
mkdir -p "$DB_DIR" "$FILES_DIR" "$DATA_DIR"

# Базы: pg_dumpall берёт и роли, и все базы (kotu, finance_duck и пр.)
sudo -u postgres pg_dumpall | gzip -9 > "$DB_DIR/all-$STAMP.sql.gz.tmp"
mv "$DB_DIR/all-$STAMP.sql.gz.tmp" "$DB_DIR/all-$STAMP.sql.gz"

# И отдельно сама база kotu в формате, который восстанавливается одной
# командой pg_restore. Дамп всего кластера хорош для «сервер сгорел целиком»,
# но чтобы поднять одну базу на чистой машине, из него приходится выкусывать
# нужный кусок руками — в день аварии это последнее, чем хочется заниматься.
sudo -u postgres pg_dump -Fc kotu > "$DB_DIR/kotu-$STAMP.dump.tmp"
mv "$DB_DIR/kotu-$STAMP.dump.tmp" "$DB_DIR/kotu-$STAMP.dump"

# Секреты и юниты — без них восстановление превращается в археологию
tar czf "$FILES_DIR/config-$STAMP.tar.gz" \
  --ignore-failed-read \
  /opt/kotu/.env /opt/kotu/openai-proxy-ca.pem \
  /etc/systemd/system/kotu*.service \
  /etc/nginx/sites-available 2>/dev/null || true

# Файлы приложения: книги библиотеки, аудио записей, картинки презентаций.
# В базе лежат только тексты и ссылки — без этих каталогов восстановленная
# платформа осталась бы с пустыми полками.
for d in library uploads decks; do
  [ -d "/opt/kotu/$d" ] || continue
  rsync -a --delete "/opt/kotu/$d/" "$DATA_DIR/$d/"
done

# Ротация дампов и конфигов: 14 дней. Зеркало файлов не ротируется —
# оно всегда одно и повторяет текущее состояние.
find "$DB_DIR" -name "all-*.sql.gz" -mtime +14 -delete
find "$DB_DIR" -name "kotu-*.dump" -mtime +14 -delete
find "$FILES_DIR" -name "config-*.tar.gz" -mtime +14 -delete

# Проверка: дамп должен быть непустым, распаковываться и содержать наши
# таблицы. Битый архив, о котором узнаёшь в день аварии, — не бэкап.
SIZE=$(stat -c%s "$DB_DIR/all-$STAMP.sql.gz")
gzip -t "$DB_DIR/all-$STAMP.sql.gz"
[ "$SIZE" -gt 10000 ] || { echo "БЭКАП ПОДОЗРИТЕЛЬНО МАЛ: $SIZE байт" >&2; exit 1; }
zcat "$DB_DIR/all-$STAMP.sql.gz" | grep -q "CREATE TABLE public.documents" || {
  echo "В ДАМПЕ НЕТ ТАБЛИЦ KOTU — проверьте pg_dumpall" >&2; exit 1; }

# Восстановимость проверяем не глазами, а pg_restore: он читает оглавление
# дампа и падает на битом файле.
# Читает файл, а не базу, поэтому от имени root: каталог бэкапов закрыт
# от посторонних, и postgres в него не заглядывает.
pg_restore --list "$DB_DIR/kotu-$STAMP.dump" > /dev/null

DATA_SIZE=$(du -sh "$DATA_DIR" 2>/dev/null | cut -f1)
echo "ok: база $((SIZE/1024)) КБ, файлы $DATA_SIZE"
