const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { Writable } = require('node:stream');
const { loadConfig } = require('./config.js');

try { require('esbuild-register'); } catch (_) {}
try { require('dotenv').config(); } catch (_) {}

const MAX_RPC_ARGS = 32;
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const ALLOWED_FONT_DISPLAY = new Set(['auto', 'block', 'swap', 'fallback', 'optional']);

// HTML escape utility — prevents config values from injecting HTML/JS into pages
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function sanitizeIconPath(icon) {
  if (typeof icon !== 'string') return null;
  const trimmed = icon.trim();
  if (!trimmed || trimmed.includes('://') || trimmed.startsWith('//')) return null;
  const lower = trimmed.toLowerCase();
  if (lower.startsWith('javascript:') || lower.startsWith('data:') || lower.startsWith('vbscript:')) {
    return null;
  }
  if (trimmed.includes('..') || trimmed.includes('\0')) return null;
  return '/' + trimmed.replace(/^\/+/, '');
}

function sanitizeRpcValue(value, depth = 0) {
  if (depth > 32) {
    throw new Error('RPC argument nesting exceeds maximum depth');
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeRpcValue(item, depth + 1));
  }
  const clean = {};
  for (const key of Object.keys(value)) {
    if (DANGEROUS_KEYS.has(key)) continue;
    clean[key] = sanitizeRpcValue(value[key], depth + 1);
  }
  return clean;
}

