'use strict';

const MAGIC_0 = 0x56; // 'V'
const MAGIC_1 = 0x46; // 'F'
const PROTOCOL_VERSION = 1;
const HEADER_SIZE = 28;

const CODEC_IDS = Object.freeze({
  vp8: 0x01,
  vp9: 0x02,
  h264: 0x03,
  av1: 0x04,
  rgba: 0x10,
  'rgba-deflate': 0x11,
  jpeg: 0x12,
  png: 0x13,
});

const CODEC_NAMES = Object.freeze(
  Object.fromEntries(Object.entries(CODEC_IDS).map(([name, id]) => [id, name]))
);

const FRAME_FLAGS = Object.freeze({
  KEYFRAME: 1 << 0,
  DIRTY_RECT: 1 << 1,
});

const ALLOWED_INPUT_TYPES = new Set([
  'pointermove',
  'pointerdown',
  'pointerup',
  'wheel',
  'scroll-to',
  'dom-event',
  'keydown',
  'keyup',
  'input',
  'resize',
  'visibility',
  'popstate',
  'keyframe-request',
]);

const ALLOWED_CONTROL_TYPES = new Set([
  'ready',
  'cursor',
  'nav',
  'title',
  'scroll',
  'console',
  'dom-sync',
  'dom-patch',
  'input-focus',
  'input-blur',
  'clipboard',
  'error',
]);

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

/**
 * Encodes a binary Vula Frame packet.
 * Layout (28 bytes big-endian header + payload):
 *   0..1   magic ("VF")
 *   2      version (1)
 *   3      codecId
 *   4      flags (bit 0 = keyframe, bit 1 = dirtyRect)
 *   5      reserved (0)
 *   6..7   width (uint16)
 *   8..9   height (uint16)
 *   10..13 seq (uint32)
 *   14..21 timestampUs (uint64)
 *   22..25 payloadLength (uint32)
 *   26..27 reserved2 (0)
 */
function encodeFramePacket({
  codec,
  keyframe = true,
  dirtyRect = false,
  width,
  height,
  seq = 0,
  timestampUs = 0,
  payload,
}) {
  const codecId = typeof codec === 'number' ? codec : CODEC_IDS[codec];
  if (!codecId || !CODEC_NAMES[codecId]) {
    throw new Error(`Unsupported stream codec: ${String(codec)}`);
  }
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload || []);
  const packet = Buffer.allocUnsafe(HEADER_SIZE + body.length);

  packet[0] = MAGIC_0;
  packet[1] = MAGIC_1;
  packet[2] = PROTOCOL_VERSION;
  packet[3] = codecId;
  packet[4] = (keyframe ? FRAME_FLAGS.KEYFRAME : 0) | (dirtyRect ? FRAME_FLAGS.DIRTY_RECT : 0);
  packet[5] = 0;
  packet.writeUInt16BE(Math.max(1, Math.min(65535, Math.floor(width))), 6);
  packet.writeUInt16BE(Math.max(1, Math.min(65535, Math.floor(height))), 8);
  packet.writeUInt32BE(seq >>> 0, 10);

  const tsBig = BigInt(Math.max(0, Math.floor(Number(timestampUs) || 0)));
  packet.writeBigUInt64BE(tsBig, 14);
  packet.writeUInt32BE(body.length >>> 0, 22);
  packet.writeUInt16BE(0, 26);

  body.copy(packet, HEADER_SIZE);
  return packet;
}

/**
 * Decodes a binary Vula Frame packet.
 */
function decodeFramePacket(raw) {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  if (buf.length < HEADER_SIZE) {
    throw new Error('Frame packet shorter than header');
  }
  if (buf[0] !== MAGIC_0 || buf[1] !== MAGIC_1) {
    throw new Error('Invalid Vula frame packet magic');
  }
  if (buf[2] !== PROTOCOL_VERSION) {
    throw new Error(`Unsupported frame packet version: ${buf[2]}`);
  }
  const codecId = buf[3];
  const codec = CODEC_NAMES[codecId];
  if (!codec) {
    throw new Error(`Unknown frame codec id: ${codecId}`);
  }
  const flags = buf[4];
  const width = buf.readUInt16BE(6);
  const height = buf.readUInt16BE(8);
  const seq = buf.readUInt32BE(10);
  const timestampUs = Number(buf.readBigUInt64BE(14));
  const payloadLength = buf.readUInt32BE(22);

  if (buf.length < HEADER_SIZE + payloadLength) {
    throw new Error('Truncated Vula frame packet payload');
  }

  return {
    version: PROTOCOL_VERSION,
    codec,
    codecId,
    keyframe: Boolean(flags & FRAME_FLAGS.KEYFRAME),
    dirtyRect: Boolean(flags & FRAME_FLAGS.DIRTY_RECT),
    width,
    height,
    seq,
    timestampUs,
    payload: buf.subarray(HEADER_SIZE, HEADER_SIZE + payloadLength),
  };
}

