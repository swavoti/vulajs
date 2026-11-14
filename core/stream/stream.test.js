'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');
const zlib = require('node:zlib');

const { loadConfig } = require('../config.js');
const { generateClientRouteManifest, generateRouteManifest } = require('../router/manifest.js');
const { csrfProtection } = require('../RSC/csrf.js');
const { buildCspHeader, createSecurityMiddleware } = require('../server.js');
const {
  SurfaceBuffer,
  attachStreamUpgradeHandler,
  decodeFramePacket,
  encodeFramePacket,
  getStreamClientScript,
  registerStreamRoutes,
  validateInputEvent,
} = require('./index.js');

function createMiniApp() {
  const routes = [];
  return {
    routes,
    get(routePath, handler) {
      routes.push({ method: 'GET', path: routePath, handler });
    },
    post(routePath, handler) {
      routes.push({ method: 'POST', path: routePath, handler });
    },
  };
}

function enhanceResponse(res) {
  res.locals = {};
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.set = (headers, val) => {
    if (typeof headers === 'string') {
      res.setHeader(headers, val);
    } else {
      for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    }
    return res;
  };
  res.json = (obj) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(obj));
  };
  res.send = (body) => res.end(body);
  return res;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (err) { reject(err); }
    });
  });
}

function buildMaskedWsFrame(opcode, data) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  const mask = crypto.randomBytes(4);
  let header;
  if (payload.length < 126) {
    header = Buffer.allocUnsafe(2);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | payload.length;
  } else {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | opcode;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  }
  const masked = Buffer.allocUnsafe(payload.length);
  for (let i = 0; i < payload.length; i += 1) {
    masked[i] = payload[i] ^ mask[i & 3];
  }
  return Buffer.concat([header, mask, masked]);
}

function connectRawWs(port, requestPath, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const headers = {
      Origin: `http://127.0.0.1:${port}`,
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Key': key,
      'Sec-WebSocket-Version': '13',
      ...extraHeaders,
    };
    for (const [k, v] of Object.entries(headers)) {
      if (v === undefined || v === null) delete headers[k];
    }
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: requestPath,
      headers,
    });
    req.on('upgrade', (res, socket, head) => {
      let buf = head && head.length ? Buffer.from(head) : Buffer.alloc(0);
      const messages = [];
      const waiters = [];

      function pump() {
        while (buf.length >= 2) {
          const opcode = buf[0] & 0x0f;
          let len = buf[1] & 0x7f;
          let offset = 2;
          if (len === 126) {
            if (buf.length < 4) return;
            len = buf.readUInt16BE(2);
            offset = 4;
          } else if (len === 127) {
            if (buf.length < 10) return;
            len = Number(buf.readBigUInt64BE(2));
            offset = 10;
          }
          if (buf.length < offset + len) return;
          const payload = Buffer.from(buf.subarray(offset, offset + len));
          buf = buf.subarray(offset + len);
          if (opcode === 0x08) {
            socket.end();
            return;
          }
          const item = opcode === 0x01
            ? { isBinary: false, data: payload.toString('utf8') }
            : { isBinary: true, data: payload };
          if (waiters.length) {
            waiters.shift()(item);
          } else {
            messages.push(item);
          }
        }
      }

      socket.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        pump();
      });
      pump();

      resolve({
        socket,
        sendText(str) {
          socket.write(buildMaskedWsFrame(0x01, str));
        },
        nextMessage(timeoutMs = 2000) {
          if (messages.length) return Promise.resolve(messages.shift());
          return new Promise((resMsg, rejMsg) => {
            const timer = setTimeout(() => rejMsg(new Error('Timed out waiting for WS message')), timeoutMs);
            waiters.push((item) => {
              clearTimeout(timer);
              resMsg(item);
            });
          });
        },
        close() {
          try { socket.write(buildMaskedWsFrame(0x08, Buffer.alloc(0))); } catch (_) {}
          socket.end();
        },
      });
    });
    req.on('response', (res) => {
      reject(new Error(`Unexpected HTTP status ${res.statusCode}`));
    });
    req.on('error', reject);
    req.end();
  });
}

