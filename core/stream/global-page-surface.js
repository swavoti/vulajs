const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const { resolveStreamingConfig } = require('../config.js');
const { createCdpDomSession, createCdpPageSession, findBrowserBinary } = require('./cdp-renderer.js');

function toAscii(str) {
  return String(str || '')
    .replace(/[\u2014\u2013]/g, '-')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\u2192/g, '->')
    .replace(/\u2190/g, '<-')
    .replace(/\u00B7|\u2022/g, '|')
    .replace(/\u00BC/g, '1/4')
    .replace(/\u00BD/g, '1/2')
    .replace(/\u00BE/g, '3/4')
    .replace(/\u00B0/g, ' deg')
    .replace(/\u2026/g, '...')
    .replace(/[^\x20-\x7E\n]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

function decodeEntities(str) {
  return String(str || '')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/&mdash;/gi, '-')
    .replace(/&ndash;/gi, '-')
    .replace(/&rsquo;|&lsquo;/gi, "'")
    .replace(/&rdquo;|&ldquo;/gi, '"')
    .replace(/&middot;|&bull;/gi, '|')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function stripTags(html) {
  return toAscii(decodeEntities(String(html || '').replace(/<[^>]+>/g, ' ')));
}

function getAttr(attrStr, name) {
  const re = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const m = String(attrStr || '').match(re);
  return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? '') : '';
}

function extractRouteParams(pattern, pathname) {
  const patternParts = pattern.split('/').filter(Boolean);
  const pathParts = pathname.split('/').filter(Boolean);
  const params = {};

  for (let i = 0; i < patternParts.length; i++) {
    const part = patternParts[i];
    if (part.startsWith('*')) {
      const key = part.slice(1) || 'slug';
      params[key] = pathParts.slice(i).map(decodeURIComponent).join('/');
      return params;
    }
    if (i >= pathParts.length) return null;
    if (part.startsWith(':')) {
      params[part.slice(1)] = decodeURIComponent(pathParts[i]);
    } else if (part !== pathParts[i]) {
      return null;
    }
  }

  return pathParts.length === patternParts.length ? params : null;
}

function parseNavLinks(headerHtml) {
  const links = [];
  const re = /<a\s+([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(headerHtml)) !== null) {
    const attrs = m[1];
    const href = getAttr(attrs, 'href');
    const cls = getAttr(attrs, 'class');
    const label = stripTags(m[2]).replace(/^H\s+/, '');
    if (!label) continue;
    links.push({
      href: href || '/',
      label,
      isBrand: cls.includes('brand'),
      isCta: cls.includes('cta'),
    });
  }
  return links;
}

function parseBlocks(html) {
  let cleaned = String(html || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg)[^>]*>[\s\S]*?<\/\1>/gi, '');

  const headerMatch = cleaned.match(/<header\b[^>]*>([\s\S]*?)<\/header>/i);
  const navLinks = headerMatch ? parseNavLinks(headerMatch[1]) : [];
  if (headerMatch) {
    cleaned = cleaned.replace(headerMatch[0], '');
  }

  // Drop footer from primary flow but keep main body content clean
  cleaned = cleaned.replace(/<footer\b[^>]*>[\s\S]*?<\/footer>/i, '');

  const blocks = [];
  const tokenRe = /<(h1|h2|h3|h4|p|li|blockquote|a|button|img|input|textarea|label|span|div)\b([^>]*)>([\s\S]*?)<\/\1>|<(img|input)\b([^>]*)\/?>/gi;

  // Walk block-level elements sequentially by slicing matched top segments
  const itemRe = /<(h1|h2|h3|h4|p|li|blockquote|a|button)\b([^>]*)>([\s\S]*?)<\/\1>|<(img|input)\b([^>]*)\/?>/gi;
  let match;
  let lastImgAlt = '';
  while ((match = itemRe.exec(cleaned)) !== null) {
    const tag = (match[1] || match[4] || '').toLowerCase();
    const attrs = match[2] || match[5] || '';
    const inner = match[3] || '';
    const cls = getAttr(attrs, 'class');

    if (tag === 'img') {
      const alt = toAscii(getAttr(attrs, 'alt') || 'Recipe visual');
      if (alt && alt !== lastImgAlt) {
        lastImgAlt = alt;
        blocks.push({ kind: 'media', text: alt });
      }
      continue;
    }

    if (tag === 'input') {
      const placeholder = toAscii(getAttr(attrs, 'placeholder') || getAttr(attrs, 'value') || 'Enter value...');
      blocks.push({ kind: 'input', text: placeholder });
      continue;
    }

    if (tag === 'a') {
      const href = getAttr(attrs, 'href');
      const text = stripTags(inner);
      if (!text) continue;
      const isCard = cls.includes('card');
      blocks.push({
        kind: isCard ? 'card-link' : 'link',
        href: href || '/',
        text,
        isButton: cls.includes('btn') || cls.includes('cta'),
      });
      continue;
    }

    if (tag === 'button') {
      const text = stripTags(inner);
      if (!text) continue;
      blocks.push({ kind: 'button', text });
      continue;
    }

    const text = stripTags(inner);
    if (!text) continue;

    if (tag === 'h1') {
      blocks.push({ kind: 'h1', text });
    } else if (tag === 'h2' || tag === 'h3' || tag === 'h4') {
      blocks.push({ kind: 'h2', text });
    } else if (tag === 'li') {
      blocks.push({ kind: 'li', text: `- ${text}` });
    } else {
      blocks.push({ kind: 'p', text });
    }
  }

  if (blocks.length === 0) {
    const fallbackText = stripTags(cleaned);
    if (fallbackText) {
      blocks.push({ kind: 'p', text: fallbackText });
    }
  }

  return { navLinks, blocks, tokenRe };
}

