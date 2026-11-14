# Deploying Vula.js (`@swavoti/vula`)

This guide covers deploying a **Vula.js** application to production across all major cloud, container, VPS, and PaaS hosting providers.

---

## 1. Production Build & Start Checklist

Before deploying to any provider, verify your `package.json` scripts and `vulaism.config.yaml`:

### `package.json`
```json
{
  "scripts": {
    "dev": "vula dev",
    "build": "vula build",
    "start": "vula start"
  }
}
```

- **`vula build`**: Generates `.vula-routes.json`, compiles client/SSR bundles into `.swvula/`, and prepares WASM route tables.
- **`vula start`**: Starts the production Vula.js HTTP + WebSocket server with `NODE_ENV=production` (dev error overlays and `/__vula_dev_ws` are strictly disabled).

### Choosing Your Rendering Mode (`vulaism.config.yaml`)

Vula.js supports two production modes:

1. **Global Server-Side DOM & Canvas Streaming (Default — Recommended for Containers & VPS)**
   ```yaml
   streaming:
     enabled: true
     global: true
   server:
     port: 3000
     trust-proxy: true
   ```
   - Keeps application logic on the server and streams on-demand DOM patches (`dom-patch` / `dom-sync`) over a persistent WebSocket (`/_vula/stream/ws`).
   - **Host requirements:** Persistent WebSocket support + Chromium/Chrome installed in the container or VM.

2. **Standard SSR + Client Router + WASM LZSS Compression (For Serverless / Lightweight Hosts without Chromium)**
   ```yaml
   streaming:
     enabled: false
     global: false
   server:
     port: 3000
     trust-proxy: true
   ```
   - Streams React 19 SSR HTML on initial request and uses the WASM trie router + LZSS-compressed `/_vula/route` payloads for client navigation without requiring headless Chromium.

---

## 2. Docker (Universal Container Deployment)

Use this `Dockerfile` for **Railway, Render, Fly.io, Google Cloud Run, AWS ECS/App Runner, DigitalOcean App Platform, or Kubernetes**:

```dockerfile
FROM node:22-bookworm-slim

# Install Chromium for Vula Global DOM & Canvas Streaming
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV VULA_CHROME_PATH=/usr/bin/chromium
ENV PORT=3000

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npx vula build

EXPOSE 3000

CMD ["npx", "vula", "start", "--port", "3000"]
```

Build and run locally:
```bash
docker build -t my-vula-app .
docker run -p 3000:3000 -e NODE_ENV=production my-vula-app
```

---

## 3. Railway

Railway supports persistent WebSockets and Dockerfiles out of the box.

1. Push your Vula.js repository to GitHub (include the `Dockerfile` above, or use Nixpacks).
2. In the **Railway Dashboard**, click **New Project → Deploy from GitHub repo**.
3. In **Variables**, set:
   - `NODE_ENV=production`
   - `PORT=3000`
   - `VULA_CHROME_PATH=/usr/bin/chromium` (if using Docker/apt Chromium)
4. In `vulaism.config.yaml`, ensure `server.trust-proxy: true` so Railway's TLS proxy forwards `X-Forwarded-Proto: https` accurately for CSRF and WebSocket origin checks.
5. Generate a public domain under **Settings → Networking** targeting port `3000`.

---

## 4. Render

1. In the **Render Dashboard**, click **New + → Web Service** and connect your GitHub repository.
2. Select **Docker** as the Runtime (recommended for Global DOM Streaming with Chromium) or **Node** (if `streaming.global: false`):
   - **Build Command (Node runtime):** `npm ci && npx vula build`
   - **Start Command (Node runtime):** `npx vula start --port $PORT`
3. Set Environment Variables:
   - `NODE_ENV=production`
4. In `vulaism.config.yaml`, set `server.trust-proxy: true`.

---

## 5. Fly.io

Fly.io runs micro-VMs close to users with native WebSocket support and low-latency TCP routing.

1. Install `flyctl` and initialize your app:
   ```bash
   fly launch --no-deploy
   ```