test('streaming is enabled globally by default and gates route registration & CSP when disabled', () => {
  const defaults = loadConfig(tmpdir());
  assert.equal(defaults.streaming.enabled, true);
  assert.equal(defaults.streaming.global, true);

  const disabledConfig = {
    ...defaults,
    streaming: { ...defaults.streaming, enabled: false, global: false },
  };
  const disabledApp = createMiniApp();
  assert.equal(registerStreamRoutes(disabledApp, { manifest: { streamSurfaces: [] }, config: disabledConfig }), null);
  assert.equal(disabledApp.routes.length, 0);

  const prodCspOff = buildCspHeader(true, 'n1', false, disabledConfig);
  assert.ok(prodCspOff.includes("connect-src 'self';"));

  const prodCspOn = buildCspHeader(true, 'n1', false, defaults);
  assert.ok(prodCspOn.includes("connect-src 'self' ws: wss:;"));
  assert.ok(!prodCspOn.includes("'unsafe-eval'"));

  const enabledApp = createMiniApp();
  const mgr = registerStreamRoutes(enabledApp, { manifest: { streamSurfaces: [] }, config: defaults });
  assert.ok(mgr);
  mgr.destroyAll();
  assert.deepEqual(
    enabledApp.routes.map((r) => `${r.method} ${r.path}`),
    ['GET /_vula/stream/client.js', 'POST /_vula/stream/ticket', 'POST /_vula/stream/signal']
  );
});

test('manifest discovers *.stream.* surfaces on server without leaking them to client manifest', (t) => {
  const appDir = mkdtempSync(path.join(tmpdir(), 'vula-stream-manifest-'));
  t.after(() => rmSync(appDir, { recursive: true, force: true }));

  mkdirSync(path.join(appDir, 'studio'), { recursive: true });
  writeFileSync(path.join(appDir, 'page.tsx'), 'export default function Home() {}');
  writeFileSync(path.join(appDir, 'studio', 'canvas.stream.ts'), 'export default function Canvas() {}');
  writeFileSync(path.join(appDir, 'dashboard.stream.comp.js'), 'module.exports = function Dash() {};');

  const manifest = generateRouteManifest(appDir);
  assert.deepEqual(
    manifest.streamSurfaces.map((s) => s.name).sort(),
    ['dashboard', 'studio/canvas']
  );
  const clientManifest = generateClientRouteManifest(manifest);
  assert.deepEqual(Object.keys(clientManifest), ['routes']);
});

test('binary frame packet round-trip and input validation enforce bounds', () => {
  const pkt = encodeFramePacket({
    codec: 'vp8',
    keyframe: true,
    width: 1280,
    height: 720,
    seq: 42,
    timestampUs: 123456789,
    payload: Buffer.from([1, 2, 3, 4, 5]),
  });
  const decoded = decodeFramePacket(pkt);
  assert.equal(decoded.codec, 'vp8');
  assert.equal(decoded.keyframe, true);
  assert.equal(decoded.width, 1280);
  assert.equal(decoded.height, 720);
  assert.equal(decoded.seq, 42);
  assert.equal(decoded.timestampUs, 123456789);
  assert.deepEqual(decoded.payload, Buffer.from([1, 2, 3, 4, 5]));

  assert.throws(() => decodeFramePacket(Buffer.from('BAD')), /shorter than header/);

  const clamped = validateInputEvent(
    { type: 'pointerdown', x: 99999, y: -50, button: 0, extra: 'ignored' },
    { maxWidth: 800, maxHeight: 600 }
  );
  assert.deepEqual(clamped, { type: 'pointerdown', x: 800, y: 0, button: 0, buttons: 0 });
  assert.equal(validateInputEvent({ type: '__proto__' }), null);
  assert.equal(validateInputEvent({ type: 'popstate', path: '//evil.com' }).path, '/');
});

