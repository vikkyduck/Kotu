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

  # Проверка: достучится ли VDS до api.openai.com с этим ключом
  CODE=$(curl -s -o /dev/null -w "%{http_code}" -m 15 \
    -H "Authorization: Bearer $KEY" https://api.openai.com/v1/models || echo "000")
  case "$CODE" in
    200) echo "   ✅ OpenAI доступен НАПРЯМУЮ с сервера — прокси не нужен, транскрибация должна работать" ;;
    401) echo "   ❌ OpenAI ответил 401 — ключ не принят (проверьте, что скопирован целиком)" ;;
    403) echo "   ⚠️  OpenAI ответил 403 — российский IP заблокирован, нужен прокси (CF Worker)" ;;
    000) echo "   ⚠️  api.openai.com не отвечает с сервера — нужен прокси (CF Worker)" ;;
    *)   echo "   ⚠️  OpenAI ответил кодом $CODE — покажите это Клоду" ;;
  esac
'
unset KEY
echo "Готово. Локально ключ нигде не сохранён."