2. Ensure your `Dockerfile` is in the project root and verify `fly.toml`:
   ```toml
   app = "my-vula-site"
   primary_region = "iad"

   [env]
     NODE_ENV = "production"
     PORT = "3000"
     VULA_CHROME_PATH = "/usr/bin/chromium"

   [http_service]
     internal_port = 3000
     force_https = true
     auto_stop_machines = "suspend"
     auto_start_machines = true
     min_machines_running = 1
   ```
3. Set `server.trust-proxy: true` in `vulaism.config.yaml`.
4. Deploy:
   ```bash
   fly deploy
   ```

---

## 6. DigitalOcean (App Platform & Droplets)

### Option A: DigitalOcean App Platform
1. Create a new App from your GitHub repo using the `Dockerfile`.
2. Set HTTP Port to `3000` and `NODE_ENV=production`.
3. Set `server.trust-proxy: true` in `vulaism.config.yaml`.

### Option B: Ubuntu Droplet / VPS (Hetzner, Linode, DigitalOcean, EC2)
1. Install Node.js 22+, Chromium, PM2, and Nginx/Caddy:
   ```bash
   sudo apt update && sudo apt install -y chromium nginx
   npm install -g pm2
   ```
2. Build and start your app with PM2:
   ```bash
   npm ci
   npx vula build
   NODE_ENV=production pm2 start "npx vula start --port 3000" --name vula-site
   pm2 save
   ```
3. Configure **Nginx** with WebSocket `Upgrade` headers (required for `/_vula/stream/ws`):
   ```nginx
   server {
       listen 80;
       server_name example.com;

       location / {
           proxy_pass http://127.0.0.1:3000;
           proxy_http_version 1.1;
           proxy_set_header Upgrade $http_upgrade;
           proxy_set_header Connection "upgrade";
           proxy_set_header Host $host;
           proxy_set_header X-Real-IP $remote_addr;
           proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
           proxy_set_header X-Forwarded-Proto $scheme;
           proxy_read_timeout 86400s;
           proxy_send_timeout 86400s;
       }
   }
   ```
   *(Or use **Caddy**, which proxies WebSockets and HTTPS automatically with a 3-line `Caddyfile`: `example.com { reverse_proxy localhost:3000 }`.)*

---

## 7. Google Cloud Run

Cloud Run supports concurrent HTTP + WebSocket connections in container instances.

1. Build and push the container image, or deploy directly from source:
   ```bash
   gcloud run deploy my-vula-site \
     --source . \
     --region us-central1 \
     --allow-unauthenticated \
     --port 3000 \
     --memory 1Gi \
     --cpu 2 \
     --timeout 3600 \
     --set-env-vars="NODE_ENV=production,VULA_CHROME_PATH=/usr/bin/chromium"
   ```
2. Set `--timeout 3600` (up to 60 minutes) so active WebSocket DOM streaming sessions are not terminated prematurely.
3. Ensure `server.trust-proxy: true` in `vulaism.config.yaml`.

---

## 8. AWS (App Runner / ECS Fargate)

1. Push your Docker image to **Amazon ECR**.
2. Create an **AWS App Runner** service or **ECS Fargate** task definition with:
   - Port: `3000`
   - CPU/Memory: at least `1 vCPU / 2 GB RAM` when running Chromium streaming
   - Environment: `NODE_ENV=production`, `VULA_CHROME_PATH=/usr/bin/chromium`
3. If using an Application Load Balancer (ALB) in front of ECS:
   - Enable **Stickiness** on the Target Group if running multiple tasks.
   - Increase ALB **Idle Timeout** to `300`–`3600` seconds for WebSocket streams.
   - Set `server.trust-proxy: true` in `vulaism.config.yaml`.

---

## 9. Vercel & Netlify

Because Vercel and Netlify serverless functions are stateless and do not run persistent WebSocket daemons or a background Chromium process:

1. If deploying directly to serverless functions, set `streaming.enabled: false` and `streaming.global: false` in `vulaism.config.yaml` so Vula runs in **Standard SSR + WASM Client Router** mode (`/_vula/route`).
2. If you want **Global Server-Side DOM Streaming** (`streaming.global: true`) or `*.stream.ts` surfaces, host the Vula server on **Railway, Fly.io, Render, Cloud Run, or a VPS** and point your custom domain (or Vercel/Netlify rewrite proxy) to that container.
