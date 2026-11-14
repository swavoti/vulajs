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
    17: 'rgba-deflate',
    18: 'jpeg',
    19: 'png'
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

    var scrollHost = document.createElement('div');
    scrollHost.style.cssText = 'position:relative;width:100%;height:100%;overflow:auto;outline:none;';

    var viewportWrap = document.createElement('div');
    viewportWrap.style.cssText = 'position:sticky;top:0;left:0;width:100%;height:100%;overflow:hidden;z-index:1;';

    var scrollSpacer = document.createElement('div');
    scrollSpacer.style.cssText = 'position:absolute;top:0;left:0;width:1px;height:1px;pointer-events:none;z-index:0;';

    var canvas = document.createElement('canvas');
    canvas.tabIndex = 0;
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';
    canvas.style.outline = 'none';
    container.innerHTML = '';
    viewportWrap.appendChild(canvas);
    scrollHost.appendChild(scrollSpacer);
    scrollHost.appendChild(viewportWrap);
    container.appendChild(scrollHost);

    var ctx = canvas.getContext('2d', { alpha: false });
    var hiddenInput = document.createElement('input');
    hiddenInput.type = 'text';
    hiddenInput.autocomplete = 'off';
    hiddenInput.style.cssText = 'position:absolute;opacity:0;pointer-events:none;left:0;top:0;width:1px;height:1px;';
    viewportWrap.appendChild(hiddenInput);

    var ignoreNextScroll = false;

    var destroyed = false;
    var activeTransport = null;
    var pc = null;
    var ws = null;
    var decoder = null;
    var configuredCodec = null;
    var offscreenCanvas = null;
    var offscreenCtx = null;
    var rgbaChain = Promise.resolve();
    var latestImagePkt = null;
    var imageDecoding = false;

    function drainLatestImage() {
      if (destroyed || !ctx || imageDecoding || !latestImagePkt) return;
      var pkt = latestImagePkt;
      latestImagePkt = null;
      imageDecoding = true;
      var mime = pkt.codecId === 18 ? 'image/jpeg' : 'image/png';
      var blob = new Blob([pkt.payload], { type: mime });
      createImageBitmap(blob).then(function(imgBmp) {
        if (!destroyed && ctx) {
          if (canvas.width !== pkt.width || canvas.height !== pkt.height) {
            canvas.width = pkt.width;
            canvas.height = pkt.height;
          }
          ctx.drawImage(imgBmp, 0, 0, canvas.width, canvas.height);
        }
        imgBmp.close();
      }).catch(function(err) {
        if (typeof opts.onError === 'function') opts.onError(err);
      }).finally(function() {
        imageDecoding = false;
        if (latestImagePkt && !destroyed) drainLatestImage();
      });
    }

    function getSize() {
      var rect = viewportWrap.getBoundingClientRect();
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
      } else if (msg.type === 'scroll') {
        scrollSpacer.style.height = Math.max(1, msg.scrollHeight || 1) + 'px';
        scrollSpacer.style.width = (msg.scrollWidth > msg.clientWidth ? msg.scrollWidth + 'px' : '1px');
        if (Math.abs(scrollHost.scrollTop - (msg.scrollY || 0)) > 2 || Math.abs(scrollHost.scrollLeft - (msg.scrollX || 0)) > 2) {
          ignoreNextScroll = true;
          scrollHost.scrollLeft = msg.scrollX || 0;
          scrollHost.scrollTop = msg.scrollY || 0;
          setTimeout(function() { ignoreNextScroll = false; }, 30);
        }
      } else if (msg.type === 'console' && typeof console !== 'undefined') {
        var logFn = console[msg.level] || console.log;
        if (typeof logFn === 'function') {
          logFn.apply(console, ['[vula-stream]'].concat(msg.args || []));
        }
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

      if (pkt.codecId === 18 || pkt.codecId === 19) {
        latestImagePkt = pkt;
        drainLatestImage();
        return;
      }

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

      // Built-in RGBA / Deflate-RGBA path (serialized to preserve frame order)
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
      var pendingMove = null;
      var pendingWheel = null;
      var inputRaf = 0;
      function flushPendingInput() {
        inputRaf = 0;
        if (pendingMove) {
          sendInput(pendingMove);
          pendingMove = null;
        }
        if (pendingWheel) {
          sendInput(pendingWheel);
          pendingWheel = null;
        }
      }
      function scheduleFlush() {
        if (inputRaf) return;
        if (typeof requestAnimationFrame === 'function') {
          inputRaf = requestAnimationFrame(flushPendingInput);
        } else {
          inputRaf = setTimeout(flushPendingInput, 16);
        }
      }
      canvas.addEventListener('pointermove', function(e) {
        var p = mapCoords(e);
        pendingMove = { type: 'pointermove', x: p.x, y: p.y, buttons: e.buttons };
        scheduleFlush();
      });
      canvas.addEventListener('pointerdown', function(e) {
        flushPendingInput();
        canvas.focus();
        var p = mapCoords(e);
        sendInput({ type: 'pointerdown', x: p.x, y: p.y, button: e.button, buttons: e.buttons });
      });
      canvas.addEventListener('pointerup', function(e) {
        flushPendingInput();
        var p = mapCoords(e);
        sendInput({ type: 'pointerup', x: p.x, y: p.y, button: e.button, buttons: e.buttons });
      });
      canvas.addEventListener('wheel', function(e) {
        e.preventDefault();
        var p = mapCoords(e);
        if (pendingWheel) {
          pendingWheel.x = p.x;
          pendingWheel.y = p.y;
          pendingWheel.deltaX += e.deltaX;
          pendingWheel.deltaY += e.deltaY;
        } else {
          pendingWheel = { type: 'wheel', x: p.x, y: p.y, deltaX: e.deltaX, deltaY: e.deltaY };
        }
        scheduleFlush();
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
      var scrollRaf = 0;
      scrollHost.addEventListener('scroll', function() {
        if (ignoreNextScroll) return;
        if (scrollRaf) return;
        var sched = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : function(fn) { return setTimeout(fn, 16); };
        scrollRaf = sched(function() {
          scrollRaf = 0;
          if (!destroyed) {
            sendInput({ type: 'scroll-to', x: Math.round(scrollHost.scrollLeft), y: Math.round(scrollHost.scrollTop) });
          }
        });
      }, { passive: true });
      document.addEventListener('paste', onPaste);
      document.addEventListener('visibilitychange', onVisibilityChange);
      window.addEventListener('popstate', onPopState);
    }

    function onPaste(e) {
      if (destroyed) return;
      if (document.activeElement !== canvas && document.activeElement !== hiddenInput) return;
      var text = e.clipboardData && e.clipboardData.getData('text/plain');
      if (text) {
        e.preventDefault();
        sendInput({ type: 'input', value: text });
      }
    }
    function onVisibilityChange() {
      sendInput({ type: 'visibility', hidden: document.hidden });
    }
    function onPopState() {
      sendInput({ type: 'popstate', path: window.location.pathname + window.location.search });
    }

    var lastSentSize = getSize();
    var ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(function() {
      var s = getSize();
      if (s.width === lastSentSize.width && s.height === lastSentSize.height && s.dpr === lastSentSize.dpr) return;
      lastSentSize = s;
      sendInput({ type: 'resize', width: s.width, height: s.height, dpr: s.dpr });
    }) : null;
    if (ro) ro.observe(viewportWrap);

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
        latestImagePkt = null;
        if (ro) ro.disconnect();
        document.removeEventListener('paste', onPaste);
        document.removeEventListener('visibilitychange', onVisibilityChange);
        window.removeEventListener('popstate', onPopState);
        if (decoder) { try { decoder.close(); } catch (_) {} }
        if (pc) { try { pc.close(); } catch (_) {} }
        if (ws) { try { ws.close(); } catch (_) {} }
      }
    };
  }

  function syncAttributes(targetEl, sourceEl) {
    var i;
    var oldAttrs = targetEl.attributes;
    for (i = oldAttrs.length - 1; i >= 0; i--) {
      var name = oldAttrs[i].name;
      if (!sourceEl.hasAttribute(name)) {
        targetEl.removeAttribute(name);
      }
    }
    var newAttrs = sourceEl.attributes;
    for (i = 0; i < newAttrs.length; i++) {
      var attr = newAttrs[i];
      if (targetEl.getAttribute(attr.name) !== attr.value) {
        targetEl.setAttribute(attr.name, attr.value);
      }
    }
  }

  function syncAttributesMap(targetEl, attrsMap) {
    if (!attrsMap || typeof attrsMap !== 'object') return;
    var i;
    var oldAttrs = targetEl.attributes;
    for (i = oldAttrs.length - 1; i >= 0; i--) {
      var name = oldAttrs[i].name;
      if (!Object.prototype.hasOwnProperty.call(attrsMap, name)) {
        targetEl.removeAttribute(name);
      }
    }
    var keys = Object.keys(attrsMap);
    for (i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (targetEl.getAttribute(k) !== attrsMap[k]) {
        targetEl.setAttribute(k, attrsMap[k]);
      }
    }
  }

  function filterMorphNodes(nodeList, removeCommentsFromDom) {
    var raw = Array.prototype.slice.call(nodeList);
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      var n = raw[i];
      if (n.nodeType === 8) {
        if (removeCommentsFromDom && n.parentNode) n.parentNode.removeChild(n);
        continue;
      }
      if (n.nodeType === 1 && n.tagName === 'SCRIPT') continue;
      out.push(n);
    }
    return out;
  }

  function morphChildren(targetParent, sourceParent) {
    var targetChildren = filterMorphNodes(targetParent.childNodes, true);
    var sourceChildren = filterMorphNodes(sourceParent.childNodes, false);
    var i = 0;
    for (i = 0; i < sourceChildren.length; i++) {
      var nextChild = sourceChildren[i];
      var curChild = targetChildren[i];
      if (!curChild) {
        targetParent.appendChild(document.importNode(nextChild, true));
        continue;
      }
      if (curChild.nodeType !== nextChild.nodeType ||
          (curChild.nodeType === 1 && curChild.tagName !== nextChild.tagName)) {
        targetParent.replaceChild(document.importNode(nextChild, true), curChild);
        continue;
      }
      if (curChild.nodeType === 3) {
        if (curChild.nodeValue !== nextChild.nodeValue) {
          curChild.nodeValue = nextChild.nodeValue;
        }
        continue;
      }
      if (curChild.nodeType === 1) {
        if (curChild.getAttribute('data-vula-stream-mounted') === '1' &&
            curChild.getAttribute('data-vula-stream') === nextChild.getAttribute('data-vula-stream')) {
          continue;
        }
        var isFocused = document.activeElement === curChild;
        syncAttributes(curChild, nextChild);
        if (curChild.tagName === 'INPUT') {
          if (!isFocused) {
            if (curChild.type === 'checkbox' || curChild.type === 'radio') {
              curChild.checked = nextChild.hasAttribute('checked');
            } else {
              curChild.value = nextChild.getAttribute('value') || '';
            }
          }
        } else if (curChild.tagName === 'TEXTAREA') {
          if (!isFocused) curChild.value = nextChild.textContent || '';
        } else if (curChild.tagName === 'SELECT') {
          morphChildren(curChild, nextChild);
          if (!isFocused) {
            var opt = nextChild.querySelector('option[selected]');
            if (opt) curChild.value = opt.value;
          }
          continue;
        } else {
          morphChildren(curChild, nextChild);
        }
      }
    }
    for (i = targetChildren.length - 1; i >= sourceChildren.length; i--) {
      if (targetChildren[i] && targetChildren[i].parentNode === targetParent) {
        targetParent.removeChild(targetChildren[i]);
      }
    }
  }

  function getControlIndex(rootEl, targetEl) {
    var list = rootEl.querySelectorAll(targetEl.tagName);
    for (var i = 0; i < list.length; i++) {
      if (list[i] === targetEl) return i;
    }
    return -1;
  }

  function mountDomSurface(rootEl, options) {
    if (!rootEl) throw new Error('VulaStream: root element is required');
    var opts = options || {};
    var surface = opts.surface || '__global__';
    var currentPath = opts.path || (window.location.pathname + window.location.search);
    var destroyed = false;
    var ws = null;
    var embeddedStreams = [];
    var pendingMessages = [];
    var reconnectAttempts = 0;
    var reconnectTimer = 0;
    var domReady = false;
    var mountStartMs = Date.now();
    var navStartMs = 0;
    var pendingNavPath = '';
    var queuedInteractions = [];

    rootEl.setAttribute('data-vula-dom', 'incoming');
    if (typeof console !== 'undefined' && console.log) {
      console.log('[vula] UI painted — interactive DOM incoming for ' + currentPath + '...');
    }

    function sendMsg(obj) {
      if (destroyed) return;
      var payload = JSON.stringify(obj);
      if (ws && ws.readyState === 1) {
        ws.send(payload);
      } else {
        if (pendingMessages.length >= 64) pendingMessages.shift();
        pendingMessages.push(payload);
      }
    }

    function replayQueuedInteractions() {
      if (!queuedInteractions.length) return;
      var queue = queuedInteractions.slice();
      queuedInteractions.length = 0;
      for (var i = 0; i < queue.length; i++) {
        var item = queue[i];
        if (item.kind === 'link' && item.href) {
          var links = rootEl.querySelectorAll('a[href]');
          var matchedLink = null;
          for (var j = 0; j < links.length; j++) {
            var h = links[j].getAttribute('href') || '';
            if (h === item.href) { matchedLink = links[j]; break; }
          }
          navStartMs = Date.now();
          pendingNavPath = item.href;
          if (typeof console !== 'undefined' && console.log) {
            console.log('[vula] compiling ' + item.href + '...');
          }
          sendMsg({
            type: 'dom-event',
            event: 'click',
            vid: matchedLink ? (matchedLink.getAttribute('data-vid') || '') : '',
            href: item.href
          });
        } else if (item.kind === 'control') {
          var candidates = rootEl.querySelectorAll(item.tag || 'button');
          var matchedCtrl = (item.index >= 0 && candidates[item.index]) ? candidates[item.index] : null;
          if (!matchedCtrl && item.text) {
            for (var k = 0; k < candidates.length; k++) {
              if ((candidates[k].textContent || '').trim().slice(0, 64) === item.text) {
                matchedCtrl = candidates[k];
                break;
              }
            }
          }
          var vid = matchedCtrl ? matchedCtrl.getAttribute('data-vid') : '';
          if (vid) {
            sendMsg({ type: 'dom-event', event: 'click', vid: vid });
          }
        }
      }
    }

    function mountEmbeddedStreams() {
      for (var s = embeddedStreams.length - 1; s >= 0; s--) {
        var entry = embeddedStreams[s];
        if (!entry || !entry.el || !rootEl.contains(entry.el)) {
          if (entry && entry.inst) {
            try { entry.inst.destroy(); } catch (_) {}
          }
          embeddedStreams.splice(s, 1);
        }
      }
      var hosts = rootEl.querySelectorAll('[data-vula-stream]');
      for (var i = 0; i < hosts.length; i++) {
        var el = hosts[i];
        if (el.getAttribute('data-vula-stream-mounted') === '1') continue;
        var name = el.getAttribute('data-vula-stream');
        if (!name) continue;
        el.setAttribute('data-vula-stream-mounted', '1');
        var inst = mountStreamSurface(el, { surface: name });
        embeddedStreams.push({ el: el, inst: inst });
      }
    }

    function handleControl(raw) {
      var msg;
      try { msg = JSON.parse(raw); } catch (_) { return; }
      if (!msg || !msg.type) return;
      if (msg.type === 'console' && typeof console !== 'undefined') {
        var logFn = console[msg.level] || console.log;
        if (typeof logFn === 'function') logFn.apply(console, ['[vula-stream]'].concat(msg.args || []));
        return;
      }
      if (msg.type === 'dom-patch' && Array.isArray(msg.chunks)) {
        if (msg.title) document.title = msg.title;
        for (var c = 0; c < msg.chunks.length; c++) {
          var chunk = msg.chunks[c];
          if (!chunk || !chunk.vid) continue;
          var targetNode = rootEl.querySelector('[data-vid="' + chunk.vid.replace(/"/g, '') + '"]');
          if (!targetNode) continue;
          if (chunk.attrs) syncAttributesMap(targetNode, chunk.attrs);
          var patchTmpl = document.createElement('template');
          patchTmpl.innerHTML = chunk.html || '';
          morphChildren(targetNode, patchTmpl.content);
        }
        mountEmbeddedStreams();
        return;
      }
      if (msg.type === 'dom-sync') {
        if (msg.title) document.title = msg.title;
        var nextPath = msg.path || '/';
        var curBrowserPath = window.location.pathname + window.location.search;
        if (nextPath !== curBrowserPath) {
          window.__vulaNavigationInProgress = true;
          try {
            window.history.pushState({}, '', nextPath);
          } finally {
            window.__vulaNavigationInProgress = false;
          }
          window.scrollTo(0, 0);
        }
        currentPath = nextPath;
        var tmpl = document.createElement('template');
        tmpl.innerHTML = msg.html || '';
        morphChildren(rootEl, tmpl.content);
        mountEmbeddedStreams();

        if (!domReady) {
          domReady = true;
          rootEl.setAttribute('data-vula-dom', 'ready');
          if (typeof console !== 'undefined' && console.log) {
            console.log('[vula] interactive DOM ready (' + currentPath + ') in ' + (Date.now() - mountStartMs) + 'ms');
          }
          replayQueuedInteractions();
        } else if (navStartMs > 0) {
          var elapsed = Date.now() - navStartMs;
          navStartMs = 0;
          pendingNavPath = '';
          if (typeof console !== 'undefined' && console.log) {
            console.log('[vula] compiled ' + currentPath + ' in ' + elapsed + 'ms');
          }
        }
        return;
      }
      if (msg.type === 'nav' && typeof msg.path === 'string' && msg.path.startsWith('/')) {
        if (window.location.pathname + window.location.search !== msg.path) {
          var method = msg.replace ? 'replaceState' : 'pushState';
          window.__vulaNavigationInProgress = true;
          try {
            window.history[method]({}, '', msg.path);
          } finally {
            window.__vulaNavigationInProgress = false;
          }
        }
      } else if (msg.type === 'title' && typeof msg.title === 'string') {
        document.title = msg.title;
      }
    }

    function onClick(e) {
      if (e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      var target = e.target;
      if (!target || !target.closest) return;
      var link = target.closest('a[href]');
      if (link) {
        if (link.hasAttribute('download') || (link.target && link.target !== '_self')) return;
        var rawHref = link.getAttribute('href') || '';
        if (!rawHref || rawHref.startsWith('#') || rawHref.startsWith('mailto:') || rawHref.startsWith('tel:')) return;
        var dest;
        try { dest = new URL(link.href, window.location.href); } catch (_) { return; }
        if (dest.origin !== window.location.origin) return;
        e.preventDefault();
        var nextHref = dest.pathname + dest.search + dest.hash;
        if (!domReady) {
          if (typeof console !== 'undefined' && console.log) {
            console.log('[vula] DOM still incoming — queued navigation to ' + nextHref + '...');
          }
          queuedInteractions.push({ kind: 'link', href: nextHref });
          return;
        }
        navStartMs = Date.now();
        pendingNavPath = nextHref;
        if (typeof console !== 'undefined' && console.log) {
          console.log('[vula] compiling ' + nextHref + '...');
        }
        sendMsg({
          type: 'dom-event',
          event: 'click',
          vid: link.getAttribute('data-vid') || '',
          href: nextHref
        });
        return;
      }
      var control = target.closest('button, input[type="button"], input[type="checkbox"], input[type="radio"], select, label, summary, [role="button"], [role="tab"], [role="menuitem"]') || target.closest('[data-vid]');
      if (!control) return;
      if ((control.tagName === 'BUTTON' && (control.getAttribute('type') || 'submit') === 'submit' && control.closest('form')) ||
          (control.tagName === 'INPUT' && control.type === 'submit' && control.closest('form'))) {
        return;
      }
      var vid = control.getAttribute('data-vid') || '';
      var ctrlTag = control.tagName || 'BUTTON';
      var ctrlIndex = getControlIndex(rootEl, control);
      var ctrlText = (control.textContent || '').trim().slice(0, 64);
      var ctrlAria = control.getAttribute('aria-label') || '';
      if (!domReady) {
        if (typeof console !== 'undefined' && console.log) {
          console.log('[vula] DOM still incoming — queued click on <' + ctrlTag.toLowerCase() + '>...');
        }
        queuedInteractions.push({
          kind: 'control',
          tag: ctrlTag,
          index: ctrlIndex,
          text: ctrlText,
          ariaLabel: ctrlAria
        });
        return;
      }
      sendMsg({
        type: 'dom-event',
        event: 'click',
        vid: vid,
        tag: ctrlTag,
        index: ctrlIndex,
        text: ctrlText,
        ariaLabel: ctrlAria
      });
    }

    function onInputOrChange(e) {
      var target = e.target;
      if (!target || !target.getAttribute) return;
      var vid = target.getAttribute('data-vid');
      if (!vid) return;
      sendMsg({
        type: 'dom-event',
        event: e.type,
        vid: vid,
        value: target.value != null ? String(target.value) : '',
        checked: Boolean(target.checked)
      });
    }

    function onSubmit(e) {
      var form = e.target;
      if (!form || !form.getAttribute) return;
      e.preventDefault();
      var vid = form.getAttribute('data-vid') || '';
      sendMsg({ type: 'dom-event', event: 'submit', vid: vid });
    }

    function onPopState() {
      var nextPath = window.location.pathname + window.location.search;
      navStartMs = Date.now();
      pendingNavPath = nextPath;
      if (typeof console !== 'undefined' && console.log) {
        console.log('[vula] compiling ' + nextPath + '...');
      }
      sendMsg({ type: 'popstate', path: nextPath });
    }

    function refreshDomHmr() {
      if (destroyed) return;
      var curUrl = window.location.pathname + window.location.search;
      sendMsg({ type: 'popstate', path: curUrl });
      fetch(curUrl, {
        cache: 'no-store',
        headers: { Accept: 'text/html' }
      }).then(function(res) {
        if (!res.ok) return null;
        return res.text();
      }).then(function(html) {
        if (!html || destroyed) return;
        try {
          var parser = new DOMParser();
          var doc = parser.parseFromString(html, 'text/html');
          if (doc.title) document.title = doc.title;
          var nextRoot = doc.getElementById('root');
          if (nextRoot) {
            morphChildren(rootEl, nextRoot);
            mountEmbeddedStreams();
          }
        } catch (_) {}
      }).catch(function() {});
    }

    window.__vulaHmrRefresh = refreshDomHmr;

    function onPageShow(e) {
      if (e && e.persisted && !destroyed) {
        if (ws) { try { ws.close(); } catch (_) {} ws = null; }
        connectDomSocket();
      }
    }

    rootEl.addEventListener('click', onClick);
    rootEl.addEventListener('input', onInputOrChange);
    rootEl.addEventListener('change', onInputOrChange);
    rootEl.addEventListener('submit', onSubmit);
    window.addEventListener('popstate', onPopState);
    window.addEventListener('pageshow', onPageShow);
    mountEmbeddedStreams();

    function connectDomSocket() {
      if (destroyed) return;
      fetch('/_vula/stream/ticket', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          surface: surface,
          width: Math.max(320, window.innerWidth || 1280),
          height: Math.max(320, window.innerHeight || 720),
          dpr: Math.max(1, Math.min(3, window.devicePixelRatio || 1)),
          params: { mode: 'dom', path: currentPath }
        })
      }).then(function(res) {
        if (!res.ok) throw new Error('Stream ticket failed');
        return res.json();
      }).then(function(info) {
        if (destroyed) return;
        var proto = window.location.protocol === 'https:' ? 'wss://' : 'ws://';
        var sock = new WebSocket(proto + window.location.host + '/_vula/stream/ws?ticket=' + encodeURIComponent(info.ticket));
        ws = sock;
        sock.onopen = function() {
          reconnectAttempts = 0;
          while (pendingMessages.length && sock.readyState === 1) {
            sock.send(pendingMessages.shift());
          }
        };
        sock.onmessage = function(ev) {
          if (typeof ev.data === 'string') handleControl(ev.data);
        };
        sock.onclose = function() {
          if (ws === sock) ws = null;
          if (!destroyed) {
            var delay = Math.min(3000, 250 * Math.pow(2, reconnectAttempts++));
            reconnectTimer = setTimeout(connectDomSocket, delay);
          }
        };
      }).catch(function(err) {
        if (typeof opts.onError === 'function') opts.onError(err);
        if (!destroyed) {
          var delay = Math.min(3000, 250 * Math.pow(2, reconnectAttempts++));
          reconnectTimer = setTimeout(connectDomSocket, delay);
        }
      });
    }

    connectDomSocket();

    return {
      destroy: function() {
        destroyed = true;
        if (reconnectTimer) clearTimeout(reconnectTimer);
        rootEl.removeEventListener('click', onClick);
        rootEl.removeEventListener('input', onInputOrChange);
        rootEl.removeEventListener('change', onInputOrChange);
        rootEl.removeEventListener('submit', onSubmit);
        window.removeEventListener('popstate', onPopState);
        window.removeEventListener('pageshow', onPageShow);
        for (var i = 0; i < embeddedStreams.length; i++) {
          var es = embeddedStreams[i];
          if (es && es.inst && es.inst.destroy) es.inst.destroy();
        }
        if (ws) { try { ws.close(); } catch (_) {} }
      }
    };
  }

  global.VulaStream = {
    mount: mountStreamSurface,
    mountDom: mountDomSurface,
    parsePacket: parsePacket
  };
})(typeof window !== 'undefined' ? window : globalThis);
`;
}

module.exports = {
  getStreamClientScript,
};
