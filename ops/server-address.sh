# Адрес сервера платформы для скриптов, которые запускаются с компьютера
# владелицы (deploy.sh, set-*.sh, ops/pull-backup.sh и другие).
#
# Адреса в репозитории нет: он публичный. Адрес берется из переменной
# SERVER_HOST или из файла ops/server.local (в git не попадает):
#
#   SERVER_HOST=203.0.113.10
#
# Пользователь по умолчанию root, другой - через SERVER_USER.
# Использование в скрипте:  SERVER=$(kotu_server) || exit 1

kotu_server() {
  local here host
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  host="${SERVER_HOST:-}"
  if [ -z "$host" ] && [ -f "$here/server.local" ]; then
    host="$(sed -n 's/^SERVER_HOST=//p' "$here/server.local" | head -n 1 | tr -d '[:space:]')"
  fi
  if [ -z "$host" ]; then
    echo "❌ Не задан адрес сервера: создайте ops/server.local со строкой SERVER_HOST=<адрес>" >&2
    return 1
  fi
  echo "${SERVER_USER:-root}@${host}"
}