function buildCspHeader(cspConfig, nonce, isDev, experimentalConfig) {
  if (cspConfig === false) return null;
  if (typeof cspConfig === 'string' && cspConfig.trim()) {
    return cspConfig.trim();
  }
  const scriptSrc = ["'self'", `'nonce-${nonce}'`];
  if (isDev) {
    scriptSrc.push("'unsafe-eval'");
  }
  const streamEnabled = Boolean(experimentalConfig && experimentalConfig['webrtc-stream']);
  const connectSrc = (isDev || streamEnabled) ? "'self' ws: wss:" : "'self'";
  return [
    "default-src 'self'",
    `script-src ${scriptSrc.join(' ')}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com data:",
    "img-src 'self' data: blob:",
    `connect-src ${connectSrc}`,
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'self'",
  ].join('; ');
}

function injectHeadTags(html, config, vulaVersion = 'unknown') {
  if (typeof html !== 'string' || !html.includes('</head>')) return html;

  const iconPath = config.app.icon ? sanitizeIconPath(config.app.icon) : null;
  const fontPreload = config.optimization['font-preload'];
  const fontDisplay = config.optimization['font-display'] || 'swap';
  const appName = escapeHtml(config.app.name || 'Vula App');
  const lang = escapeHtml(config.app.lang || 'en');

  let tags = `
    <meta name="generator" content="vula-${escapeHtml(vulaVersion)}" />
    <meta property="og:type" content="website" />
    <meta property="og:title" content="${appName}" />`;

  if (!/<meta[^>]+name=["']viewport["']/i.test(html)) {
    tags += `
    <meta name="viewport" content="width=device-width, initial-scale=1" />`;
  }

  if (iconPath && !html.includes(`href="${escapeHtml(iconPath)}"`)) {
    tags += `
    <link rel="icon" href="${escapeHtml(iconPath)}" />`;
  }

  if (fontPreload) {
    const safeFontDisplay = ALLOWED_FONT_DISPLAY.has(fontDisplay) ? fontDisplay : 'swap';
    tags += `
    <style>@font-face { font-display: ${safeFontDisplay}; }</style>`;
  }

  let out = html;
  if (!/<html[^>]+lang=/i.test(out)) {
    out = out.replace('<html', `<html lang="${lang}"`);
  }
  return out.replace('</head>', tags + '\n  </head>');
}

function serveSwvulaAssets(swvulaDir, isDev, expressLib = require('express')) {
  const allowedDotfiles = new Set(['/.vula.cache.js', '/.vula.cache.css']);
  if (isDev) {
    allowedDotfiles.add('/.vula.cache.js.map');
    allowedDotfiles.add('/.vula.cache.css.map');
  }
  const staticHandler = expressLib.static(swvulaDir, { index: false, dotfiles: 'deny' });

  return function swvulaMiddleware(req, res, next) {
    if (allowedDotfiles.has(req.path)) {
      const filePath = path.join(swvulaDir, req.path.slice(1));
      if (fs.existsSync(filePath)) {
        return res.sendFile(filePath);
      }
      return next();
    }
    return staticHandler(req, res, next);
  };
}

function createSecurityMiddleware({ config, isDev = false, vulaVersion = 'unknown' }) {
  return function securityAndMetaMiddleware(req, res, next) {
    const nonce = crypto.randomBytes(16).toString('base64');
    res.locals = res.locals || {};
    res.locals.cspNonce = nonce;

    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');

    const cspHeader = buildCspHeader(
      config.security['content-security-policy'],
      nonce,
      isDev,
      config.experimental
    );
    if (cspHeader) {
      res.setHeader('Content-Security-Policy', cspHeader);
    }

    if (config.optimization['text-opt']) {
      res.setHeader('X-Text-Opt', 'enabled');
      res.setHeader('Vary', 'Accept-Encoding');
    }

    if (typeof res.send === 'function') {
      const originalSend = res.send.bind(res);
      res.send = function (body) {
        if (typeof body === 'string' && body.includes('</head>')) {
          body = injectHeadTags(body, config, vulaVersion);
        }
        return originalSend(body);
      };
    }
    next();
  };
}

function createServerComponentHandler({ manifest, config, getAuthHook }) {
  return async function serverComponentHandler(req, res) {
    const contentType = typeof req.is === 'function'
      ? req.is('application/json')
      : String(req.headers?.['content-type'] || '').toLowerCase().includes('application/json');
    if (!contentType) {
      return res.status(415).json({ error: 'Content-Type must be application/json' });
    }
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Invalid request body' });
    }

    const { name, args } = req.body;

    // Input validation — prevent prototype pollution and path traversal via name
    if (
      typeof name !== 'string' ||
      name.length === 0 ||
      name.length > 200 ||
      name.startsWith('/') ||
      name.includes('..') ||
      name.includes('\\') ||
      name.includes('\0') ||
      !/^[a-zA-Z0-9_/-]+$/.test(name)
    ) {
      return res.status(400).json({ error: 'Invalid server component name' });
    }
    if (args !== undefined && (!Array.isArray(args) || args.length > MAX_RPC_ARGS)) {
      return res.status(400).json({ error: `args must be an array with at most ${MAX_RPC_ARGS} items` });
    }

    if (!manifest.serverComponents || !manifest.serverComponents.length) {
      return res.status(404).json({ error: 'No server components registered' });
    }
    const comp = manifest.serverComponents.find(c => c.name === name);
    if (!comp) {
      return res.status(404).json({ error: 'Server component not found' });
    }

    let safeArgs;
    try {
      safeArgs = sanitizeRpcValue(args || []);
    } catch (err) {
      return res.status(400).json({ error: 'Invalid server component arguments' });
    }

    try {
      const handler = require(comp.path);
      const fn = handler.default || handler;
      if (typeof fn !== 'function') {
        return res.status(500).json({ error: 'Invalid server component handler' });
      }

      if (typeof handler.authorize === 'function') {
        const authorized = await handler.authorize(req);
        if (!authorized) {
          return res.status(403).json({ error: 'Forbidden' });
        }
      } else if (config.security['server-component-auth'] !== false && handler.isPublic !== true) {
        let isAuthenticated = Boolean(
          req.user ||
          req.auth ||
          req.session?.user ||
          req.session?.authenticated
        );
        const authHook = typeof getAuthHook === 'function' ? getAuthHook() : null;
        if (!isAuthenticated && typeof authHook === 'function') {
          isAuthenticated = Boolean(await authHook(req));
        }
        if (!isAuthenticated) {
          return res.status(401).json({ error: 'Authentication required for server component execution' });
        }
      }

      const result = await fn(...safeArgs);
      res.json({ result });
    } catch (err) {
      console.error('[vula] Server component error:', err);
      // Never leak internal error messages to the client
      res.status(500).json({ error: 'Server component execution failed' });
    }
  };
}

function streamReactSsrResponse({
  res,
  renderToPipeableStream,
  element,
  nonce,
  htmlHead,
  htmlTail,
  bootstrapScripts = ['/.vula.cache.js'],
}) {
  let didError = false;
  const { pipe, abort } = renderToPipeableStream(element, {
    nonce,
    bootstrapScripts,
    onShellReady() {
      if (res.destroyed || res.writableEnded) return;
      res.status(didError ? 500 : 200);
      res.set('content-type', 'text/html; charset=utf-8');
      res.write(htmlHead);

      const bodyStream = new Writable({
        write(chunk, encoding, callback) {
          if (!res.writableEnded && !res.destroyed) {
            res.write(chunk, encoding, callback);
          } else {
            callback();
          }
        },
        final(callback) {
          if (!res.writableEnded && !res.destroyed) {
            res.write(htmlTail);
            res.end();
          }
          callback();
        },
      });

      bodyStream.on('error', (err) => {
        console.error('[vula] SSR stream error:', err);
        if (!res.writableEnded && !res.destroyed) res.end();
      });

      pipe(bodyStream);
    },
    onShellError(err) {
      console.error('[vula] SSR shell error:', err);
      if (!res.headersSent) {
        res.status(500).send('<!DOCTYPE html><html><body><h1>500 Internal Server Error</h1></body></html>');
      } else if (!res.writableEnded && !res.destroyed) {
        res.end();
      }
    },
    onError(err) {
      didError = true;
      console.error('[vula] SSR Error:', err);
    },
  });

  res.on('close', () => {
    if (!res.writableFinished) {
      abort();
    }
  });
}

function buildDevWsScript(nonce) {
  return `
<script nonce="${escapeHtml(nonce)}">
  (function() {
    var currentVula = 'unknown';
    var latestVula  = 'unknown';

    // ── Noise filter ──────────────────────────────────────────────────────────
    var IGNORED = [
      'Problem communicating active modules to the server',
      'lazy-compilation',
      '__webpack_hmr',
    ];
    function isSilenced(msg) {
      var s = (msg || '').toString();
      return IGNORED.some(function(p) { return s.includes(p); });
    }

    // ── DOM helpers ───────────────────────────────────────────────────────────
    function esc(s) { return (s||'').toString().replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

    function dismiss() {
      var el = document.getElementById('__vula_overlay__');
      if (el) el.remove();
    }

    function renderOverlay(title, msg, filename) {
      if (isSilenced(msg)) return;

      var el = document.getElementById('__vula_overlay__');
      if (!el) {
        el = document.createElement('div');
        el.id = '__vula_overlay__';
        document.body.appendChild(el);
      }
      el.style.cssText = [
        'position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;padding:24px',
        'background:rgba(8,12,22,.72);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px)',
        'font:14px/1.55 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#e5e7eb',
      ].join(';');

      el.innerHTML = '<section style="width:min(100%,680px);max-height:80vh;overflow:auto;background:#111827;border:1px solid #374151;border-radius:16px;box-shadow:0 24px 80px rgba(0,0,0,.45)">'
        + '<header style="display:flex;align-items:center;justify-content:space-between;gap:16px;padding:18px 20px;border-bottom:1px solid #273244">'
        + '<div><div style="display:flex;align-items:center;gap:9px"><span style="font-weight:700;color:#f9fafb">Vula</span><span style="color:#6b7280">/</span><span style="font-weight:600;color:#fca5a5">' + esc(title) + '</span></div>'
        + '<div style="margin-top:5px;font-size:12px;color:#9ca3af">Development error' + (currentVula !== 'unknown' ? ' · Vula v' + esc(currentVula) : '') + '</div></div>'
        + '<button id="__vula_dismiss__" aria-label="Close error overlay" style="border:1px solid #374151;border-radius:9px;background:#1f2937;color:#d1d5db;padding:7px 11px;cursor:pointer;font:inherit">Close</button>'
        + '</header><div style="padding:18px 20px">'
        + (filename ? '<div style="margin-bottom:10px;color:#c4b5fd;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere">' + esc(filename) + '</div>' : '')
        + '<pre id="__vula_error_text__" style="margin:0;max-height:52vh;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;background:#0b1220;border:1px solid #273244;border-radius:10px;padding:14px;color:#e5e7eb;font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace">' + esc(msg) + '</pre>'
        + '<div style="display:flex;justify-content:flex-end;margin-top:14px"><button id="__vula_copy__" style="border:0;border-radius:9px;background:#4f46e5;color:white;padding:8px 13px;cursor:pointer;font:600 12px ui-sans-serif,system-ui">Copy details</button></div>'
        + '</div></section>';

      document.getElementById('__vula_dismiss__').onclick = dismiss;
      document.getElementById('__vula_copy__').onclick = function() {
        var btn = this;
        if (!navigator.clipboard) return;
        navigator.clipboard.writeText((title || '') + '\\n' + (filename || '') + '\\n' + (msg || '')).then(function() {
          btn.textContent = 'Copied';
          setTimeout(function() { btn.textContent = 'Copy details'; }, 1600);
        }).catch(function(err) { console.error('[vula] Could not copy error details:', err); });
      };
    }

    // Warn once when app code bypasses Vula's navigation API.
    var warnedNavigation = false;
    function warnNavigation(destination) {
      if (warnedNavigation) return;
      warnedNavigation = true;
      console.warn('[Vula] Browser navigation via href or another router is deprecated for internal pages. Use <VulaLink page="' + destination + '"> to keep navigation in Vula.');
    }
    document.addEventListener('click', function(event) {
      var link = event.target && event.target.closest ? event.target.closest('a[href]') : null;
      if (!link || link.hasAttribute('data-vula-link') || link.hasAttribute('download') || (link.target && link.target !== '_self')) return;
      var destination;
      try { destination = new URL(link.href, window.location.href); } catch (_) { return; }
      if (destination.origin !== window.location.origin || destination.pathname === window.location.pathname && destination.hash && destination.search === window.location.search) return;
      warnNavigation(destination.pathname + destination.search + destination.hash);
    }, true);

    ['pushState', 'replaceState'].forEach(function(method) {
      var original = window.history[method];
      window.history[method] = function(state, title, url) {
        if (!window.__vulaNavigationInProgress) warnNavigation(url || window.location.pathname);
        return original.call(this, state, title, url);
      };
    });

    // ── Global error listeners ────────────────────────────────────────────────
    window.addEventListener('error', function(e) {
      renderOverlay('Runtime Error', (e.message || '') + '\\n' + (e.error ? e.error.stack : ''), e.filename);
    });
    window.addEventListener('unhandledrejection', function(e) {
      var reason = e.reason;
      if (!reason) return;
      var msg = reason.stack || reason.message || String(reason);
      renderOverlay('Unhandled Rejection', msg);
    });
    var _origConsoleError = console.error;
    console.error = function() {
      _origConsoleError.apply(console, arguments);
      var msg = Array.prototype.slice.call(arguments).map(function(a) {
        return typeof a === 'object' ? (a && a.stack ? a.stack : JSON.stringify(a)) : String(a);
      }).join(' ');
      if (!isSilenced(msg)) renderOverlay('Console Error', msg);
    };

    // ── WebSocket (HMR / version check) ──────────────────────────────────────
    var wsProtocol = window.location.protocol === 'https:' ? 'wss://' : 'ws://';
    var ws = new WebSocket(wsProtocol + window.location.host);
    ws.onmessage = function(event) {
      var data = JSON.parse(event.data);
      if (data.type === 'connected') {
        currentVula = data.version  || 'unknown';
        latestVula  = data.latestVersion || 'unknown';
        window.__vulaVersion = currentVula;
        window.__vulaLatest  = latestVula;
      } else if (data.type === 'reload') {
        window.location.reload();
      } else if (data.type === 'error') {
        var m = data.message.match(/([^\\s]+):\\d+:\\d+/);
        renderOverlay('Build Error', data.message, m ? m[1] : null);
      }
    };
  })();
</script>`;
}

/**
 * Builds and configures the Vula.js Express application without binding a port.
 */
async function createApp(options = {}) {
  const express = require('express');
  const cwd = options.cwd || process.cwd();
  const config = options.config || loadConfig(cwd);
  const resolvedPort = options.port || config.server.port || 3000;
  const isDev = options.devMode !== undefined ? options.devMode : process.env.NODE_ENV !== 'production';

  let vulaVersion = 'unknown';
  try { vulaVersion = require('../package.json').version; } catch (_) {}

  const app = express();
  app.disable('x-powered-by');
  // Limit request body size to 1mb to prevent DoS via large payloads
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  if (config.server['trust-proxy']) {
    app.set('trust proxy', 1);
  }

  const cookie = require('cookie');
  const httpProxy = require('http-proxy');
  const { csrfProtection } = require('./RSC/server.js');

  // Cookie parsing middleware
  app.use((req, res, next) => {
    if (req.headers.cookie) {
      req.cookies = cookie.parse(req.headers.cookie);
    } else {
      req.cookies = {};
    }
    next();
  });

  // Security headers + CSP + meta injection middleware (applies to both res.send and streaming SSR)
  app.use(createSecurityMiddleware({ config, isDev, vulaVersion }));

  // CSRF protection (respects allowed-origins from config; defaults to strict same-origin)
  if (config.security.csrf) {
    app.use(csrfProtection(config.security['allowed-origins'] || []));
  }

  // HTTP proxy (only enabled via config)
  if (config.proxy.enabled) {
    const rawTarget = config.proxy.target || 'http://localhost:8080';
    let targetUrl;
    try {
      targetUrl = new URL(rawTarget);
    } catch {
      throw new Error(`[vula] Invalid proxy target URL: ${rawTarget}`);
    }
    if (targetUrl.protocol !== 'http:' && targetUrl.protocol !== 'https:') {
      throw new Error(`[vula] Unsupported proxy protocol: ${targetUrl.protocol}`);
    }
    const proxy = httpProxy.createProxyServer({ xfwd: true });
    const prefix = config.proxy.prefix || '/proxy';
    app.use(prefix, (req, res) => {
      delete req.headers['proxy-authorization'];
      proxy.web(req, res, { target: targetUrl.origin }, (err) => {
        console.error('[vula] Proxy error:', err.message);
        if (!res.headersSent) res.status(502).send('Bad Gateway');
      });
    });
    console.log(`[vula] Proxy active: ${prefix} -> ${targetUrl.origin}`);
  }

  // Auto-register @swavoti/image-opti if installed and enabled in config
  if (config.modules['image-opti']) {
    try {
      const { imageOptimizerMiddleware } = require('@swavoti/image-opti');
      app.use(imageOptimizerMiddleware);
      console.log('[vula] @swavoti/image-opti: active (intercepts /images/* with ?w= and ?format=)');
    } catch (_) {}
  }

  // Auto-register @swavoti/video-opti if installed and enabled in config
  if (config.modules['video-opti']) {
    if (isDev) {
      console.log('\x1b[36m[vula] starting video opti module...\x1b[0m');
    }
    try {
      const videoOpti = await import('@swavoti/video-opti');
      if (typeof videoOpti.init === 'function') {
        await videoOpti.init();
      }

      const videoOptimizerMiddleware = videoOpti.videoOptimizerMiddleware || videoOpti.default?.videoOptimizerMiddleware;
      const serveVideoCacheMiddleware = videoOpti.serveVideoCacheMiddleware || videoOpti.default?.serveVideoCacheMiddleware;

      if (serveVideoCacheMiddleware) app.use(serveVideoCacheMiddleware());
      if (videoOptimizerMiddleware) app.use(videoOptimizerMiddleware);

      console.log('[vula] @swavoti/video-opti: active (auto HLS chunking for .mp4/.mkv/.webm)');
      if (isDev) {
        console.log('\x1b[32m[vula] video opti loaded\x1b[0m');
      }
    } catch (err) {
      if (isDev) {
        console.error('\x1b[31m[vula] failed to load video opti module:\x1b[0m', err.message);
      }
    }
  }

  // Load manifest
  const manifestPath = path.join(cwd, '.vula-routes.json');
  let manifest = options.manifest;
  if (!manifest) {
    if (!fs.existsSync(manifestPath)) {
      console.error('[vula] No .vula-routes.json found. Run `vula dev` or `vula build` first.');
      process.exit(1);
    }
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  }

  const wasmPath = path.join(__dirname, 'wasm', 'vula-core.wasm');
  const { createWasmRuntime, extractRouteParams } = require('./wasm/runtime.js');
  const wasmRuntime = options.wasmRuntime || await createWasmRuntime(wasmPath, manifest.routes || []);

  app.get('/_vula/wasm', (req, res) => {
    res.set({
      'cache-control': !isDev ? 'public, max-age=0, must-revalidate' : 'no-store',
      'content-type': 'application/wasm',
      'x-content-type-options': 'nosniff',
    });
    res.sendFile(wasmPath);
  });

  // User middleware
  if (manifest.middleware) {
    try {
      const mw = require(manifest.middleware);
      app.use(mw.default || mw);
    } catch (err) {
      console.error('[vula] Failed to load middleware:', err.message);
    }
  }

  // Register API routes
  if (manifest.apiRoutes && manifest.apiRoutes.length) {
    manifest.apiRoutes.forEach(route => {
      let handler;
      try {
        handler = require(route.handlerPath);
      } catch (err) {
        console.error(`[vula] Failed to load API handler ${route.path}:`, err.message);
        return;
      }

      ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].forEach(method => {
        if (typeof handler[method] === 'function') {
          app[method.toLowerCase()](route.path, async (req, res) => {
            try {
              await handler[method](req, res);
            } catch (err) {
              console.error(`[vula] ${method} ${route.path} error:`, err);
              if (!res.headersSent) {
                res.status(500).json({ error: 'Internal Server Error' });
              }
            }
          });
          console.log(`  ${method} ${route.path}`);
        }
      });
    });
  }

  // Server component bridge endpoint (authenticated/authorized by default)
  app.post('/_vula/server-component', createServerComponentHandler({
    manifest,
    config,
    getAuthHook: () => app.locals.authenticateServerComponent,
  }));

  // Experimental on-demand WebRTC / WebCodecs frame streaming (disabled unless experimental.webrtc-stream is true)
  const { registerStreamRoutes } = require('./stream/index.js');
  const streamManager = registerStreamRoutes(app, {
    manifest,
    config,
    getAuthHook: () => app.locals.authenticateServerComponent,
    isDev,
  });

  // Render the matched page fragment and compress it when the codec saves bytes.
  app.get('/_vula/route', async (req, res) => {
    const requestedPath = req.query.path;
    if (typeof requestedPath !== 'string' || !requestedPath.startsWith('/') || requestedPath.startsWith('//')) {
      return res.status(400).send('Invalid route path');
    }

    let targetUrl;
    try {
      targetUrl = new URL(requestedPath, 'http://vula.local');
    } catch (err) {
      return res.status(400).send('Invalid route path');
    }
    if (targetUrl.origin !== 'http://vula.local') {
      return res.status(400).send('Invalid route path');
    }

    const routeIndex = wasmRuntime.match(targetUrl.pathname);
    if (routeIndex < 0) {
      return res.status(404).send('Page not found');
    }
    const matchedRoute = manifest.routes[routeIndex];
    const matchedParams = extractRouteParams(matchedRoute.path, targetUrl.pathname);
    if (!matchedParams) return res.status(400).send('Invalid route path');

    try {
      const React = require(require.resolve('react', { paths: [cwd, process.cwd()] }));
      const { renderToPipeableStream } = require(require.resolve('react-dom/server', { paths: [cwd, process.cwd()] }));
      const { Buffer } = require('node:buffer');
      const ComponentModule = require(matchedRoute.componentPath);
      const Component = ComponentModule.default || ComponentModule;

      const maxPageBytes = 8 * 1024 * 1024;
      const chunks = [];
      let totalBytes = 0;
      let renderError = false;
      let stream;
      const output = new Writable({
        write(chunk, encoding, callback) {
          totalBytes += chunk.length;
          if (totalBytes > maxPageBytes) {
            callback(new Error(`Rendered route exceeded ${maxPageBytes} bytes`));
            return;
          }
          chunks.push(Buffer.from(chunk));
          callback();
        },
      });
      output.on('error', (err) => {
        console.error('[vula] Failed to buffer rendered route:', err);
        if (stream) stream.abort();
        if (!res.headersSent) res.status(500).send('Page rendering failed');
      });
      output.on('finish', () => {
        if (res.destroyed) return;
        const html = Buffer.concat(chunks);
        let compressed;
        try {
          compressed = wasmRuntime.compress(html);
        } catch (err) {
          console.error('[vula] Route response compression failed:', err);
          if (!res.headersSent) res.status(500).send('Page compression failed');
          return;
        }
        const statusCode = renderError ? 500 : 200;
        res.set({
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
        });
        if (compressed && compressed.length < html.length) {
          res.status(statusCode).set({
            'content-type': 'application/vnd.vula.page+lzss; version=1',
            'content-length': String(compressed.length),
            'x-vula-compression': 'lzss-1',
          }).end(compressed);
        } else {
          res.status(statusCode).set({
            'content-type': 'text/html; charset=utf-8',
            'content-length': String(html.length),
          }).end(html);
        }
      });
      stream = renderToPipeableStream(
        React.createElement(Component, { params: matchedParams }),
        {
          onAllReady() {
            stream.pipe(output);
          },
          onShellError(err) {
            console.error('[vula] Route SSR failed:', err);
            if (!res.headersSent) res.status(500).send('Page rendering failed');
          },
          onError(err) {
            renderError = true;
            console.error('[vula] Route SSR error:', err);
          },
        }
      );
    } catch (err) {
      console.error('[vula] Failed to render route:', err);
      if (!res.headersSent) res.status(500).send('Page rendering failed');
    }
  });

  // Serve service worker
  const swPath = path.join(cwd, 'public', 'vula-sw.js');
  if (fs.existsSync(swPath)) {
    app.get('/vula-sw.js', (req, res) => {
      res.sendFile(swPath);
    });
  }

  // Static public assets (ignoring index.html to allow Rspack/Router to handle it)
  const publicDir = path.join(cwd, 'public');
  if (fs.existsSync(publicDir)) {
    app.use(express.static(publicDir, { index: false, dotfiles: 'deny' }));
  }

  // Helper for SSR and streaming HTML
  async function serveHtml(req, res) {
    const { renderToPipeableStream } = require(require.resolve('react-dom/server', { paths: [cwd, process.cwd()] }));
    const React = require(require.resolve('react', { paths: [cwd, process.cwd()] }));

    const manifestData = fs.existsSync(manifestPath)
      ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
      : manifest;
    const routeIndex = wasmRuntime.match(req.path);
    if (routeIndex < 0) {
      return res.status(404).send('<!DOCTYPE html><html><body><h1>404 Not Found</h1></body></html>');
    }
    const matchedRoute = manifestData.routes[routeIndex];
    const matchedParams = extractRouteParams(matchedRoute.path, req.path);
    if (!matchedParams) return res.status(400).send('Invalid route path');

    try {
      const ComponentModule = require(matchedRoute.componentPath);
      const Component = ComponentModule.default || ComponentModule;

      const lang = escapeHtml(config.app.lang || 'en');
      const appName = escapeHtml(config.app.name || 'Vula App');

      // Check if a global layout exists
      let LayoutComponent = React.Fragment;
      const layoutPath = path.join(cwd, 'app', 'layout.tsx');
      if (fs.existsSync(layoutPath)) {
        try {
          const LayoutModule = require(layoutPath);
          LayoutComponent = LayoutModule.default || LayoutModule;
        } catch (err) {
          console.error('[vula] Error loading app/layout.tsx during SSR:', err);
        }
      }

      const pageElement = React.createElement(
        'div',
        { id: 'vula-page-root' },
        React.createElement(Component, { params: matchedParams })
      );
      let appElement;
      try {
        const { StaticRouter } = require(require.resolve('react-router-dom/server', { paths: [cwd, process.cwd()] }));
        appElement = React.createElement(StaticRouter, { location: req.url },
          React.createElement(LayoutComponent, null, pageElement)
        );
      } catch (_) {
        appElement = React.createElement(LayoutComponent, null, pageElement);
      }

      const nonce = res.locals.cspNonce || '';
      const wsScript = isDev ? buildDevWsScript(nonce) : '';

      // Parse custom index.html if it exists to preserve user favicons and meta tags
      let htmlHead = `<!DOCTYPE html><html lang="${lang}"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><title>${appName}</title><link rel="stylesheet" href="/.vula.cache.css"/></head><body><div id="root">`;
      let htmlTail = `</div>${wsScript}</body></html>`;
      const indexHtmlPath = path.join(cwd, 'index.html');
      if (fs.existsSync(indexHtmlPath)) {
        let indexHtml = fs.readFileSync(indexHtmlPath, 'utf8');
        if (!indexHtml.includes('.vula.cache.css')) {
          indexHtml = indexHtml.replace('</head>', '<link rel="stylesheet" href="/.vula.cache.css"/>\n</head>');
        }
        const rootParts = indexHtml.split('<div id="root"></div>');
        if (rootParts.length === 2) {
          htmlHead = rootParts[0] + '<div id="root">';
          htmlTail = `</div>${wsScript}` + rootParts[1];
        }
      }

      htmlHead = injectHeadTags(htmlHead, config, vulaVersion);
      htmlHead = htmlHead.replace(
        '<div id="root">',
        `<div id="root" data-vula-route-index="${routeIndex}">`
      );

      streamReactSsrResponse({
        res,
        renderToPipeableStream,
        element: React.createElement(React.StrictMode, null, appElement),
        nonce,
        htmlHead,
        htmlTail,
      });
    } catch (err) {
      console.error('[vula] Failed to SSR:', err);
      if (!res.headersSent) {
        res.status(500).send('Internal Server Error');
      }
    }
  }

  // Frontend serving
  const swvulaDir = path.join(cwd, '.swvula');
  if (!isDev) {
    if (fs.existsSync(swvulaDir)) {
      app.use(serveSwvulaAssets(swvulaDir, false));
    }
    app.get('*', async (req, res) => {
      await serveHtml(req, res);
    });
  } else {
    if (fs.existsSync(swvulaDir)) {
      app.use(serveSwvulaAssets(swvulaDir, true));
    }

    // Only proxy /_rspack/* when an external Rspack dev port differs from our Express port
    const rspackTargetPort = options.rspackPort || process.env.VULA_RSPACK_PORT;
    if (rspackTargetPort && Number(rspackTargetPort) !== Number(resolvedPort)) {
      const rspackProxy = httpProxy.createProxyServer({ target: `http://localhost:${Number(rspackTargetPort)}` });
      app.all('/_rspack/*', (req, res) => {
        rspackProxy.web(req, res, {}, () => {
          if (!res.headersSent) res.status(502).send('Rspack Dev Server is down');
        });
      });
    }

    app.get('*', async (req, res) => {
      await serveHtml(req, res);
    });
  }

  return { app, config, manifest, wasmRuntime, resolvedPort, manifestPath, isDev, cwd, streamManager };
}

