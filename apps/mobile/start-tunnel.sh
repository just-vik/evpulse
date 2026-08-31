#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# Запуск Expo Go туннеля с аутентификацией.
# Работает по WiFi И по LTE — как веб-приложение.
#
# Первый запуск:
#   1. Зарегистрируйся на https://expo.dev (бесплатно)
#   2. Открой https://expo.dev/accounts/[твой-логин]/settings/access-tokens
#   3. Нажми "Create Token", скопируй токен
#   4. Запусти: EXPO_TOKEN=expo_xxxx bash start-tunnel.sh
#      или добавь в ~/.bashrc: export EXPO_TOKEN=expo_xxxx
# ──────────────────────────────────────────────────────────────────────────────
set -e
cd "$(dirname "$0")"

# Проверяем токен
if [ -z "$EXPO_TOKEN" ]; then
  echo ""
  echo "╔══════════════════════════════════════════════════════════╗"
  echo "║  EXPO_TOKEN не установлен                                ║"
  echo "╚══════════════════════════════════════════════════════════╝"
  echo ""
  echo "Шаги (5 минут, бесплатно):"
  echo ""
  echo "  1. Зарегистрируйся: https://expo.dev (если нет аккаунта)"
  echo ""
  echo "  2. Создай токен:"
  echo "     https://expo.dev/accounts/[твой-логин]/settings/access-tokens"
  echo "     → Create Token → скопируй"
  echo ""
  echo "  3. Запусти с токеном:"
  echo "     EXPO_TOKEN=expo_xxxx bash start-tunnel.sh"
  echo ""
  echo "  4. Чтобы не вводить каждый раз:"
  echo "     echo 'export EXPO_TOKEN=expo_xxxx' >> ~/.bashrc"
  echo "     source ~/.bashrc"
  echo ""
  exit 1
fi

echo ""
echo "✓ EXPO_TOKEN установлен"

# Проверим авторизацию
WHO=$(/home/vik/tesla-platform/node_modules/.bin/expo whoami 2>/dev/null || echo "")
if echo "$WHO" | grep -q "@"; then
  echo "✓ Залогинен как: $WHO"
else
  echo "  Авторизуемся через токен..."
fi

# API URL — указывает на публичный сервер (работает и по WiFi и по LTE)
export EXPO_PUBLIC_API_URL="https://api.evpulse.app"

echo "✓ API URL: $EXPO_PUBLIC_API_URL"
echo ""
echo "▶ Запускаем Metro + туннель..."
echo "  Сканируй QR в Expo Go — работает с любой сети."
echo ""

exec /home/vik/tesla-platform/node_modules/.bin/expo start --tunnel --clear