test('end-to-end auth, CSRF, on-demand ticket, server-hidden state, and WebSocket frame stream', async (t) => {
  const workDir = mkdtempSync(path.join(tmpdir(), 'vula-stream-e2e-'));
  t.after(() => rmSync(workDir, { recursive: true, force: true }));

  const privateSurfacePath = path.join(workDir, 'secret.stream.js');
  writeFileSync(privateSurfacePath, `
    module.exports.authorize = async (req) => req.headers['x-stream-user'] === 'alice';
    module.exports.default = function createSecretSurface(ctx) {
      let clicks = 0;
      let destroyed = false;
      globalThis.__lastStreamClicks = () => clicks;
      globalThis.__lastStreamDestroyed = () => destroyed;
      return {
        onInput(event) {
          if (event.type === 'pointerdown') {
            clicks += 1;
            ctx.pushControl({ type: 'cursor', cursor: 'pointer' });
            ctx.pushControl({ type: 'nav', path: '/secret?clicks=' + clicks });
          }
        },
        render(buf) {
          buf.clear(clicks === 0 ? '#102030' : '#401020');
          buf.drawText('SECRET:' + clicks, 8, 8, '#ffffff', 2);
        },
        onDestroy() {
          destroyed = true;
        },
      };
    };
  `);

  const config = {
    ...loadConfig(workDir),
    streaming: {
      enabled: true,
      global: true,
      codec: 'vp8',
      quality: 'hd',
      fps: 60,
      'max-width': 800,
      'max-height': 600,
      'idle-timeout-ms': 5000,
      'max-sessions': 4,
    },
  };
  const manifest = {
    streamSurfaces: [{ name: 'secret', path: privateSurfacePath }],
  };

  const securityMw = createSecurityMiddleware({ config, isDev: false, vulaVersion: '2.0.5' });
  const csrfMw = csrfProtection([]);
  const routeTable = new Map();
  const miniApp = {
    get(p, h) { routeTable.set(`GET ${p}`, h); },
    post(p, h) { routeTable.set(`POST ${p}`, h); },
  };
  const streamManager = registerStreamRoutes(miniApp, { manifest, config, isDev: false });

  const server = http.createServer(async (req, res) => {
    enhanceResponse(res);
    req.protocol = 'http';
    await new Promise((resolve) => securityMw(req, res, resolve));
    if (res.writableEnded) return;

    const urlPath = new URL(req.url, 'http://127.0.0.1').pathname;
    const handler = routeTable.get(`${req.method} ${urlPath}`);
    if (!handler) return res.status(404).send('Not Found');

    if (req.method === 'POST') {
      csrfMw(req, res, () => {});
      if (res.writableEnded) return;
      try {
        req.body = await readJsonBody(req);
      } catch {
        return res.status(400).json({ error: 'Invalid JSON' });
      }
    }
    await handler(req, res);
  });

  attachStreamUpgradeHandler(server, streamManager);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    streamManager.destroyAll();
    server.closeAllConnections?.();
    return new Promise((resolve) => server.close(resolve));
  });

  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  // 1. Client script is served, syntactically valid JS, and contains zero server surface logic
  const clientRes = await fetch(`${baseUrl}/_vula/stream/client.js`);
  assert.equal(clientRes.status, 200);
  const clientJs = await clientRes.text();
  assert.doesNotThrow(() => new Function(clientJs));
  assert.ok(clientJs.includes('VideoDecoder'));
  assert.ok(!clientJs.includes('SECRET:'));

  // 2. CSRF blocks cross-origin ticket mint
  const csrfFail = await fetch(`${baseUrl}/_vula/stream/ticket`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.com' },
    body: JSON.stringify({ surface: 'secret', width: 200, height: 120 }),
  });
  assert.equal(csrfFail.status, 403);

  // 3. Unauthorized user gets 403 from authorize()
  const authFail = await fetch(`${baseUrl}/_vula/stream/ticket`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({ surface: 'secret', width: 200, height: 120 }),
  });
  assert.equal(authFail.status, 403);

  // 4. Authorized user mints ticket and negotiates signaling
  const ticketRes = await fetch(`${baseUrl}/_vula/stream/ticket`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl, 'x-stream-user': 'alice' },
    body: JSON.stringify({ surface: 'secret', width: 200, height: 120 }),
  });
  assert.equal(ticketRes.status, 200);
  const ticketInfo = await ticketRes.json();
  assert.ok(ticketInfo.ticket);

  // Tampered ticket must fail on signal & WS upgrade
  const badSig = await fetch(`${baseUrl}/_vula/stream/signal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({ ticket: `${ticketInfo.ticket}tamper` }),
  });
  assert.equal(badSig.status, 401);
  await assert.rejects(connectRawWs(port, `/_vula/stream/ws?ticket=bad.token`), /401/);

  const sigRes = await fetch(`${baseUrl}/_vula/stream/signal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({ ticket: ticketInfo.ticket }),
  });
  assert.equal(sigRes.status, 200);
  const sigData = await sigRes.json();
  assert.equal(sigData.wsPath, '/_vula/stream/ws');

  // Cross-origin or missing Origin on WS upgrade must fail with 403
  await assert.rejects(
    connectRawWs(port, `${sigData.wsPath}?ticket=${encodeURIComponent(ticketInfo.ticket)}`, { Origin: 'https://evil.com' }),
    /403/
  );
  await assert.rejects(
    connectRawWs(port, `${sigData.wsPath}?ticket=${encodeURIComponent(ticketInfo.ticket)}`, { Origin: undefined }),
    /403/
  );

  // 5. Connect over real WebSocket and receive initial ready + frame #1
  assert.equal(streamManager.getActiveCount(), 0);
  const ws = await connectRawWs(port, `${sigData.wsPath}?ticket=${encodeURIComponent(ticketInfo.ticket)}`);
  assert.equal(streamManager.getActiveCount(), 1);

  const readyMsg = await ws.nextMessage();
  assert.equal(readyMsg.isBinary, false);
  const readyJson = JSON.parse(readyMsg.data);
  assert.equal(readyJson.type, 'ready');
  assert.equal(readyJson.width, 200);
  assert.equal(readyJson.height, 120);

  const frame1Msg = await ws.nextMessage();
  assert.equal(frame1Msg.isBinary, true);
  const frame1 = decodeFramePacket(frame1Msg.data);
  assert.equal(frame1.codec, 'rgba-deflate');
  assert.equal(frame1.keyframe, true);
  const rgba1 = zlib.inflateSync(frame1.payload);
  // Corner pixel should be #102030
  assert.equal(rgba1[0], 0x10);
  assert.equal(rgba1[1], 0x20);
  assert.equal(rgba1[2], 0x30);

  // 6. Send pointerdown -> server executes onInput, emits cursor + nav controls + frame #2
  ws.sendText(JSON.stringify({ type: 'pointerdown', x: 10, y: 10, button: 0 }));

  const ctrl1 = JSON.parse((await ws.nextMessage()).data);
  const ctrl2 = JSON.parse((await ws.nextMessage()).data);
  assert.deepEqual([ctrl1, ctrl2], [
    { type: 'cursor', cursor: 'pointer' },
    { type: 'nav', path: '/secret?clicks=1', replace: false },
  ]);

  const frame2Msg = await ws.nextMessage();
  assert.equal(frame2Msg.isBinary, true);
  const frame2 = decodeFramePacket(frame2Msg.data);
  const rgba2 = zlib.inflateSync(frame2.payload);
  // Corner pixel updated to #401020 on the server!
  assert.equal(rgba2[0], 0x40);
  assert.equal(rgba2[1], 0x10);
  assert.equal(rgba2[2], 0x20);
  assert.equal(globalThis.__lastStreamClicks(), 1);

  // 7. Visibility hidden pauses rendering; visible triggers fresh keyframe
  ws.sendText(JSON.stringify({ type: 'visibility', hidden: true }));
  ws.sendText(JSON.stringify({ type: 'visibility', hidden: false }));
  const resumeFrameMsg = await ws.nextMessage();
  assert.equal(resumeFrameMsg.isBinary, true);
  assert.equal(decodeFramePacket(resumeFrameMsg.data).keyframe, true);

  // 8. Disconnect cleans up session on the server and burns ticket against replay
  ws.close();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(streamManager.getActiveCount(), 0);
  assert.equal(globalThis.__lastStreamDestroyed(), true);

  await assert.rejects(
    connectRawWs(port, `${sigData.wsPath}?ticket=${encodeURIComponent(ticketInfo.ticket)}`),
    /401/
  );
});

