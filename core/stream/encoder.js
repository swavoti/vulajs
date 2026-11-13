'use strict';

const { spawn, execFileSync } = require('node:child_process');
const zlib = require('node:zlib');
const { encodeFramePacket } = require('./protocol.js');

// Compact 5x7 bitmap font (ASCII 32..126 subset + fallback) for zero-dep server UI rendering
const GLYPHS_5X7 = {
  ' ': [0x00, 0x00, 0x00, 0x00, 0x00],
  '!': [0x00, 0x00, 0x5f, 0x00, 0x00],
  '"': [0x00, 0x07, 0x00, 0x07, 0x00],
  '#': [0x14, 0x7f, 0x14, 0x7f, 0x14],
  '$': [0x24, 0x2a, 0x7f, 0x2a, 0x12],
  '%': [0x23, 0x13, 0x08, 0x64, 0x62],
  '&': [0x36, 0x49, 0x55, 0x22, 0x50],
  '\'': [0x00, 0x05, 0x03, 0x00, 0x00],
  '(': [0x00, 0x1c, 0x22, 0x41, 0x00],
  ')': [0x00, 0x41, 0x22, 0x1c, 0x00],
  '*': [0x14, 0x08, 0x3e, 0x08, 0x14],
  '+': [0x08, 0x08, 0x3e, 0x08, 0x08],
  ',': [0x00, 0x50, 0x30, 0x00, 0x00],
  '-': [0x08, 0x08, 0x08, 0x08, 0x08],
  '.': [0x00, 0x60, 0x60, 0x00, 0x00],
  '/': [0x20, 0x10, 0x08, 0x04, 0x02],
  '0': [0x3e, 0x51, 0x49, 0x45, 0x3e],
  '1': [0x00, 0x42, 0x7f, 0x40, 0x00],
  '2': [0x42, 0x61, 0x51, 0x49, 0x46],
  '3': [0x21, 0x41, 0x45, 0x4b, 0x31],
  '4': [0x18, 0x14, 0x12, 0x7f, 0x10],
  '5': [0x27, 0x45, 0x45, 0x45, 0x39],
  '6': [0x3c, 0x4a, 0x49, 0x49, 0x30],
  '7': [0x01, 0x71, 0x09, 0x05, 0x03],
  '8': [0x36, 0x49, 0x49, 0x49, 0x36],
  '9': [0x06, 0x49, 0x49, 0x29, 0x1e],
  ':': [0x00, 0x36, 0x36, 0x00, 0x00],
  ';': [0x00, 0x56, 0x36, 0x00, 0x00],
  '<': [0x08, 0x14, 0x22, 0x41, 0x00],
  '=': [0x14, 0x14, 0x14, 0x14, 0x14],
  '>': [0x00, 0x41, 0x22, 0x14, 0x08],
  '?': [0x02, 0x01, 0x51, 0x09, 0x06],
  '@': [0x32, 0x49, 0x79, 0x41, 0x3e],
  'A': [0x7e, 0x11, 0x11, 0x11, 0x7e],
  'B': [0x7f, 0x49, 0x49, 0x49, 0x36],
  'C': [0x3e, 0x41, 0x41, 0x41, 0x22],
  'D': [0x7f, 0x41, 0x41, 0x22, 0x1c],
  'E': [0x7f, 0x49, 0x49, 0x49, 0x41],
  'F': [0x7f, 0x09, 0x09, 0x09, 0x01],
  'G': [0x3e, 0x41, 0x49, 0x49, 0x7a],
  'H': [0x7f, 0x08, 0x08, 0x08, 0x7f],
  'I': [0x00, 0x41, 0x7f, 0x41, 0x00],
  'J': [0x20, 0x40, 0x41, 0x3f, 0x01],
  'K': [0x7f, 0x08, 0x14, 0x22, 0x41],
  'L': [0x7f, 0x40, 0x40, 0x40, 0x40],
  'M': [0x7f, 0x02, 0x0c, 0x02, 0x7f],
  'N': [0x7f, 0x04, 0x08, 0x10, 0x7f],
  'O': [0x3e, 0x41, 0x41, 0x41, 0x3e],
  'P': [0x7f, 0x09, 0x09, 0x09, 0x06],
  'Q': [0x3e, 0x41, 0x51, 0x21, 0x5e],
  'R': [0x7f, 0x09, 0x19, 0x29, 0x46],
  'S': [0x46, 0x49, 0x49, 0x49, 0x31],
  'T': [0x01, 0x01, 0x7f, 0x01, 0x01],
  'U': [0x3f, 0x40, 0x40, 0x40, 0x3f],
  'V': [0x1f, 0x20, 0x40, 0x20, 0x1f],
  'W': [0x3f, 0x40, 0x38, 0x40, 0x3f],
  'X': [0x63, 0x14, 0x08, 0x14, 0x63],
  'Y': [0x07, 0x08, 0x70, 0x08, 0x07],
  'Z': [0x61, 0x51, 0x49, 0x45, 0x43],
  '[': [0x00, 0x7f, 0x41, 0x41, 0x00],
  '\\': [0x02, 0x04, 0x08, 0x10, 0x20],
  ']': [0x00, 0x41, 0x41, 0x7f, 0x00],
  '_': [0x40, 0x40, 0x40, 0x40, 0x40],
  'a': [0x20, 0x54, 0x54, 0x54, 0x78],
  'b': [0x7f, 0x48, 0x44, 0x44, 0x38],
  'c': [0x38, 0x44, 0x44, 0x44, 0x20],
  'd': [0x38, 0x44, 0x44, 0x48, 0x7f],
  'e': [0x38, 0x54, 0x54, 0x54, 0x18],
  'f': [0x08, 0x7e, 0x09, 0x01, 0x02],
  'g': [0x0c, 0x52, 0x52, 0x52, 0x3e],
  'h': [0x7f, 0x08, 0x04, 0x04, 0x78],
  'i': [0x00, 0x44, 0x7d, 0x40, 0x00],
  'j': [0x20, 0x40, 0x44, 0x3d, 0x00],
  'k': [0x7f, 0x10, 0x28, 0x44, 0x00],
  'l': [0x00, 0x41, 0x7f, 0x40, 0x00],
  'm': [0x7c, 0x04, 0x18, 0x04, 0x78],
  'n': [0x7c, 0x08, 0x04, 0x04, 0x78],
  'o': [0x38, 0x44, 0x44, 0x44, 0x38],
  'p': [0x7c, 0x14, 0x14, 0x14, 0x08],
  'q': [0x08, 0x14, 0x14, 0x18, 0x7c],
  'r': [0x7c, 0x08, 0x04, 0x04, 0x08],
  's': [0x48, 0x54, 0x54, 0x54, 0x20],
  't': [0x04, 0x3f, 0x44, 0x40, 0x20],
  'u': [0x3c, 0x40, 0x40, 0x20, 0x7c],
  'v': [0x1c, 0x20, 0x40, 0x20, 0x1c],
  'w': [0x3c, 0x40, 0x30, 0x40, 0x3c],
  'x': [0x44, 0x28, 0x10, 0x28, 0x44],
  'y': [0x0c, 0x50, 0x50, 0x50, 0x3c],
  'z': [0x44, 0x64, 0x54, 0x4c, 0x44],
  '{': [0x00, 0x08, 0x36, 0x41, 0x00],
  '|': [0x00, 0x00, 0x7f, 0x00, 0x00],
  '}': [0x00, 0x41, 0x36, 0x08, 0x00],
};

