'use strict';

/**
 * Generates the lightweight browser client script served at `/_vula/stream/client.js`.
 * Zero external dependencies — only WebRTC, WebCodecs (VideoDecoder), Canvas2D, and DecompressionStream.
 */
function getStreamClientScript() {
  return `(function(global){
  'use strict';

  var HEADER_SIZE = 28;
  var CODEC_MAP = {
    1: 'vp8',
    2: 'vp9',
    3: 'avc1.42001f',
    4: 'av01.0.04M.08',
    16: 'rgba',
    17: 'rgba-deflate'
  };

  function parsePacket(arrayBuffer) {
    var view = new DataView(arrayBuffer);
    if (arrayBuffer.byteLength < HEADER_SIZE) return null;
    if (view.getUint8(0) !== 0x56 || view.getUint8(1) !== 0x46) return null;
    if (view.getUint8(2) !== 1) return null;
    var codecId = view.getUint8(3);
    var flags = view.getUint8(4);
    var width = view.getUint16(6, false);
    var height = view.getUint16(8, false);
    var seq = view.getUint32(10, false);
    var hi = view.getUint32(14, false);
    var lo = view.getUint32(18, false);
    var timestampUs = hi * 4294967296 + lo;
    var payloadLength = view.getUint32(22, false);
    if (arrayBuffer.byteLength < HEADER_SIZE + payloadLength) return null;
    return {
      codecId: codecId,
      codec: CODEC_MAP[codecId] || null,
      keyframe: (flags & 1) !== 0,
      width: width,
      height: height,
      seq: seq,
      timestampUs: timestampUs,
      payload: new Uint8Array(arrayBuffer, HEADER_SIZE, payloadLength)
    };
  }

  async function inflateDeflate(bytes) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('DecompressionStream is required for rgba-deflate fallback');
    }
    var ds = new DecompressionStream('deflate');
    var writer = ds.writable.getWriter();
    writer.write(bytes);
    writer.close();
    var out = await new Response(ds.readable).arrayBuffer();
    return new Uint8ClampedArray(out);
  }

  function mountStreamSurface(container, options) {
    if (!container) throw new Error('VulaStream: container element is required');
    var opts = options || {};
    var surface = opts.surface;
    if (!surface) throw new Error('VulaStream: surface name is required');

    container.style.position = container.style.position || 'relative';
    container.style.overflow = 'hidden';

    var canvas = document.createElement('canvas');
    canvas.tabIndex = 0;
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';
    canvas.style.outline = 'none';
    container.innerHTML = '';
    container.appendChild(canvas);

    var ctx = canvas.getContext('2d', { alpha: false });
    var hiddenInput = document.createElement('input');
    hiddenInput.type = 'text';
    hiddenInput.autocomplete = 'off';
    hiddenInput.style.cssText = 'position:absolute;opacity:0;pointer-events:none;left:0;top:0;width:1px;height:1px;';
    container.appendChild(hiddenInput);

    var destroyed = false;
    var activeTransport = null;
    var pc = null;
    var ws = null;
    var decoder = null;
    var configuredCodec = null;
    var offscreenCanvas = null;
    var offscreenCtx = null;
    var rgbaChain = Promise.resolve();

    function getSize() {
      var rect = container.getBoundingClientRect();
      var dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
      var w = Math.max(64, Math.round((rect.width || 800) * dpr));
      var h = Math.max(64, Math.round((rect.height || 600) * dpr));
      w = w - (w % 2);
      h = h - (h % 2);
      return { width: w, height: h, dpr: dpr };
    }

    function sendInput(evt) {
      if (destroyed || !activeTransport) return;
      activeTransport.sendText(JSON.stringify(evt));
    }

    function handleControl(raw) {
      var msg;
      try { msg = JSON.parse(raw); } catch (_) { return; }
      if (!msg || !msg.type) return;
      if (msg.type === 'cursor') {
        canvas.style.cursor = msg.cursor || 'default';
      } else if (msg.type === 'title' && typeof msg.title === 'string') {
        document.title = msg.title;
      } else if (msg.type === 'nav' && typeof msg.path === 'string' && msg.path.startsWith('/')) {
        if (window.location.pathname + window.location.search !== msg.path) {
          var method = msg.replace ? 'replaceState' : 'pushState';
          window.__vulaNavigationInProgress = true;
          try {
            window.history[method]({}, '', msg.path);
          } finally {
            window.__vulaNavigationInProgress = false;
          }
        }
      } else if (msg.type === 'input-focus') {
        hiddenInput.type = msg.inputType === 'password' ? 'password' : 'text';
        hiddenInput.value = msg.value || '';
        hiddenInput.style.left = (msg.x || 0) + 'px';
        hiddenInput.style.top = (msg.y || 0) + 'px';
        hiddenInput.style.width = (msg.width || 160) + 'px';
        hiddenInput.style.height = (msg.height || 32) + 'px';
        hiddenInput.style.pointerEvents = 'auto';
        hiddenInput.focus();
      } else if (msg.type === 'input-blur') {
        hiddenInput.style.pointerEvents = 'none';
        hiddenInput.blur();
      } else if (msg.type === 'clipboard' && navigator.clipboard && typeof msg.text === 'string') {
        navigator.clipboard.writeText(msg.text).catch(function(){});
      } else if (msg.type === 'ready' && typeof opts.onReady === 'function') {
        opts.onReady(msg);
      } else if (msg.type === 'error' && typeof opts.onError === 'function') {
        opts.onError(new Error(msg.message || 'Stream error'));
      }
    }

    async function handleFrame(arrayBuffer) {
      if (destroyed) return;
      var pkt = parsePacket(arrayBuffer);
      if (!pkt) return;

      if (canvas.width !== pkt.width || canvas.height !== pkt.height) {
        canvas.width = pkt.width;
        canvas.height = pkt.height;
      }

      if (pkt.codecId <= 4) {
        if (typeof VideoDecoder === 'undefined') {
          sendInput({ type: 'keyframe-request' });
          return;
        }
        if (!decoder || configuredCodec !== pkt.codec) {
          if (decoder) { try { decoder.close(); } catch (_) {} }
          configuredCodec = pkt.codec;
          decoder = new VideoDecoder({
            output: function(frame) {
              if (!destroyed && ctx) {
                ctx.drawImage(frame, 0, 0, canvas.width, canvas.height);
              }
              frame.close();
            },
            error: function(err) {
              if (typeof opts.onError === 'function') opts.onError(err);
              sendInput({ type: 'keyframe-request' });
            }
          });
          decoder.configure({ codec: pkt.codec, optimizeForLatency: true });
        }
        if (decoder.state === 'configured') {
          decoder.decode(new EncodedVideoChunk({
            type: pkt.keyframe ? 'key' : 'delta',
            timestamp: pkt.timestampUs,
            data: pkt.payload
          }));
        }
        return;
      }

      // Built-in RGBA or Deflate-RGBA path (serialized to preserve frame order)
      rgbaChain = rgbaChain.then(async function() {
        if (destroyed || !ctx) return;
        var rgba = pkt.codecId === 17
          ? await inflateDeflate(pkt.payload)
          : new Uint8ClampedArray(pkt.payload.buffer, pkt.payload.byteOffset, pkt.payload.byteLength);

        if (destroyed || !ctx) return;
        if (rgba.length !== pkt.width * pkt.height * 4) return;
        var imgData = new ImageData(rgba, pkt.width, pkt.height);
        if (typeof createImageBitmap === 'function') {
          var bmp = await createImageBitmap(imgData);
          if (!destroyed) ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
          bmp.close();
        } else {
          if (!offscreenCanvas) {
            offscreenCanvas = document.createElement('canvas');
            offscreenCtx = offscreenCanvas.getContext('2d');
          }
          offscreenCanvas.width = pkt.width;
          offscreenCanvas.height = pkt.height;
          offscreenCtx.putImageData(imgData, 0, 0);
          ctx.drawImage(offscreenCanvas, 0, 0, canvas.width, canvas.height);
        }
      }).catch(function(err) {
        if (typeof opts.onError === 'function') opts.onError(err);
      });
    }

    function bindInputListeners() {
      function mapCoords(e) {
        var rect = canvas.getBoundingClientRect();
        var scaleX = canvas.width / Math.max(1, rect.width);
        var scaleY = canvas.height / Math.max(1, rect.height);
        return {
          x: Math.round((e.clientX - rect.left) * scaleX),
          y: Math.round((e.clientY - rect.top) * scaleY)
        };
      }
      canvas.addEventListener('pointermove', function(e) {
        var p = mapCoords(e);
        sendInput({ type: 'pointermove', x: p.x, y: p.y, buttons: e.buttons });
      });
      canvas.addEventListener('pointerdown', function(e) {
        canvas.focus();
        var p = mapCoords(e);
        sendInput({ type: 'pointerdown', x: p.x, y: p.y, button: e.button, buttons: e.buttons });
      });
      canvas.addEventListener('pointerup', function(e) {
        var p = mapCoords(e);
        sendInput({ type: 'pointerup', x: p.x, y: p.y, button: e.button, buttons: e.buttons });
      });
      canvas.addEventListener('wheel', function(e) {
        e.preventDefault();
        var p = mapCoords(e);
        sendInput({ type: 'wheel', x: p.x, y: p.y, deltaX: e.deltaX, deltaY: e.deltaY });
      }, { passive: false });
      canvas.addEventListener('keydown', function(e) {
        sendInput({
          type: 'keydown', key: e.key, code: e.code,
          ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey
        });
      });
      canvas.addEventListener('keyup', function(e) {
        sendInput({
          type: 'keyup', key: e.key, code: e.code,
          ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: e.metaKey
        });
      });
      hiddenInput.addEventListener('input', function() {
        sendInput({ type: 'input', value: hiddenInput.value });
      });
      document.addEventListener('visibilitychange', onVisibilityChange);
      window.addEventListener('popstate', onPopState);
    }

    function onVisibilityChange() {
      sendInput({ type: 'visibility', hidden: document.hidden });
    }
    function onPopState() {
      sendInput({ type: 'popstate', path: window.location.pathname + window.location.search });
    }

    var ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(function() {
      var s = getSize();
      sendInput({ type: 'resize', width: s.width, height: s.height, dpr: s.dpr });
    }) : null;
    if (ro) ro.observe(container);

    function connectWebSocket(wsPath, ticket) {
      var proto = window.location.protocol === 'https:' ? 'wss://' : 'ws://';
      ws = new WebSocket(proto + window.location.host + wsPath + '?ticket=' + encodeURIComponent(ticket));
      ws.binaryType = 'arraybuffer';
      activeTransport = {
        sendText: function(txt) {
          if (ws && ws.readyState === 1) ws.send(txt);
        }
      };
      ws.onmessage = function(ev) {
        if (typeof ev.data === 'string') handleControl(ev.data);
        else handleFrame(ev.data);
      };
      ws.onerror = function() {
        if (typeof opts.onError === 'function') opts.onError(new Error('Stream transport error'));
      };
    }

    async function start() {
      var size = getSize();
      var ticketRes = await fetch('/_vula/stream/ticket', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          surface: surface,
          width: size.width,
          height: size.height,
          dpr: size.dpr,
          params: opts.params || {}
        })
      });
      if (!ticketRes.ok) {
        var errBody = await ticketRes.json().catch(function() { return {}; });
        throw new Error(errBody.error || ('Stream ticket failed (' + ticketRes.status + ')'));
      }
      var ticketInfo = await ticketRes.json();
      if (destroyed) return;

      bindInputListeners();

      if (typeof RTCPeerConnection !== 'undefined') {
        try {
          pc = new RTCPeerConnection({ iceServers: ticketInfo.iceServers || [] });
          var frameDc = pc.createDataChannel('vula-frames', { ordered: true });
          frameDc.binaryType = 'arraybuffer';
          var inputDc = pc.createDataChannel('vula-input', { ordered: true });

          pc.onicecandidate = function(ev) {
            if (ev.candidate) {
              fetch('/_vula/stream/signal', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ ticket: ticketInfo.ticket, candidate: ev.candidate })
              }).catch(function(){});
            }
          };

          var offer = await pc.createOffer();
          await pc.setLocalDescription(offer);

          var sigRes = await fetch('/_vula/stream/signal', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ticket: ticketInfo.ticket, offer: offer })
          });
          var sig = await sigRes.json();
          if (destroyed) return;

          if (sig.transport === 'webrtc' && sig.answer) {
            await pc.setRemoteDescription(sig.answer);
            frameDc.onmessage = function(ev) {
              if (typeof ev.data === 'string') handleControl(ev.data);
              else handleFrame(ev.data);
            };
            inputDc.onmessage = function(ev) {
              if (typeof ev.data === 'string') handleControl(ev.data);
            };
            activeTransport = {
              sendText: function(txt) {
                if (inputDc.readyState === 'open') inputDc.send(txt);
              }
            };
            return;
          }
          try { pc.close(); } catch (_) {}
          pc = null;
          connectWebSocket(sig.wsPath || '/_vula/stream/ws', ticketInfo.ticket);
          return;
        } catch (err) {
          if (pc) { try { pc.close(); } catch (_) {} pc = null; }
        }
      }
      connectWebSocket('/_vula/stream/ws', ticketInfo.ticket);
    }

    start().catch(function(err) {
      if (typeof opts.onError === 'function') opts.onError(err);
    });

    return {
      destroy: function() {
        destroyed = true;
        if (ro) ro.disconnect();
        document.removeEventListener('visibilitychange', onVisibilityChange);
        window.removeEventListener('popstate', onPopState);
        if (decoder) { try { decoder.close(); } catch (_) {} }
        if (pc) { try { pc.close(); } catch (_) {} }
        if (ws) { try { ws.close(); } catch (_) {} }
      }
    };
  }

  global.VulaStream = {
    mount: mountStreamSurface,
    parsePacket: parsePacket
  };
})(typeof window !== 'undefined' ? window : globalThis);
`;
}

module.exports = {
  getStreamClientScript,
};
