'use strict';

const { getStreamClientScript } = require('./client-runtime.js');
const { SurfaceBuffer, createFrameEncoder, isFfmpegAvailable } = require('./encoder.js');
const {
  CODEC_IDS,
  CODEC_NAMES,
  FRAME_FLAGS,
  clampViewport,
  decodeFramePacket,
  encodeFramePacket,
  sanitizeControlMessage,
  validateInputEvent,
  validateSurfaceName,
} = require('./protocol.js');
const { createStreamManager } = require('./session-manager.js');
const { hasWebRtcPeerSupport } = require('./webrtc-peer.js');

/**
 * Registers the experimental on-demand WebRTC/WebCodecs streaming endpoints on an Express app.
 * No-ops unless `config.experimental['webrtc-stream'] === true`.
 */
function registerStreamRoutes(app, { manifest, config, getAuthHook, isDev = false }) {
  if (!config?.experimental?.['webrtc-stream']) {
    return null;
  }

  const streamManager = createStreamManager({ manifest, config, getAuthHook });
  const clientScript = getStreamClientScript();

  app.get('/_vula/stream/client.js', (req, res) => {
    res.set({
      'cache-control': isDev ? 'no-store' : 'public, max-age=300',
      'content-type': 'application/javascript; charset=utf-8',
      'x-content-type-options': 'nosniff',
    }).send(clientScript);
  });

  app.post('/_vula/stream/ticket', streamManager.mintTicketHandler);
  app.post('/_vula/stream/signal', streamManager.signalHandler);

  return streamManager;
}

/**
 * Attaches HTTP Upgrade handling for `/_vula/stream/ws` without interfering with other WebSocket servers.
 */
function attachStreamUpgradeHandler(server, streamManager, { fallbackUpgrade } = {}) {
  if (!server || !streamManager) return;

  server.on('upgrade', (req, socket, head) => {
    let pathname = '/';
    try {
      pathname = new URL(req.url || '/', 'http://vula.local').pathname;
    } catch {
      socket.destroy();
      return;
    }

    if (pathname === '/_vula/stream/ws') {
      streamManager.handleWsUpgrade(req, socket);
      return;
    }

    if (typeof fallbackUpgrade === 'function') {
      fallbackUpgrade(req, socket, head);
    } else {
      socket.destroy();
    }
  });
}

module.exports = {
  CODEC_IDS,
  CODEC_NAMES,
  FRAME_FLAGS,
  SurfaceBuffer,
  attachStreamUpgradeHandler,
  clampViewport,
  createFrameEncoder,
  createStreamManager,
  decodeFramePacket,
  encodeFramePacket,
  getStreamClientScript,
  hasWebRtcPeerSupport,
  registerStreamRoutes,
  sanitizeControlMessage,
  validateInputEvent,
  validateSurfaceName,
};
