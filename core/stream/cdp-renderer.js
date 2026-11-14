'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { URL } = require('node:url');
const { WebSocket } = require('ws');

const BROWSER_CANDIDATES = [
  process.env.VULA_STREAM_BROWSER,
  '/usr/bin/brave-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
].filter(Boolean);

const ALLOWED_CURSORS = new Set([
  'auto',
  'default',
  'pointer',
  'text',
  'move',
  'grab',
  'grabbing',
  'crosshair',
  'not-allowed',
  'wait',
  'ew-resize',
  'ns-resize',
  'nwse-resize',
  'nesw-resize',
]);

function findBrowserBinary() {
  for (const bin of BROWSER_CANDIDATES) {
    try {
      if (fs.existsSync(bin)) return bin;
    } catch {
      // ignore
    }
  }
  return null;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
    srv.on('error', reject);
  });
}

function createCdpClient(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let nextId = 1;
    const pending = new Map();
    const listeners = new Map();

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString('utf8'));
      } catch {
        return;
      }
      if (msg.id && pending.has(msg.id)) {
        const entry = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) {
          entry.reject(new Error(msg.error.message || 'CDP error'));
        } else {
          entry.resolve(msg.result || {});
        }
        return;
      }
      if (msg.method) {
        const fns = listeners.get(msg.method);
        if (fns) {
          for (const fn of fns) {
            try {
              fn(msg.params || {});
            } catch {
              // ignore handler errors
            }
          }
        }
      }
    });

    ws.once('open', () => {
      resolve({
        call(method, params = {}) {
          if (ws.readyState !== WebSocket.OPEN) {
            return Promise.reject(new Error('CDP socket closed'));
          }
          const id = nextId++;
          return new Promise((res, rej) => {
            pending.set(id, { resolve: res, reject: rej });
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
        on(method, fn) {
          if (!listeners.has(method)) listeners.set(method, new Set());
          listeners.get(method).add(fn);
        },
        close() {
          for (const entry of pending.values()) {
            entry.reject(new Error('CDP client closed'));
          }
          pending.clear();
          listeners.clear();
          try {
            ws.close();
          } catch {
            // ignore
          }
        },
      });
    });

    ws.once('error', (err) => reject(err));
  });
}

let sharedBrowserState = null;
let sharedBrowserBootPromise = null;
let bootingProc = null;
let browserShutdownRequested = false;

