#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Kotu — безопасная установка ключа OpenAI на сервер.
# Запуск:  ~/kotu/set-openai-key.sh
# Ключ вводится вслепую (не видно на экране), не попадает в историю shell,
# не светится в аргументах процессов (передаётся через stdin по ssh).
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SERVER="${SERVER_USER:-root}@${SERVER_HOST:-5.129.198.180}"
ENV_FILE="/opt/kotu/.env"

printf "Вставьте ключ OpenAI (sk-...) и нажмите Enter — ввод не отображается: "
read -rs KEY
echo

if [[ ! "$KEY" =~ ^sk-[A-Za-z0-9_-]{20,}$ ]]; then
  echo "❌ Это не похоже на ключ OpenAI (должен начинаться с sk-). Ничего не изменено."
  exit 1
fi

echo "==> Записываю ключ в $ENV_FILE на сервере и перезапускаю сервис"
printf '%s' "$KEY" | ssh "$SERVER" '
  set -euo pipefail
  KEY=$(cat)
  grep -v "^AI_INTEGRATIONS_OPENAI_API_KEY=" '"$ENV_FILE"' > '"$ENV_FILE"'.tmp
  printf "AI_INTEGRATIONS_OPENAI_API_KEY=%s\n" "$KEY" >> '"$ENV_FILE"'.tmp
  mv '"$ENV_FILE"'.tmp '"$ENV_FILE"'
  chmod 600 '"$ENV_FILE"' && chown kotu:kotu '"$ENV_FILE"'
  systemctl restart kotu
  sleep 2
  systemctl is-active kotu >/dev/null && echo "   сервис kotu: работает"

  # Проверяем ключ ТАК ЖЕ, как ходит приложение — через транзит на дроплете.
  # Прямой запрос к api.openai.com с российского адреса всегда даёт 403,
  # и раньше эта проверка пугала ложной тревогой.
  CODE=$(curl -s -o /dev/null -w "%{http_code}" -m 30 \
    -H "Authorization: Bearer $KEY" http://127.0.0.1:8444/v1/models || echo "000")
  case "$CODE" in
    200) echo "   ✅ Ключ принят — OpenAI доступен из приложения" ;;
    401) echo "   ❌ Ключ не принят (проверьте, что скопирован целиком)" ;;
    403) echo "   ⚠️  403 через транзит — похоже, транзит на дроплете отдаёт запрос напрямую. Покажите Клоду" ;;
    000) echo "   ⚠️  Нет ответа — проверьте, жив ли транзит: systemctl status openai-proxy на дроплете" ;;
    *)   echo "   ⚠️  Ответ $CODE — покажите это Клоду" ;;
  esac
'
unset KEY
echo "Готово. Локально ключ нигде не сохранён."