function parseColor(color) {
  if (Array.isArray(color) && color.length >= 3) {
    return [color[0] & 255, color[1] & 255, color[2] & 255, color[3] === undefined ? 255 : color[3] & 255];
  }
  if (typeof color === 'string' && color.startsWith('#')) {
    const hex = color.slice(1);
    if (hex.length === 6 || hex.length === 8) {
      return [
        parseInt(hex.slice(0, 2), 16) || 0,
        parseInt(hex.slice(2, 4), 16) || 0,
        parseInt(hex.slice(4, 6), 16) || 0,
        hex.length === 8 ? parseInt(hex.slice(6, 8), 16) : 255,
      ];
    }
  }
  return [255, 255, 255, 255];
}

/**
 * Lightweight zero-dependency server-side RGBA surface buffer.
 * Lets server stream components draw UI directly on the server without shipping logic to clients.
 */
class SurfaceBuffer {
  constructor(width, height) {
    this.resize(width, height);
  }

  resize(width, height) {
    this.width = Math.max(2, Math.floor(width));
    this.height = Math.max(2, Math.floor(height));
    this.data = Buffer.alloc(this.width * this.height * 4);
  }

  clear(color = '#0a0a0a') {
    const [r, g, b, a] = parseColor(color);
    const buf = this.data;
    for (let i = 0; i < buf.length; i += 4) {
      buf[i] = r;
      buf[i + 1] = g;
      buf[i + 2] = b;
      buf[i + 3] = a;
    }
  }