async function shutdownSharedBrowser() {
  browserShutdownRequested = true;
  const state = sharedBrowserState;
  sharedBrowserState = null;
  sharedBrowserBootPromise = null;
  const pendingProc = bootingProc;
  bootingProc = null;
  if (pendingProc) {
    try { pendingProc.kill('SIGKILL'); } catch {}
  }
  if (!state) return;
  try {
    state.browserClient?.close();
  } catch {
    // ignore
  }
  try {
    state.proc?.kill('SIGKILL');
  } catch {
    // ignore
  }
  if (state.userDataDir) {
    try {
      fs.rmSync(state.userDataDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

process.once('exit', () => {
  if (bootingProc) {
    try { bootingProc.kill('SIGKILL'); } catch {}
  }
  if (sharedBrowserState?.proc) {
    try {
      sharedBrowserState.proc.kill('SIGKILL');
    } catch {
      // ignore
    }
  }
});

async function ensureSharedBrowser() {
  if (sharedBrowserState && !sharedBrowserState.proc.killed) {
    return sharedBrowserState;
  }
  if (sharedBrowserBootPromise) {
    return sharedBrowserBootPromise;
  }

  browserShutdownRequested = false;
  sharedBrowserBootPromise = (async () => {
    const bin = findBrowserBinary();
    if (!bin) {
      throw new Error('No headless Chromium/Brave binary found');
    }

    async function launchWithSandbox(useSandbox) {
      const cdpPort = await getFreePort();
      if (browserShutdownRequested) {
        throw new Error('Browser warmup aborted by shutdown');
      }
      const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vula-stream-browser-'));
      const args = [
        '--headless=new',
        `--remote-debugging-port=${cdpPort}`,
        `--user-data-dir=${userDataDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-dev-shm-usage',
        '--mute-audio',
      ];
      if (!useSandbox) {
        args.push('--no-sandbox');
      }
      args.push('about:blank');

      const proc = spawn(bin, args, { stdio: ['ignore', 'ignore', 'ignore'] });
      bootingProc = proc;
      let exitedEarly = false;

      proc.once('exit', () => {
        exitedEarly = true;
        if (bootingProc === proc) bootingProc = null;
        if (sharedBrowserState && sharedBrowserState.proc === proc) {
          sharedBrowserState = null;
        }
        try {
          fs.rmSync(userDataDir, { recursive: true, force: true });
        } catch {
          // ignore
        }
      });

      const deadline = Date.now() + 7000;
      let versionInfo = null;
      while (Date.now() < deadline && !browserShutdownRequested && !exitedEarly) {
        try {
          const res = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
          if (res.ok) {
            versionInfo = await res.json();
            if (versionInfo && versionInfo.webSocketDebuggerUrl) break;
          }
        } catch {
          // retry
        }
        await new Promise((r) => setTimeout(r, 60));
      }

      if (browserShutdownRequested || exitedEarly || !versionInfo || !versionInfo.webSocketDebuggerUrl) {
        try {
          proc.kill('SIGKILL');
        } catch {
          // ignore
        }
        if (exitedEarly && useSandbox && process.env.VULA_STREAM_STRICT_SANDBOX !== '1') {
          return null;
        }
        throw new Error(browserShutdownRequested ? 'Browser warmup aborted by shutdown' : 'Timed out waiting for headless Chromium CDP');
      }

      return { cdpPort, userDataDir, proc, versionInfo };
    }

    const preferSandbox = process.env.VULA_STREAM_NO_SANDBOX !== '1';
    let booted = await launchWithSandbox(preferSandbox);
    if (!booted) {
      console.warn('[vula-stream] Chromium sandbox unsupported in this environment; falling back to --no-sandbox');
      booted = await launchWithSandbox(false);
    }

    const { cdpPort, userDataDir, proc, versionInfo } = booted;

    const browserClient = await createCdpClient(versionInfo.webSocketDebuggerUrl);
    if (browserShutdownRequested) {
      try { browserClient.close(); } catch {}
      try { proc.kill('SIGKILL'); } catch {}
      throw new Error('Browser warmup aborted by shutdown');
    }
    bootingProc = null;
    sharedBrowserState = {
      cdpPort,
      userDataDir,
      proc,
      browserClient,
    };
    return sharedBrowserState;
  })();

  try {
    return await sharedBrowserBootPromise;
  } finally {
    sharedBrowserBootPromise = null;
  }
}

function warmUpBrowser() {
  if (process.env.VULA_STREAM_NO_CDP === '1' || process.env.NODE_ENV === 'test') {
    return;
  }
  if (!findBrowserBinary()) return;
  ensureSharedBrowser().catch(() => {});
}

function mapButtonName(btn) {
  if (btn === 1) return 'middle';
  if (btn === 2) return 'right';
  return 'left';
}

function mapMoveButtonName(buttons) {
  if (buttons & 1) return 'left';
  if (buttons & 2) return 'right';
  if (buttons & 4) return 'middle';
  return 'none';
}

function mapModifiers(evt) {
  let mask = 0;
  if (evt.altKey) mask |= 1;
  if (evt.ctrlKey) mask |= 2;
  if (evt.metaKey) mask |= 4;
  if (evt.shiftKey) mask |= 8;
  return mask;
}

function resolveQualityOptions(preset) {
  const normalized = String(preset || 'hd').toLowerCase();
  if (normalized === 'lossless' || normalized === 'png') {
    return { format: 'png', codec: 'png', screenshotParams: { format: 'png' } };
  }
  if (normalized === 'balanced') {
    return {
      format: 'jpeg',
      codec: 'jpeg',
      quality: 84,
      screenshotParams: { format: 'jpeg', quality: 84 },
    };
  }
  return {
    format: 'jpeg',
    codec: 'jpeg',
    quality: 94,
    screenshotParams: { format: 'jpeg', quality: 94 },
  };
}

function formatRemoteArg(arg) {
  if (!arg) return '';
  if (Object.prototype.hasOwnProperty.call(arg, 'value')) {
    return typeof arg.value === 'string' ? arg.value : JSON.stringify(arg.value);
  }
  return arg.description || arg.type || '';
}

/**
 * Creates an isolated per-session incognito Chromium context + target and scopes internal SSR headers strictly to baseUrl.
 */
async function createIsolatedCdpTarget(browser, baseUrl, internalRenderSecret, targetOpts = {}) {
  const { browserContextId } = await browser.browserClient.call('Target.createBrowserContext', {
    disposeOnDetach: true,
  });

  let targetId;
  try {
    ({ targetId } = await browser.browserClient.call('Target.createTarget', {
      url: 'about:blank',
      browserContextId,
      ...targetOpts,
    }));
  } catch (err) {
    await browser.browserClient.call('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
    throw err;
  }

  const targetsRes = await fetch(`http://127.0.0.1:${browser.cdpPort}/json/list`);
  const targets = await targetsRes.json();
  const target = Array.isArray(targets) ? targets.find((t) => t.id === targetId) : null;
  if (!target || !target.webSocketDebuggerUrl) {
    await browser.browserClient.call('Target.closeTarget', { targetId }).catch(() => {});
    await browser.browserClient.call('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
    throw new Error('Failed to resolve CDP target WebSocket');
  }

  const pageCdp = await createCdpClient(target.webSocketDebuggerUrl);
  const baseOrigin = new URL(baseUrl).origin;

  function setupScopedInternalHeaders() {
    pageCdp.on('Fetch.requestPaused', (params) => {
      const reqUrl = String(params.request?.url || '');
      const isInternalOrigin = reqUrl === baseOrigin || reqUrl.startsWith(`${baseOrigin}/`);
      const headers = Object.entries(params.request?.headers || {})
        .filter(([name]) => name.toLowerCase() !== 'x-vula-internal-ssr')
        .map(([name, value]) => ({ name, value: String(value) }));
      if (isInternalOrigin && internalRenderSecret) {
        headers.push({ name: 'x-vula-internal-ssr', value: internalRenderSecret });
      }
      pageCdp.call('Fetch.continueRequest', {
        requestId: params.requestId,
        headers,
      }).catch(() => {});
    });

    return pageCdp.call('Fetch.enable', {
      patterns: [{ urlPattern: `${baseOrigin}/*`, requestStage: 'Request' }],
    });
  }

  function dispose() {
    pageCdp.close();
    browser.browserClient.call('Target.closeTarget', { targetId }).catch(() => {});
    browser.browserClient.call('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
  }

  return { pageCdp, targetId, browserContextId, setupScopedInternalHeaders, dispose };
}

async function createCdpPageSession(ctx, {
  baseUrl,
  initialPath = '/',
  internalRenderSecret,
  allowConsoleLogs = false,
  dynamicLoading = true,
  streamQuality = 'hd',
}) {
  const browser = await ensureSharedBrowser();
  const isolated = await createIsolatedCdpTarget(browser, baseUrl, internalRenderSecret, { newWindow: true });
  const { pageCdp } = isolated;

  const qualityCfg = resolveQualityOptions(streamQuality);
  let destroyed = false;
  let lastPath = initialPath || '/';
  let lastCursor = 'default';
  let cursorTimer = null;
  let scrollSyncTimer = null;
  let lastCursorCheckAt = 0;
  let lastWheelAt = 0;
  let capturingInFlight = false;
  let screencastStarted = false;
  let screencastRestartPending = false;
  let lastScreencastFrameAt = 0;
  let moveInFlight = false;
  let pendingMove = null;
  let wheelInFlight = false;
  let pendingWheel = null;
  let scrollToInFlight = false;
  let pendingScrollTo = null;

  const getMetrics = () => {
    const dpr = Math.max(1, Math.min(3, Number(ctx.dpr) || 1));
    const width = Math.max(64, Number(ctx.width) || 1280);
    const height = Math.max(64, Number(ctx.height) || 720);
    return {
      dpr,
      width,
      height,
      cssWidth: Math.max(64, Math.round(width / dpr)),
      cssHeight: Math.max(64, Math.round(height / dpr)),
    };
  };

  async function syncScrollMetrics() {
    if (destroyed) return;
    try {
      const res = await pageCdp.call('Runtime.evaluate', {
        expression: '(() => { var d = document.documentElement, b = document.body; return { scrollX: Math.round(window.scrollX || 0), scrollY: Math.round(window.scrollY || 0), scrollWidth: Math.max(d ? d.scrollWidth : 0, b ? b.scrollWidth : 0, window.innerWidth), scrollHeight: Math.max(d ? d.scrollHeight : 0, b ? b.scrollHeight : 0, window.innerHeight), clientWidth: Math.round(window.innerWidth || 1), clientHeight: Math.round(window.innerHeight || 1) }; })()',
        returnByValue: true,
      });
      const v = res?.result?.value;
      if (!destroyed && v && typeof v === 'object') {
        ctx.pushControl({ type: 'scroll', ...v });
      }
    } catch {
      // ignore
    }
  }

  function scheduleScrollSync(delay = 70) {
    clearTimeout(scrollSyncTimer);
    scrollSyncTimer = setTimeout(() => {
      syncScrollMetrics();
    }, delay);
  }

  async function syncTitleAndPath(urlStr) {
    if (destroyed) return;
    try {
      const parsed = new URL(urlStr || baseUrl);
      if (`http://127.0.0.1:${parsed.port}` === baseUrl || parsed.origin === baseUrl) {
        const nextPath = (parsed.pathname || '/') + (parsed.search || '');
        if (nextPath !== lastPath) {
          lastPath = nextPath;
          ctx.pushControl({ type: 'nav', path: nextPath, replace: true });
        }
      }
    } catch {
      // ignore
    }
    try {
      const res = await pageCdp.call('Runtime.evaluate', {
        expression: 'document.title',
        returnByValue: true,
      });
      if (!destroyed && res?.result?.value) {
        ctx.pushControl({ type: 'title', title: String(res.result.value) });
      }
    } catch {
      // ignore
    }
    syncScrollMetrics();
  }

  async function captureOnce() {
    if (destroyed || capturingInFlight) return;
    capturingInFlight = true;
    try {
      const m = getMetrics();
      const shot = await pageCdp.call('Page.captureScreenshot', qualityCfg.screenshotParams);
      if (!destroyed && shot?.data && typeof ctx.pushFrame === 'function') {
        ctx.pushFrame(Buffer.from(shot.data, 'base64'), {
          codec: qualityCfg.codec,
          width: m.width,
          height: m.height,
          keyframe: true,
        });
      }
    } catch {
      // ignore
    } finally {
      capturingInFlight = false;
    }
  }

  async function ensureScreencastRunning({ forceRestart = false } = {}) {
    if (destroyed || screencastRestartPending) return;
    if (screencastStarted && !forceRestart) return;
    screencastRestartPending = true;
    try {
      const m = getMetrics();
      if (screencastStarted && forceRestart) {
        await pageCdp.call('Page.stopScreencast').catch(() => {});
      }
      const scParams = {
        format: qualityCfg.format,
        maxWidth: m.width,
        maxHeight: m.height,
        everyNthFrame: 1,
      };
      if (qualityCfg.quality) {
        scParams.quality = qualityCfg.quality;
      }
      await pageCdp.call('Page.startScreencast', scParams);
      screencastStarted = true;
    } catch {
      // ignore
    } finally {
      screencastRestartPending = false;
    }
  }

  function flushMove() {
    if (destroyed || moveInFlight || !pendingMove) return;
    const ev = pendingMove;
    pendingMove = null;
    moveInFlight = true;
    pageCdp.call('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: ev.x,
      y: ev.y,
      button: mapMoveButtonName(ev.buttons),
      buttons: ev.buttons,
    }).catch(() => {}).finally(() => {
      moveInFlight = false;
      if (pendingMove && !destroyed) flushMove();
    });
  }

  function flushWheel() {
    if (destroyed || wheelInFlight || !pendingWheel) return;
    const ev = pendingWheel;
    pendingWheel = null;
    wheelInFlight = true;
    pageCdp.call('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: ev.x,
      y: ev.y,
      deltaX: ev.deltaX,
      deltaY: ev.deltaY,
    }).catch(() => {}).finally(() => {
      wheelInFlight = false;
      scheduleScrollSync(90);
      if (pendingWheel && !destroyed) flushWheel();
    });
  }

  function flushScrollTo() {
    if (destroyed || scrollToInFlight || !pendingScrollTo) return;
    const pos = pendingScrollTo;
    pendingScrollTo = null;
    scrollToInFlight = true;
    pageCdp.call('Runtime.evaluate', {
      expression: `window.scrollTo(${pos.x}, ${pos.y})`,
      returnByValue: false,
    }).catch(() => {}).finally(() => {
      scrollToInFlight = false;
      if (pendingScrollTo && !destroyed) flushScrollTo();
    });
  }

  pageCdp.on('Page.screencastFrame', (params) => {
    if (destroyed) return;
    lastScreencastFrameAt = Date.now();
    const m = getMetrics();
    if (params.data && typeof ctx.pushFrame === 'function') {
      ctx.pushFrame(Buffer.from(params.data, 'base64'), {
        codec: qualityCfg.codec,
        width: m.width,
        height: m.height,
        keyframe: true,
      });
    }
    pageCdp.call('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {});
  });

  if (allowConsoleLogs) {
    pageCdp.on('Runtime.consoleAPICalled', (params) => {
      if (destroyed) return;
      ctx.pushControl({
        type: 'console',
        level: params.type || 'log',
        args: Array.isArray(params.args) ? params.args.map(formatRemoteArg) : [],
      });
    });
  }

  let initialLoadResolved = false;
  let onLoadResolve = null;
  const loadDonePromise = new Promise((resolve) => {
    onLoadResolve = resolve;
  });

  pageCdp.on('Page.loadEventFired', async () => {
    initialLoadResolved = true;
    if (onLoadResolve) {
      onLoadResolve();
      onLoadResolve = null;
    }
    await syncTitleAndPath();
    if (!dynamicLoading) {
      await ensureScreencastRunning();
      await captureOnce();
    } else if (Date.now() - lastScreencastFrameAt > 120) {
      await captureOnce();
    }
  });

  pageCdp.on('Page.navigatedWithinDocument', async (params) => {
    await syncTitleAndPath(params.url);
    if (Date.now() - lastScreencastFrameAt > 120) {
      captureOnce();
    }
  });

  pageCdp.on('Page.frameNavigated', async (params) => {
    if (!params.frame?.parentId) {
      await syncTitleAndPath(params.frame?.url);
    }
  });

  await pageCdp.call('Page.enable');
  await pageCdp.call('Runtime.enable');
  await pageCdp.call('Network.enable');
  await pageCdp.call('Network.setCacheDisabled', { cacheDisabled: true }).catch(() => {});
  await isolated.setupScopedInternalHeaders();

  const m0 = getMetrics();
  await pageCdp.call('Emulation.setDeviceMetricsOverride', {
    width: m0.cssWidth,
    height: m0.cssHeight,
    deviceScaleFactor: m0.dpr,
    mobile: false,
  });

  const targetUrl = new URL(initialPath || '/', baseUrl).toString();
  await pageCdp.call('Page.navigate', { url: targetUrl });

  if (dynamicLoading) {
    // Stream progressive UI paints immediately as sections/components render
    await ensureScreencastRunning();
    setTimeout(() => {
      if (!destroyed && lastScreencastFrameAt === 0) {
        captureOnce();
      }
    }, 80);
  } else {
    // Wait cleanly for initial document + fonts to finish loading before streaming
    await Promise.race([
      loadDonePromise,
      new Promise((r) => setTimeout(r, 4000)),
    ]);
    if (!initialLoadResolved) {
      await ensureScreencastRunning();
      await captureOnce();
    }
  }

  return {
    render() {
      if (!screencastStarted) {
        ensureScreencastRunning();
      }
      if (Date.now() - lastScreencastFrameAt > 150) {
        captureOnce();
      }
    },

    onInput(event) {
      if (destroyed || !event) return;
      const m = getMetrics();
      const x = Math.round((event.x || 0) / m.dpr);
      const y = Math.round((event.y || 0) / m.dpr);

      if (event.type === 'resize') {
        pageCdp.call('Emulation.setDeviceMetricsOverride', {
          width: m.cssWidth,
          height: m.cssHeight,
          deviceScaleFactor: m.dpr,
          mobile: false,
        }).then(() => ensureScreencastRunning({ forceRestart: true }))
          .then(() => syncScrollMetrics())
          .then(() => captureOnce())
          .catch(() => {});
        return;
      }

      if (event.type === 'scroll-to') {
        lastWheelAt = Date.now();
        pendingScrollTo = { x: Number(event.x || 0), y: Number(event.y || 0) };
        flushScrollTo();
        return;
      }

      if (event.type === 'pointermove') {
        pendingMove = { x, y, buttons: Number(event.buttons || 0) };
        flushMove();

        const now = Date.now();
        if (now - lastWheelAt > 180 && now - lastCursorCheckAt >= 120) {
          lastCursorCheckAt = now;
          clearTimeout(cursorTimer);
          cursorTimer = setTimeout(async () => {
            if (destroyed || Date.now() - lastWheelAt < 180) return;
            try {
              const res = await pageCdp.call('Runtime.evaluate', {
                expression: `(() => { const el = document.elementFromPoint(${x}, ${y}); return el ? getComputedStyle(el).cursor : 'default'; })()`,
                returnByValue: true,
              });
              const rawC = res?.result?.value;
              const safeC = ALLOWED_CURSORS.has(rawC) ? (rawC === 'auto' ? 'default' : rawC) : 'default';
              if (safeC !== lastCursor) {
                lastCursor = safeC;
                ctx.pushControl({ type: 'cursor', cursor: safeC });
              }
            } catch {
              // ignore
            }
          }, 25);
        }
        return;
      }

      if (event.type === 'pointerdown') {
        pageCdp.call('Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x,
          y,
          button: mapButtonName(event.button),
          buttons: Number(event.buttons || 1),
          clickCount: 1,
        }).catch(() => {});
        return;
      }

      if (event.type === 'pointerup') {
        pageCdp.call('Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x,
          y,
          button: mapButtonName(event.button),
          buttons: Number(event.buttons || 0),
          clickCount: 1,
        }).then(() => scheduleScrollSync(80)).catch(() => {});
        return;
      }

      if (event.type === 'wheel') {
        lastWheelAt = Date.now();
        const dx = Number(event.deltaX || 0);
        const dy = Number(event.deltaY || 0);
        if (pendingWheel) {
          pendingWheel.x = x;
          pendingWheel.y = y;
          pendingWheel.deltaX += dx;
          pendingWheel.deltaY += dy;
        } else {
          pendingWheel = { x, y, deltaX: dx, deltaY: dy };
        }
        flushWheel();
        return;
      }

      if (event.type === 'keydown' || event.type === 'keyup') {
        const key = String(event.key || '');
        const cdpType = event.type === 'keydown' ? 'keyDown' : 'keyUp';
        pageCdp.call('Input.dispatchKeyEvent', {
          type: cdpType,
          key,
          code: String(event.code || ''),
          modifiers: mapModifiers(event),
          text: event.type === 'keydown' && key.length === 1 && !event.ctrlKey && !event.metaKey ? key : undefined,
        }).catch(() => {});
        if (event.type === 'keyup') {
          scheduleScrollSync(80);
        }
        return;
      }

      if (event.type === 'input' && typeof event.value === 'string') {
        pageCdp.call('Input.insertText', { text: event.value }).catch(() => {});
        return;
      }

      if (event.type === 'popstate' && typeof event.path === 'string') {
        lastPath = event.path;
        const navUrl = new URL(event.path, baseUrl).toString();
        pageCdp.call('Page.navigate', { url: navUrl }).catch(() => {});
      }
    },

    reload() {
      if (destroyed) return;
      pageCdp.call('Page.reload', { ignoreCache: true }).catch(() => {});
    },

    onDestroy() {
      destroyed = true;
      clearTimeout(cursorTimer);
      clearTimeout(scrollSyncTimer);
      pageCdp.call('Page.stopScreencast').catch(() => {});
      isolated.dispose();
    },
  };
}

const DOM_BRIDGE_SCRIPT = `(function(){
  if (window.__vulaBridge) return;
  var seq = 1;
  var nodes = new Map();
  var pendingSync = 0;
  var dirtyNodes = new Set();
  var forceFullSync = true;
  var lastPath = '';

  function assignVids(root) {
    if (!root) return;
    nodes.clear();
    var all = root.querySelectorAll('*');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      var vid = el.getAttribute('data-vid');
      if (!vid) {
        vid = 'v' + (seq++);
        el.setAttribute('data-vid', vid);
      }
      nodes.set(vid, el);
      var tag = el.tagName;
      if (tag === 'INPUT') {
        if (el.type === 'checkbox' || el.type === 'radio') {
          if (el.checked) el.setAttribute('checked', '');
          else el.removeAttribute('checked');
        } else {
          el.setAttribute('value', el.value || '');
        }
      } else if (tag === 'SELECT') {
        var opts = el.options;
        for (var j = 0; j < opts.length; j++) {
          if (opts[j].selected) opts[j].setAttribute('selected', '');
          else opts[j].removeAttribute('selected');
        }
      }
    }
  }

  function cleanCloneHtml(el) {
    var clone = el.cloneNode(true);
    var scripts = clone.querySelectorAll('script');
    for (var i = 0; i < scripts.length; i++) scripts[i].remove();
    var textareas = el.querySelectorAll('textarea');
    var cloneTextareas = clone.querySelectorAll('textarea');
    for (var t = 0; t < textareas.length && t < cloneTextareas.length; t++) {
      cloneTextareas[t].textContent = textareas[t].value || '';
    }
    return clone.innerHTML;
  }

  function snapshot() {
    var root = document.getElementById('root');
    if (!root) {
      var streamRoot = document.getElementById('vula-stream-root');
      if (streamRoot) {
        var sName = location.pathname.replace(/^\\/+|\\/+$/g, '');
        if (sName) {
          return {
            type: 'dom-sync',
            path: location.pathname + location.search + location.hash,
            title: document.title,
            html: '<div style="width:100%;height:100vh" data-vula-stream="' + sName.replace(/"/g, '') + '"></div>'
          };
        }
      }
      return null;
    }
    assignVids(root);
    var curPath = location.pathname + location.search + location.hash;
    if (!forceFullSync && curPath === lastPath && dirtyNodes.size > 0 && dirtyNodes.size <= 6) {
      var chunks = [];
      var targets = Array.from(dirtyNodes);
      var canPatch = true;
      for (var i = 0; i < targets.length; i++) {
        var t = targets[i];
        if (!t || !t.isConnected || t === root || !root.contains(t)) {
          canPatch = false;
          break;
        }
        var vid = t.getAttribute('data-vid');
        if (!vid) {
          canPatch = false;
          break;
        }
        var attrs = {};
        for (var a = 0; a < t.attributes.length; a++) {
          attrs[t.attributes[a].name] = t.attributes[a].value;
        }
        chunks.push({
          vid: vid,
          attrs: attrs,
          html: cleanCloneHtml(t)
        });
      }
      if (canPatch && chunks.length > 0) {
        dirtyNodes.clear();
        return {
          type: 'dom-patch',
          path: curPath,
          title: document.title,
          chunks: chunks
        };
      }
    }
    dirtyNodes.clear();
    forceFullSync = false;
    lastPath = curPath;
    return {
      type: 'dom-sync',
      path: curPath,
      title: document.title,
      html: cleanCloneHtml(root)
    };
  }

  function emitNow() {
    if (pendingSync) {
      clearTimeout(pendingSync);
      pendingSync = 0;
    }
    if (typeof window.__vulaEmitDomSync !== 'function') return;
    var snap = snapshot();
    if (snap) {
      window.__vulaEmitDomSync(JSON.stringify(snap));
    }
  }

  function scheduleEmit(full) {
    if (full) forceFullSync = true;
    if (pendingSync) return;
    pendingSync = setTimeout(emitNow, 4);
  }

  function markDirtyTarget(node, root) {
    if (!node || !root) {
      forceFullSync = true;
      return;
    }
    var el = node.nodeType === 1 ? node : node.parentElement;
    if (!el || el === root || !root.contains(el)) {
      forceFullSync = true;
      return;
    }
    var holder = el.closest('[data-vid]');
    if (!holder || holder === root) {
      forceFullSync = true;
      return;
    }
    for (var existing of dirtyNodes) {
      if (existing.contains(holder)) return;
      if (holder.contains(existing)) dirtyNodes.delete(existing);
    }
    dirtyNodes.add(holder);
  }

  var observer = null;
  function watch() {
    var root = document.getElementById('root');
    if (!root) {
      var streamRoot = document.getElementById('vula-stream-root');
      if (streamRoot) return emitNow();
      return setTimeout(watch, 16);
    }
    assignVids(root);
    if (observer) observer.disconnect();
    observer = new MutationObserver(function(mutations) {
      var changed = false;
      for (var i = 0; i < mutations.length; i++) {
        var m = mutations[i];
        if (m.type !== 'attributes' || (m.attributeName !== 'data-vid' && m.attributeName !== 'value' && m.attributeName !== 'checked' && m.attributeName !== 'selected')) {
          changed = true;
          if (m.type === 'childList') {
            markDirtyTarget(m.target, root);
          } else {
            markDirtyTarget(m.target, root);
          }
        }
      }
      if (changed) scheduleEmit(false);
    });
    observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true });
    if (window.__vulaDynamicLoading !== false || document.readyState === 'complete') {
      forceFullSync = true;
      emitNow();
    } else {
      window.addEventListener('load', function() { forceFullSync = true; emitNow(); }, { once: true });
    }
  }

  window.addEventListener('vula:navigate', function() {
    scheduleEmit(true);
    setTimeout(function() { scheduleEmit(true); }, 25);
  });
  window.addEventListener('popstate', function() {
    scheduleEmit(true);
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', watch);
  else watch();

  function findFallbackElement(ev) {
    var root = document.getElementById('root') || document;
    if (ev.href) {
      var links = root.querySelectorAll('a[href]');
      for (var i = 0; i < links.length; i++) {
        var h = links[i].getAttribute('href') || '';
        if (h === ev.href || links[i].pathname + links[i].search + links[i].hash === ev.href) {
          return links[i];
        }
      }
    }
    if (ev.tag) {
      var list = root.querySelectorAll(ev.tag);
      if (ev.ariaLabel) {
        for (var a = 0; a < list.length; a++) {
          if (list[a].getAttribute('aria-label') === ev.ariaLabel) return list[a];
        }
      }
      if (ev.text) {
        for (var j = 0; j < list.length; j++) {
          if ((list[j].textContent || '').trim().slice(0, 64) === ev.text) return list[j];
        }
      }
      if (typeof ev.index === 'number' && ev.index >= 0 && list[ev.index]) {
        return list[ev.index];
      }
    }
    return null;
  }

  function triggerClick(el) {
    var clickable = el.closest ? (el.closest('button, a, input, select, textarea, label, summary, [role="button"]') || el) : el;
    if (typeof clickable.click === 'function') {
      clickable.click();
    } else {
      clickable.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    }
  }

  window.__vulaBridge = {
    emitNow: function() { forceFullSync = true; emitNow(); },
    dispatch: function(ev) {
      var el = ev.vid ? nodes.get(ev.vid) : null;
      if (!el || !el.isConnected) {
        el = ev.vid ? document.querySelector('[data-vid="' + CSS.escape(ev.vid) + '"]') : null;
      }
      if (!el || !el.isConnected) {
        el = findFallbackElement(ev);
      }
      if (!el) {
        if (ev.event === 'click' && ev.href && typeof window.__vulaNavigate === 'function') {
          window.__vulaNavigate(ev.href);
          scheduleEmit(true);
          setTimeout(function() { scheduleEmit(true); }, 35);
          return true;
        }
        return false;
      }
      if (ev.event === 'input' || ev.event === 'change') {
        var tag = el.tagName;
        if (tag === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
          var checkedSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked').set;
          checkedSetter.call(el, Boolean(ev.checked));
        } else if (tag === 'INPUT') {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, String(ev.value || ''));
        } else if (tag === 'TEXTAREA') {
          Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, String(ev.value || ''));
        } else if (tag === 'SELECT') {
          Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, String(ev.value || ''));
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        scheduleEmit(false);
        setTimeout(function() { scheduleEmit(false); }, 30);
        return true;
      }
      if (ev.event === 'submit') {
        var form = el.tagName === 'FORM' ? el : el.closest('form');
        if (form) {
          form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
          scheduleEmit(false);
          setTimeout(function() { scheduleEmit(false); }, 40);
          return true;
        }
      }
      if (ev.event === 'click') {
        var beforePath = location.pathname + location.search;
        triggerClick(el);
        if (ev.href && typeof window.__vulaNavigate === 'function') {
          var targetLink = el.closest ? el.closest('a[href]') : null;
          if (!targetLink && location.pathname + location.search === beforePath) {
            window.__vulaNavigate(ev.href);
          }
        }
        scheduleEmit(Boolean(ev.href));
        setTimeout(function() { scheduleEmit(Boolean(ev.href)); }, 30);
        setTimeout(function() { scheduleEmit( false ); }, 100);
        return true;
      }
      return false;
    }
  };
})();`;

async function createCdpDomSession(ctx, {
  baseUrl,
  initialPath = '/',
  internalRenderSecret,
  allowConsoleLogs = false,
  dynamicLoading = true,
}) {
  const browser = await ensureSharedBrowser();
  const isolated = await createIsolatedCdpTarget(browser, baseUrl, internalRenderSecret);
  const { pageCdp } = isolated;
  let destroyed = false;
  let lastEmittedHtml = null;

  await pageCdp.call('Page.enable');
  await pageCdp.call('Runtime.enable');
  await pageCdp.call('Network.enable');
  await pageCdp.call('Network.setCacheDisabled', { cacheDisabled: true }).catch(() => {});
  await pageCdp.call('Runtime.addBinding', { name: '__vulaEmitDomSync' });
  await pageCdp.call('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__vulaDynamicLoading=${dynamicLoading ? 'true' : 'false'};\n${DOM_BRIDGE_SCRIPT}`,
  });

  pageCdp.on('Runtime.bindingCalled', (params) => {
    if (destroyed || params.name !== '__vulaEmitDomSync') return;
    try {
      const snap = JSON.parse(params.payload);
      if (!snap || typeof snap !== 'object') return;
      if (snap.type === 'dom-patch' && Array.isArray(snap.chunks) && snap.chunks.length > 0) {
        lastEmittedHtml = null;
        ctx._lastDomPath = snap.path || ctx._lastDomPath || '/';
        ctx.pushControl({
          type: 'dom-patch',
          path: snap.path || '/',
          title: snap.title || '',
          chunks: snap.chunks,
        });
        return;
      }
      if (typeof snap.html !== 'string') return;
      if (snap.html === lastEmittedHtml && snap.path === ctx._lastDomPath) return;
      lastEmittedHtml = snap.html;
      ctx._lastDomPath = snap.path;
      ctx.pushControl({
        type: 'dom-sync',
        path: snap.path || '/',
        title: snap.title || '',
        html: snap.html,
      });
    } catch {
      // ignore invalid payload
    }
  });

  if (allowConsoleLogs) {
    pageCdp.on('Runtime.consoleAPICalled', (params) => {
      if (destroyed) return;
      ctx.pushControl({
        type: 'console',
        level: params.type || 'log',
        args: Array.isArray(params.args) ? params.args.map(formatRemoteArg) : [],
      });
    });
  }

  await isolated.setupScopedInternalHeaders();

  const dpr = Math.max(1, Math.min(3, Number(ctx.dpr) || 1));
  const width = Math.max(320, Number(ctx.width) || 1280);
  const height = Math.max(320, Number(ctx.height) || 720);
  await pageCdp.call('Emulation.setDeviceMetricsOverride', {
    width: Math.round(width / dpr),
    height: Math.round(height / dpr),
    deviceScaleFactor: dpr,
    mobile: false,
  });

  const targetUrl = new URL(initialPath || '/', baseUrl).toString();
  await pageCdp.call('Page.navigate', { url: targetUrl });

  return {
    streamsOwnFrames: true,
    render() {
      if (!destroyed) {
        pageCdp.call('Runtime.evaluate', {
          expression: 'window.__vulaBridge && window.__vulaBridge.emitNow()',
        }).catch(() => {});
      }
    },
    onInput(event) {
      if (destroyed || !event) return;
      if (event.type === 'dom-event') {
        const serialized = JSON.stringify({
          event: event.event,
          vid: event.vid,
          href: event.href,
          value: event.value,
          checked: event.checked,
          tag: event.tag,
          index: event.index,
          text: event.text,
          ariaLabel: event.ariaLabel,
        });
        pageCdp.call('Runtime.evaluate', {
          expression: `window.__vulaBridge && window.__vulaBridge.dispatch(${serialized})`,
          returnByValue: true,
        }).then((res) => {
          if (!res?.result?.value && event.event === 'click' && event.href) {
            const navUrl = new URL(event.href, baseUrl).toString();
            pageCdp.call('Page.navigate', { url: navUrl }).catch(() => {});
          }
        }).catch(() => {});
        return;
      }
      if (event.type === 'popstate' && typeof event.path === 'string') {
        lastEmittedHtml = null;
        const navUrl = new URL(event.path, baseUrl).toString();
        pageCdp.call('Page.navigate', { url: navUrl }).catch(() => {});
        return;
      }
      if (event.type === 'resize') {
        const ndpr = Math.max(1, Math.min(3, Number(ctx.dpr) || 1));
        const nw = Math.max(320, Number(ctx.width) || 1280);
        const nh = Math.max(320, Number(ctx.height) || 720);
        pageCdp.call('Emulation.setDeviceMetricsOverride', {
          width: Math.round(nw / ndpr),
          height: Math.round(nh / ndpr),
          deviceScaleFactor: ndpr,
          mobile: false,
        }).catch(() => {});
      }
    },
    reload() {
      if (destroyed) return;
      lastEmittedHtml = null;
      pageCdp.call('Page.reload', { ignoreCache: true }).catch(() => {});
    },
    onDestroy() {
      destroyed = true;
      isolated.dispose();
    },
  };
}

module.exports = {
  findBrowserBinary,
  warmUpBrowser,
  createCdpPageSession,
  createCdpDomSession,
  shutdownSharedBrowser,
};