test('config normalizes top-level streaming and --global / VULA_STREAM_GLOBAL', (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vula-global-cfg-'));
  t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));

  fs.writeFileSync(
    path.join(workDir, 'vulaism.config.yaml'),
    'streaming:\n  enabled: "--global"\n  global: false\n'
  );
  const cfgStringGlobal = loadConfig(workDir);
  assert.equal(cfgStringGlobal.streaming.enabled, true);
  assert.equal(cfgStringGlobal.streaming.global, true);

  fs.writeFileSync(
    path.join(workDir, 'vulaism.config.yaml'),
    'streaming:\n  enabled: true\n  global: false\n'
  );
  const prevEnv = process.env.VULA_STREAM_GLOBAL;
  process.env.VULA_STREAM_GLOBAL = '1';
  t.after(() => {
    if (prevEnv === undefined) delete process.env.VULA_STREAM_GLOBAL;
    else process.env.VULA_STREAM_GLOBAL = prevEnv;
  });

  const cfgCliGlobal = loadConfig(workDir);
  assert.equal(cfgCliGlobal.streaming.enabled, true);
  assert.equal(cfgCliGlobal.streaming.global, true);
});

test('global stream surface __global__ renders app pages on server and navigates over WS', async (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vula-global-stream-'));
  t.after(() => fs.rmSync(workDir, { recursive: true, force: true }));

  const appDir = path.join(workDir, 'app');
  const recipesDir = path.join(appDir, 'recipes');
  fs.mkdirSync(recipesDir, { recursive: true });

  const homePagePath = path.join(appDir, 'page.js');
  const recipesPagePath = path.join(recipesDir, 'page.js');
  const reactPath = require.resolve('react');

  fs.writeFileSync(homePagePath, `
    const React = require(${JSON.stringify(reactPath)});
    module.exports = function HomePage() {
      return React.createElement('div', null,
        React.createElement('h1', null, 'Welcome Kitchen'),
        React.createElement('a', { href: '/recipes', className: 'hh-btn' }, 'Browse Recipes')
      );
    };
  `);
  fs.writeFileSync(recipesPagePath, `
    const React = require(${JSON.stringify(reactPath)});
    module.exports = function RecipesPage() {
      return React.createElement('div', null,
        React.createElement('h1', null, 'All Recipes'),
        React.createElement('p', null, 'Tomato rigatoni')
      );
    };
  `);

  const manifest = {
    routes: [
      { path: '/', componentPath: homePagePath },
      { path: '/recipes', componentPath: recipesPagePath },
    ],
    streamSurfaces: [],
  };
  const wasmRuntime = {
    match(pathname) {
      return manifest.routes.findIndex((r) => r.path === pathname);
    },
  };

  const config = {
    ...loadConfig(workDir),
    app: { name: 'Global Test Kitchen', lang: 'en' },
    streaming: {
      enabled: true,
      global: true,
      codec: 'vp8',
      quality: 'hd',
      fps: 60,
      'max-width': 1280,
      'max-height': 720,
      'idle-timeout-ms': 5000,
      'max-sessions': 4,
      'allow-console-logs': false,
      'dynamic-loading': true,
    },
  };

  const securityMw = createSecurityMiddleware({ config, isDev: false, vulaVersion: '2.0.6' });
  const csrfMw = csrfProtection([]);
  const routeTable = new Map();
  const miniApp = {
    get(p, h) { routeTable.set(`GET ${p}`, h); },
    post(p, h) { routeTable.set(`POST ${p}`, h); },
  };
  const streamManager = registerStreamRoutes(miniApp, {
    manifest,
    config,
    wasmRuntime,
    cwd: workDir,
    isDev: false,
  });

  const server = http.createServer(async (req, res) => {
    enhanceResponse(res);
    req.protocol = 'http';
    await new Promise((resolve) => securityMw(req, res, resolve));
    if (res.writableEnded) return;
    const urlPath = new URL(req.url, 'http://127.0.0.1').pathname;
    const handler = routeTable.get(`${req.method} ${urlPath}`);
    if (!handler) return res.status(404).send('Not Found');
    if (req.method === 'POST') {
      csrfMw(req, res, () => {});
      if (res.writableEnded) return;
      req.body = await readJsonBody(req);
    }
    await handler(req, res);
  });

  attachStreamUpgradeHandler(server, streamManager);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    streamManager.destroyAll();
    server.closeAllConnections?.();
    return new Promise((resolve) => server.close(resolve));
  });

  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const originHeaders = {
    Origin: baseUrl,
    Referer: `${baseUrl}/`,
    'Content-Type': 'application/json',
  };

  const ticketRes = await fetch(`${baseUrl}/_vula/stream/ticket`, {
    method: 'POST',
    headers: originHeaders,
    body: JSON.stringify({ surface: '__global__', width: 800, height: 600, dpr: 1, params: { path: '/' } }),
  });
  assert.equal(ticketRes.status, 200);
  const ticketJson = await ticketRes.json();
  assert.ok(ticketJson.ticket);

  const ws = await connectRawWs(port, `/_vula/stream/ws?ticket=${encodeURIComponent(ticketJson.ticket)}`);

  // Should receive title control + ready control + initial binary frame
  let gotReady = false;
  let gotTitle = false;
  let firstFrame = null;
  for (let i = 0; i < 4 && !firstFrame; i++) {
    const msg = await ws.nextMessage();
    if (msg.isBinary) {
      firstFrame = decodeFramePacket(msg.data);
    } else {
      const ctrl = JSON.parse(msg.data);
      if (ctrl.type === 'ready') gotReady = true;
      if (ctrl.type === 'title') gotTitle = ctrl.title.includes('Welcome Kitchen');
    }
  }
  assert.equal(gotReady, true);
  assert.equal(gotTitle, true);
  assert.ok(firstFrame);
  assert.equal(firstFrame.keyframe, true);
  const rgba = zlib.inflateSync(firstFrame.payload);
  // Top header pixel should be crisp #FFFFFF
  assert.equal(rgba[0], 0xFF);
  assert.equal(rgba[1], 0xFF);
  assert.equal(rgba[2], 0xFF);

  // Simulate popstate navigation to /recipes and verify new title + binary frame
  ws.sendText(JSON.stringify({ type: 'popstate', path: '/recipes' }));
  let gotRecipesTitle = false;
  let gotRecipesFrame = false;
  for (let i = 0; i < 4 && !gotRecipesFrame; i++) {
    const msg = await ws.nextMessage();
    if (msg.isBinary) {
      gotRecipesFrame = true;
    } else {
      const ctrl = JSON.parse(msg.data);
      if (ctrl.type === 'title' && ctrl.title.includes('All Recipes')) {
        gotRecipesTitle = true;
      }
    }
  }
  assert.equal(gotRecipesTitle, true);
  assert.equal(gotRecipesFrame, true);

  ws.close();
});

