# Mobile — Testing with Expo Go

How to run `apps/mobile` on a real iPhone via **Expo Go**, for development only. This is
not a production distribution path — see [Development Build / TestFlight](#future-development-build--testflight)
at the end.

Two modes, pick based on where the phone is:

| Mode | When to use | Speed |
|---|---|---|
| **LAN** | iPhone and this server are on the same home Wi-Fi | Fast Refresh, low latency |
| **Tunnel** | iPhone on LTE/5G, a different Wi-Fi, or away from home | Works anywhere, slower |

Either way, the EVPulse **API** is unaffected — the app always talks to
`https://api.evpulse.app` over HTTPS (see `apps/mobile/.env`). Only the Metro/Fast-Refresh
dev bundle needs LAN or tunnel connectivity; nothing about the API or production
infrastructure changes.

## Prerequisites

- Expo Go installed on the iPhone (App Store).
- This server and the iPhone reachable on the same network (LAN mode) — or just internet
  access on both (tunnel mode).
- `apps/mobile` dependencies already installed (`npm install` from the repo root — this is
  an npm workspace, don't run `npm install` inside `apps/mobile` alone).
- Port 8081 free on this machine (Metro's default dev-server port).

## LAN — home network

```bash
cd /home/vik/tesla-platform/apps/mobile
npm run dev:lan
```

- Phone and server **must be on the same LAN/Wi-Fi subnet**. Guest Wi-Fi, client
  isolation (common on guest networks and some mesh routers), a VPN active on either
  device, or the two devices being on different VLANs will all silently break this —
  if the QR scan hangs, check that first.
- A terminal QR code appears. Open the **Camera app** (or Expo Go's own scanner) on the
  iPhone and scan it — it opens directly in Expo Go.
- **No router port forwarding, no opening port 8081 to the internet.** LAN mode only
  needs the two devices to reach each other locally.

## Tunnel — remote / cellular

```bash
cd /home/vik/tesla-platform/apps/mobile
npm run dev:tunnel
```

- Use this when the iPhone is on LTE/5G, a different Wi-Fi network, or otherwise not on
  the same LAN as this server.
- The tunnel (via `@expo/ngrok`, already installed) only carries the **development
  JS bundle** — it's unrelated to the EVPulse API, which the app reaches directly over
  HTTPS regardless of tunnel/LAN mode.
- Tunnel is noticeably slower than LAN (extra network hop) — prefer LAN when both
  devices are home.
- Same QR-scan flow as LAN: scan with the Camera app or Expo Go, it opens the project.
- **No port forwarding, no firewall changes, no Cloudflare/Nginx changes required or
  performed by this mode** — it's an outbound tunnel initiated from this machine.

## Clearing cache (stale bundle)

```bash
cd /home/vik/tesla-platform/apps/mobile
npm run dev:clear
```

Use this whenever the app on the phone looks stuck on old code, shows a stale error
overlay, or a dependency/asset change isn't reflected after a normal reload.

## Stopping the dev server

`Ctrl+C` in the terminal running `dev:lan` / `dev:tunnel` / `dev:clear`. There's no
background process left running afterward — Metro only runs in the foreground.

## Troubleshooting

### "No development servers found" in Expo Go
The dev server isn't running (this is the state described in the current diagnostic —
Expo Go shows only its own home screen until `npm run dev:lan` or `dev:tunnel` is
actively running and a QR has been scanned). Start one of the two commands above and
re-scan.

### SDK mismatch error in Expo Go
Expo Go on the App Store only supports the current/recent SDK. This project is on
**Expo SDK 54**. If Expo Go reports a mismatch:
- Update Expo Go from the App Store, or
- Check `apps/mobile/package.json`'s `expo` version against what your installed Expo Go
  build supports.
Do not downgrade the project's SDK to chase an outdated Expo Go install — update Expo Go
instead.

### LAN QR doesn't open / scan hangs
1. Confirm both devices show the same Wi-Fi network name in their settings (not just
   "connected to Wi-Fi" — guest networks often share an SSID prefix but are isolated).
2. Turn off any VPN on the phone or the server.
3. If your router has AP/client isolation enabled for that network, LAN mode cannot
   work there — switch to `npm run dev:tunnel` instead, or fix the router setting
   (out of scope here — router configuration is your call, not something this repo
   controls).
4. Confirm the printed LAN IP in the terminal matches this server's actual LAN address
   (`192.168.2.53` at the time of this check) — if the server has multiple network
   interfaces, Expo may pick the wrong one; `dev:tunnel` sidesteps this entirely.

### Stale bundle / cache issues
Run `npm run dev:clear` (clears Metro's cache). If that doesn't help, fully close Expo
Go on the phone (swipe it away, don't just background it) and re-scan the QR.

### Dependency version warnings
`npx expo-doctor` currently reports 8 packages a patch version behind what SDK 54
expects (`expo`, `expo-constants`, `expo-linking`, `expo-local-authentication`,
`expo-notifications`, `expo-router`, `expo-web-browser`, `@types/react`). Non-blocking
for Expo Go — fix via `npx expo install --check` if you want to clear the warning.

(A duplicate `react` install used to show up here too — `apps/web` and `apps/mobile`
had pinned different exact React versions, causing two React instances in the monorepo
and a real risk of "Invalid hook call" in code using `@tanstack/react-query` hooks.
Fixed by aligning both on `react@19.1.0` and hoisting a single copy at the repo root —
`npx expo-doctor`'s duplicate-dependency check now passes.)

## Do not

- **Do not** open port 8081 on your router to the internet, and **do not** set up port
  forwarding for it. Neither LAN nor tunnel mode needs that — LAN works locally, tunnel
  is an outbound connection this machine initiates.
- **Do not** treat Expo Go as a production distribution channel. It's a development-only
  tool for fast iteration; end users never install Expo Go to use EVPulse.

## Future: Development Build / TestFlight

Expo Go can't include custom native modules beyond what Expo bundles by default. This
project doesn't currently need one (no native deps outside Expo Go's supported set), but
once it does — or when it's time to distribute to real users — the path is:

1. **Development Build** (`eas build --profile development`, already configured in
   `apps/mobile/eas.json`) — an internal build with the dev client, installed once,
   then updated via Fast Refresh like Expo Go but with full native-module support.
2. **TestFlight** (`eas build --profile preview` or `production`, then `eas submit`) —
   for internal/external testers ahead of an App Store release.

Both are separate, deliberate steps outside the scope of this document — this file only
covers same-day Expo Go iteration.
