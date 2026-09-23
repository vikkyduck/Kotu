#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Kotu — подключить ключ OpenAI, Claude (Anthropic), Gemini (Google) или Perplexity.
# Запуск:  ~/kotu/set-ai-key.sh
#
# Ключ вводится вслепую, уходит на сервер через stdin по ssh, кладётся в
# /opt/kotu/.env (права 600) и сразу проверяется живым запросом через ваш
# транзит. В историю команд, список процессов и чат он не попадает.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SERVER="${SERVER_USER:-root}@${SERVER_HOST:-5.129.198.180}"

echo "Какой ключ подключаем?"
echo "  1) Claude (Anthropic) — анализ текста, написание лекций, проверка достоверности"
echo "  2) Gemini (Google)    — длинные документы, картинки"
echo "  3) Perplexity         — поиск источников с ссылками"
echo "  4) OpenAI             — оформление расшифровок, лекции"
read -rp "Введите 1, 2, 3 или 4: " CHOICE

case "$CHOICE" in
  1) VAR=ANTHROPIC_API_KEY;  NAME="Claude";;
  2) VAR=GEMINI_API_KEY;     NAME="Gemini";;
  3) VAR=PERPLEXITY_API_KEY; NAME="Perplexity";;
  4) VAR=AI_INTEGRATIONS_OPENAI_API_KEY; NAME="OpenAI";;
  *) echo "❌ Нужно 1, 2, 3 или 4. Ничего не изменено."; exit 1;;
esac

printf "Вставьте ключ %s и нажмите Enter — ввод не отображается: " "$NAME"
read -rs KEY
echo

[ ${#KEY} -ge 20 ] || { echo "❌ Слишком короткая строка — не похоже на ключ. Ничего не изменено."; exit 1; }

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

  echo '   Проверяю ключ живым запросом…'
  case '$VAR' in
    ANTHROPIC_API_KEY)
      CODE=\$(curl -s -o /dev/null -w '%{http_code}' -m 30 \
        -H \"x-api-key: \$KEY\" -H 'anthropic-version: 2023-06-01' \
        http://127.0.0.1:8444/anthropic/v1/models || echo 000) ;;
    GEMINI_API_KEY)
      CODE=\$(curl -s -o /dev/null -w '%{http_code}' -m 30 \
        \"http://127.0.0.1:8444/gemini/v1beta/models?key=\$KEY\" || echo 000) ;;
    PERPLEXITY_API_KEY)
      CODE=\$(curl -s -o /dev/null -w '%{http_code}' -m 60 \
        -H \"Authorization: Bearer \$KEY\" -H 'content-type: application/json' \
        -d '{\"model\":\"sonar\",\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}],\"max_tokens\":1}' \
        http://127.0.0.1:8444/perplexity/chat/completions || echo 000) ;;
    AI_INTEGRATIONS_OPENAI_API_KEY)
      CODE=\$(curl -s -o /dev/null -w '%{http_code}' -m 30 \
        -H \"Authorization: Bearer \$KEY\" \
        http://127.0.0.1:8444/v1/models || echo 000) ;;
  esac

  case \"\$CODE\" in
    200) echo '   ✅ Ключ принят — $NAME доступен из приложения' ;;
    401|403) echo '   ❌ Сервис не принял ключ (проверьте, что скопирован целиком)' ;;
    000) echo '   ⚠️  Нет ответа — проверьте, жив ли транзит на дроплете' ;;
    *) echo \"   ⚠️  Ответ \$CODE — покажите это Клоду\" ;;
  esac
"
unset KEY
echo "Готово."