function validateSurfaceName(name) {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= 200 &&
    !name.startsWith('/') &&
    !name.includes('..') &&
    !name.includes('\\') &&
    !name.includes('\0') &&
    /^[a-zA-Z0-9_/-]+$/.test(name)
  );
}

function clampViewport(width, height, maxWidth = 1920, maxHeight = 1080) {
  const safeMaxW = Math.max(64, Math.min(3840, Number(maxWidth) || 1920));
  const safeMaxH = Math.max(64, Math.min(2160, Number(maxHeight) || 1080));
  const w = Math.max(64, Math.min(safeMaxW, Math.round(Number(width) || 800)));
  const h = Math.max(64, Math.min(safeMaxH, Math.round(Number(height) || 600)));
  // Ensure even dimensions for YUV420 hardware video encoders (VP8/H.264)
  return {
    width: w - (w % 2),
    height: h - (h % 2),
  };
}

function clampCoord(val, max) {
  const n = Number(val);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(max, Math.round(n)));
}

/**
 * Validates and normalizes an input event coming from a browser DataChannel/WS.
 */
function validateInputEvent(raw, bounds = { maxWidth: 1920, maxHeight: 1080 }) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const type = raw.type;
  if (typeof type !== 'string' || !ALLOWED_INPUT_TYPES.has(type)) {
    return null;
  }

  const maxW = bounds.maxWidth || 1920;
  const maxH = bounds.maxHeight || 1080;

  switch (type) {
    case 'pointermove':
    case 'pointerdown':
    case 'pointerup':
      return {
        type,
        x: clampCoord(raw.x, maxW),
        y: clampCoord(raw.y, maxH),
        button: Math.max(0, Math.min(4, Math.floor(Number(raw.button) || 0))),
        buttons: Math.max(0, Math.min(31, Math.floor(Number(raw.buttons) || 0))),
      };
    case 'wheel':
      return {
        type,
        x: clampCoord(raw.x, maxW),
        y: clampCoord(raw.y, maxH),
        deltaX: Math.max(-2000, Math.min(2000, Number(raw.deltaX) || 0)),
        deltaY: Math.max(-2000, Math.min(2000, Number(raw.deltaY) || 0)),
      };
    case 'scroll-to':
      return {
        type,
        x: Math.max(0, Math.min(200000, Math.round(Number(raw.x) || 0))),
        y: Math.max(0, Math.min(200000, Math.round(Number(raw.y) || 0))),
      };
    case 'dom-event': {
      const evName = ['click', 'input', 'change', 'submit'].includes(raw.event) ? raw.event : null;
      if (!evName) return null;
      const out = {
        type,
        event: evName,
        vid: typeof raw.vid === 'string' ? raw.vid.slice(0, 64) : '',
        href: typeof raw.href === 'string' && raw.href.startsWith('/') && !raw.href.startsWith('//')
          ? raw.href.slice(0, 1024)
          : '',
        value: typeof raw.value === 'string' ? raw.value.slice(0, 8192) : '',
        checked: Boolean(raw.checked),
      };
      if (typeof raw.tag === 'string' && /^[a-zA-Z0-9_-]{1,24}$/.test(raw.tag)) {
        out.tag = raw.tag;
      }
      if (typeof raw.index === 'number' && Number.isFinite(raw.index)) {
        out.index = Math.max(-1, Math.min(10000, Math.floor(raw.index)));
      }
      if (typeof raw.text === 'string' && raw.text.length > 0) {
        out.text = raw.text.slice(0, 64);
      }
      if (typeof raw.ariaLabel === 'string' && raw.ariaLabel.length > 0) {
        out.ariaLabel = raw.ariaLabel.slice(0, 128);
      }
      return out;
    }
    case 'keydown':
    case 'keyup':
      return {
        type,
        key: typeof raw.key === 'string' ? raw.key.slice(0, 32) : '',
        code: typeof raw.code === 'string' ? raw.code.slice(0, 32) : '',
        ctrlKey: Boolean(raw.ctrlKey),
        shiftKey: Boolean(raw.shiftKey),
        altKey: Boolean(raw.altKey),
        metaKey: Boolean(raw.metaKey),
      };
    case 'input':
      return {
        type,
        value: typeof raw.value === 'string' ? raw.value.slice(0, 4096) : '',
      };
    case 'resize': {
      const dims = clampViewport(raw.width, raw.height, maxW, maxH);
      return {
        type,
        width: dims.width,
        height: dims.height,
        dpr: Math.max(1, Math.min(3, Number(raw.dpr) || 1)),
      };
    }
    case 'visibility':
      return {
        type,
        hidden: Boolean(raw.hidden),
      };
    case 'popstate':
      return {
        type,
        path: typeof raw.path === 'string' && raw.path.startsWith('/') && !raw.path.startsWith('//')
          ? raw.path.slice(0, 1024)
          : '/',
      };
    case 'keyframe-request':
      return { type };
    default:
      return null;
  }
}

