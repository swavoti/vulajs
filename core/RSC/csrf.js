function normalizeOrigin(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (!parsed.origin || parsed.origin === 'null') return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function getRequestExpectedOrigin(req) {
  const host = typeof req?.get === 'function' ? req.get('host') : req?.headers?.host;
  if (typeof host !== 'string' || !host || /[\s/\\@?#]/.test(host)) return null;
  const protocol = req.protocol === 'https' || req.protocol === 'http'
    ? req.protocol
    : (req.socket?.encrypted ? 'https' : 'http');
  return normalizeOrigin(`${protocol}://${host}`);
}

function verifyOrigin(req, allowedOrigins = []) {
  const rawOrigin = req?.headers?.origin || req?.headers?.referer;
  if (!rawOrigin) return false;

  const requestOrigin = normalizeOrigin(rawOrigin);
  if (!requestOrigin) return false;

  const normalizedAllowed = (Array.isArray(allowedOrigins) ? allowedOrigins : [])
    .map(normalizeOrigin)
    .filter(Boolean);

  const secFetchSite = req?.headers?.['sec-fetch-site'];
  if (secFetchSite === 'cross-site' && !normalizedAllowed.includes(requestOrigin)) {
    return false;
  }

  if (normalizedAllowed.includes(requestOrigin)) {
    return true;
  }

  const expectedOrigin = getRequestExpectedOrigin(req);
  if (expectedOrigin !== null && requestOrigin === expectedOrigin) {
    return true;
  }

  return false;
}

function csrfProtection(allowedOrigins = []) {
  return function(req, res, next) {
    if (req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE' || req.method === 'PATCH') {
      if (!verifyOrigin(req, allowedOrigins)) {
        return res.status(403).json({ error: 'CSRF token mismatch or invalid origin' });
      }
    }
    next();
  };
}

module.exports = { verifyOrigin, csrfProtection, normalizeOrigin, getRequestExpectedOrigin };
