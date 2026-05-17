<p align="center">
  <img src="https://raw.githubusercontent.com/nguyenblacks/vulajs/refs/heads/main/assets/vula.jpeg" alt="Vula.js" width="120" />
</p>

<h1 align="center">Vula.js  Experimental </h1>

<p align="center">
  A React framework built on Rspack. File-based routing, API routes, server components, and caching — all in one codebase.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@swavoti/vula"><img src="https://img.shields.io/npm/v/@swavoti/vula?color=764ba2&label=npm" alt="npm" /></a>
  <img src="https://img.shields.io/badge/runtime-Deno%20%7C%20Node-blue" alt="runtime" />
  <img src="https://img.shields.io/badge/bundler-Rspack%20(Rust)-orange" alt="bundler" />
  <img src="https://img.shields.io/badge/license-MIT-green" alt="license" />
</p>

---

## What is Vula.js?

Vula.js is a React framework for building full-stack web applications. You write your pages and your API routes in the same project, and Vula handles the rest — routing, bundling, server-side execution, caching, and security.

Your frontend code runs in the browser. Your backend code (API routes, server components) runs on the server. Vula bridges the two so you can build everything in one place without worrying about the plumbing.

It runs on both **Deno** and **Node.js**, and uses **Rspack** (a Rust-based bundler) instead of Webpack for fast builds and instant hot module replacement.

---

## Benefits

- **File-based routing** — Drop a `page.tsx` in `app/` and it becomes a route. No config files, no router setup.
- **API routes in the same codebase** — Write backend handlers in `app/api/`. They run on the server, but live right next to your frontend code.
- **Server components** — Run logic on the server and get results on the client with `Vula.server()`. No REST boilerplate needed.
- **Built-in caching** — Add `<VulaCache />` to your app and get service worker caching out of the box.
- **Security scanning** — Vula scans your code for unauthorized `<script>` tags before every build. If it's not in `vula.scripts.allow.ts`, the build fails.
- **Rspack bundling** — Rust-powered builds. Dev server starts fast, HMR is instant.
- **Deno and Node support** — Set `"runtime": "deno"` or `"runtime": "node"` in your `package.json` and Vula adapts.
- **SEO injection** — Viewport, OpenGraph, and meta tags are injected automatically into every HTML response.
- **Middleware** — Add a `middleware.ts` in your `app/` folder and it runs before every request.

---

## Quick Start

```bash
# Install globally
npm install -g @swavoti/vula

# Enter your project and install dependencies
cd my-app
deno install    # or: npm install

# Start the dev server
vula dev
```

Your app is running at `http://localhost:3000`.

---

## Project Structure

```
my-app/
├── app/
│   ├── page.tsx                   # Home page (/)
│   ├── about/
│   │   └── page.tsx               # About page (/about)
│   ├── api/
│   │   ├── hello.ts               # API route (GET /api/hello)
│   │   └── counter.sever.comp.ts  # Server component
│   └── middleware.ts              # Runs before every request
├── src/
│   ├── index.tsx                  # Client entry point
│   ├── globals.css                # Global styles
│   ├── cache.tsx                  # VulaCache component
│   └── vula.ts                    # Client bridge (Vula.server, Vula.api)
├── public/
│   └── vula-sw.js                 # Service worker for caching
├── core/
│   ├── server.js                  # Express server (API + SSR)
│   └── router/
│       └── manifest.js            # Route manifest generator
├── bin/
│   └── vula.js                    # CLI (vula dev, vula build)
├── vula.scripts.allow.ts          # Security allow list
├── rspack.config.js               # Rspack bundler config
├── tsconfig.json                  # TypeScript config
├── deno.json                      # Deno config
└── package.json
```

---

# Documentation

## Pages

Any file named `page.tsx` (or `page.jsx`) inside the `app/` directory becomes a route.

| File | Route |
|---|---|
| `app/page.tsx` | `/` |
| `app/about/page.tsx` | `/about` |
| `app/blog/page.tsx` | `/blog` |
| `app/blog/post/page.tsx` | `/blog/post` |

### Example

```tsx
// app/page.tsx
export default function Home() {
  return (
    <div>
      <h1>Home Page</h1>
      <p>Edit this file and the browser updates instantly.</p>
    </div>
  );
}
```

Vula scans `app/` on startup and generates a route manifest (`.vula-routes.json`). The client-side router uses this manifest to lazy-load the correct component based on the current URL.

---

## API Routes

Any `.ts` or `.js` file inside `app/api/` becomes an API endpoint. Export named functions for each HTTP method you want to handle.

