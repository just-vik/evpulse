# EVPulse — App Store Beta (TestFlight) Checklist

## ⚠️ Проверено перед публикацией (2026-08-31, обновлено в рамках P0)

Два пункта из этого чек-листа были явно перепроверены по исходному коду `apps/mobile/src` перед тем, как
что-либо утверждать в App Store Connect / privacy policy. Полный аудит — в
[`../../docs/MOBILE_PRODUCT_DESIGN.md`](../../docs/MOBILE_PRODUCT_DESIGN.md).

| Проверка | Результат | Основание |
|---|---|---|
| «Tesla credentials are never stored on your device» (строка ниже, «ГОТОВОЕ ОПИСАНИЕ») | ✅ **Подтверждено, можно публиковать как есть** | В `SecureStore` пишутся только `access_token`/`refresh_token`/`user_id` (собственный JWT EVPulse), `biometric_lock_enabled`, `selected_vehicle_id`. Tesla OAuth полностью server-side: `useTeslaOAuth.ts` только запрашивает `/auth/tesla/link` (URL для браузера) и опрашивает `/auth/tesla/status` (boolean) — токен Tesla в мобильный клиент никогда не попадает. |
| `NSLocationWhenInUseUsageDescription` (iOS) + `ACCESS_FINE_LOCATION`/`ACCESS_COARSE_LOCATION` (Android) в `app.json` | ✅ **Удалены в P0 (подтверждено твоим решением).** EVPulse не запрашивает и не использует местоположение телефона — карта в Drive показывает только записанный маршрут поездки (GPS из Tesla telemetry на сервере). В коде нет `expo-location`, нет `navigator.geolocation`, `MapView` не использует `showsUserLocation`/`followsUserLocation`. При будущем добавлении реальной функции «показать меня на карте» permission нужно будет добавить заново вместе с отдельным privacy review — не восстанавливать этот же permission по инерции. |

Отдельно: пункт «Какие данные собираются (email, Tesla token, location)» в privacy-policy ниже (§4) остаётся
верным **в смысле локации автомобиля** (GPS поездок и зарядных сессий действительно хранится на сервере) — это
не то же самое, что device location permission выше. Формулировку в privacy policy стоит уточнить: «location of
your vehicle (from Tesla telemetry)», а не «your location». EVPulse currently does not collect device location.

## ✅ ГОТОВО В КОДЕ

| Пункт | Статус |
|-------|--------|
| Нативное приложение Expo (iOS + Android) | ✅ |
| Иконка 1024×1024 (`assets/icon.png`) | ✅ Создана |
| Splash-экран 1284×2778 (`assets/splash.png`) | ✅ Создан |
| Bundle ID: `com.evpulse.app` | ✅ |
| Название приложения: **EVPulse** (без нарушения TM Tesla) | ✅ |
| Авторизация (email/password + Tesla OAuth) | ✅ |
| Face ID / Touch ID биометрия | ✅ |
| Push-уведомления (expo-notifications) | ✅ |
| Dashboard с live-телеметрией | ✅ |
| История поездок + карта (react-native-maps) | ✅ |
| Зарядные сессии | ✅ |
| Аналитика батареи + SOH график | ✅ |
| Настройки + управление Tesla-аккаунтом | ✅ |
| Offline-поддержка (кэш через React Query) | ✅ |
| EAS config (`eas.json`) | ✅ |
| `ITSAppUsesNonExemptEncryption: false` | ✅ |
| Privacy Manifest (NSPrivacyAccessedAPITypes) | ✅ |
| Scheme изменён: `evpulse://` | ✅ |

---

## ⏳ НУЖНО СДЕЛАТЬ ДО ТЕСТ-ФЛАЙТА

### 1. Apple Developer Account ($99/год)
- Зарегистрироваться на https://developer.apple.com/
- Активировать аккаунт (занимает 24-48 ч)

### 2. EAS / Expo аккаунт
```bash
npm install -g eas-cli
eas login
eas build:configure   # создаст projectId → вставить в app.json extra.eas.projectId
```

