const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const { Writable } = require('node:stream');
const { loadConfig, resolveStreamingConfig } = require('./config.js');

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

function buildCspHeader(cspConfig, nonce, isDev, streamingOrExperimentalConfig) {
  if (cspConfig === false) return null;
  if (typeof cspConfig === 'string' && cspConfig.trim()) {
    return cspConfig.trim();
  }
  const scriptSrc = ["'self'", `'nonce-${nonce}'`];
  if (isDev) {
    scriptSrc.push("'unsafe-eval'");
  }
  const streamEnabled = streamingOrExperimentalConfig
    ? Boolean(resolveStreamingConfig(streamingOrExperimentalConfig).enabled)
    : false;
  const connectSrc = isDev
    ? "'self' ws: wss: http://localhost:* http://127.0.0.1:*"
    : (streamEnabled ? "'self' ws: wss:" : "'self'");
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
        return res.sendFile(filePath, { dotfiles: 'allow' });
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
      config
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

function stripAnsiCodes(str) {
  return String(str || '').replace(/\x1b\[[0-9;]*m/g, '');
}

function getDevErrorStore() {
  if (!global.__vulaDevErrorStore) {
    global.__vulaDevErrorStore = {
      build: [],
      ssr: [],
    };
  }
  return global.__vulaDevErrorStore;
}

function getAllDevErrors() {
  const store = getDevErrorStore();
  return [...store.build, ...store.ssr];
}

function broadcastDevWs(data) {
  if (!global.vulaWssClients) return;
  const msg = JSON.stringify(data);
  global.vulaWssClients.forEach((c) => {
    if (c.readyState === 1) c.send(msg);
  });
}

function setDevErrors(source, errors) {
  const store = getDevErrorStore();
  const key = source === 'ssr' ? 'ssr' : 'build';
  store[key] = Array.isArray(errors) ? errors : [];
  broadcastDevWs({ type: 'sync-errors', errors: getAllDevErrors() });
}

function pushDevError(source, errorItem) {
  const store = getDevErrorStore();
  const key = source === 'ssr' ? 'ssr' : 'build';
  const msg = stripAnsiCodes(errorItem?.message || '');
  const list = store[key];
  const filtered = list.filter((e) => e.message !== msg || e.title !== errorItem?.title);
  filtered.unshift({
    source: key,
    title: errorItem?.title || 'Error',
    file: errorItem?.file || '',
    message: msg,
  });
  if (filtered.length > 8) filtered.length = 8;
  store[key] = filtered;
  broadcastDevWs({ type: 'sync-errors', errors: getAllDevErrors() });
}

function clearProjectRequireCache(cwd = process.cwd()) {
  const roots = [path.join(cwd, 'app'), path.join(cwd, 'src')];
  for (const cachedPath of Object.keys(require.cache)) {
    if (roots.some((r) => cachedPath === r || cachedPath.startsWith(r + path.sep))) {
      delete require.cache[cachedPath];
    }
  }
}

function notifyDevCompiling(target) {
  const label = String(target || 'changes').trim();
  console.log(`\x1b[36m[vula]\x1b[0m compiling ${label}...`);
  broadcastDevWs({
    type: 'compile-log',
    phase: 'start',
    file: label,
  });
}

function notifyDevBuildDone(durationMs = 0, cwd = process.cwd()) {
  clearProjectRequireCache(cwd);
  const ms = Math.max(1, Math.round(Number(durationMs) || 0));
  console.log(`\x1b[32m✓ [vula]\x1b[0m compiled in ${ms}ms`);
  if (global.__vulaStreamManager && typeof global.__vulaStreamManager.reloadActiveSessions === 'function') {
    global.__vulaStreamManager.reloadActiveSessions();
  }
  broadcastDevWs({
    type: 'hmr-update',
    durationMs: ms,
    timestamp: Date.now(),
  });
}

function formatErrorDetails(err, fallbackFile = '') {
  const msg = stripAnsiCodes(err && (err.stack || err.message) ? (err.stack || err.message) : String(err || 'Unknown error'));
  let file = fallbackFile || '';
  if (!file) {
    const m = msg.match(/(?:\/[^\s:)]+|\b(?:app|src|core|pages|components)[\\/][^\s:)]+)\.(?:tsx|ts|jsx|js|css)(?::\d+(?::\d+)?)?/i);
    if (m) file = m[0];
  }
  return { file, message: msg };
}