| File | Endpoint |
|---|---|
| `app/api/hello.ts` | `/api/hello` |
| `app/api/users/index.ts` | `/api/users` |
| `app/api/users/profile.ts` | `/api/users/profile` |

### Supported Methods

Export any of these: `GET`, `POST`, `PUT`, `DELETE`, `PATCH`.

### Example

```ts
// app/api/hello.ts

export async function GET(req, res) {
  res.json({
    status: "ok",
    message: "Hello from your API",
    timestamp: new Date().toISOString(),
  });
}

export async function POST(req, res) {
  const body = req.body;
  res.json({ received: body });
}
```

API route handlers receive standard Express `req` and `res` objects. They run on the server only — they are never bundled into the client.

### Calling API Routes from the Frontend

Use the `Vula.api()` helper:

```tsx
import { Vula } from '../src/vula';

// Short form — automatically prefixes with /api/
const data = await Vula.api('hello');

// Full path
const data = await Vula.api('/api/hello');

// POST with body
const data = await Vula.api('hello', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ name: 'Vula' }),
});
```

---

## Server Components

Server components let you run logic on the server and get the result back on the client — without writing a full API route. They're useful for database queries, file access, or anything that shouldn't run in the browser.

### Naming Convention

Server component files use the extension `.sever.comp.ts` (or `.js`).

| File | Component Name |
|---|---|
| `app/api/counter.sever.comp.ts` | `api/counter` |
| `app/auth/verify.sever.comp.ts` | `auth/verify` |

### Writing a Server Component

Export a default async function:

```ts
// app/api/counter.sever.comp.ts

export default async function counter(currentValue: number) {
  return currentValue + 1;
}
```

### Calling from the Frontend

Use `Vula.server()`:

```tsx
import { Vula } from '../src/vula';

const newCount = await Vula.server('api/counter', 5);
// Returns: 6
```

The client bridge sends the arguments to the server via `POST /_vula/server-component`, the server runs the function, and returns the result as JSON.

---

## Middleware

Create a `middleware.ts` (or `.js`) in the root of your `app/` directory. It runs before every incoming request.

```ts
// app/middleware.ts

export default function middleware(req, res, next) {
  console.log(`${req.method} ${req.url}`);
  next();
}
```

Common uses:
- Request logging
- Authentication checks
- CORS headers
- Rate limiting

The middleware receives standard Express `req`, `res`, and `next` arguments.

---

## Caching (Service Worker)

Vula includes a built-in service worker for asset caching. Add the `<VulaCache />` component anywhere in your app to enable it.

```tsx
import { VulaCache } from '../src/cache';

export default function Layout() {
  return (
    <div>
      <VulaCache />
      {/* your content */}
    </div>
  );
}
```

### How It Works

- On first load, the service worker caches your HTML and JS bundles.
- On subsequent visits, assets are served from cache first, then updated in the background.
- API routes (`/api/*`) and server component calls (`/_vula/*`) are **never cached** — they always hit the server.
- When you deploy a new version, old caches are automatically cleaned up.

The service worker lives at `public/vula-sw.js`. You can customize it if you need different caching strategies.

---

## Security (Script Allow List)

Vula scans all `.tsx` and `.jsx` files in `app/` for `<script>` tags before every `dev` and `build` run. If a script source isn't listed in `vula.scripts.allow.ts`, the process exits with an error.

### The Allow List

```ts
// vula.scripts.allow.ts

export const ALLOWED_SCRIPTS: string[] = [
  "https://fonts.googleapis.com",
  "https://www.googletagmanager.com/gtag/js",
];
```

### What Happens on Violation

```
[vula] BLOCKED: Unverified script in page.tsx: https://evil.com/inject.js
[vula] Add it to vula.scripts.allow.ts or remove it.
```

The build stops. Your users' browsers are protected.

---

## SEO

Vula automatically injects meta tags into every HTML response served by the dev server and production server:

```html
<meta name="generator" content="vula-1.0.3" />
<meta property="og:type" content="website" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
```

For page-specific SEO (title, description, og:image), set them in your `page.tsx` using standard `<head>` elements or a `<Helmet>`-style library.

---

## CLI Reference

| Command | Description |
|---|---|
| `vula dev` | Start the development server on port 3000 |
| `vula build` | Build for production using Rspack |

### `vula dev`

1. Runs security checks (script allow list)
2. Runs ESLint (if installed)
3. Generates the route manifest
4. Starts the Express server with Rspack dev middleware

### `vula build`

1. Runs security checks
2. Runs ESLint
3. Generates the route manifest
4. Runs `rspack build` to produce a production bundle in `dist/`

---

## Runtime Configuration

Set the runtime in your `package.json`:

```json
{
  "runtime": "deno"
}
```

