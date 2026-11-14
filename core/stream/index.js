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

const { resolveStreamingConfig } = require('../config.js');

/**
 * Registers the stable server streaming endpoints on an Express app.
 * Enabled globally by default unless `config.streaming.enabled === false`.
 */
function registerStreamRoutes(app, { manifest, manifestPath, config, wasmRuntime, cwd, serverRef, getAuthHook, isDev = false }) {
  const streamCfg = resolveStreamingConfig(config);
  if (!streamCfg.enabled) {
    return null;
  }

  if (process.env.VULA_STREAM_WARMUP === '1' && process.env.VULA_STREAM_NO_CDP !== '1' && streamCfg.global) {
    const { warmUpBrowser } = require('./cdp-renderer.js');
    warmUpBrowser();
  }

  const streamManager = createStreamManager({
    manifest,
    manifestPath,
    config,
    wasmRuntime,
    cwd,
    serverRef,
    getAuthHook,
  });
  const clientScript = getStreamClientScript();

  app.get('/_vula/stream/client.js', (req, res) => {
    res.set({
      'cache-control': 'no-store, no-cache, must-revalidate',
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
