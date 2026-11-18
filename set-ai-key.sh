#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Kotu - подключить запасной ключ OpenAI API.
# Запуск:  ~/kotu/set-ai-key.sh
#
# Модели платформы работают по подписке Codex через мост агента ПСИ, ключ не
# нужен. Ключ OpenAI API - запасной путь: платформа переходит на него, только
# когда подписка недоступна, и сначала присылает об этом сообщение в Telegram
# (ARCHITECTURE.md §5). Без ключа платформа в таких случаях ждет подписку.
#
# Ключ вводится вслепую, уходит на сервер через stdin по ssh, кладется в
# /opt/kotu/.env (права 600) и сразу проверяется запросом к OpenAI API.
# В историю команд, список процессов и чат он не попадает.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

. "$(dirname "$0")/ops/server-address.sh"
SERVER=$(kotu_server) || exit 1
VAR=AI_INTEGRATIONS_OPENAI_API_KEY

printf "Вставьте ключ OpenAI API и нажмите Enter - ввод не отображается: "
read -rs KEY
echo

[ ${#KEY} -ge 20 ] || { echo "❌ Слишком короткая строка - не похоже на ключ. Ничего не изменено."; exit 1; }

printf '%s' "$KEY" | ssh "$SERVER" "
  set -euo pipefail
  umask 077
  KEY=\$(cat)
  ENV=/opt/kotu/.env
  grep -v '^$VAR=' \"\$ENV\" > \"\$ENV.tmp\" || true
  printf '%s=%s\n' '$VAR' \"\$KEY\" >> \"\$ENV.tmp\"
  mv \"\$ENV.tmp\" \"\$ENV\"
  chmod 600 \"\$ENV\" && chown kotu:kotu \"\$ENV\"
  systemctl restart kotu

  BASE=\$(sed -n 's/^AI_INTEGRATIONS_OPENAI_BASE_URL=//p' \"\$ENV\" | tail -n 1)
  BASE=\${BASE:-https://api.openai.com/v1}
  echo '   Проверяю ключ запросом к OpenAI API...'
  CODE=\$(curl -s -o /dev/null -w '%{http_code}' -m 30 \
    -H \"Authorization: Bearer \$KEY\" \"\$BASE/models\" || echo 000)

  case \"\$CODE\" in
    200) echo '   ✅ Ключ принят - запасной путь готов' ;;
    401|403) echo '   ❌ OpenAI не принял ключ (проверьте, что скопирован целиком)' ;;
    000) echo '   ⚠️  Нет ответа от OpenAI API - проверьте сеть сервера' ;;
    *) echo \"   ⚠️  Ответ \$CODE - покажите это Клоду\" ;;
  esac
"
unset KEY
echo "Готово."