function streamReactSsrResponse({
  res,
  renderToPipeableStream,
  element,
  nonce,
  htmlHead,
  htmlTail,
  bootstrapScripts = ['/.vula.cache.js'],
  isDev = false,
  vulaVersion = 'unknown',
  routeFile = '',
  routePath = '',
  ssrStartMs = 0,
}) {
  let didError = false;
  let lastError = null;
  const { pipe, abort } = renderToPipeableStream(element, {
    nonce,
    bootstrapScripts,
    onShellReady() {
      if (res.destroyed || res.writableEnded) return;
      res.status(didError ? 500 : 200);
      res.set({
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store, no-cache, must-revalidate, private',
        pragma: 'no-cache',
        expires: '0',
      });
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
          if (isDev && routePath && ssrStartMs > 0) {
            const elapsedMs = Math.max(1, Date.now() - ssrStartMs);
            console.log(`[vula] compiled ${routePath} in ${elapsedMs}ms`);
            broadcastDevWs({
              type: 'compile-log',
              phase: 'done',
              path: routePath,
              durationMs: elapsedMs,
            });
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
      const formatted = formatErrorDetails(err, routeFile);
      if (isDev) {
        pushDevError('ssr', { title: 'SSR Error', file: formatted.file, message: formatted.message });
      }
      if (!res.headersSent) {
        if (isDev) {
          const initialErrors = [{ title: 'SSR Error', file: formatted.file, message: formatted.message }];
          res.status(500).type('html').send(
            `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Vula Dev Error</title></head><body><div id="root"></div>${buildDevWsScript(nonce || '', vulaVersion, initialErrors)}</body></html>`
          );
        } else {
          res.status(500).send('<!DOCTYPE html><html><body><h1>500 Internal Server Error</h1></body></html>');
        }
      } else if (!res.writableEnded && !res.destroyed) {
        res.end();
      }
    },
    onError(err) {
      didError = true;
      lastError = err;
      console.error('[vula] SSR Error:', err);
      if (isDev) {
        const formatted = formatErrorDetails(err, routeFile);
        pushDevError('ssr', { title: 'SSR Error', file: formatted.file, message: formatted.message });
      }
    },
  });

  res.on('close', () => {
    if (!res.writableFinished) {
      abort();
    }
  });
}

function buildDevWsScript(nonce, vulaVersion = 'unknown', initialErrors = null) {
  const seedErrors = Array.isArray(initialErrors) ? initialErrors : getAllDevErrors();
  const safeInitialJson = JSON.stringify(seedErrors).replace(/</g, '\\u003c');
  return `
<script nonce="${escapeHtml(nonce)}">
  (function() {
    var currentVula = ${JSON.stringify(String(vulaVersion || 'unknown'))};
    var latestVula  = 'unknown';
    var errorItems  = [];
    var seededErrors = ${safeInitialJson};

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

    // ── DOM & Version helpers ─────────────────────────────────────────────────
    function stripAnsi(s) {
      return String(s || '').replace(/\\x1b\\[[0-9;]*m/g, '');
    }
    function esc(s) { return (s||'').toString().replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }

    function compareVersions(a, b) {
      var pa = String(a || '').replace(/^v/i, '').split('-')[0].split('.').map(Number);
      var pb = String(b || '').replace(/^v/i, '').split('-')[0].split('.').map(Number);
      for (var i = 0; i < Math.max(pa.length, pb.length); i++) {
        var na = isNaN(pa[i]) ? 0 : pa[i];
        var nb = isNaN(pb[i]) ? 0 : pb[i];
        if (na !== nb) return na - nb;
      }
      return 0;
    }

    function extractFilePath(filename, msg) {
      var raw = stripAnsi(filename || '').trim();
      var text = stripAnsi(msg || '');
      if (!raw && text) {
        var m = text.match(/(?:https?:\\/\\/[^\\s)]+|(?:file:\\/\\/)?(?:\\/[\\w./-]+|[a-zA-Z]:\\\\[\\w.\\\\/-]+|(?:app|src|core|pages|components)[\\/][^\\s:)]+)\\.(?:tsx|ts|jsx|js|css)(?::\\d+(?::\\d+)?)?)/i);
        if (!m) m = text.match(/([\\w./-]+\\.(?:tsx|ts|jsx|js|css)(?::\\d+(?::\\d+)?)?)/i);
        if (m) raw = m[0];
      }
      if (!raw) return 'unknown file';
      try {
        if (/^https?:\\/\\//i.test(raw)) {
          var u = new URL(raw);
          raw = u.pathname + (raw.slice(u.origin.length + u.pathname.length).match(/^:\\d+(?::\\d+)?/) || [''])[0];
        }
      } catch (_) {}
      raw = raw.replace(/^\\.[\\/]/, '');
      var idx = raw.search(/[\\/](?:app|src|core|pages|components)[\\/]/i);
      if (idx >= 0) raw = raw.slice(idx + 1);
      return raw || 'unknown file';
    }

    function normalizeEntry(title, msg, filename, source) {
      var cleanMsg = stripAnsi(msg || '');
      var file = extractFilePath(filename, cleanMsg);
      return {
        source: source || 'runtime',
        title: title || 'Error',
        file: file,
        msg: cleanMsg,
      };
    }

    function buildHeaderBrandHtml() {
      var verText = currentVula !== 'unknown' ? 'v' + esc(currentVula) : 'v-dev';
      var updateText = '';
      if (latestVula !== 'unknown' && currentVula !== 'unknown' && compareVersions(currentVula, latestVula) < 0) {
        updateText = '<span style="color:#b45309;font-size:12px;font-weight:500">· update v' + esc(latestVula) + '</span>';
      }
      var vulaIcon = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true" style="display:block;flex-shrink:0">'
        + '<path d="M4 5.5L12 19.5L20 5.5" stroke="#111827" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>'
        + '<path d="M8.5 5.5L12 12L15.5 5.5" stroke="#dc2626" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
        + '</svg>';
      return vulaIcon
        + '<span style="font-weight:700;font-size:13px;color:#111827;letter-spacing:-0.01em">swavoti/vula</span>'
        + '<span style="font:500 12px ui-monospace,SFMono-Regular,Menlo,monospace;color:#6b7280">' + verText + '</span>'
        + updateText;
    }

    function dismiss() {
      errorItems = [];
      var el = document.getElementById('__vula_overlay__');
      if (el) el.remove();
    }

    function ensureOverlayStyles() {
      if (document.getElementById('__vula_overlay_css__')) return;
      var style = document.createElement('style');
      style.id = '__vula_overlay_css__';
      style.textContent = ''
        + '#__vula_overlay__ summary::-webkit-details-marker{display:none}'
        + '#__vula_overlay__ summary::marker{display:none;content:""}'
        + '#__vula_overlay__ details[open] .__vula_chev__{transform:rotate(180deg)}'
        + '#__vula_overlay__ .__vula_row_sum__:hover{background:#fafafa}';
      (document.head || document.documentElement).appendChild(style);
    }

    function paintOverlay() {
      var el = document.getElementById('__vula_overlay__');
      if (!errorItems.length) {
        if (el) el.remove();
        return;
      }
      ensureOverlayStyles();
      if (!el) {
        el = document.createElement('div');
        el.id = '__vula_overlay__';
        (document.body || document.documentElement).appendChild(el);
      }
      el.style.cssText = [
        'position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;padding:24px',
        'background:rgba(255,255,255,0.92);backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px)',
        'font:13px/1.5 ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#111827',
      ].join(';');

      var chevronSvg = '<svg class="__vula_chev__" width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden="true" style="display:block;flex-shrink:0;color:#6b7280;transition:transform .15s ease">'
        + '<path d="M5 7.5L10 12.5L15 7.5" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>'
        + '</svg>';

      var rowsHtml = errorItems.map(function(item, idx) {
        var isFirst = idx === 0;
        var borderBottom = idx < errorItems.length - 1 ? 'border-bottom:1px solid #e5e7eb;' : '';
        return '<details' + (isFirst ? ' open' : '') + ' style="' + borderBottom + 'background:#ffffff">'
          + '<summary class="__vula_row_sum__" style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 16px;cursor:pointer;user-select:none;list-style:none">'
          + '<span style="display:inline-flex;align-items:center;gap:8px;min-width:0;flex:1;flex-wrap:wrap">'
          + '<span style="width:6px;height:6px;border-radius:50%;background:#dc2626;display:inline-block;flex-shrink:0"></span>'
          + '<span style="font:500 12.5px ui-monospace,SFMono-Regular,Menlo,monospace;color:#111827;overflow-wrap:anywhere">' + esc(item.file) + '</span>'
          + '<span style="color:#6b7280;font-size:12px">' + esc(item.title) + '</span>'
          + '</span>'
          + chevronSvg
          + '</summary>'
          + '<div style="padding:0 16px 14px 30px;background:#ffffff">'
          + '<pre style="margin:0;padding:10px 12px;max-height:42vh;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;background:#fafafa;border:1px solid #e5e7eb;border-radius:6px;color:#111827;font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace">' + esc(item.msg) + '</pre>'
          + '</div>'
          + '</details>';
      }).join('');

      var latestItem = errorItems[0];
      var errorCountLabel = errorItems.length + (errorItems.length === 1 ? ' error' : ' errors');
      el.innerHTML = '<section style="width:min(100%,760px);max-height:86vh;overflow:auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:10px;box-shadow:0 10px 30px rgba(17,24,39,0.08)">'
        + '<header style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:12px 16px;border-bottom:1px solid #e5e7eb;background:#ffffff">'
        + '<div id="__vula_brand_bar__" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">'
        + buildHeaderBrandHtml()
        + '<span style="display:inline-flex;align-items:center;gap:5px;padding:2px 9px;border-radius:999px;background:#fef2f2;border:1px solid #fecaca;color:#b91c1c;font:600 11.5px ui-sans-serif,system-ui">' + esc(errorCountLabel) + '</span>'
        + '</div>'
        + '<div style="display:inline-flex;align-items:center;gap:8px;flex-shrink:0">'
        + '<button id="__vula_copy__" style="border:1px solid #e5e7eb;border-radius:6px;background:#ffffff;color:#111827;padding:4px 10px;cursor:pointer;font:500 12px ui-sans-serif,system-ui">Copy</button>'
        + '<button id="__vula_dismiss__" aria-label="Close error overlay" style="border:1px solid #e5e7eb;border-radius:6px;background:#ffffff;color:#6b7280;padding:4px 10px;cursor:pointer;font:500 12px ui-sans-serif,system-ui">Close</button>'
        + '</div>'
        + '</header>'
        + '<div style="background:#ffffff">' + rowsHtml + '</div>'
        + '</section>';

      document.getElementById('__vula_dismiss__').onclick = dismiss;
      document.getElementById('__vula_copy__').onclick = function() {
        var btn = this;
        if (!navigator.clipboard) return;
        navigator.clipboard.writeText((latestItem.title || '') + '\\n' + (latestItem.file || '') + '\\n' + (latestItem.msg || '')).then(function() {
          btn.textContent = 'Copied';
          setTimeout(function() { btn.textContent = 'Copy'; }, 1600);
        }).catch(function(err) { console.error('[vula] Could not copy error details:', err); });
      };
    }

    function renderOverlay(title, msg, filename, source) {
      var cleanMsg = stripAnsi(msg || '');
      if (isSilenced(cleanMsg)) return;
      var entry = normalizeEntry(title, cleanMsg, filename, source);
      if (!errorItems.length || errorItems[0].msg !== entry.msg || errorItems[0].title !== entry.title) {
        errorItems.unshift(entry);
        if (errorItems.length > 12) errorItems.length = 12;
      }
      paintOverlay();
    }

    function syncServerErrors(serverList) {
      var runtimeOnly = errorItems.filter(function(item) { return item.source === 'runtime'; });
      var serverItems = (Array.isArray(serverList) ? serverList : []).map(function(item) {
        return normalizeEntry(item.title || 'Build Error', item.message || item.msg || '', item.file || '', item.source || 'build');
      }).filter(function(item) { return item.msg && !isSilenced(item.msg); });
      errorItems = serverItems.concat(runtimeOnly).slice(0, 12);
      paintOverlay();
    }

    if (Array.isArray(seededErrors) && seededErrors.length) {
      syncServerErrors(seededErrors);
    }
    document.addEventListener('DOMContentLoaded', function() {
      if (errorItems.length) paintOverlay();
    });

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
      renderOverlay('Runtime Error', (e.message || '') + '\\n' + (e.error ? e.error.stack : ''), e.filename, 'runtime');
    });
    window.addEventListener('unhandledrejection', function(e) {
      var reason = e.reason;
      if (!reason) return;
      var msg = reason.stack || reason.message || String(reason);
      renderOverlay('Unhandled Rejection', msg, null, 'runtime');
    });
    var _origConsoleError = console.error;
    console.error = function() {
      _origConsoleError.apply(console, arguments);
      var msg = Array.prototype.slice.call(arguments).map(function(a) {
        return typeof a === 'object' ? (a && a.stack ? a.stack : JSON.stringify(a)) : String(a);
      }).join(' ');
      if (!isSilenced(msg)) renderOverlay('Console Error', msg, null, 'runtime');
    };

    // ── WebSocket (HMR / version check) ──────────────────────────────────────
    var wsProtocol = window.location.protocol === 'https:' ? 'wss://' : 'ws://';
    var ws = new WebSocket(wsProtocol + window.location.host);
    ws.onmessage = function(event) {
      var data = JSON.parse(event.data);
      if (data.type === 'connected' || data.type === 'version') {
        currentVula = data.version  || currentVula || 'unknown';
        latestVula  = data.latestVersion || latestVula || 'unknown';
        window.__vulaVersion = currentVula;
        window.__vulaLatest  = latestVula;
        if (errorItems.length && document.getElementById('__vula_overlay__')) {
          paintOverlay();
        }
      } else if (data.type === 'reload') {
        window.location.reload();
      } else if (data.type === 'compile-log') {
        var label = data.path || data.file || 'changes';
        if (data.phase === 'start') {
          console.log('[vula] compiling ' + label + '...');
        } else if (data.phase === 'done') {
          console.log('[vula] compiled ' + label + ' in ' + (data.durationMs || 1) + 'ms');
        }
      } else if (data.type === 'hmr-update') {
        syncServerErrors([]);
        console.log('[vula] HMR compiled' + (data.file ? ' (' + data.file + ')' : '') + ' in ' + (data.durationMs || 1) + 'ms');
        var links = document.querySelectorAll('link[rel="stylesheet"]');
        for (var i = 0; i < links.length; i++) {
          var href = links[i].getAttribute('href') || '';
          if (href.indexOf('.vula.cache.css') !== -1) {
            links[i].setAttribute('href', '/.vula.cache.css?t=' + (data.timestamp || Date.now()));
          }
        }
        if (typeof window.__vulaHmrRefresh === 'function') {
          window.__vulaHmrRefresh();
        }
      } else if (data.type === 'sync-errors') {
        syncServerErrors(data.errors);
      } else if (data.type === 'clear-errors') {
        syncServerErrors([]);
      } else if (data.type === 'error') {
        var cleanErrMsg = stripAnsi(data.message || '');
        var m = cleanErrMsg.match(/([^\\s]+):\\d+:\\d+/);
        renderOverlay(data.title || 'Build Error', cleanErrMsg, data.file || (m ? m[1] : null), data.source || 'build');
      }
    };
  })();
</script>`;
}

const REACT_SHARED_SPECIFIERS = new Set([
  'react',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  'react-dom',
  'react-dom/client',
  'react-dom/server',
]);

let pinnedReactPaths = null;
let reactResolveHookInstalled = false;

/**
 * Ensures symlinked framework client modules resolve React and ReactDOM from the host app's single copy.
 */
function pinHostReactResolution(cwd) {
  const hostPaths = Array.from(new Set([cwd, process.cwd()].filter(Boolean)));
  pinnedReactPaths = hostPaths;
  if (reactResolveHookInstalled) return;
  reactResolveHookInstalled = true;

  const Module = require('node:module');
  const originalResolve = Module._resolveFilename;
  const frameworkRoot = path.resolve(__dirname, '..');

  Module._resolveFilename = function patchedResolve(request, parent, isMain, options) {
    if (
      REACT_SHARED_SPECIFIERS.has(request) &&
      parent &&
      typeof parent.filename === 'string' &&
      parent.filename.startsWith(frameworkRoot) &&
      pinnedReactPaths
    ) {
      try {
        return originalResolve.call(this, request, parent, isMain, {
          ...(options || {}),
          paths: pinnedReactPaths,
        });
      } catch (_) {
        // Fall through to default resolution if host does not provide the specifier.
      }
    }
    return originalResolve.call(this, request, parent, isMain, options);
  };
}

/**
 * Builds and configures the Vula.js Express application without binding a port.
 */
async function createApp(options = {}) {
  const express = require('express');
  const cwd = options.cwd || process.cwd();
  pinHostReactResolution(cwd);
  const config = options.config || loadConfig(cwd);
  const resolvedPort = options.port || config.server.port || 3000;
  const isDev = options.devMode !== undefined
    ? Boolean(options.devMode)
    : process.env.NODE_ENV === 'development';

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
  let userMiddlewareFn = null;
  if (manifest.middleware) {
    try {
      const mw = require(manifest.middleware);
      userMiddlewareFn = mw.default || mw;
      if (typeof userMiddlewareFn === 'function') {
        app.use(userMiddlewareFn);
      } else {
        userMiddlewareFn = null;
      }
    } catch (err) {
      console.error('[vula] Failed to load middleware:', err.message);
    }
  }

  async function runUserMiddlewareForTarget(req, res, targetUrl) {
    if (typeof userMiddlewareFn !== 'function') return true;
    const proxiedReq = Object.create(req, {
      path: { value: targetUrl.pathname, enumerable: true, configurable: true },
      url: { value: targetUrl.pathname + targetUrl.search, enumerable: true, configurable: true },
      originalUrl: { value: targetUrl.pathname + targetUrl.search, enumerable: true, configurable: true },
      query: { value: Object.fromEntries(targetUrl.searchParams.entries()), enumerable: true, configurable: true },
    });
    return new Promise((resolve) => {
      let settled = false;
      const done = (err) => {
        if (settled) return;
        settled = true;
        if (err) {
          if (!res.headersSent) res.status(500).send('Middleware error');
          resolve(false);
          return;
        }
        resolve(!res.headersSent && !res.writableEnded);
      };
      try {
        const ret = userMiddlewareFn(proxiedReq, res, done);
        if (ret && typeof ret.then === 'function') {
          ret.then(() => {
            if (!settled && (res.headersSent || res.writableEnded)) {
              settled = true;
              resolve(false);
            }
          }, (err) => done(err));
        }
      } catch (err) {
        done(err);
      }
    });
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

  const nodeCrypto = require('node:crypto');
  const streamServerRef = {
    port: null,
    internalRenderSecret: nodeCrypto.randomBytes(24).toString('hex'),
  };
  app.locals.streamServerRef = streamServerRef;

  function isInternalStreamRendererRequest(req) {
    const provided = req.get('x-vula-internal-ssr');
    if (!provided || typeof provided !== 'string') return false;
    const a = Buffer.from(provided, 'utf8');
    const b = Buffer.from(streamServerRef.internalRenderSecret, 'utf8');
    if (a.length !== b.length || !nodeCrypto.timingSafeEqual(a, b)) return false;
    const remote = req.socket?.remoteAddress || req.ip || '';
    return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
  }

  // Experimental on-demand WebRTC / WebCodecs frame streaming (disabled unless experimental.webrtc-stream is true)
  const { registerStreamRoutes } = require('./stream/index.js');
  const streamManager = registerStreamRoutes(app, {
    manifest,
    manifestPath,
    config,
    wasmRuntime,
    cwd,
    serverRef: streamServerRef,
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

    const middlewareAllowed = await runUserMiddlewareForTarget(req, res, targetUrl);
    if (!middlewareAllowed || res.headersSent || res.writableEnded) {
      return;
    }

    const routeStartMs = Date.now();
    if (isDev) {
      console.log(`[vula] compiling ${matchedRoute.path} (${matchedRoute.clientPath})...`);
      broadcastDevWs({
        type: 'compile-log',
        phase: 'start',
        path: matchedRoute.path,
        file: matchedRoute.clientPath,
      });
    }

    try {
      const React = require(require.resolve('react', { paths: [cwd, process.cwd()] }));
      const { renderToPipeableStream } = require(require.resolve('react-dom/server', { paths: [cwd, process.cwd()] }));
      const { Buffer } = require('node:buffer');
      const ComponentModule = require(matchedRoute.componentPath);
      if (typeof ComponentModule.authorize === 'function') {
        const authorized = await ComponentModule.authorize(req);
        if (!authorized) {
          return res.status(403).send('Forbidden');
        }
      }
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
        const compileMs = Math.max(1, Date.now() - routeStartMs);
        if (isDev) {
          console.log(`[vula] compiled ${matchedRoute.path} in ${compileMs}ms`);
          broadcastDevWs({
            type: 'compile-log',
            phase: 'done',
            path: matchedRoute.path,
            file: matchedRoute.clientPath,
            durationMs: compileMs,
          });
        }
        res.set({
          'cache-control': 'no-store, no-cache, must-revalidate, private',
          'pragma': 'no-cache',
          'expires': '0',
          'x-content-type-options': 'nosniff',
          'x-vula-route-path': matchedRoute.path,
          'x-vula-route-client-path': matchedRoute.clientPath,
          'x-vula-compile-ms': String(compileMs),
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
            if (isDev) {
              const formatted = formatErrorDetails(err, matchedRoute.clientPath || matchedRoute.path);
              pushDevError('ssr', { title: 'Route SSR Error', file: formatted.file, message: formatted.message });
            }
            if (!res.headersSent) res.status(500).send('Page rendering failed');
          },
          onError(err) {
            renderError = true;
            console.error('[vula] Route SSR error:', err);
            if (isDev) {
              const formatted = formatErrorDetails(err, matchedRoute.clientPath || matchedRoute.path);
              pushDevError('ssr', { title: 'Route SSR Error', file: formatted.file, message: formatted.message });
            }
          },
        }
      );
    } catch (err) {
      console.error('[vula] Failed to render route:', err);
      if (isDev) {
        const formatted = formatErrorDetails(err, matchedRoute.clientPath || matchedRoute.path);
        pushDevError('ssr', { title: 'Route SSR Error', file: formatted.file, message: formatted.message });
      }
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

  function buildStreamShellHtml({ title, nonce, lang, surface, params, bg = '#FAF7F2' }) {
    const safeLang = escapeHtml(lang || 'en');
    const safeTitle = escapeHtml(title || 'Vula App');
    const safeNonce = escapeHtml(nonce || '');
    const mountOpts = params ? { surface, params } : { surface };
    const safeMountJson = JSON.stringify(mountOpts).replace(/</g, '\\u003c');
    const safeBg = escapeHtml(bg);
    return `<!DOCTYPE html><html lang="${safeLang}"><head><meta charset="utf-8"/><title>${safeTitle}</title><style>html,body,#vula-stream-root{margin:0;width:100%;height:100%;background:${safeBg};overflow:hidden}</style></head><body><div id="vula-stream-root"></div><script src="/_vula/stream/client.js" nonce="${safeNonce}"></script><script nonce="${safeNonce}">window.VulaStream&&window.VulaStream.mount(document.getElementById('vula-stream-root'),${safeMountJson});</script></body></html>`;
  }

  // Helper for SSR and streaming HTML
  async function serveHtml(req, res) {
    const manifestData = fs.existsSync(manifestPath)
      ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
      : manifest;
    const routeIndex = wasmRuntime.match(req.path);
    const nonce = res.locals.cspNonce || '';
    const lang = config.app.lang || 'en';
    const appName = config.app.name || 'Vula App';

    if (routeIndex < 0) {
      if (streamManager && Array.isArray(manifestData.streamSurfaces)) {
        const candidateSurface = req.path.replace(/^\/+|\/+$/g, '');
        const matchedSurface = candidateSurface
          ? manifestData.streamSurfaces.find((s) => s.name === candidateSurface)
          : null;
        if (matchedSurface) {
          return res.status(200).set({
            'cache-control': 'no-store, no-cache, must-revalidate, private',
            pragma: 'no-cache',
            expires: '0',
          }).type('html').send(buildStreamShellHtml({
            title: `${matchedSurface.name} - ${appName}`,
            nonce,
            lang,
            surface: matchedSurface.name,
            bg: '#050509',
          }));
        }
      }
      return res.status(404).send('<!DOCTYPE html><html><body><h1>404 Not Found</h1></body></html>');
    }

    const isInternalRender = isInternalStreamRendererRequest(req);
    const isGlobalDomStream = Boolean(
      streamManager &&
      resolveStreamingConfig(config).global &&
      !isInternalRender
    );

    const { renderToPipeableStream } = require(require.resolve('react-dom/server', { paths: [cwd, process.cwd()] }));
    const React = require(require.resolve('react', { paths: [cwd, process.cwd()] }));
    const matchedRoute = manifestData.routes[routeIndex];
    const matchedParams = extractRouteParams(matchedRoute.path, req.path);
    if (!matchedParams) return res.status(400).send('Invalid route path');

    const ssrStartMs = Date.now();
    if (isDev && !isInternalRender) {
      console.log(`[vula] compiling ${matchedRoute.path} (${matchedRoute.clientPath})...`);
      broadcastDevWs({
        type: 'compile-log',
        phase: 'start',
        path: matchedRoute.path,
        file: matchedRoute.clientPath,
      });
    }

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
      const wsScript = isDev ? buildDevWsScript(nonce, vulaVersion) : '';
      const safePathJson = JSON.stringify(req.originalUrl || req.path || '/').replace(/</g, '\\u003c');
      const domStreamScript = isGlobalDomStream
        ? `<script src="/_vula/stream/client.js" nonce="${escapeHtml(nonce)}"></script><script nonce="${escapeHtml(nonce)}">window.VulaStream&&window.VulaStream.mountDom(document.getElementById('root'),{surface:'__global__',path:${safePathJson}});</script>`
        : '';

      // Parse custom index.html if it exists to preserve user favicons and meta tags
      let htmlHead = `<!DOCTYPE html><html lang="${lang}"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/><title>${appName}</title><link rel="stylesheet" href="/.vula.cache.css"/></head><body><div id="root">`;
      let htmlTail = `</div>${domStreamScript}${wsScript}</body></html>`;
      const indexHtmlPath = path.join(cwd, 'index.html');
      if (fs.existsSync(indexHtmlPath)) {
        let indexHtml = fs.readFileSync(indexHtmlPath, 'utf8');
        if (!indexHtml.includes('.vula.cache.css')) {
          indexHtml = indexHtml.replace('</head>', '<link rel="stylesheet" href="/.vula.cache.css"/>\n</head>');
        }
        if (isGlobalDomStream) {
          indexHtml = indexHtml
            .replace(/<script\b[^>]*\bsrc\s*=\s*["'][^"']*\.vula\.cache\.js[^"']*["'][^>]*>\s*<\/script>/gi, '')
            .replace(/<script\b[^>]*\bsrc\s*=\s*["'][^"']*\/chunks\/[^"']*["'][^>]*>\s*<\/script>/gi, '')
            .replace(/<link\b[^>]*\bas\s*=\s*["']script["'][^>]*>/gi, '');
        }
        const rootParts = indexHtml.split('<div id="root"></div>');
        if (rootParts.length === 2) {
          htmlHead = rootParts[0] + '<div id="root">';
          htmlTail = `</div>${domStreamScript}${wsScript}` + rootParts[1];
        }
      }

      htmlHead = injectHeadTags(htmlHead, config, vulaVersion);
      htmlHead = htmlHead.replace(
        '<div id="root">',
        `<div id="root" data-vula-dom="incoming" data-vula-route-index="${routeIndex}" data-vula-route-path="${escapeHtml(matchedRoute.path)}" data-vula-route-client-path="${escapeHtml(matchedRoute.clientPath)}">`
      );

      streamReactSsrResponse({
        res,
        renderToPipeableStream,
        element: React.createElement(React.StrictMode, null, appElement),
        nonce,
        htmlHead,
        htmlTail,
        bootstrapScripts: isGlobalDomStream ? [] : ['/.vula.cache.js'],
        isDev: isDev && !isInternalRender,
        vulaVersion,
        routeFile: matchedRoute.clientPath || matchedRoute.path,
        routePath: matchedRoute.path,
        ssrStartMs,
      });
    } catch (err) {
      console.error('[vula] Failed to SSR:', err);
      const formatted = formatErrorDetails(err, matchedRoute.clientPath || matchedRoute.path);
      if (isDev) {
        pushDevError('ssr', { title: 'SSR Error', file: formatted.file, message: formatted.message });
      }
      if (!res.headersSent) {
        if (isDev) {
          const initialErrors = [{ title: 'SSR Error', file: formatted.file, message: formatted.message }];
          res.status(500).type('html').send(
            `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Vula Dev Error</title></head><body><div id="root"></div>${buildDevWsScript(nonce || '', vulaVersion, initialErrors)}</body></html>`
          );
        } else {
          res.status(500).send('Internal Server Error');
        }
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

    // Only proxy /_rspack/* (and HMR *.hot-update.* assets) when an external Rspack dev port differs from our Express port
    const rspackTargetPort = options.rspackPort || process.env.VULA_RSPACK_PORT;
    if (rspackTargetPort && Number(rspackTargetPort) !== Number(resolvedPort)) {
      const rspackProxy = httpProxy.createProxyServer({ target: `http://localhost:${Number(rspackTargetPort)}` });
      app.all('/_rspack/*', (req, res) => {
        rspackProxy.web(req, res, {}, () => {
          if (!res.headersSent) res.status(502).send('Rspack Dev Server is down');
        });
      });
      app.get(/^\/[^/]+\.hot-update\.(?:js|json|js\.map)$/i, (req, res) => {
        rspackProxy.web(req, res, {}, () => {
          if (!res.headersSent) res.status(404).type('text/plain').send('Not Found');
        });
      });
    }

    app.get('*', async (req, res) => {
      if (/\.(hot-update\.js|hot-update\.json|js\.map|css\.map|js|css|json)$/i.test(req.path)) {
        return res.status(404).type('text/plain').send('Not Found');
      }
      await serveHtml(req, res);
    });
  }

  return { app, config, manifest, wasmRuntime, resolvedPort, manifestPath, isDev, cwd, streamManager };
}

/**
 * Starts the Vula.js server (HTTP + dev watcher/WebSocket when not in production).
 */
async function startServer(portOrOptions) {
  const appOptions = (portOrOptions && typeof portOrOptions === 'object')
    ? portOrOptions
    : { port: portOrOptions };
  const ctx = await createApp(appOptions);
  const { app, wasmRuntime, manifest, resolvedPort, isDev, cwd, streamManager } = ctx;
  global.__vulaStreamManager = streamManager || null;

  if (isDev && !process.env.VULA_DISABLE_WATCHER) {
    global.vulaWssClients = global.vulaWssClients || new Set();

    const chokidar = require('chokidar');
    const { generateClientRouteManifest, generateRouteManifest } = require('./router/manifest.js');
    const appDir = path.join(cwd, 'app');
    const srcDir = path.join(cwd, 'src');
    const watchDirs = [appDir, srcDir].filter((d) => fs.existsSync(d));

    let debounceTimer;
    const watcher = chokidar.watch(watchDirs, {
      ignored: /(\.git|node_modules)/,
      persistent: true,
      ignoreInitial: true
    });

    watcher.on('all', (event, filename) => {
      if (filename && /\.(tsx|ts|jsx|js|css)$/i.test(filename)) {
        clearProjectRequireCache(cwd);
        const relFile = path.relative(cwd, filename);
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          const hmrStartMs = Date.now();
          notifyDevCompiling(relFile);
          try {
            if (fs.existsSync(appDir)) {
              const manifestData = generateRouteManifest(appDir);
              wasmRuntime.setRoutes(manifestData.routes);
              manifest.routes = manifestData.routes;
              manifest.streamSurfaces = manifestData.streamSurfaces;
              fs.writeFileSync(path.join(cwd, '.vula-routes.json'), JSON.stringify(manifestData, null, 2));
              fs.writeFileSync(
                path.join(cwd, '.vula-routes.client.json'),
                JSON.stringify(generateClientRouteManifest(manifestData))
              );
            }
            setDevErrors('ssr', []);
            const elapsedMs = Math.max(1, Date.now() - hmrStartMs);
            console.log(`\x1b[32m✓ [vula]\x1b[0m compiled ${relFile} in ${elapsedMs}ms`);
            if (streamManager && typeof streamManager.reloadActiveSessions === 'function') {
              streamManager.reloadActiveSessions();
            }
            broadcastDevWs({
              type: 'hmr-update',
              file: relFile,
              durationMs: elapsedMs,
              timestamp: Date.now(),
            });
          } catch (err) {
            console.error('[vula] Manifest error:', err);
            const formatted = formatErrorDetails(err, filename);
            pushDevError('ssr', { title: 'Manifest Error', file: formatted.file, message: formatted.message });
          }
        }, 120);
      }
    });

    const cleanupWatcher = () => { clearTimeout(debounceTimer); watcher.close(); };
    process.once('SIGTERM', cleanupWatcher);
    process.once('SIGINT', cleanupWatcher);
  }

  const server = app.listen(resolvedPort, () => {
    const addr = server.address();
    if (app.locals && app.locals.streamServerRef && addr && typeof addr === 'object' && addr.port) {
      app.locals.streamServerRef.port = addr.port;
    }
    console.log(`[vula] Server running at http://localhost:${addr && typeof addr === 'object' ? addr.port : resolvedPort}`);
    console.log(`[vula] text-opt: ${ctx.config.optimization['text-opt'] ? 'on' : 'off'} | csrf: ${ctx.config.security.csrf ? 'on' : 'off'} | proxy: ${ctx.config.proxy.enabled ? 'on' : 'off'}`);
  });

  if (isDev) {
    const { WebSocketServer } = require('ws');
    const { verifyOrigin } = require('./RSC/csrf.js');
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
          if (latest) {
            latestVulaVersion = latest;
            broadcastDevWs({
              type: 'version',
              version: currentVulaVersion,
              latestVersion: latestVulaVersion,
            });
          }
        } catch (e) {}
      });
    }).on('error', () => {});

    const allowedOrigins = (ctx.config && ctx.config.security && ctx.config.security['allowed-origins']) || [];
    const wss = streamManager
      ? new WebSocketServer({ noServer: true })
      : new WebSocketServer({
          server,
          verifyClient: ({ req }) => verifyOrigin(req, allowedOrigins),
        });
    global.vulaWssClients = global.vulaWssClients || new Set();
    wss.on('connection', (ws) => {
      ws.send(JSON.stringify({
        type: 'connected',
        version: currentVulaVersion,
        latestVersion: latestVulaVersion
      }));
      const activeErrors = getAllDevErrors();
      if (activeErrors.length) {
        ws.send(JSON.stringify({ type: 'sync-errors', errors: activeErrors }));
      }
      global.vulaWssClients.add(ws);
      ws.on('close', () => global.vulaWssClients.delete(ws));
    });

    if (streamManager) {
      const { attachStreamUpgradeHandler } = require('./stream/index.js');
      attachStreamUpgradeHandler(server, streamManager, {
        fallbackUpgrade: (req, socket, head) => {
          if (!verifyOrigin(req, allowedOrigins)) {
            socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
            socket.destroy();
            return;
          }
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
  buildDevWsScript,
  clearProjectRequireCache,
  getAllDevErrors,
  injectHeadTags,
  notifyDevBuildDone,
  notifyDevCompiling,
  pushDevError,
  serveSwvulaAssets,
  setDevErrors,
};
