'use strict';

const crypto = require('node:crypto');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_WS_PAYLOAD = 4 * 1024 * 1024;
const MAX_RX_BUFFER = MAX_WS_PAYLOAD + 1024;

function buildServerFrame(opcode, data) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data || ''), 'utf8');
  const len = payload.length;
  let header;

  if (len < 126) {
    header = Buffer.allocUnsafe(2);
    header[0] = 0x80 | opcode;
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }

  return Buffer.concat([header, payload]);
}

/**
 * Minimal, self-contained RFC 6455 WebSocket upgrade handler for stream transport/signaling.
 * Uses only node:crypto so stream tests and deployments work even without external WS bindings.
 */
function acceptWebSocketUpgrade(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (typeof key !== 'string' || !key) {
    socket.destroy();
    return null;
  }

  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '',
      '',
    ].join('\r\n')
  );

  let closed = false;
  let rxBuffer = Buffer.alloc(0);
  let fragOpcode = 0;
  let fragChunks = [];
  let fragBytes = 0;
  const listeners = { message: [], close: [], error: [] };

  function emit(event, ...args) {
    for (const fn of listeners[event]) {
      try {
        fn(...args);
      } catch (err) {
        if (event !== 'error') emit('error', err);
      }
    }
  }

  function close(code = 1000) {
    if (closed) return;
    closed = true;
    try {
      const payload = Buffer.allocUnsafe(2);
      payload.writeUInt16BE(code, 0);
      socket.write(buildServerFrame(0x08, payload));
    } catch (_) {}
    try { socket.end(); } catch (_) {}
    emit('close');
  }

  socket.on('data', (chunk) => {
    if (closed) return;
    if (rxBuffer.length + chunk.length > MAX_RX_BUFFER) {
      close(1009);
      return;
    }
    rxBuffer = Buffer.concat([rxBuffer, chunk]);

    while (rxBuffer.length >= 2) {
      const b0 = rxBuffer[0];
      const b1 = rxBuffer[1];
      const fin = Boolean(b0 & 0x80);
      const opcode = b0 & 0x0f;
      const masked = Boolean(b1 & 0x80);
      let payloadLen = b1 & 0x7f;
      let offset = 2;

      if (!masked) {
        close(1002);
        return;
      }

      if (payloadLen === 126) {
        if (rxBuffer.length < 4) return;
        payloadLen = rxBuffer.readUInt16BE(2);
        offset = 4;
      } else if (payloadLen === 127) {
        if (rxBuffer.length < 10) return;
        const bigLen = rxBuffer.readBigUInt64BE(2);
        if (bigLen > BigInt(MAX_WS_PAYLOAD)) {
          close(1009);
          return;
        }
        payloadLen = Number(bigLen);
        offset = 10;
      }

      if (payloadLen > MAX_WS_PAYLOAD) {
        close(1009);
        return;
      }

      if (rxBuffer.length < offset + 4 + payloadLen) return;

      const maskKey = rxBuffer.subarray(offset, offset + 4);
      const payload = Buffer.from(rxBuffer.subarray(offset + 4, offset + 4 + payloadLen));
      rxBuffer = rxBuffer.subarray(offset + 4 + payloadLen);

      for (let i = 0; i < payload.length; i += 1) {
        payload[i] ^= maskKey[i & 3];
      }

      if (opcode >= 0x08 && !fin) {
        close(1002);
        return;
      }
      if (opcode === 0x08) {
        close(1000);
        return;
      }
      if (opcode === 0x09) {
        if (!closed) socket.write(buildServerFrame(0x0a, payload));
        continue;
      }
      if (opcode === 0x0a) {
        continue;
      }

      if (opcode === 0x00) {
        if (!fragOpcode || fragBytes + payload.length > MAX_WS_PAYLOAD) {
          close(fragOpcode ? 1009 : 1002);
          return;
        }
        fragChunks.push(payload);
        fragBytes += payload.length;
        if (fin) {
          const full = Buffer.concat(fragChunks);
          const doneOpcode = fragOpcode;
          fragOpcode = 0;
          fragChunks = [];
          fragBytes = 0;
          if (doneOpcode === 0x01) emit('message', full.toString('utf8'), false);
          else emit('message', full, true);
        }
        continue;
      }

      if (opcode !== 0x01 && opcode !== 0x02) {
        close(1002);
        return;
      }
      if (fragOpcode) {
        close(1002);
        return;
      }
      if (!fin) {
        fragOpcode = opcode;
        fragChunks = [payload];
        fragBytes = payload.length;
        continue;
      }

      if (opcode === 0x01) {
        emit('message', payload.toString('utf8'), false);
      } else {
        emit('message', payload, true);
      }
    }
  });

  socket.on('close', () => {
    if (!closed) {
      closed = true;
      emit('close');
    }
  });
  socket.on('error', (err) => emit('error', err));

  return {
    transportName: 'ws',
    get isOpen() {
      return !closed && !socket.destroyed;
    },
    sendBinary(buf) {
      if (!closed && !socket.destroyed) {
        socket.write(buildServerFrame(0x02, buf));
      }
    },
    sendText(str) {
      if (!closed && !socket.destroyed) {
        socket.write(buildServerFrame(0x01, String(str)));
      }
    },
    on(event, fn) {
      if (listeners[event]) listeners[event].push(fn);
    },
    close,
  };
}

module.exports = {
  acceptWebSocketUpgrade,
};
