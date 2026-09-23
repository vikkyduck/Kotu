#!/usr/bin/env bash
# Сколько строк было в главных таблицах в каждом дампе kotu — ночных и снятых
# перед деплоем. Только числа, без содержимого. Нужно, чтобы понять, КОГДА
# что-то исчезло (правило владелицы: система сама ничего не стирает).
#
# Запуск с компьютера:  ssh root@5.129.198.180 bash -s < ~/kotu/ops/dump-counts.sh
set -euo pipefail
# Тот же список, что в описи deploy.sh (строки_*).
TABLES="transcriptions documents folders lectures decks users"
printf '%-45s' "дамп"; for t in $TABLES; do printf '%16s' "$t"; done; echo
for f in /opt/backups/db/kotu-*.dump /opt/backups/predeploy/*/kotu.dump; do
  [ -f "$f" ] || continue
  printf '%-45s' "${f#/opt/backups/}"
  for t in $TABLES; do
    # В выводе pg_restore -a данные таблицы — между строкой «COPY …» и «\.».
    n=$(pg_restore -a -t "$t" -f - "$f" 2>/dev/null |
      awk '$0 == "\\." {c = 0} c {n++} /^COPY / {c = 1} END {print n + 0}')
    printf '%16s' "$n"
  done
  echo
done
