# Vula.js Troubleshooting Guide (`@swavoti/vula`)

Use this guide to diagnose and resolve common issues with navigation performance, WebSocket streaming, security headers, HMR, and production deployments.

---

## 1. Slow Navigation or Delayed UI Updates

### Check Your Internet Connection First
If page navigation or interactive UI updates feel slow or delayed:

> **First check the user's internet connection (network latency / ping, packet loss, unstable Wi-Fi/mobile data, or VPN/proxy throttling).**

**Why this matters in Vula.js:**
- Vula's navigation and global DOM engine use **highly optimized, on-demand WebSockets (`/_vula/stream/ws`)** and **WASM LZSS-compressed route payloads (`/_vula/route`)**.
- Nothing is pre-bloated into a massive client bundle—pages, route payloads, and surgical DOM subtree chunks (`dom-patch` / `dom-sync`) are **loaded strictly on demand** when the user clicks or navigates.
- Because on-demand streaming sends compact WebSocket frames at the exact moment of interaction, **network round-trip time (RTT) and connection stability** directly determine how fast the on-demand packet travels between the browser and server:
  1. **Test network latency & jitter:** High ping (`>250ms`), packet loss, or captive portals delay WebSocket frames.
  2. **Disable aggressive VPNs or corporate HTTP proxies:** Some proxies buffer WebSocket frames instead of flushing them immediately.
  3. **Check DevTools Network → WS tab:** Inspect `/_vula/stream/ws` messages. Server compilation itself typically completes in `<5–30ms` (logged in DevTools as `[vula] compiled /path in Xms`); if the delay is higher than the logged server `ms`, the bottleneck is the network connection between the client and host.

---

## 2. Buttons or Links Don't Respond While Page Is Still Loading

### What Is Happening
Vula paints the SSR HTML shell immediately so the user sees the visual page right away (`[vula] UI painted — interactive DOM incoming for /...`), while the interactive DOM session (`data-vula-dom="incoming"`) connects on demand in the background.

### How Vula Handles It
- `#root` carries `data-vula-dom="incoming"` while the interactive DOM is connecting and transitions to `data-vula-dom="ready"` once ready (`[vula] interactive DOM ready (...) in Xms`).
- Early clicks on links or buttons during `data-vula-dom="incoming"` are **silently queued** and automatically replayed the instant the initial `dom-sync` arrives.
- Vula **never** injects spinners or overrides cursors on your site—if you want a visual loading state while `data-vula-dom="incoming"`, you can style `[data-vula-dom="incoming"]` in your own CSS.

---

## 3. WebSocket Connection Fails (`403 Forbidden` or Close Code `1008`)

### Symptoms
- Browser console shows WebSocket connection failure to `ws://.../ _vula/stream/ws?ticket=...`
- Server responds with `403 Forbidden (CSRF origin check failed)` on `POST /_vula/stream/ticket`

### Fixes
1. **Behind Nginx, Caddy, Cloudflare, Railway, Fly.io, or Render:**
   Set `trust-proxy: true` in `vulaism.config.yaml` so Express trusts `X-Forwarded-Proto` and `X-Forwarded-Host`:
   ```yaml
   server:
     trust-proxy: true
   ```
2. **Custom Domains or Cross-Origin Embeds:**
   Add your allowed origin(s) in `vulaism.config.yaml`:
   ```yaml
   security:
     csrf: true
     allowed-origins:
       - "https://yourdomain.com"
   ```
3. **Reverse Proxy Missing WebSocket Upgrade Headers:**
   Ensure your reverse proxy forwards `Upgrade: websocket` and `Connection: upgrade` headers (see [deploy.md](./deploy.md)).

---

## 4. Headless Chromium Not Found (`Could not locate a Chrome/Chromium binary`)

### Symptoms
When `streaming.enabled: true` and `streaming.global: true`, the server logs that it cannot find a Chromium/Chrome binary.

### Fixes
1. Install Chromium on your machine or container:
   ```bash
   # Debian / Ubuntu
   sudo apt-get update && sudo apt-get install -y chromium
   ```
2. Or point Vula to a custom browser binary via `VULA_CHROME_PATH`:
   ```bash
   export VULA_CHROME_PATH=/usr/bin/chromium
   ```
3. If deploying to an environment where Chromium cannot be installed, disable global headless streaming in `vulaism.config.yaml`:
   ```yaml
   streaming:
     enabled: false
     global: false
   ```

---

## 5. Server Component RPC Returns `401 Unauthorized` (`*.sever.comp.ts`)

### Symptoms
Calling `Vula.server('api/my-action', payload)` returns `401 Unauthorized`.

### Fixes
By default, `security.server-component-auth: true` protects all `*.sever.comp.ts` modules from unauthenticated invocation. Choose one of the following:
1. **Mark a public Server Component explicitly** in your `*.sever.comp.ts` file:
   ```ts
   export const isPublic = true;
   ```
2. **Or implement custom authorization** in your `*.sever.comp.ts` file:
   ```ts
   export async function authorize(req: any) {
     return Boolean(req.cookies?.session_token);
   }
   ```
3. **Or disable the global requirement** in `vulaism.config.yaml` if all server components in your app are public:
   ```yaml
   security:
     server-component-auth: false
   ```

---

## 6. Hot Module Reload (HMR) or Route Changes Not Updating in `vula dev`

### Fixes
1. **New route files (`app/.../page.tsx` or `app/api/*.ts`):**
   Vula automatically regenerates `.vula-routes.json` when files are added/removed in `app/`. If `.vula-routes.json` was deleted manually, restart `vula dev` or run `vula build`.
2. **Check the Dev Error Overlay & Console:**
   In `vula dev`, syntax or SSR errors open the pure-white Vula error overlay showing the exact file and stack trace, and compilation timings are logged in both the terminal and browser console (`[vula] compiling ...` / `[vula] compiled ... in Xms`). Fix the reported syntax/type error and save the file to trigger an automatic in-place HMR refresh.