function wrapText(text, maxChars) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const limit = Math.max(12, maxChars);
  const lines = [];
  let line = '';

  for (const word of words) {
    if (!line) {
      line = word.length > limit ? word.slice(0, limit) : word;
      continue;
    }
    if (line.length + 1 + word.length <= limit) {
      line += ' ' + word;
    } else {
      lines.push(line);
      line = word.length > limit ? word.slice(0, limit) : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

async function createGlobalPageSurface(ctx, options = {}) {
  const {
    manifest,
    manifestPath,
    config,
    wasmRuntime,
    cwd = process.cwd(),
    serverRef,
  } = options;

  const streamCfg = resolveStreamingConfig(config);
  const isDomMode = ctx?.params?.mode === 'dom';

  if (
    process.env.VULA_STREAM_NO_CDP !== '1' &&
    serverRef &&
    serverRef.port &&
    serverRef.internalRenderSecret &&
    findBrowserBinary()
  ) {
    try {
      const opts = {
        baseUrl: `http://127.0.0.1:${serverRef.port}`,
        initialPath: ctx?.params?.path || '/',
        internalRenderSecret: serverRef.internalRenderSecret,
        allowConsoleLogs: Boolean(streamCfg['allow-console-logs']),
        dynamicLoading: streamCfg['dynamic-loading'] !== false,
        streamQuality: streamCfg.quality || 'hd',
      };
      if (isDomMode) {
        return await createCdpDomSession(ctx, opts);
      }
      const cdpSession = await createCdpPageSession(ctx, opts);
      return {
        streamsOwnFrames: true,
        ...cdpSession,
      };
    } catch (err) {
      if (isDomMode) {
        console.error('[vula-stream] Server DOM stream renderer failed:', err.message);
        const targetPath = normalizePath(ctx?.params?.path || '/');
        return {
          streamsOwnFrames: true,
          render() {
            if (ctx && typeof ctx.pushControl === 'function') {
              ctx.pushControl({
                type: 'dom-sync',
                path: targetPath,
                title: 'Stream Renderer Error',
                html: '<main role="alert" style="padding:2rem;font-family:system-ui,sans-serif"><h2>Server Stream Unavailable</h2><p>Headless server renderer failed to start. Client-side fallback is disabled.</p></main>',
              });
            }
          },
          onInput() {},
          onDestroy() {},
        };
      }
      console.warn('[vula-stream] Headless Chromium render unavailable, using fallback surface:', err.message);
    }
  } else if (isDomMode) {
    const targetPath = normalizePath(ctx?.params?.path || '/');
    return {
      streamsOwnFrames: true,
      render() {
        if (ctx && typeof ctx.pushControl === 'function') {
          ctx.pushControl({
            type: 'dom-sync',
            path: targetPath,
            title: 'Stream Renderer Unavailable',
            html: '<main role="alert" style="padding:2rem;font-family:system-ui,sans-serif"><h2>Server Stream Unavailable</h2><p>No headless Chromium/Brave runtime found on the server. Client-side fallback is disabled.</p></main>',
          });
        }
      },
      onInput() {},
      onDestroy() {},
    };
  }

  let currentPath = normalizePath(ctx?.params?.path || '/');
  let scrollY = 0;
  let maxScroll = 0;
  let hoverX = -1;
  let hoverY = -1;
  let lastCursor = 'default';
  let statusNotice = '';
  let pageState = {
    title: (config && config.app && config.app.name) || 'Vula App',
    navLinks: [],
    blocks: [],
    error: null,
  };
  let hitboxes = [];
  let delegateSurface = null;

  function normalizePath(raw) {
    try {
      const u = new URL(String(raw || '/'), 'http://vula.local');
      return u.pathname || '/';
    } catch {
      return '/';
    }
  }

  function loadManifestData() {
    if (manifestPath && fs.existsSync(manifestPath)) {
      try {
        return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      } catch {
        // fallback to in-memory manifest
      }
    }
    return manifest || { routes: [], streamSurfaces: [] };
  }

  function findLayoutComponent() {
    const candidates = [
      path.join(cwd, 'app', 'layout.tsx'),
      path.join(cwd, 'app', 'layout.jsx'),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        try {
          const mod = require(candidate);
          return mod.default || mod;
        } catch (err) {
          console.warn('[vula-stream] Failed to load layout:', err.message);
          return null;
        }
      }
    }
    return null;
  }

  function destroyDelegate() {
    if (delegateSurface && typeof delegateSurface.onDestroy === 'function') {
      try {
        delegateSurface.onDestroy();
      } catch {
        // ignore
      }
    }
    delegateSurface = null;
  }

  function renderCurrentRoute() {
    destroyDelegate();
    const manifestData = loadManifestData();
    const routeIndex = wasmRuntime ? wasmRuntime.match(currentPath) : -1;

    if (routeIndex < 0) {
      const candidateName = currentPath.replace(/^\/+|\/+$/g, '');
      const surfaceEntry = Array.isArray(manifestData.streamSurfaces)
        ? manifestData.streamSurfaces.find((s) => s.name === candidateName)
        : null;

      if (surfaceEntry && fs.existsSync(surfaceEntry.path)) {
        try {
          const mod = require(surfaceEntry.path);
          const factory = mod.default || mod.createSurface || mod;
          if (typeof factory === 'function') {
            delegateSurface = factory({
              ...ctx,
              surfaceName: surfaceEntry.name,
            });
            if (ctx && typeof ctx.pushControl === 'function') {
              ctx.pushControl({
                type: 'title',
                title: `${surfaceEntry.name} - ${(config?.app?.name || 'Vula App')}`,
              });
            }
            return;
          }
        } catch (err) {
          pageState = {
            title: 'Stream Error',
            navLinks: [],
            blocks: [{ kind: 'h1', text: 'Failed to start stream surface' }, { kind: 'p', text: toAscii(err.message) }],
            error: err.message,
          };
          return;
        }
      }

      pageState = {
        title: `404 - ${(config?.app?.name || 'Vula App')}`,
        navLinks: pageState.navLinks,
        blocks: [
          { kind: 'h1', text: '404 - Page Not Found' },
          { kind: 'p', text: `No route matched ${toAscii(currentPath)}` },
          { kind: 'link', href: '/', text: 'Return Home', isButton: true },
        ],
        error: null,
      };
      return;
    }

    const matchedRoute = manifestData.routes[routeIndex];
    const matchedParams = extractRouteParams(matchedRoute.path, currentPath) || {};

    try {
      const resolvePaths = [cwd, process.cwd(), path.resolve(__dirname, '../..')];
      const React = require(require.resolve('react', { paths: resolvePaths }));
      const { renderToStaticMarkup } = require(require.resolve('react-dom/server', { paths: resolvePaths }));

      const PageMod = require(matchedRoute.componentPath);
      const PageComp = PageMod.default || PageMod;
      const LayoutComp = findLayoutComponent();

      let element = React.createElement(PageComp, { params: matchedParams });
      if (LayoutComp) {
        element = React.createElement(LayoutComp, null, element);
      }

      const markup = renderToStaticMarkup(element);
      const parsed = parseBlocks(markup);
      const heading = parsed.blocks.find((b) => b.kind === 'h1');
      const title = heading
        ? `${heading.text} - ${toAscii(config?.app?.name || 'Vula App')}`
        : toAscii(config?.app?.name || 'Vula App');

      pageState = {
        title,
        navLinks: parsed.navLinks,
        blocks: parsed.blocks,
        error: null,
      };
      if (ctx && typeof ctx.pushControl === 'function') {
        ctx.pushControl({ type: 'title', title });
      }
    } catch (err) {
      pageState = {
        title: `Error - ${toAscii(config?.app?.name || 'Vula App')}`,
        navLinks: pageState.navLinks,
        blocks: [
          { kind: 'h1', text: 'Server Stream Render Error' },
          { kind: 'p', text: toAscii(err && err.message ? err.message : String(err)) },
          { kind: 'link', href: '/', text: 'Reload Home', isButton: true },
        ],
        error: err.message,
      };
    }
  }

  function navigateTo(nextHref, { pushHistory = true } = {}) {
    const nextPath = normalizePath(nextHref);
    if (nextPath === currentPath) return;
    currentPath = nextPath;
    scrollY = 0;
    statusNotice = '';
    if (pushHistory && ctx && typeof ctx.pushControl === 'function') {
      ctx.pushControl({ type: 'nav', path: currentPath });
    }
    renderCurrentRoute();
  }

  renderCurrentRoute();

  return {
    render(buf) {
      if (delegateSurface && typeof delegateSurface.render === 'function') {
        delegateSurface.render(buf);
        return;
      }

      const w = buf.width;
      const h = buf.height;
      const nextHitboxes = [];

      // Warm editorial background
      buf.clear(0xFA, 0xF7, 0xF2, 0xFF);

      const headerH = 60;
      const containerW = Math.min(980, Math.max(280, w - 48));
      const leftX = Math.floor((w - containerW) / 2);

      // Compute content stream first starting below header minus scrollY
      let cursorY = headerH + 28 - scrollY;
      const startContentY = cursorY;

      for (const block of pageState.blocks) {
        if (block.kind === 'h1') {
          const scale = w >= 720 ? 3 : 2;
          const charW = 6 * scale;
          const lineH = 9 * scale;
          const lines = wrapText(block.text, Math.floor(containerW / charW));
          for (const line of lines) {
            if (cursorY + lineH >= headerH && cursorY < h) {
              buf.drawText(line, leftX, cursorY, '#1C1917', scale);
            }
            cursorY += lineH + 4;
          }
          cursorY += 10;
          continue;
        }

        if (block.kind === 'h2') {
          const scale = 2;
          const charW = 6 * scale;
          const lineH = 8 * scale;
          const lines = wrapText(block.text, Math.floor(containerW / charW));
          cursorY += 6;
          for (const line of lines) {
            if (cursorY + lineH >= headerH && cursorY < h) {
              buf.drawText(line, leftX, cursorY, '#292524', scale);
            }
            cursorY += lineH + 4;
          }
          cursorY += 8;
          continue;
        }

        if (block.kind === 'media') {
          const boxH = 54;
          if (cursorY + boxH >= headerH && cursorY < h) {
            buf.fillRect(leftX, cursorY, containerW, boxH, '#F3ECE1');
            buf.strokeRect(leftX, cursorY, containerW, boxH, '#E5DDD0', 1);
            buf.fillRect(leftX, cursorY, 5, boxH, '#C2410C');
            const label = toAscii(`[Media: ${block.text}]`).slice(0, Math.floor((containerW - 28) / 6));
            buf.drawText(label, leftX + 16, cursorY + 22, '#78716C', 1);
          }
          cursorY += boxH + 14;
          continue;
        }

        if (block.kind === 'input') {
          const boxH = 38;
          const boxW = Math.min(460, containerW);
          if (cursorY + boxH >= headerH && cursorY < h) {
            buf.fillRect(leftX, cursorY, boxW, boxH, '#FFFFFF');
            buf.strokeRect(leftX, cursorY, boxW, boxH, '#D6CCC0', 1);
            buf.drawText(block.text.slice(0, Math.floor((boxW - 24) / 6)), leftX + 12, cursorY + 15, '#78716C', 1);
          }
          cursorY += boxH + 12;
          continue;
        }

        if (block.kind === 'card-link') {
          const scale = 2;
          const charW = 6 * scale;
          const lineH = 8 * scale;
          const lines = wrapText(block.text, Math.floor((containerW - 36) / charW));
          const cardH = Math.max(46, lines.length * (lineH + 4) + 22);
          const hovered =
            hoverX >= leftX && hoverX <= leftX + containerW &&
            hoverY >= Math.max(headerH, cursorY) && hoverY <= cursorY + cardH;

          if (cursorY + cardH >= headerH && cursorY < h) {
            buf.fillRect(leftX, cursorY, containerW, cardH, hovered ? '#FDF9F3' : '#FFFFFF');
            buf.strokeRect(leftX, cursorY, containerW, cardH, hovered ? '#C2410C' : '#E5DDD0', hovered ? 2 : 1);
            buf.fillRect(leftX, cursorY, 4, cardH, '#C2410C');
            let ly = cursorY + 12;
            for (const line of lines) {
              buf.drawText(line, leftX + 16, ly, '#1C1917', scale);
              ly += lineH + 4;
            }
          }
          nextHitboxes.push({
            x: leftX,
            y: Math.max(headerH, cursorY),
            w: containerW,
            h: cardH,
            href: block.href,
            kind: 'nav',
          });
          cursorY += cardH + 12;
          continue;
        }

        if (block.kind === 'link' || block.kind === 'button') {
          const scale = w >= 720 ? 2 : 1;
          const charW = 6 * scale;
          const btnText = block.text.slice(0, Math.floor((containerW - 32) / charW));
          const btnW = Math.min(containerW, btnText.length * charW + 28);
          const btnH = scale === 2 ? 36 : 26;
          const hovered =
            hoverX >= leftX && hoverX <= leftX + btnW &&
            hoverY >= Math.max(headerH, cursorY) && hoverY <= cursorY + btnH;

          if (cursorY + btnH >= headerH && cursorY < h) {
            if (block.isButton || block.kind === 'button') {
              const fill = block.kind === 'button'
                ? (hovered ? '#E7DEC8' : '#EFE7DA')
                : (hovered ? '#9A3412' : '#C2410C');
              const fg = block.kind === 'button' ? '#1C1917' : '#FFFFFF';
              buf.fillRect(leftX, cursorY, btnW, btnH, fill);
              if (block.kind === 'button') {
                buf.strokeRect(leftX, cursorY, btnW, btnH, '#D6CCC0', 1);
              }
              buf.drawText(btnText, leftX + 14, cursorY + (scale === 2 ? 11 : 9), fg, scale);
            } else {
              buf.drawText(btnText, leftX, cursorY + 4, hovered ? '#9A3412' : '#C2410C', scale);
              buf.fillRect(leftX, cursorY + (scale === 2 ? 22 : 14), btnText.length * charW, 1, '#C2410C');
            }
          }
          nextHitboxes.push({
            x: leftX,
            y: Math.max(headerH, cursorY),
            w: btnW,
            h: btnH,
            href: block.kind === 'link' ? block.href : null,
            kind: block.kind === 'link' ? 'nav' : 'button',
            label: block.text,
          });
          cursorY += btnH + 10;
          continue;
        }

        // Paragraph / list item
        const scale = 2;
        const charW = 6 * scale;
        const lineH = 8 * scale;
        const lines = wrapText(block.text, Math.floor(containerW / charW));
        for (const line of lines) {
          if (cursorY + lineH >= headerH && cursorY < h) {
            buf.drawText(line, leftX, cursorY, '#44403C', scale);
          }
          cursorY += lineH + 4;
        }
        cursorY += 8;
      }

      const totalContentH = (cursorY - startContentY) + 48;
      maxScroll = Math.max(0, totalContentH - (h - headerH));

      // Scrollbar track & thumb when content exceeds viewport
      if (maxScroll > 0) {
        const trackX = w - 10;
        const trackY = headerH + 6;
        const trackH = Math.max(24, h - headerH - 12);
        buf.fillRect(trackX, trackY, 6, trackH, '#EAE2D6');
        const thumbH = Math.max(24, Math.floor((trackH * (h - headerH)) / totalContentH));
        const thumbY = trackY + Math.floor(((trackH - thumbH) * scrollY) / maxScroll);
        buf.fillRect(trackX, thumbY, 6, thumbH, '#A89F91');
      }

      // Draw sticky header last so scrolling content cleanly clips underneath it
      buf.fillRect(0, 0, w, headerH, '#FFFFFF');
      buf.fillRect(0, headerH - 1, w, 1, '#E5DDD0');

      let navX = 20;
      for (const nav of pageState.navLinks) {
        if (nav.isBrand) {
          buf.fillRect(navX, 16, 26, 28, '#C2410C');
          buf.drawText('H', navX + 7, 23, '#FFFFFF', 2);
          buf.drawText(nav.label, navX + 34, 23, '#1C1917', 2);
          const brandW = 34 + nav.label.length * 12 + 12;
          nextHitboxes.push({ x: navX, y: 10, w: brandW, h: 40, href: nav.href, kind: 'nav' });
          navX += brandW + 14;
          continue;
        }

        const itemW = nav.label.length * 6 + 16;
        if (navX + itemW > w - 165) break;

        const hovered = hoverX >= navX && hoverX <= navX + itemW && hoverY >= 14 && hoverY <= 46;
        const active = currentPath === normalizePath(nav.href);
        if (nav.isCta) {
          buf.fillRect(navX, 16, itemW, 28, hovered ? '#9A3412' : '#C2410C');
          buf.drawText(nav.label, navX + 8, 27, '#FFFFFF', 1);
        } else {
          if (hovered || active) {
            buf.fillRect(navX, 16, itemW, 28, hovered ? '#F3ECE1' : '#FAF5EE');
          }
          buf.drawText(nav.label, navX + 8, 27, active ? '#C2410C' : '#292524', 1);
          if (active) {
            buf.fillRect(navX + 8, 41, Math.max(8, itemW - 16), 2, '#C2410C');
          }
        }
        nextHitboxes.push({ x: navX, y: 14, w: itemW, h: 32, href: nav.href, kind: 'nav' });
        navX += itemW + 8;
      }

      // Live stream status badge in top-right of header
      const badgeLabel = statusNotice || `STREAM ${currentPath}`;
      const badgeText = badgeLabel.slice(0, 24);
      const badgeW = badgeText.length * 6 + 16;
      const badgeX = Math.max(navX + 8, w - badgeW - 16);
      if (badgeX + badgeW <= w - 4) {
        buf.fillRect(badgeX, 18, badgeW, 24, '#ECFCCB');
        buf.strokeRect(badgeX, 18, badgeW, 24, '#BEF264', 1);
        buf.drawText(badgeText, badgeX + 8, 27, '#3F6212', 1);
      }

      hitboxes = nextHitboxes;
    },

    onInput(event) {
      if (delegateSurface && typeof delegateSurface.onInput === 'function') {
        delegateSurface.onInput(event, ctx);
        return;
      }

      if (event.type === 'wheel') {
        const delta = Number(event.deltaY || 0);
        scrollY = Math.max(0, Math.min(maxScroll, scrollY + delta));
        return;
      }

      if (event.type === 'keydown') {
        const step = 48;
        if (event.key === 'ArrowDown' || event.key === 'PageDown') {
          scrollY = Math.max(0, Math.min(maxScroll, scrollY + (event.key === 'PageDown' ? 280 : step)));
        } else if (event.key === 'ArrowUp' || event.key === 'PageUp') {
          scrollY = Math.max(0, Math.min(maxScroll, scrollY - (event.key === 'PageUp' ? 280 : step)));
        } else if (event.key === 'Home') {
          scrollY = 0;
        } else if (event.key === 'End') {
          scrollY = maxScroll;
        }
        return;
      }

      if (event.type === 'pointermove') {
        hoverX = event.x;
        hoverY = event.y;
        const hit = [...hitboxes].reverse().find(
          (hb) => hoverX >= hb.x && hoverX <= hb.x + hb.w && hoverY >= hb.y && hoverY <= hb.y + hb.h
        );
        const nextCursor = hit ? 'pointer' : 'default';
        if (nextCursor !== lastCursor) {
          lastCursor = nextCursor;
          if (ctx && typeof ctx.pushControl === 'function') {
            ctx.pushControl({ type: 'cursor', cursor: nextCursor });
          }
        }
        return;
      }

      if (event.type === 'pointerdown' && event.button === 0) {
        hoverX = event.x;
        hoverY = event.y;
        const hit = [...hitboxes].reverse().find(
          (hb) => hoverX >= hb.x && hoverX <= hb.x + hb.w && hoverY >= hb.y && hoverY <= hb.y + hb.h
        );
        if (hit) {
          if (hit.kind === 'nav' && hit.href && hit.href.startsWith('/')) {
            navigateTo(hit.href, { pushHistory: true });
          } else if (hit.kind === 'button') {
            statusNotice = `ACTION: ${toAscii(hit.label).slice(0, 14)}`;
          }
        }
        return;
      }

      if (event.type === 'popstate' && typeof event.path === 'string') {
        navigateTo(event.path, { pushHistory: false });
      }
    },

    onDestroy() {
      destroyDelegate();
    },
  };
}

module.exports = {
  createGlobalPageSurface,
  extractRouteParams,
};