| Value | Behavior |
|---|---|
| `"deno"` | Uses Deno to run Rspack CLI commands |
| `"node"` (default) | Uses npx to run Rspack CLI commands |

Both runtimes use the same codebase, the same `app/` directory, and the same API route handlers.

---

## Configuration Files

### `rspack.config.js`

Standard Rspack configuration. Vula sets up SWC for TypeScript/JSX, CSS handling, React Refresh for HMR, and the `@app` alias for the `app/` directory.

### `tsconfig.json`

TypeScript config with `react-jsx` transform, path aliases, and type references.

### `deno.json`

Deno-specific config for JSX support and `node_modules` directory mode.

---

## Customizing HTML Template

Vula.js uses an `index.html` file as a template for your application. By default, it looks for this file in the **root** of your project.

### Automatic Script Injection

You **do not** need to manually add `<script>` tags to your `index.html`. Rspack automatically detects all entry points (like `src/index.tsx`) and injects the necessary `<script>` and `<link>` tags for you during the build process.

```html
<!-- index.html (Project Root) -->
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>My Vula App</title>
</head>
<body>
    <div id="root"></div>
    <!-- No manual script tags needed! -->
</body>
</html>
```

### Why avoid `public/index.html`?

If you place an `index.html` file inside the `public/` directory, it will be served as a raw static file. Because it hasn't been processed by Rspack, it will **not** have the automatic script injections, which usually results in a blank page.

Always keep your template in the project root and let Vula.js handle the injection for you.

---

## TypeScript in Vula

Vula uses TypeScript everywhere. Here's what you need to know.

### Pages

Pages are `.tsx` files. They export a default React component. No special types needed:

```tsx
// app/dashboard/page.tsx
export default function Dashboard() {
  return <h1>Dashboard</h1>;
}
```

### API Route Types

API handlers receive Express `Request` and `Response` objects. Import the types:

```ts
// app/api/users.ts
import type { Request, Response } from 'express';

export async function GET(req: Request, res: Response) {
  const users = [{ id: 1, name: "Alice" }];
  res.json(users);
}

export async function POST(req: Request, res: Response) {
  const { name } = req.body;
  // save to database...
  res.status(201).json({ id: 2, name });
}
```

### Server Component Types

Server components are just functions. Type them however you want:

```ts
// app/api/math.sever.comp.ts
interface CalcInput {
  a: number;
  b: number;
  op: 'add' | 'subtract' | 'multiply';
}

export default async function calculate(input: CalcInput): Promise<number> {
  switch (input.op) {
    case 'add': return input.a + input.b;
    case 'subtract': return input.a - input.b;
    case 'multiply': return input.a * input.b;
  }
}
```

---

## Environment Variables

Vula uses `dotenv` to load variables from a `.env` file in your project root.

### Setup

Create a `.env` file:

```
DATABASE_URL=postgres://localhost:5432/mydb
API_SECRET=supersecretkey123
PUBLIC_APP_NAME=My Vula App
```

### Usage in API Routes

```ts
// app/api/db.ts
import type { Request, Response } from 'express';

export async function GET(req: Request, res: Response) {
  const dbUrl = process.env.DATABASE_URL;
  // use dbUrl to connect...
  res.json({ connected: true });
}
```

### Security

Environment variables are **server-only**. They are available in:
- API routes (`app/api/*.ts`)
- Server components (`*.sever.comp.ts`)
- Middleware (`app/middleware.ts`)

They are **never** sent to the browser. The Rspack bundler only bundles what's in `src/` and `app/page.tsx` files — it does not have access to `process.env` at build time unless you explicitly configure it.

---

## Error Handling

### API Routes

Vula wraps every API handler in a try/catch. If your handler throws, the server responds with `500 Internal Server Error` and logs the error:

```ts
export async function GET(req: Request, res: Response) {
  throw new Error("Something broke");
  // Client receives: { "error": "Internal Server Error" }
  // Server logs the full stack trace
}
```

To return custom errors:

```ts
export async function GET(req: Request, res: Response) {
  const user = await findUser(req.query.id);
  if (!user) {
    return res.status(404).json({ error: "User not found" });
  }
  res.json(user);
}
```

### Server Components

If a server component throws, the client bridge (`Vula.server()`) rejects with an error:

```tsx
try {
  const result = await Vula.server('api/riskyAction', data);
} catch (err) {
  // err.message = "Server component execution failed"
  console.error(err);
}
```

### Client-Side Errors

For React rendering errors, use standard React error boundaries:

```tsx
// app/error-boundary.tsx
import React from 'react';

export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return <div>Something went wrong.</div>;
    }
    return this.props.children;
  }
}
```

---

## Deployment