  fillRect(x, y, w, h, color) {
    const [r, g, b, a] = parseColor(color);
    const x0 = Math.max(0, Math.floor(x));
    const y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(this.width, Math.floor(x + w));
    const y1 = Math.min(this.height, Math.floor(y + h));
    const buf = this.data;

    for (let py = y0; py < y1; py += 1) {
      let idx = (py * this.width + x0) * 4;
      for (let px = x0; px < x1; px += 1) {
        buf[idx] = r;
        buf[idx + 1] = g;
        buf[idx + 2] = b;
        buf[idx + 3] = a;
        idx += 4;
      }
    }
  }

  strokeRect(x, y, w, h, color, thickness = 1) {
    const t = Math.max(1, Math.floor(thickness));
    this.fillRect(x, y, w, t, color);
    this.fillRect(x, y + h - t, w, t, color);
    this.fillRect(x, y, t, h, color);
    this.fillRect(x + w - t, y, t, h, color);
  }

  drawText(text, x, y, color = '#ffffff', scale = 2) {
    const s = Math.max(1, Math.floor(scale));
    const str = String(text || '');
    let cursorX = Math.floor(x);
    const startY = Math.floor(y);

    for (let i = 0; i < str.length; i += 1) {
      const ch = str[i];
      if (ch === '\n') {
        cursorX = Math.floor(x);
        continue;
      }
      const glyph = GLYPHS_5X7[ch] || GLYPHS_5X7[' '];
      for (let col = 0; col < 5; col += 1) {
        const bits = glyph[col];
        for (let row = 0; row < 7; row += 1) {
          if (bits & (1 << row)) {
            this.fillRect(cursorX + col * s, startY + row * s, s, s, color);
          }
        }
      }
      cursorX += 6 * s;
    }
  }
}

let cachedFfmpegAvailable = null;

function isFfmpegAvailable() {
  if (cachedFfmpegAvailable !== null) return cachedFfmpegAvailable;
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore', timeout: 1500 });
    cachedFfmpegAvailable = true;
  } catch {
    cachedFfmpegAvailable = false;
  }
  return cachedFfmpegAvailable;
}

/**
 * Creates a frame encoder.
 * Uses ffmpeg for real-time WebCodecs VP8/VP9/H.264/AV1 when available,
 * and falls back cleanly to built-in zlib-deflated RGBA packets so zero-dep mode always works.
 */
