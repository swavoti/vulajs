'use strict';

const crypto = require('node:crypto');
const { URL } = require('node:url');
const { SurfaceBuffer, createFrameEncoder } = require('./encoder.js');
const {
  clampViewport,
  sanitizeControlMessage,
  validateInputEvent,
  validateSurfaceName,
} = require('./protocol.js');
const { createWebRtcPeerSession } = require('./webrtc-peer.js');
const { acceptWebSocketUpgrade } = require('./ws-transport.js');

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function sanitizeParams(value, depth = 0) {
  if (depth > 16) throw new Error('Stream params exceed maximum nesting depth');
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => sanitizeParams(v, depth + 1));
  const clean = {};
  for (const key of Object.keys(value)) {
    if (DANGEROUS_KEYS.has(key)) continue;
    clean[key] = sanitizeParams(value[key], depth + 1);
  }
  return clean;
}

function createStreamManager({ manifest, config, getAuthHook, secret }) {
  const signingSecret = secret || crypto.randomBytes(32);
  const expConfig = (config && config.experimental) || {};

  const maxWidth = Math.max(64, Number(expConfig['webrtc-stream-max-width']) || 1920);
  const maxHeight = Math.max(64, Number(expConfig['webrtc-stream-max-height']) || 1080);
  const fps = Math.max(1, Math.min(120, Number(expConfig['webrtc-stream-fps']) || 30));
  const preferredCodec = String(expConfig['webrtc-stream-codec'] || 'vp8');
  const idleTimeoutMs = Math.max(1000, Number(expConfig['webrtc-stream-idle-timeout-ms']) || 60000);
  const maxSessions = Math.max(1, Number(expConfig['webrtc-stream-max-sessions']) || 64);
  const iceServers = Array.isArray(expConfig['webrtc-ice-servers']) ? expConfig['webrtc-ice-servers'] : [];

  const activeSessions = new Map();
  const pendingPeers = new Map();

  function signPayload(payloadObj) {
    const body = Buffer.from(JSON.stringify(payloadObj), 'utf8').toString('base64url');
    const sig = crypto.createHmac('sha256', signingSecret).update(body).digest('base64url');
    return `${body}.${sig}`;
  }

  function verifyTicket(token) {
    if (typeof token !== 'string' || !token.includes('.')) return null;
    const parts = token.split('.');
    if (parts.length !== 2) return null;
    const [body, sig] = parts;
    if (!body || !sig) return null;

    const expectedSig = crypto.createHmac('sha256', signingSecret).update(body).digest('base64url');
    const sigBuf = Buffer.from(sig, 'utf8');
    const expBuf = Buffer.from(expectedSig, 'utf8');
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return null;
    }

    try {
      const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
      if (!parsed || typeof parsed !== 'object') return null;
      if (typeof parsed.exp !== 'number' || Date.now() > parsed.exp) return null;
      if (!validateSurfaceName(parsed.surface)) return null;
      if (typeof parsed.sessionId !== 'string' || !parsed.sessionId) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  function findSurfaceEntry(surfaceName) {
    const surfaces = manifest && Array.isArray(manifest.streamSurfaces) ? manifest.streamSurfaces : [];
    return surfaces.find((s) => s.name === surfaceName) || null;
  }

  async function authorizeSurface(req, handler) {
    if (typeof handler.authorize === 'function') {
      const allowed = await handler.authorize(req);
      return allowed ? { ok: true } : { ok: false, status: 403, error: 'Forbidden' };
    }
    const authRequired = config?.security?.['server-component-auth'] !== false;
    if (authRequired && handler.isPublic !== true) {
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
        return { ok: false, status: 401, error: 'Authentication required for streamed surface' };
      }
    }
    return { ok: true };
  }

  async function mintTicketHandler(req, res) {
    const contentType = typeof req.is === 'function'
      ? req.is('application/json')
      : String(req.headers?.['content-type'] || '').toLowerCase().includes('application/json');
    if (!contentType) {
      return res.status(415).json({ error: 'Content-Type must be application/json' });
    }
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ error: 'Invalid request body' });
    }

    const { surface, width, height, dpr, params } = req.body;
    if (!validateSurfaceName(surface)) {
      return res.status(400).json({ error: 'Invalid stream surface name' });
    }

    const entry = findSurfaceEntry(surface);
    if (!entry) {
      return res.status(404).json({ error: 'Stream surface not found' });
    }

    let handler;
    try {
      handler = require(entry.path);
    } catch (err) {
      console.error('[vula-stream] Failed to load surface:', err);
      return res.status(500).json({ error: 'Failed to load stream surface' });
    }

    const auth = await authorizeSurface(req, handler);
    if (!auth.ok) {
      return res.status(auth.status).json({ error: auth.error });
    }

    if (activeSessions.size >= maxSessions) {
      return res.status(503).json({ error: 'Stream capacity reached; try again shortly' });
    }

    let safeParams;
    try {
      safeParams = sanitizeParams(params || {});
    } catch {
      return res.status(400).json({ error: 'Invalid stream parameters' });
    }

    const dims = clampViewport(width, height, maxWidth, maxHeight);
    const safeDpr = Math.max(1, Math.min(3, Number(dpr) || 1));
    const sessionId = crypto.randomUUID();
    const userId = req.user?.id || req.auth?.id || req.session?.user?.id || null;

    const ticket = signPayload({
      sessionId,
      surface,
      userId,
      width: dims.width,
      height: dims.height,
      dpr: safeDpr,
      params: safeParams,
      iat: Date.now(),
      exp: Date.now() + 60_000,
    });

    return res.json({
      ticket,
      sessionId,
      width: dims.width,
      height: dims.height,
      fps,
      codec: preferredCodec,
      iceServers,
    });
  }

  async function attachTransport(ticketData, transport) {
    if (activeSessions.has(ticketData.sessionId)) {
      transport.close(1008);
      return null;
    }
    if (activeSessions.size >= maxSessions) {
      transport.sendText(JSON.stringify({ type: 'error', message: 'Stream capacity reached' }));
      transport.close(1013);
      return null;
    }

    const entry = findSurfaceEntry(ticketData.surface);
    if (!entry) {
      transport.sendText(JSON.stringify({ type: 'error', message: 'Surface not found' }));
      transport.close(1008);
      return null;
    }

    let mod;
    try {
      mod = require(entry.path);
    } catch (err) {
      console.error('[vula-stream] Surface load error:', err);
      transport.sendText(JSON.stringify({ type: 'error', message: 'Surface initialization failed' }));
      transport.close(1011);
      return null;
    }

    const fn = mod.default || mod;
    if (typeof fn !== 'function') {
      transport.sendText(JSON.stringify({ type: 'error', message: 'Invalid stream surface export' }));
      transport.close(1011);
      return null;
    }

    let width = ticketData.width;
    let height = ticketData.height;
    let dpr = ticketData.dpr || 1;
    let hidden = false;
    let dirty = true;
    let forceKeyframe = true;
    let closed = false;
    let renderTimer = null;
    let idleTimer = null;
    let lastActivityAt = Date.now();
    const minFrameIntervalMs = Math.max(8, Math.floor(1000 / fps));

    const surfaceBuffer = new SurfaceBuffer(width, height);
    const encoder = createFrameEncoder({
      codec: preferredCodec,
      width,
      height,
      fps,
      onPacket: (packet) => {
        if (!closed && transport.isOpen) {
          transport.sendBinary(packet);
        }
      },
      onError: (err) => {
        console.error('[vula-stream] Encoder error:', err.message);
      },
    });

    function pushControl(msg) {
      if (closed || !transport.isOpen) return;
      const safe = sanitizeControlMessage(msg);
      if (safe) {
        transport.sendText(JSON.stringify(safe));
      }
    }

    let lastRenderAt = 0;
    function renderAndEncodeFrame() {
      renderTimer = null;
      if (closed || hidden || !dirty || !transport.isOpen) return;
      dirty = false;
      lastRenderAt = Date.now();
      const key = forceKeyframe;
      forceKeyframe = false;
      try {
        const customRgba = surfaceInstance.render(surfaceBuffer, ctx);
        const buf = Buffer.isBuffer(customRgba) || customRgba instanceof Uint8Array
          ? customRgba
          : surfaceBuffer.data;
        encoder.encode(buf, { keyframe: key });
      } catch (err) {
        console.error('[vula-stream] Render error:', err);
        pushControl({ type: 'error', message: 'Surface render failed' });
      }
      if (dirty && !closed && !hidden) {
        requestRender();
      }
    }

    function requestRender() {
      dirty = true;
      if (closed || hidden || renderTimer) return;
      const elapsed = Date.now() - lastRenderAt;
      const delay = elapsed >= minFrameIntervalMs ? 0 : Math.max(1, minFrameIntervalMs - elapsed);
      renderTimer = setTimeout(renderAndEncodeFrame, delay);
    }

    const ctx = {
      sessionId: ticketData.sessionId,
      surface: ticketData.surface,
      get width() { return width; },
      get height() { return height; },
      get dpr() { return dpr; },
      params: ticketData.params || {},
      userId: ticketData.userId || null,
      requestRender,
      pushControl,
    };

    let surfaceInstance = null;
    try {
      const created = await fn(ctx, surfaceBuffer);
      if (created && typeof created === 'object' && typeof created.render === 'function') {
        surfaceInstance = created;
      } else {
        // Function acted as direct stateless render(ctx, surfaceBuffer)
        surfaceInstance = {
          render: (buf, c) => fn(c, buf),
        };
      }
    } catch (err) {
      console.error('[vula-stream] Surface init failed:', err);
      encoder.close();
      transport.sendText(JSON.stringify({ type: 'error', message: 'Surface init failed' }));
      transport.close(1011);
      return null;
    }

    function resetIdleTimer() {
      lastActivityAt = Date.now();
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (!closed && Date.now() - lastActivityAt >= idleTimeoutMs) {
          destroy();
        }
      }, idleTimeoutMs);
    }

    function destroy() {
      if (closed) return;
      closed = true;
      activeSessions.delete(ticketData.sessionId);
      pendingPeers.delete(ticketData.sessionId);
      if (renderTimer) clearTimeout(renderTimer);
      if (idleTimer) clearTimeout(idleTimer);
      try {
        if (surfaceInstance && typeof surfaceInstance.onDestroy === 'function') {
          surfaceInstance.onDestroy();
        }
      } catch (_) {}
      encoder.close();
      transport.close();
    }

    activeSessions.set(ticketData.sessionId, {
      sessionId: ticketData.sessionId,
      surface: ticketData.surface,
      destroy,
    });
    resetIdleTimer();

    pushControl({
      type: 'ready',
      transport: transport.transportName,
      codec: encoder.codec,
      width,
      height,
    });

    // Initial first frame immediately
    requestRender();

    transport.on('message', (msg, isBinary) => {
      if (closed || isBinary) return;
      resetIdleTimer();
      let parsed;
      try {
        parsed = JSON.parse(msg);
      } catch {
        return;
      }
      const event = validateInputEvent(parsed, { maxWidth, maxHeight });
      if (!event) return;

      if (event.type === 'visibility') {
        hidden = event.hidden;
        if (!hidden) {
          forceKeyframe = true;
          requestRender();
        }
        return;
      }
      if (event.type === 'resize') {
        if (event.width !== width || event.height !== height) {
          width = event.width;
          height = event.height;
          dpr = event.dpr;
          surfaceBuffer.resize(width, height);
          encoder.resize(width, height);
          forceKeyframe = true;
        }
      }
      if (event.type === 'keyframe-request') {
        forceKeyframe = true;
        requestRender();
        return;
      }
      if (surfaceInstance && typeof surfaceInstance.onInput === 'function') {
        try {
          surfaceInstance.onInput(event, ctx);
        } catch (err) {
          console.error('[vula-stream] onInput error:', err);
        }
      }
      requestRender();
    });

    transport.on('close', destroy);
    transport.on('error', destroy);

    return activeSessions.get(ticketData.sessionId);
  }

  async function signalHandler(req, res) {
    const contentType = typeof req.is === 'function'
      ? req.is('application/json')
      : String(req.headers?.['content-type'] || '').toLowerCase().includes('application/json');
    if (!contentType) {
      return res.status(415).json({ error: 'Content-Type must be application/json' });
    }
    const { ticket, offer, candidate } = req.body || {};
    const ticketData = verifyTicket(ticket);
    if (!ticketData) {
      return res.status(401).json({ error: 'Invalid or expired stream ticket' });
    }

    if (candidate && pendingPeers.has(ticketData.sessionId)) {
      try {
        await pendingPeers.get(ticketData.sessionId).addIceCandidate(candidate);
        return res.json({ ok: true });
      } catch {
        return res.status(400).json({ error: 'Invalid ICE candidate' });
      }
    }

    if (offer && typeof offer.sdp === 'string') {
      try {
        const peer = await createWebRtcPeerSession({
          offerSdp: offer.sdp,
          iceServers,
          onChannelReady: (transport) => {
            attachTransport(ticketData, transport);
          },
        });
        if (peer) {
          pendingPeers.set(ticketData.sessionId, peer);
          return res.json({
            transport: 'webrtc',
            answer: peer.answer,
            iceServers,
          });
        }
      } catch (err) {
        console.warn('[vula-stream] WebRTC peer negotiation failed, falling back to WS:', err.message);
      }
    }

    return res.json({
      transport: 'ws',
      wsPath: '/_vula/stream/ws',
      iceServers,
    });
  }

  function handleWsUpgrade(req, socket) {
    let ticketToken = null;
    try {
      const url = new URL(req.url, 'http://vula.local');
      ticketToken = url.searchParams.get('ticket');
    } catch {
      socket.destroy();
      return;
    }

    const ticketData = verifyTicket(ticketToken);
    if (!ticketData) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const transport = acceptWebSocketUpgrade(req, socket);
    if (!transport) return;
    attachTransport(ticketData, transport);
  }

  function destroyAll() {
    for (const session of Array.from(activeSessions.values())) {
      session.destroy();
    }
  }

  return {
    mintTicketHandler,
    signalHandler,
    handleWsUpgrade,
    verifyTicket,
    destroyAll,
    getActiveCount: () => activeSessions.size,
  };
}

module.exports = {
  createStreamManager,
};
