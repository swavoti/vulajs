'use strict';

let cachedWerift = undefined;

function loadWerift() {
  if (cachedWerift !== undefined) return cachedWerift;
  try {
    cachedWerift = require('werift');
  } catch {
    cachedWerift = null;
  }
  return cachedWerift;
}

function hasWebRtcPeerSupport() {
  return Boolean(loadWerift());
}

/**
 * Negotiates a real server-side WebRTC RTCPeerConnection + RTCDataChannel
 * using `werift` when installed in the host project.
 */
async function createWebRtcPeerSession({ offerSdp, iceServers = [], onChannelReady }) {
  const werift = loadWerift();
  if (!werift || !werift.RTCPeerConnection) {
    return null;
  }

  const pc = new werift.RTCPeerConnection({ iceServers });
  let frameChannel = null;
  let inputChannel = null;
  let closed = false;
  const listeners = { message: [], close: [], error: [] };

  function emit(event, ...args) {
    for (const fn of listeners[event]) {
      try { fn(...args); } catch (_) {}
    }
  }

  const transport = {
    transportName: 'webrtc-datachannel',
    get isOpen() {
      return !closed && Boolean(frameChannel && frameChannel.readyState === 'open');
    },
    sendBinary(buf) {
      if (frameChannel && frameChannel.readyState === 'open') {
        frameChannel.send(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
      }
    },
    sendText(str) {
      const target = inputChannel && inputChannel.readyState === 'open' ? inputChannel : frameChannel;
      if (target && target.readyState === 'open') {
        target.send(String(str));
      }
    },
    on(event, fn) {
      if (listeners[event]) listeners[event].push(fn);
    },
    close() {
      if (closed) return;
      closed = true;
      try { pc.close(); } catch (_) {}
      emit('close');
    },
  };

  pc.onDataChannel.subscribe((channel) => {
    if (channel.label === 'vula-frames') {
      frameChannel = channel;
      channel.stateChanged.subscribe((state) => {
        if (state === 'open' && onChannelReady) onChannelReady(transport);
      });
    } else if (channel.label === 'vula-input') {
      inputChannel = channel;
      channel.onMessage.subscribe((msg) => {
        const isBinary = Buffer.isBuffer(msg) || msg instanceof Uint8Array;
        emit('message', isBinary ? Buffer.from(msg) : String(msg), isBinary);
      });
    }
  });

  pc.connectionStateChange.subscribe((state) => {
    if (state === 'closed' || state === 'failed' || state === 'disconnected') {
      transport.close();
    }
  });

  await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);

  return {
    answer: pc.localDescription,
    transport,
    addIceCandidate: async (candidate) => {
      if (candidate) {
        await pc.addIceCandidate(candidate);
      }
    },
  };
}

module.exports = {
  createWebRtcPeerSession,
  hasWebRtcPeerSupport,
};
