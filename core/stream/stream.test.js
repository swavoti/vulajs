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

function connectRawWs(port, requestPath) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: requestPath,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        'Sec-WebSocket-Key': key,
        'Sec-WebSocket-Version': '13',
      },
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

test('experimental webrtc-stream flag defaults off and gates route registration & CSP', () => {
  const defaults = loadConfig(tmpdir());
  assert.equal(defaults.experimental['webrtc-stream'], false);

  const disabledApp = createMiniApp();
  assert.equal(registerStreamRoutes(disabledApp, { manifest: { streamSurfaces: [] }, config: defaults }), null);
  assert.equal(disabledApp.routes.length, 0);

  const prodCspOff = buildCspHeader(true, 'n1', false, defaults.experimental);
  assert.ok(prodCspOff.includes("connect-src 'self';"));

  const enabledConfig = {
    ...defaults,
    experimental: { ...defaults.experimental, 'webrtc-stream': true },
  };
  const prodCspOn = buildCspHeader(true, 'n1', false, enabledConfig.experimental);
  assert.ok(prodCspOn.includes("connect-src 'self' ws: wss:;"));
  assert.ok(!prodCspOn.includes("'unsafe-eval'"));

  const enabledApp = createMiniApp();
  const mgr = registerStreamRoutes(enabledApp, { manifest: { streamSurfaces: [] }, config: enabledConfig });
  assert.ok(mgr);
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
    experimental: {
      'webrtc-stream': true,
      'webrtc-stream-codec': 'vp8',
      'webrtc-stream-fps': 60,
      'webrtc-stream-max-width': 800,
      'webrtc-stream-max-height': 600,
      'webrtc-stream-idle-timeout-ms': 5000,
      'webrtc-stream-max-sessions': 4,
      'webrtc-ice-servers': [],
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

  // 8. Disconnect cleans up session on the server
  ws.close();
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(streamManager.getActiveCount(), 0);
  assert.equal(globalThis.__lastStreamDestroyed(), true);
});
