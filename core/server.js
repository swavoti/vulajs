const express = require('express');
const path = require('path');
const fs = require('fs');

try { require('dotenv').config(); } catch (_) {}

/**
 * Starts the Vula.js development server.
 * Registers API routes, server components, and user middleware from the manifest,
 * then serves the frontend via Rspack dev middleware or static dist/.
 */
async function startServer(port = 3000) {
  const app = express();
  app.use(express.json());

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

  // Load manifest
  const manifestPath = path.join(process.cwd(), '.vula-routes.json');
  if (!fs.existsSync(manifestPath)) {
    console.error('[vula] No .vula-routes.json found. Run `vula dev` or `vula build` first.');
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

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
        handler = require(route.handlerPath);
      } catch (err) {
        console.error(`[vula] Failed to load API handler ${route.path}:`, err.message);
        return;
      }

      ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'].forEach(method => {
        if (typeof handler[method] === 'function') {
          app[method.toLowerCase()](route.path, async (req, res) => {
            try {
              await handler[method](req, res);
            } catch (err) {
              console.error(`[vula] ${method} ${route.path} error:`, err);
              if (!res.headersSent) {
                res.status(500).json({ error: 'Internal Server Error' });
              }
            }
          });
          console.log(`  ${method} ${route.path}`);
        }
      });
    });
  }

  // Server component bridge endpoint
  app.post('/_vula/server-component', async (req, res) => {
    const { name, args } = req.body;
    if (!manifest.serverComponents || !manifest.serverComponents.length) {
      return res.status(404).json({ error: 'No server components registered' });
    }
    const comp = manifest.serverComponents.find(c => c.name === name);
    if (!comp) {
      return res.status(404).json({ error: `Server component "${name}" not found` });
    }

    try {
      const handler = require(comp.path);
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

  // Static public assets
  const publicDir = path.join(process.cwd(), 'public');
  if (fs.existsSync(publicDir)) {
    app.use(express.static(publicDir));
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
          if (err) return next(err);
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

module.exports = { startServer };