function createFrameEncoder({
  codec = 'vp8',
  width = 800,
  height = 600,
  fps = 30,
  preferNativeFallback = false,
  onPacket,
  onError,
}) {
  let seq = 0;
  let currentWidth = width;
  let currentHeight = height;
  let closed = false;
  let ffmpegProc = null;
  let ivfBuffer = Buffer.alloc(0);
  let ivfHeaderParsed = false;

  const canUseFfmpeg =
    !preferNativeFallback &&
    ['vp8', 'vp9', 'av1'].includes(codec) &&
    isFfmpegAvailable();

  const activeCodec = canUseFfmpeg ? codec : 'rgba-deflate';

  function startFfmpeg() {
    if (!canUseFfmpeg || closed) return;
    stopFfmpeg();
    ivfBuffer = Buffer.alloc(0);
    ivfHeaderParsed = false;

    const vcodec = codec === 'vp9' ? 'libvpx-vp9' : codec === 'av1' ? 'libaom-av1' : 'libvpx';
    const args = [
      '-hide_banner',
      '-loglevel', 'error',
      '-f', 'rawvideo',
      '-pix_fmt', 'rgba',
      '-s', `${currentWidth}x${currentHeight}`,
      '-r', String(fps),
      '-i', 'pipe:0',
      '-c:v', vcodec,
      '-deadline', 'realtime',
      '-cpu-used', '8',
      '-lag-in-frames', '0',
      '-error-resilient', '1',
      '-f', 'ivf',
      'pipe:1',
    ];

    ffmpegProc = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    ffmpegProc.stdout.on('data', (chunk) => {
      ivfBuffer = Buffer.concat([ivfBuffer, chunk]);
      drainIvfFrames();
    });
    ffmpegProc.stderr.on('data', (err) => {
      if (onError) onError(new Error(err.toString('utf8').trim()));
    });
    ffmpegProc.on('error', (err) => {
      if (onError) onError(err);
    });
  }

  function drainIvfFrames() {
    if (!ivfHeaderParsed) {
      if (ivfBuffer.length < 32) return;
      ivfBuffer = ivfBuffer.subarray(32);
      ivfHeaderParsed = true;
    }
    while (ivfBuffer.length >= 12) {
      const frameSize = ivfBuffer.readUInt32LE(0);
      if (ivfBuffer.length < 12 + frameSize) break;
      const frameBytes = ivfBuffer.subarray(12, 12 + frameSize);
      ivfBuffer = ivfBuffer.subarray(12 + frameSize);

      // For VP8, bit 0 of byte 0 == 0 indicates keyframe
      const isKey = codec === 'vp8' ? (frameBytes[0] & 0x01) === 0 : seq === 0;
      const packet = encodeFramePacket({
        codec: activeCodec,
        keyframe: isKey,
        width: currentWidth,
        height: currentHeight,
        seq: seq++,
        timestampUs: Date.now() * 1000,
        payload: frameBytes,
      });
      if (onPacket) onPacket(packet);
    }
  }

  function stopFfmpeg() {
    if (ffmpegProc) {
      try { ffmpegProc.stdin.end(); } catch (_) {}
      try { ffmpegProc.kill('SIGKILL'); } catch (_) {}
      ffmpegProc = null;
    }
  }

  if (canUseFfmpeg) {
    startFfmpeg();
  }

  return {
    codec: activeCodec,
    encode(rgbaBuffer, { keyframe = false } = {}) {
      if (closed) return;
      if (canUseFfmpeg && ffmpegProc && !ffmpegProc.killed) {
        ffmpegProc.stdin.write(rgbaBuffer);
        return;
      }
      const compressed = zlib.deflateSync(rgbaBuffer, { level: 1 });
      const packet = encodeFramePacket({
        codec: 'rgba-deflate',
        keyframe: keyframe || seq === 0,
        width: currentWidth,
        height: currentHeight,
        seq: seq++,
        timestampUs: Date.now() * 1000,
        payload: compressed,
      });
      if (onPacket) onPacket(packet);
    },
    resize(nextWidth, nextHeight) {
      currentWidth = nextWidth;
      currentHeight = nextHeight;
      if (canUseFfmpeg) {
        startFfmpeg();
      }
    },
    close() {
      closed = true;
      stopFfmpeg();
    },
  };
}

module.exports = {
  SurfaceBuffer,
  createFrameEncoder,
  isFfmpegAvailable,
};
