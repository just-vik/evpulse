# EAS / App Store release checklist

## Accounts

- [ ] Apple Developer Program membership (company or individual).
- [ ] Google Play Console account (for Android).
- [ ] Expo account (`eas login`) and **EAS project** (`eas init` in `apps/mobile`).

## Configuration

- [ ] Replace placeholder `assets/icon.png` with production 1024×1024 icon and matching splash.
- [ ] Set `EXPO_PUBLIC_API_URL` to production API (HTTPS), e.g. `https://api.example.com`.
- [ ] **iOS**: `ios.bundleIdentifier` unique; enable Push Notifications capability in Apple Developer if using remote push.
- [ ] **Android**: `android.package` unique; add **Google Maps API key** in `app.json` → `android.config.googleMaps.apiKey` if you rely on Google Maps tiles.
- [ ] **Tesla OAuth**: redirect URIs in Tesla Developer Portal must match server-side `TESLA_REDIRECT_URI` (mobile uses in-app browser + server callback; custom scheme callbacks need extra backend support).

## Secrets & builds

- [ ] Store signing: `eas credentials` for iOS distribution cert + provisioning profile; Android keystore or Play App Signing.
- [ ] Run `eas build --profile production --platform ios` (and/or `android`).
- [ ] Run `eas submit` or upload `.ipa` / AAB manually.

## Store listings

- [ ] Privacy policy URL (required for data collection / telemetry).
- [ ] App Review notes: explain Tesla read-only telemetry, backend JWT auth, optional biometrics.
- [ ] Screenshots for required device sizes.

## Post-release

- [ ] Monitor crash analytics (Sentry optional).
- [ ] Confirm push: Expo tokens require a backend route (or FCM) — web-push-only API does not deliver to native Expo tokens.