### Build for Production

```bash
vula build
```

This produces a `dist/` directory with your bundled frontend.

### Run in Production

Set `NODE_ENV=production` and start the server:

```bash
NODE_ENV=production node bin/vula.js dev
```

In production mode, the server serves static files from `dist/` instead of running Rspack dev middleware.

### Docker

```dockerfile
FROM node:20-alpine

WORKDIR /app
COPY . .
RUN npm install
RUN npx vula build

ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "bin/vula.js", "dev"]
```

### Platform Support

Vula runs anywhere Node.js or Deno runs:
- Linux servers
- Docker containers
- Vercel (with custom server adapter)
- Railway, Render, Fly.io
- Any VPS

---

## How the Bridge Works (Architecture)

Understanding how Vula connects the frontend and backend:

```
Browser (Client)                    Server (Node/Deno)
─────────────────                   ──────────────────
app/page.tsx          ──build──►    dist/main.js (bundled)
src/vula.ts           ──build──►    (included in bundle)
src/cache.tsx         ──build──►    (included in bundle)

                      ──HTTP──►
Vula.api('hello')     ─────────►    app/api/hello.ts (runs here)
Vula.server('x', 5)   ─────────►    app/api/x.sever.comp.ts (runs here)

app/middleware.ts                    (runs on every request)
```

**Pages** (`page.tsx`) are bundled by Rspack and served as client-side React.

**API routes** (`app/api/*.ts`) are loaded by the Express server and executed when their matching URL is hit.

**Server components** (`*.sever.comp.ts`) are loaded by the Express server and executed when called via `Vula.server()` from the client.

**The manifest** (`.vula-routes.json`) is the glue. The CLI scans `app/` and generates this file. The client router uses it to find pages. The server uses it to find API handlers and server components.

---

## Comparison with Next.js

| Feature | Next.js | Vula.js |
|---|---|---|
| Bundler | Webpack / Turbopack | Rspack (Rust) |
| Runtime | Node.js only | Deno + Node.js |
| Routing | File-based (`app/`) | File-based (`app/`) |
| API Routes | `route.ts` with Web API | `hello.ts` with Express API |
| Server Components | React Server Components | `.sever.comp.ts` files |
| Caching | ISR / revalidate | Service Worker (client) |
| Security | None built-in | Script allow list |
| Middleware | `middleware.ts` | `middleware.ts` |
| Config | `next.config.js` | `rspack.config.js` |
| Package size | ~300MB node_modules | ~100MB node_modules |

---

## FAQ

### Do I need Deno?

No. Set `"runtime": "node"` in your `package.json` and use `npm install` + `npx vula dev`. Deno is optional but recommended for its security model and native TypeScript support.

### Can I use a database?

Yes. API routes and server components run on the server with full Node.js/Deno API access. Use any database driver: Prisma, Drizzle, pg, mongoose, etc.

### Can I use Tailwind CSS?

Yes. Install Tailwind and `postcss-loader`, then update the CSS rule in `rspack.config.js` to use `postcss-loader` with the Tailwind plugin.

### Where do static files go?

Put them in `public/`. They're served at the root URL. Example: `public/logo.png` → `http://localhost:3000/logo.png`.

### Can I deploy to Vercel?

Vula uses Express for the server, so you'd need to adapt it with Vercel's custom server support or deploy as a standalone Node process on Vercel.

### How do I add authentication?

Use `app/middleware.ts` to check auth tokens on every request, or check auth inside individual API route handlers.

### Can I use React libraries?

Yes. Vula pages are standard React components. Use any React library: React Router (for client-side routing), React Query, Zustand, Framer Motion, etc.

---

## Troubleshooting

### JSX Type Errors in Deno
If you see errors like `JSX element implicitly has type 'any'` or `no interface 'JSX.IntrinsicElements' exists` while using Deno, it means the Deno language server is struggling with strict types for React.

**Solution**: Add `"strict": false` to your `deno.json` or `tsconfig.json`:

```json
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "react",
    "strict": false
  }
}
```

### Security Patch: React 19.2.6
We strongly recommend using **React 19.2.6** or higher. Older versions (like 18.2.0) contain known vulnerabilities that are patched in the 19.x branch. Vula.js defaults to 19.2.6 for all new projects to ensure your application is secure.

---

## Contributing

1. Fork the repo
2. Create a branch: `git checkout -b feature/my-feature`
3. Make your changes
4. Test: `vula dev` and verify everything works
5. Push and open a PR

---

## License

MIT © [Swavoti](https://github.com/nguyenblacks/vulajs)

---

**Swavoti** is a trademark and its assets are a trademark of **Swavoti South Africa Pty Ltd**.

