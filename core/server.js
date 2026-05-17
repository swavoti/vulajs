const express = require('express');
const path = require('path');
const fs = require('fs');

try { require('dotenv').config(); } catch (_) { }

let nativeMatcher = null;
try {
  // 1. Try local dev binary first
  nativeMatcher = require('./native-router/vula_router.node');
} catch (e) {
  // 2. Try pre-compiled platform-specific binary based on OS/Arch
  const platform = process.platform;
  const arch = process.arch;
  try {
    if (platform === 'linux' && arch === 'x64') {
      nativeMatcher = require('./native-router/vula_router.linux-x64.node');
    } else if (platform === 'darwin' && arch === 'arm64') {
      nativeMatcher = require('./native-router/vula_router.darwin-arm64.node');
    } else if (platform === 'darwin' && arch === 'x64') {
      nativeMatcher = require('./native-router/vula_router.darwin-x64.node');
    } else if (platform === 'win32' && arch === 'x64') {
      nativeMatcher = require('./native-router/vula_router.win32-x64.node');
    }
  } catch (err) {
    // Graceful fallback silent warning
  }
}

if (nativeMatcher) {
  console.log('[vula] Native Rust route matching engine loaded successfully!');
}

/**
 * High-performance route matching helper.
 * Leverages native compiled Rust code, falling back to clean JS segments matching.
 */
function matchRoute(routePath, activePath) {
  if (nativeMatcher && typeof nativeMatcher.matchRoute === 'function') {
    return nativeMatcher.matchRoute(routePath, activePath);
  }

  // Pure JavaScript Fallback
  const cleanRoute = routePath.endsWith('/') && routePath !== '/' ? routePath.slice(0, -1) : routePath;
  const cleanActive = activePath.endsWith('/') && activePath !== '/' ? activePath.slice(0, -1) : activePath;

  const routeSegments = cleanRoute.split('/');
  const activeSegments = cleanActive.split('/');

  if (routeSegments.length !== activeSegments.length) {
    return null;
  }

  const params = {};
  for (let i = 0; i < routeSegments.length; i++) {
    const routeSeg = routeSegments[i];
    const activeSeg = activeSegments[i];

    if (routeSeg === activeSeg) {
      continue;
    }

    if (routeSeg.startsWith('[') && routeSeg.endsWith(']')) {
      const paramName = routeSeg.slice(1, -1);
      params[paramName] = decodeURIComponent(activeSeg);
    } else {
      return null;
    }
  }
  return params;
}


/**
 * Starts the Vula.js development server.
 * Registers API routes, server components, and user middleware from the manifest,
 * then serves the frontend via Rspack dev middleware or static dist/.
 */
async function startServer(port = 3000) {
  const app = express();
  app.use(express.json());

  // Default production security headers
  app.use((req, res, next) => {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.removeHeader('X-Powered-By');
    next();
  });

  // Inject SEO base tags into HTML responses
  app.use((req, res, next) => {
    const originalSend = res.send.bind(res);
    res.send = function (body) {
      if (typeof body === 'string' && body.includes('</head>')) {
        const seoTags = `
    <meta name="generator" content="vula-1.0.2" />
    <meta property="og:type" content="website" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />`;
        body = body.replace('</head>', seoTags + '\n</head>');
      }
      return originalSend(body);
    };
    next();
  });

  // Load manifest & registry
  const manifestPath = path.join(process.cwd(), '.vula-routes.json');
  const registryPath = path.join(process.cwd(), '.vula-registry.js');

  if (!fs.existsSync(manifestPath) || !fs.existsSync(registryPath)) {
    console.error('[vula] No .vula-routes.json or .vula-registry.js found. Run `vula dev` or `vula build` first.');
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const registry = require(registryPath);

  // User middleware
  if (manifest.middleware) {
    try {
      const mw = require(manifest.middleware);
      app.use(mw.default || mw);
    } catch (err) {
      console.error('[vula] Failed to load middleware:', err.message);
    }
  }

  // Register API routes
  if (manifest.apiRoutes && manifest.apiRoutes.length) {
    manifest.apiRoutes.forEach(route => {
      let handler;
      try {
        const loader = registry.apiRoutes[route.path];
        if (!loader) {
          throw new Error(`Path ${route.path} missing from registry`);
        }
        handler = loader();
      } catch (err) {
        console.error(`[vula] Failed to load API handler ${route.path}:`, err.message);
        return;
      }

      // Convert dynamic file segments "/api/users/[id]" -> Express style "/api/users/:id"
      const expressPath = route.path.replace(/\[([^\]]+)\]/g, ':$1');

      ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].forEach(method => {
        if (typeof handler[method] === 'function') {
          app[method.toLowerCase()](expressPath, async (req, res) => {
            try {
              await handler[method](req, res);
            } catch (err) {
              console.error(`[vula] ${method} ${route.path} error:`, err);
              if (!res.headersSent) {
                const isProd = process.env.NODE_ENV === 'production';
                res.status(500).json({ error: isProd ? 'Internal Server Error' : err.message });
              }
            }
          });
          console.log(`  ${method} ${expressPath}`);
        }
      });
    });
  }

  // Server component bridge endpoint
  app.post('/_vula/server-component', async (req, res) => {
    const { name, args } = req.body;
    const loader = registry.serverComponents[name];
    if (!loader) {
      return res.status(404).json({ error: `Server component "${name}" not found` });
    }

    try {
      const handler = loader();
      const fn = handler.default || handler;
      const result = await fn(...(args || []));
      res.json({ result });
    } catch (err) {
      console.error(`[vula] Server component "${name}" error:`, err);
      res.status(500).json({ error: 'Server component execution failed' });
    }
  });

  // Serve service worker
  const swPath = path.join(process.cwd(), 'public', 'vula-sw.js');
  if (fs.existsSync(swPath)) {
    app.get('/vula-sw.js', (req, res) => {
      res.sendFile(swPath);
    });
  }

  // Static public assets (ignoring index.html to allow Rspack/Router to handle it)
  const publicDir = path.join(process.cwd(), 'public');
  if (fs.existsSync(publicDir)) {
    app.use(express.static(publicDir, { index: false }));
  }

  // Frontend serving
  if (process.env.NODE_ENV === 'production') {
    const distDir = path.join(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  } else {
    try {
      const { rspack } = require('@rspack/core');
      const devMiddleware = require('webpack-dev-middleware');
      const config = require(path.join(process.cwd(), 'rspack.config.js'));
      const compiler = rspack(config);

      app.use(devMiddleware(compiler, {
        publicPath: (config.output && config.output.publicPath) || '/',
      }));

      app.get('*', (req, res, next) => {
        const filename = path.join(compiler.outputPath, 'index.html');
        compiler.outputFileSystem.readFile(filename, (err, result) => {
          if (err) {
            console.error(`[vula] Error reading ${filename} from memory:`, err.message);
            return next(); // Fall through to 404 or fallback
          }
          res.set('content-type', 'text/html');
          res.send(result);
        });
      });
    } catch (err) {
      console.error('[vula] Could not start dev middleware:', err.message);
      console.error('[vula] Falling back to static dist/ serving.');
      const distDir = path.join(process.cwd(), 'dist');
      if (fs.existsSync(distDir)) {
        app.use(express.static(distDir));
        app.get('*', (req, res) => {
          res.sendFile(path.join(distDir, 'index.html'));
        });
      }
    }
  }

  app.listen(port, () => {
    console.log(`[vula] Server running at http://localhost:${port}`);
  });
}

module.exports = { startServer, matchRoute };
