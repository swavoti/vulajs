const fs = require('fs');
const path = require('path');

const MAX_IMAGE_WIDTH = 4096;
const ALLOWED_FORMATS = new Set(['png', 'jpeg', 'jpg', 'webp', 'avif']);

/**
 * Resolves a request path inside publicDir, rejecting directory traversal,
 * null bytes, and symlinks pointing outside publicDir.
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
    return realTarget;
  } catch {
    return null;
  }
}

/**
 * Express Middleware to optimize images on the fly via sharp.
 * Usage: app.use(imageOptimizerMiddleware)
 * Supports query params like ?w=300&format=webp
 */
function imageOptimizerMiddleware(req, res, next) {
  if (!req.path.match(/\.(png|jpg|jpeg|webp)$/i)) {
    return next();
  }

  const publicDir = path.join(process.cwd(), 'public');
  const inputPath = resolveSafePublicPath(publicDir, req.path);

  if (!inputPath) {
    // Reject explicit traversal attempts; otherwise let downstream 404 handle missing files
    if (req.path.includes('..') || req.path.includes('\0') || req.path.toLowerCase().includes('%2e%2e')) {
      return res.status(400).send('Invalid image path');
    }
    return next();
  }

  const { w, format } = req.query;

  // If no params, just serve normally
  if (w === undefined && format === undefined) {
    return next();
  }

  let width = null;
  if (w !== undefined) {
    const rawW = String(w).trim();
    if (!/^\d+$/.test(rawW)) {
      return res.status(400).send('Invalid width parameter');
    }
    width = parseInt(rawW, 10);
    if (!Number.isSafeInteger(width) || width < 1 || width > MAX_IMAGE_WIDTH) {
      return res.status(400).send(`Width must be between 1 and ${MAX_IMAGE_WIDTH}`);
    }
  }

  let outFormat = format !== undefined
    ? String(format).trim().toLowerCase()
    : path.extname(inputPath).substring(1).toLowerCase();

  if (!ALLOWED_FORMATS.has(outFormat)) {
    return res.status(400).send('Unsupported image format');
  }
  if (outFormat === 'jpg') outFormat = 'jpeg';

  const sharp = require('sharp');
  let transform = sharp(inputPath);
  if (width) transform = transform.resize(width);
  transform = transform.toFormat(outFormat);

  transform.on('error', (err) => {
    console.error('[vula-image-opti] Image processing error:', err.message);
    if (!res.headersSent) {
      res.status(500).send('Image optimization failed');
    } else if (!res.writableEnded) {
      res.end();
    }
  });

  res.type(`image/${outFormat}`);
  transform.pipe(res);
}

module.exports = { imageOptimizerMiddleware, resolveSafePublicPath, MAX_IMAGE_WIDTH, ALLOWED_FORMATS };