### 3. App Store Connect — создать приложение
1. Открыть https://appstoreconnect.apple.com/
2. Новое приложение → Bundle ID: `com.evpulse.app`
3. Заполнить:
   - **Название:** EVPulse
   - **Подзаголовок:** Tesla Analytics & Monitoring
   - **Описание:** (см. ниже)
   - **Ключевые слова:** tesla, ev, electric car, battery, analytics
   - **URL поддержки:** https://evpulse.app/support
   - **URL политики конфиденциальности:** https://evpulse.app/privacy  ← ОБЯЗАТЕЛЬНО
   - **Категория:** Utilities / Productivity
   - **Возрастной рейтинг:** 4+

### 4. Политика конфиденциальности
Добавить `/privacy` страницу на сайт или использовать сервис (https://www.privacypolicies.com/).
Минимум должна содержать:
- Какие данные собираются (email, Tesla token, location)
- Как данные хранятся и защищаются
- Контактная информация

### 5. Скриншоты (ОБЯЗАТЕЛЬНО)
Apple требует скриншоты для каждого форм-фактора:
| Устройство | Разрешение |
|-----------|-----------|
| iPhone 6.7" (Pro Max) | 1290×2796 |
| iPhone 6.1" | 1170×2532 |
| (опционально) iPad 12.9" | 2048×2732 |

Минимум 1 скриншот, рекомендуется 3-5.
Можно сделать на симуляторе через `eas build --profile development --platform ios`.

### 6. Сборка и отправка в TestFlight
```bash
cd apps/mobile

# Первая сборка (нужен Apple Developer account)
eas build --platform ios --profile production

# После успешной сборки — сабмит в TestFlight
eas submit --platform ios --profile production

# Или всё одной командой:
eas build --platform ios --profile production --auto-submit
```

### 7. TestFlight Beta
1. В App Store Connect → TestFlight → добавить тестировщиков по email
2. Каждый получит ссылку для установки
3. Приложение проходит 24-48ч ревью от Apple перед TestFlight

---

## 📝 ГОТОВОЕ ОПИСАНИЕ для App Store (EN)

**Name:** EVPulse

**Subtitle:** Tesla Analytics & Monitoring

**Description:**
```
EVPulse gives you real-time visibility into your Tesla — battery health, trips, 
charging history and live telemetry, all in one clean app.

KEY FEATURES:
• Live Dashboard — battery level, range, state and power in real time
• Trip History — every drive with map, efficiency and energy breakdown
• Charging Sessions — all sessions with cost, power and SOC tracking
• Battery Analytics — State of Health, degradation trend and forecast
• Smart Notifications — charging complete, low battery, and more
• Face ID / Touch ID — instant secure unlock
• Works with Model 3, Model Y, Model S, Model X and Cybertruck

EVPulse connects to your existing EVPulse account and syncs all data 
through a secure API. Tesla credentials are never stored on your device.
```

**Keywords:** tesla, ev, electric vehicle, battery health, soh, charging, trips, analytics, range

---

## 🔧 КОМАНДЫ ДЛЯ БЫСТРОГО СТАРТА

```bash
# Установить EAS CLI
npm install -g eas-cli

# Войти в Expo
eas login

# Настроить проект (создаёт projectId)
cd /path/to/tesla-platform/apps/mobile
eas build:configure

# Собрать для симулятора (бесплатно, без Apple account)
eas build --platform ios --profile development

# Продакшн билд для TestFlight (нужен Apple Developer)
eas build --platform ios --profile production

# Сабмит в TestFlight
eas submit --platform ios
```

---

## ⚠️ ВАЖНЫЕ ЗАМЕЧАНИЯ

1. **Название "EVPulse"** — не нарушает торговую марку Tesla. Старое "Tesla Control" могло быть отклонено Apple Review.
2. **Схема deeplink** изменена с `tesla-control://` на `evpulse://` — обновите URL в Tesla Developer Portal если добавляете native redirect.
3. **Push на iOS** — Expo автоматически настраивает APNs через свой сервер. Работает "из коробки" с `expo-notifications`.
4. **Карты** — `react-native-maps` на iOS использует Apple Maps (не требует ключей). Для Android нужен Google Maps API Key в `app.json`.