test('config defaults and dom-event/dom-sync protocol validation for global DOM stream', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { validateInputEvent, sanitizeControlMessage } = require('./protocol.js');

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vula-stream-opts-'));
  try {
    const cfg = loadConfig(workDir);
    assert.equal(cfg.streaming.enabled, true);
    assert.equal(cfg.streaming.global, true);
    assert.equal(cfg.streaming['allow-console-logs'], false);
    assert.equal(cfg.streaming['dynamic-loading'], true);
    assert.equal(cfg.streaming.quality, 'hd');

    fs.writeFileSync(
      path.join(workDir, 'vulaism.config.yaml'),
      'streaming:\n  enabled: true\n  global: true\n  quality: "lossless"\n  allow-console-logs: true\n'
    );
    const cleanYamlCfg = loadConfig(workDir);
    assert.equal(cleanYamlCfg.streaming.enabled, true);
    assert.equal(cleanYamlCfg.streaming.global, true);
    assert.equal(cleanYamlCfg.streaming.quality, 'lossless');
    assert.equal(cleanYamlCfg.streaming['allow-console-logs'], true);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }

  const validEvt = validateInputEvent({
    type: 'dom-event',
    event: 'click',
    vid: 'v42',
    href: '/recipes',
  });
  assert.deepEqual(validEvt, {
    type: 'dom-event',
    event: 'click',
    vid: 'v42',
    href: '/recipes',
    value: '',
    checked: false,
  });

  // External href must be stripped
  const extEvt = validateInputEvent({
    type: 'dom-event',
    event: 'click',
    vid: 'v1',
    href: 'https://evil.example/phish',
  });
  assert.equal(extEvt.href, '');

  const syncMsg = sanitizeControlMessage({
    type: 'dom-sync',
    path: '/recipes',
    title: 'All Recipes',
    html: '<div data-vid="v1">Ok</div>',
  });
  assert.deepEqual(syncMsg, {
    type: 'dom-sync',
    path: '/recipes',
    title: 'All Recipes',
    html: '<div data-vid="v1">Ok</div>',
  });
});
