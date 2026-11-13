const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_VIDEO_BYTES = 256 * 1024 * 1024; // 256 MiB cap for in-memory WASM transcoding
const inFlightTranscodes = new Map();

/**
 * Resolves a request path inside publicDir, rejecting directory traversal,
 * null bytes, and symlinks escaping publicDir.
 */
function resolveSafePublicPath(publicDir, reqPath) {
  if (typeof reqPath !== 'string' || !reqPath) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(reqPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;

  const root = path.resolve(publicDir);
  const relativePath = decoded.replace(/^\/+/, '');
  const resolved = path.resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    return null;
  }

  try {
    if (!fs.existsSync(resolved)) return null;
    const stat = fs.lstatSync(resolved);
    if (stat.isDirectory()) return null;
    const realRoot = fs.realpathSync(root);
    const realTarget = fs.realpathSync(resolved);
    if (!realTarget.startsWith(realRoot + path.sep)) {
      return null;
    }
    return { realTarget, size: stat.size, relPath: path.relative(realRoot, realTarget) };
  } catch {
    return null;
  }
}

/**
 * Express Middleware to automatically chunk requested videos into HLS.
 * Usage: app.use('/videos', videoOptimizerMiddleware)
 */
function videoOptimizerMiddleware(req, res, next) {
  // Only process standard video files
  if (!req.path.match(/\.(mp4|mkv|webm|avi)$/i)) {
    return next();
  }

  const publicDir = path.join(process.cwd(), 'public');
  const resolved = resolveSafePublicPath(publicDir, req.path);

  if (!resolved) {
    if (req.path.includes('..') || req.path.includes('\0') || req.path.toLowerCase().includes('%2e%2e')) {
      return res.status(400).send('Invalid video path');
    }
    return next();
  }

  if (resolved.size > MAX_VIDEO_BYTES) {
    return next();
  }

  // Hash the relative path so different directories never collide and cache keys are always safe
  const cacheKey = crypto.createHash('sha256').update(resolved.relPath).digest('hex').slice(0, 16);
  const safeBaseName = path.basename(resolved.realTarget, path.extname(resolved.realTarget))
    .replace(/[^a-zA-Z0-9_-]/g, '_') || 'video';
  const cacheSubdir = `${safeBaseName}-${cacheKey}`;
  const cacheDir = path.join(process.cwd(), '.vula-cache', 'hls', cacheSubdir);

  let task = inFlightTranscodes.get(cacheDir);
  if (!task) {
    const { optimizeVideo } = require('./optimizer');
    task = optimizeVideo(resolved.realTarget, cacheDir, 'stream').finally(() => {
      inFlightTranscodes.delete(cacheDir);
    });
    inFlightTranscodes.set(cacheDir, task);
  }

  task
    .then(() => {
      const hlsUrl = `/hls/${encodeURIComponent(cacheSubdir)}/stream.m3u8`;
      res.redirect(302, hlsUrl);
    })
    .catch((err) => {
      console.error('[vula-video-opti] Failed to optimize video:', err);
      // Fallback to serving the original file if ffmpeg fails
      next();
    });
}

/**
 * Helper middleware to serve the generated HLS cache directory statically
 */
function serveVideoCacheMiddleware() {
  const express = require('express');
  const cachePath = path.join(process.cwd(), '.vula-cache');
  return express.static(cachePath, { dotfiles: 'deny', index: false });
}

module.exports = {
  videoOptimizerMiddleware,
  serveVideoCacheMiddleware,
  resolveSafePublicPath,
  MAX_VIDEO_BYTES,
};