function sanitizeControlMessage(msg) {
  if (!msg || typeof msg !== 'object' || !ALLOWED_CONTROL_TYPES.has(msg.type)) {
    return null;
  }
  switch (msg.type) {
    case 'cursor':
      return {
        type: 'cursor',
        cursor: ALLOWED_CURSORS.has(msg.cursor) ? msg.cursor : 'default',
      };
    case 'nav':
      if (typeof msg.path !== 'string' || !msg.path.startsWith('/') || msg.path.startsWith('//')) {
        return null;
      }
      return { type: 'nav', path: msg.path.slice(0, 1024), replace: Boolean(msg.replace) };
    case 'title':
      return { type: 'title', title: String(msg.title || '').slice(0, 200) };
    case 'scroll':
      return {
        type: 'scroll',
        scrollX: Math.max(0, Math.min(200000, Math.round(Number(msg.scrollX) || 0))),
        scrollY: Math.max(0, Math.min(200000, Math.round(Number(msg.scrollY) || 0))),
        scrollWidth: Math.max(1, Math.min(200000, Math.round(Number(msg.scrollWidth) || 1))),
        scrollHeight: Math.max(1, Math.min(200000, Math.round(Number(msg.scrollHeight) || 1))),
        clientWidth: Math.max(1, Math.min(10000, Math.round(Number(msg.clientWidth) || 1))),
        clientHeight: Math.max(1, Math.min(10000, Math.round(Number(msg.clientHeight) || 1))),
      };
    case 'console': {
      const level = ['log', 'info', 'warn', 'error', 'debug'].includes(msg.level) ? msg.level : 'log';
      const rawArgs = Array.isArray(msg.args) ? msg.args.slice(0, 12) : [];
      return {
        type: 'console',
        level,
        args: rawArgs.map((a) => String(a ?? '').slice(0, 1000)),
      };
    }
    case 'dom-sync':
      return {
        type: 'dom-sync',
        path: typeof msg.path === 'string' && msg.path.startsWith('/') && !msg.path.startsWith('//')
          ? msg.path.slice(0, 1024)
          : '/',
        title: typeof msg.title === 'string' ? msg.title.slice(0, 200) : '',
        html: typeof msg.html === 'string' ? msg.html.slice(0, 2 * 1024 * 1024) : '',
      };
    case 'dom-patch': {
      const rawChunks = Array.isArray(msg.chunks) ? msg.chunks.slice(0, 16) : [];
      const chunks = [];
      for (let i = 0; i < rawChunks.length; i++) {
        const c = rawChunks[i];
        if (!c || typeof c.vid !== 'string' || typeof c.html !== 'string') continue;
        const safeAttrs = {};
        if (c.attrs && typeof c.attrs === 'object' && !Array.isArray(c.attrs)) {
          for (const [k, v] of Object.entries(c.attrs)) {
            if (typeof k === 'string' && k.length <= 64 && typeof v === 'string' && v.length <= 4096) {
              safeAttrs[k] = v;
            }
          }
        }
        chunks.push({
          vid: c.vid.slice(0, 64),
          attrs: safeAttrs,
          html: c.html.slice(0, 512 * 1024),
        });
      }
      if (!chunks.length) return null;
      return {
        type: 'dom-patch',
        path: typeof msg.path === 'string' && msg.path.startsWith('/') && !msg.path.startsWith('//')
          ? msg.path.slice(0, 1024)
          : '/',
        title: typeof msg.title === 'string' ? msg.title.slice(0, 200) : '',
        chunks,
      };
    }
    case 'input-focus':
      return {
        type: 'input-focus',
        x: Math.max(0, Number(msg.x) || 0),
        y: Math.max(0, Number(msg.y) || 0),
        width: Math.max(20, Math.min(2000, Number(msg.width) || 160)),
        height: Math.max(16, Math.min(400, Number(msg.height) || 32)),
        value: String(msg.value || '').slice(0, 4096),
        inputType: msg.inputType === 'password' ? 'password' : 'text',
      };
    case 'input-blur':
      return { type: 'input-blur' };
    case 'clipboard':
      return { type: 'clipboard', text: String(msg.text || '').slice(0, 16384) };
    case 'ready':
      return {
        type: 'ready',
        transport: String(msg.transport || 'ws'),
        codec: String(msg.codec || 'rgba-deflate'),
        width: Number(msg.width) || 800,
        height: Number(msg.height) || 600,
      };
    case 'error':
      return { type: 'error', message: String(msg.message || 'Stream error').slice(0, 500) };
    default:
      return null;
  }
}

module.exports = {
  CODEC_IDS,
  CODEC_NAMES,
  FRAME_FLAGS,
  HEADER_SIZE,
  clampViewport,
  decodeFramePacket,
  encodeFramePacket,
  sanitizeControlMessage,
  validateInputEvent,
  validateSurfaceName,
};