/**
 * Starts the Vula.js server (HTTP + dev watcher/WebSocket when not in production).
 */
async function startServer(port) {
  const ctx = await createApp({ port });
  const { app, wasmRuntime, manifest, resolvedPort, isDev, cwd, streamManager } = ctx;

  if (isDev && !process.env.VULA_DISABLE_WATCHER) {
    global.vulaWssClients = global.vulaWssClients || new Set();
    const broadcast = (data) => {
      const msg = JSON.stringify(data);
      global.vulaWssClients.forEach(c => { if (c.readyState === 1) c.send(msg); });
    };

    const chokidar = require('chokidar');
    const { generateClientRouteManifest, generateRouteManifest } = require('./router/manifest.js');
    const appDir = path.join(cwd, 'app');

    let debounceTimer;
    const watcher = chokidar.watch([appDir], {
      ignored: /(\.git|node_modules)/,
      persistent: true,
      ignoreInitial: true
    });

    watcher.on('all', (event, filename) => {
      if (filename && (filename.endsWith('.tsx') || filename.endsWith('.ts') || filename.endsWith('.jsx') || filename.endsWith('.js'))) {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          console.log(`[vula] File changed: ${filename}, regenerating manifest...`);
          try {
            const manifestData = generateRouteManifest(appDir);
            wasmRuntime.setRoutes(manifestData.routes);
            manifest.routes = manifestData.routes;
            manifest.streamSurfaces = manifestData.streamSurfaces;
            fs.writeFileSync(path.join(cwd, '.vula-routes.json'), JSON.stringify(manifestData, null, 2));
            fs.writeFileSync(
              path.join(cwd, '.vula-routes.client.json'),
              JSON.stringify(generateClientRouteManifest(manifestData))
            );
          } catch (err) {
            console.error('[vula] Manifest error:', err);
            broadcast({ type: 'error', message: err.message });
          }
        }, 300);
      }
    });

    const cleanupWatcher = () => { clearTimeout(debounceTimer); watcher.close(); };
    process.once('SIGTERM', cleanupWatcher);
    process.once('SIGINT', cleanupWatcher);
  }

  const server = app.listen(resolvedPort, () => {
    console.log(`[vula] Server running at http://localhost:${resolvedPort}`);
    console.log(`[vula] text-opt: ${ctx.config.optimization['text-opt'] ? 'on' : 'off'} | csrf: ${ctx.config.security.csrf ? 'on' : 'off'} | proxy: ${ctx.config.proxy.enabled ? 'on' : 'off'}`);
  });

  if (isDev) {
    const { WebSocketServer } = require('ws');
    const https = require('https');
    const pkg = require('../package.json');
    const currentVulaVersion = pkg.version;
    let latestVulaVersion = 'unknown';

    https.get('https://registry.npmjs.org/@swavoti/vula/latest', (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const latest = JSON.parse(data).version;
          if (latest) latestVulaVersion = latest;
        } catch (e) {}
      });
    }).on('error', () => {});

    const wss = streamManager
      ? new WebSocketServer({ noServer: true })
      : new WebSocketServer({ server });
    global.vulaWssClients = global.vulaWssClients || new Set();
    wss.on('connection', (ws) => {
      ws.send(JSON.stringify({
        type: 'connected',
        version: currentVulaVersion,
        latestVersion: latestVulaVersion
      }));
      global.vulaWssClients.add(ws);
      ws.on('close', () => global.vulaWssClients.delete(ws));
    });

    if (streamManager) {
      const { attachStreamUpgradeHandler } = require('./stream/index.js');
      attachStreamUpgradeHandler(server, streamManager, {
        fallbackUpgrade: (req, socket, head) => {
          wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit('connection', ws, req);
          });
        },
      });
    }
  } else if (streamManager) {
    const { attachStreamUpgradeHandler } = require('./stream/index.js');
    attachStreamUpgradeHandler(server, streamManager);
  }

  if (streamManager) {
    server.on('close', () => streamManager.destroyAll());
  }

  return server;
}

module.exports = {
  createApp,
  startServer,
  createSecurityMiddleware,
  createServerComponentHandler,
  streamReactSsrResponse,
  escapeHtml,
  sanitizeIconPath,
  sanitizeRpcValue,
  buildCspHeader,
  injectHeadTags,
  serveSwvulaAssets,
};
