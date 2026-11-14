const assert = require('node:assert/strict');
const http = require('node:http');
const { PassThrough } = require('node:stream');
const { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { csrfProtection, verifyOrigin } = require('./RSC/csrf.js');
const {
  buildCspHeader,
  buildDevWsScript,
  createApp,
  createSecurityMiddleware,
  createServerComponentHandler,
  injectHeadTags,
  sanitizeIconPath,
  sanitizeRpcValue,
  serveSwvulaAssets,
  streamReactSsrResponse,
} = require('./server.js');
const { loadConfig } = require('./config.js');
const {
  imageOptimizerMiddleware,
  resolveSafePublicPath: resolveSafeImagePath,
} = require('../types/vula/image-opti/index.js');
const {
  videoOptimizerMiddleware,
  resolveSafePublicPath: resolveSafeVideoPath,
} = require('../types/vula/video-opti/index.js');

function enhanceResponse(res) {
  res.locals = {};
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.set = (headers, val) => {
    if (typeof headers === 'string') {
      res.setHeader(headers, val);
    } else {
      for (const [k, v] of Object.entries(headers)) {
        res.setHeader(k, v);
      }
    }
    return res;
  };
  res.json = (obj) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(obj));
  };
  res.send = (body) => {
    res.end(body);
  };
  res.sendFile = (filePath) => {
    const fs = require('node:fs');
    res.end(fs.readFileSync(filePath));
  };
  return res;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const ct = String(req.headers['content-type'] || '').toLowerCase();
      if (ct.includes('application/json')) {
        try {
          resolve(JSON.parse(raw));
        } catch (err) {
          reject(err);
        }
      } else {
        resolve(raw);
      }
    });
  });
}

test('verifyOrigin enforces strict same-origin by default and exact origin matching', () => {
  assert.equal(
    verifyOrigin({ headers: { origin: 'http://localhost:3000', host: 'localhost:3000' }, protocol: 'http' }, []),
    true
  );
  assert.equal(
    verifyOrigin({ headers: { origin: 'https://evil.com', host: 'localhost:3000' }, protocol: 'http' }, []),
    false
  );
  assert.equal(
    verifyOrigin({ headers: { host: 'localhost:3000' }, protocol: 'http' }, []),
    false
  );
  assert.equal(
    verifyOrigin({ headers: { origin: 'null', host: 'localhost:3000' }, protocol: 'http' }, []),
    false
  );

  // Prefix-spoofing attack must fail
  assert.equal(
    verifyOrigin(
      { headers: { origin: 'https://trusted.com.evil.com', host: 'api.trusted.com' }, protocol: 'https' },
      ['https://trusted.com']
    ),
    false
  );
  assert.equal(
    verifyOrigin(
      { headers: { origin: 'https://trusted.com', host: 'api.trusted.com' }, protocol: 'https' },
      ['https://trusted.com']
    ),
    true
  );
  assert.equal(
    verifyOrigin(
      { headers: { origin: 'https://other.com', host: 'api.trusted.com', 'sec-fetch-site': 'cross-site' }, protocol: 'https' },
      ['https://trusted.com']
    ),
    false
  );
});

test('sanitizeIconPath, buildCspHeader, and injectHeadTags prevent injection and enforce nonces', () => {
  assert.equal(sanitizeIconPath('javascript:alert(1)'), null);
  assert.equal(sanitizeIconPath('//evil.com/icon.png'), null);
  assert.equal(sanitizeIconPath('../secret.png'), null);
  assert.equal(sanitizeIconPath('assets/vula.jpeg'), '/assets/vula.jpeg');

  const prodCsp = buildCspHeader(true, 'abc123', false);
  assert.ok(prodCsp.includes("script-src 'self' 'nonce-abc123'"));
  assert.ok(!prodCsp.includes("'unsafe-eval'"));
  assert.ok(prodCsp.includes("object-src 'none'"));

  const devCsp = buildCspHeader(true, 'abc123', true);
  assert.ok(devCsp.includes("'unsafe-eval'"));
  assert.ok(devCsp.includes('ws: wss:'));

  const cfgDir = mkdtempSync(path.join(tmpdir(), 'vula-cfg-'));
  const config = loadConfig(cfgDir);
  rmSync(cfgDir, { recursive: true, force: true });

  config.app.name = 'My "App" <script>';
  config.app.icon = 'assets/icon" onclick="alert(1).png';
  const html = injectHeadTags('<!DOCTYPE html><html><head><title>x</title></head><body></body></html>', config, '2.0.5');
  assert.ok(!html.includes('onclick="alert(1)'));
  assert.ok(html.includes('onclick=&quot;alert(1)'));
  assert.ok(html.includes('My &quot;App&quot; &lt;script&gt;'));
});

test('sanitizeRpcValue strips prototype pollution keys', () => {
  const payload = JSON.parse('{"__proto__":{"polluted":true},"nested":{"constructor":{"x":1},"ok":42}}');
  const cleaned = sanitizeRpcValue([payload]);
  assert.equal(Object.prototype.hasOwnProperty.call(cleaned[0], '__proto__'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(cleaned[0].nested, 'constructor'), false);
  assert.equal(cleaned[0].nested.ok, 42);
  assert.equal(({}).polluted, undefined);
});

test('imageOptimizerMiddleware and videoOptimizerMiddleware block path traversal, symlinks, and oversized inputs', (t) => {
  const workDir = mkdtempSync(path.join(tmpdir(), 'vula-media-'));
  const origCwd = process.cwd();
  t.after(() => {
    process.chdir(origCwd);
    rmSync(workDir, { recursive: true, force: true });
  });

  mkdirSync(path.join(workDir, 'public', 'images'), { recursive: true });
  writeFileSync(path.join(workDir, 'public', 'images', 'ok.png'), 'not-a-real-png');
  writeFileSync(path.join(workDir, 'secret.png'), 'secret');
  symlinkSync(path.join(workDir, 'secret.png'), path.join(workDir, 'public', 'images', 'link.png'));
  process.chdir(workDir);

  assert.equal(resolveSafeImagePath(path.join(workDir, 'public'), '/../secret.png'), null);
  assert.equal(resolveSafeImagePath(path.join(workDir, 'public'), '/..%2fsecret.png'), null);
  assert.equal(resolveSafeImagePath(path.join(workDir, 'public'), '/images/link.png'), null);
  assert.ok(resolveSafeImagePath(path.join(workDir, 'public'), '/images/ok.png'));

  assert.equal(resolveSafeVideoPath(path.join(workDir, 'public'), '/../secret.mp4'), null);
  assert.equal(resolveSafeVideoPath(path.join(workDir, 'public'), '/..%2fsecret.mp4'), null);

  function runMiddleware(mw, req) {
    let statusCode = 200;
    let body = null;
    let nextCalled = false;
    const res = {
      status(code) { statusCode = code; return this; },
      send(b) { body = b; return this; },
      type() { return this; },
      headersSent: false,
      writableEnded: false,
    };
    mw(req, res, () => { nextCalled = true; });
    return { statusCode, body, nextCalled };
  }

  assert.equal(runMiddleware(imageOptimizerMiddleware, { path: '/../secret.png', query: { w: '100' } }).statusCode, 400);
  assert.equal(runMiddleware(imageOptimizerMiddleware, { path: '/images/ok.png', query: { w: '9999999' } }).statusCode, 400);
  assert.equal(runMiddleware(imageOptimizerMiddleware, { path: '/images/ok.png', query: { w: '100abc' } }).statusCode, 400);
  assert.equal(runMiddleware(imageOptimizerMiddleware, { path: '/images/ok.png', query: { format: 'svg' } }).statusCode, 400);
  assert.equal(runMiddleware(videoOptimizerMiddleware, { path: '/..%2fsecret.mp4' }).statusCode, 400);
});

test('serveSwvulaAssets allows only explicit .vula.cache dotfiles and denies arbitrary dotfiles', () => {
  const workDir = mkdtempSync(path.join(tmpdir(), 'vula-swvula-'));
  try {
    writeFileSync(path.join(workDir, '.vula.cache.js'), 'console.log("cache");');
    writeFileSync(path.join(workDir, '.env'), 'SECRET=123');

    let denyCalls = 0;
    const fakeExpress = {
      static(dir, opts) {
        assert.equal(opts.dotfiles, 'deny');
        return (req, res) => {
          denyCalls += 1;
          res.statusCode = 404;
          res.end('denied');
        };
      },
    };

    const mw = serveSwvulaAssets(workDir, false, fakeExpress);

    let jsOut = '';
    let jsOpts = null;
    mw(
      { path: '/.vula.cache.js' },
      { sendFile(p, opts) { jsOut = p; jsOpts = opts; } },
      () => {}
    );
    assert.equal(jsOut, path.join(workDir, '.vula.cache.js'));
    assert.deepEqual(jsOpts, { dotfiles: 'allow' });

    let envStatus = 0;
    mw(
      { path: '/.env' },
      { end() {}, statusCode: 0, set status(v) {}, get status() { return envStatus; } },
      () => {}
    );
    assert.equal(denyCalls, 1);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('serveSwvulaAssets serves .vula.cache dotfiles over real Express HTTP', async (t) => {
  const express = require('express');
  const workDir = mkdtempSync(path.join(tmpdir(), 'vula-swvula-http-'));
  t.after(() => rmSync(workDir, { recursive: true, force: true }));

  writeFileSync(path.join(workDir, '.vula.cache.js'), 'console.log("ok");');
  writeFileSync(path.join(workDir, '.env'), 'SECRET=1');

  const app = express();
  app.use(serveSwvulaAssets(workDir, false, express));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const { port } = server.address();
  const okRes = await fetch(`http://127.0.0.1:${port}/.vula.cache.js`);
  assert.equal(okRes.status, 200);
  assert.equal(await okRes.text(), 'console.log("ok");');

  const envRes = await fetch(`http://127.0.0.1:${port}/.env`);
  assert.equal(envRes.status, 404);
});

test('HTTP security middleware, CSRF, Server Component RPC auth, and SSR stream ordering over real sockets', async (t) => {
  const workDir = mkdtempSync(path.join(tmpdir(), 'vula-http-'));
  t.after(() => rmSync(workDir, { recursive: true, force: true }));

  const privateCompPath = path.join(workDir, 'private.sever.comp.js');
  writeFileSync(privateCompPath, 'module.exports = async function secret() { return { secret: true }; };');

  const guardedCompPath = path.join(workDir, 'guarded.sever.comp.js');
  writeFileSync(guardedCompPath, `
    module.exports.authorize = async (req) => req.headers['x-admin'] === 'yes';
    module.exports.default = async function guarded(x) { return x * 2; };
  `);

  const publicCompPath = path.join(workDir, 'pub.sever.comp.js');
  writeFileSync(publicCompPath, `
    module.exports.isPublic = true;
    module.exports.default = async function pub(obj) {
      return { hasProtoProp: Object.prototype.hasOwnProperty.call(obj, '__proto__'), v: obj.v };
    };
  `);

  const config = loadConfig(workDir);
  const manifest = {
    serverComponents: [
      { name: 'api/private', path: privateCompPath },
      { name: 'api/guarded', path: guardedCompPath },
      { name: 'api/pub', path: publicCompPath },
    ],
  };

  const securityMw = createSecurityMiddleware({ config, isDev: false, vulaVersion: '2.0.5' });
  const csrfMw = csrfProtection(config.security['allowed-origins']);
  const rpcHandler = createServerComponentHandler({ manifest, config });

  // Fake React renderToPipeableStream that faithfully simulates async shell + delayed Suspense + bootstrap script
  function fakeRenderToPipeableStream(element, opts) {
    const pass = new PassThrough();
    let aborted = false;
    setImmediate(() => {
      if (aborted) return;
      if (element.shouldFailShell) {
        opts.onShellError(new Error('shell boom'));
        return;
      }
      opts.onShellReady();
      pass.write('<main>Hello Vula</main>');
      setTimeout(() => {
        if (aborted) return;
        pass.write(`<script src="${opts.bootstrapScripts[0]}" nonce="${opts.nonce}" async=""></script>`);
        pass.end();
      }, 15);
    });
    return {
      pipe(dest) { pass.pipe(dest); },
      abort() { aborted = true; pass.destroy(); },
    };
  }

  const server = http.createServer(async (req, res) => {
    enhanceResponse(res);
    req.protocol = 'http';
    await new Promise((resolve) => securityMw(req, res, resolve));
    if (res.writableEnded) return;

    if (req.url === '/_vula/server-component' && req.method === 'POST') {
      let csrfBlocked = false;
      csrfMw(req, res, () => { csrfBlocked = false; });
      if (res.writableEnded) return;
      try {
        req.body = await readJsonBody(req);
      } catch {
        return res.status(400).json({ error: 'Invalid JSON' });
      }
      if (req.headers['x-fake-user']) {
        req.user = { id: req.headers['x-fake-user'] };
      }
      await rpcHandler(req, res);
      return;
    }

    if (req.url === '/' || req.url === '/broken') {
      const htmlHead = injectHeadTags(
        '<!DOCTYPE html><html><head><title>Test</title></head><body><div id="root" data-vula-route-index="0">',
        config,
        '2.0.5'
      );
      const htmlTail = '</div></body></html>';
      streamReactSsrResponse({
        res,
        renderToPipeableStream: fakeRenderToPipeableStream,
        element: { shouldFailShell: req.url === '/broken' },
        nonce: res.locals.cspNonce,
        htmlHead,
        htmlTail,
      });
      return;
    }

    res.status(404).send('Not found');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  // 1. SSR streaming order + CSP nonce
  const ssrRes = await fetch(`${baseUrl}/`);
  assert.equal(ssrRes.status, 200);
  const csp = ssrRes.headers.get('content-security-policy');
  assert.ok(csp && csp.includes("script-src 'self' 'nonce-"));
  assert.equal(ssrRes.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(ssrRes.headers.get('x-frame-options'), 'SAMEORIGIN');

  const html = await ssrRes.text();
  const nonce = csp.match(/'nonce-([^']+)'/)[1];
  const contentIdx = html.indexOf('<main>Hello Vula</main>');
  const scriptIdx = html.indexOf(`nonce="${nonce}"`);
  const tailIdx = html.indexOf('</div></body></html>');
  assert.ok(contentIdx > 0 && scriptIdx > contentIdx && tailIdx > scriptIdx, 'htmlTail must be written only after React stream completes');

  // 2. Shell error returns 500 cleanly without partial 200 HTML
  const brokenRes = await fetch(`${baseUrl}/broken`);
  assert.equal(brokenRes.status, 500);

  // 3. CSRF blocks cross-origin and missing origin
  const csrfCross = await fetch(`${baseUrl}/_vula/server-component`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.com' },
    body: JSON.stringify({ name: 'api/pub', args: [{ v: 1 }] }),
  });
  assert.equal(csrfCross.status, 403);

  const csrfMissing = await fetch(`${baseUrl}/_vula/server-component`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'api/pub', args: [{ v: 1 }] }),
  });
  assert.equal(csrfMissing.status, 403);

  // 4. Non-JSON rejected with 415
  const nonJson = await fetch(`${baseUrl}/_vula/server-component`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain', Origin: baseUrl },
    body: 'hello',
  });
  assert.equal(nonJson.status, 415);

  // 5. Private server component fails closed with 401 when unauthenticated, succeeds with authenticated user
  const unauth = await fetch(`${baseUrl}/_vula/server-component`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({ name: 'api/private', args: [] }),
  });
  assert.equal(unauth.status, 401);

  const authed = await fetch(`${baseUrl}/_vula/server-component`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl, 'x-fake-user': 'u1' },
    body: JSON.stringify({ name: 'api/private', args: [] }),
  });
  assert.equal(authed.status, 200);
  assert.deepEqual(await authed.json(), { result: { secret: true } });

  // 6. Custom authorize() enforces 403 / 200
  const guardedDeny = await fetch(`${baseUrl}/_vula/server-component`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({ name: 'api/guarded', args: [5] }),
  });
  assert.equal(guardedDeny.status, 403);

  const guardedAllow = await fetch(`${baseUrl}/_vula/server-component`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl, 'x-admin': 'yes' },
    body: JSON.stringify({ name: 'api/guarded', args: [5] }),
  });
  assert.equal(guardedAllow.status, 200);
  assert.deepEqual(await guardedAllow.json(), { result: 10 });

  // 7. Public server component succeeds and strips __proto__
  const pubRes = await fetch(`${baseUrl}/_vula/server-component`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: '{"name":"api/pub","args":[{"__proto__":{"polluted":true},"v":7}]}',
  });
  assert.equal(pubRes.status, 200);
  assert.deepEqual(await pubRes.json(), { result: { hasProtoProp: false, v: 7 } });
});

test('createApp fails closed on devMode when NODE_ENV is unset, enforces middleware on /_vula/route, and renders white dev error overlay', async (t) => {
  const workDir = mkdtempSync(path.join(tmpdir(), 'vula-route-mw-'));
  const prevNodeEnv = process.env.NODE_ENV;
  delete process.env.NODE_ENV;
  t.after(() => {
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
    rmSync(workDir, { recursive: true, force: true });
  });

  const appDir = path.join(workDir, 'app');
  mkdirSync(path.join(appDir, 'admin'), { recursive: true });
  mkdirSync(path.join(workDir, '.swvula'), { recursive: true });
  const reactPath = require.resolve('react');
  const adminPagePath = path.join(appDir, 'admin', 'page.js');
  writeFileSync(adminPagePath, `
    const React = require(${JSON.stringify(reactPath)});
    module.exports = function AdminPage() { return React.createElement('div', null, 'TOP_SECRET_ADMIN'); };
  `);

  const mwPath = path.join(workDir, 'middleware.js');
  writeFileSync(mwPath, `
    module.exports = function(req, res, next) {
      if (req.path.startsWith('/admin') && req.headers['x-auth'] !== 'ok') {
        return res.status(401).send('Unauthorized admin access');
      }
      next();
    };
  `);

  writeFileSync(path.join(workDir, 'vulaism.config.yaml'), 'streaming:\n  enabled: false\n  global: false\n');
  const manifest = {
    routes: [{ path: '/admin', clientPath: 'app/admin/page.js', componentPath: adminPagePath }],
    apiRoutes: [],
    serverComponents: [],
    streamSurfaces: [],
    middleware: mwPath,
  };
  writeFileSync(path.join(workDir, '.vula-routes.json'), JSON.stringify(manifest));

  const wasmRuntime = {
    match(pathname) { return pathname === '/admin' ? 0 : -1; },
    compress(buf) { return buf; },
  };

  const { app, isDev } = await createApp({ cwd: workDir, manifest, wasmRuntime });
  assert.equal(isDev, false);

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;

  // Middleware must block /_vula/route?path=/admin without x-auth
  const blocked = await fetch(`http://127.0.0.1:${port}/_vula/route?path=%2Fadmin`);
  assert.equal(blocked.status, 401);
  assert.ok(!(await blocked.text()).includes('TOP_SECRET_ADMIN'));

  // Authorized request succeeds
  const allowed = await fetch(`http://127.0.0.1:${port}/_vula/route?path=%2Fadmin`, {
    headers: { 'x-auth': 'ok' },
  });
  assert.equal(allowed.status, 200);
  assert.ok((await allowed.text()).includes('TOP_SECRET_ADMIN'));

  // Dev overlay script uses pure white surface, inline swavoti/vula, v-prefix, error count chip, and seeded build errors
  const overlayScript = buildDevWsScript('test-nonce', '2.0.6', [
    { title: 'Build Error', file: 'app/page.tsx:12:4', message: 'SyntaxError: Unexpected token', source: 'build' },
  ]);
  assert.ok(overlayScript.includes('#ffffff'));
  assert.ok(overlayScript.includes('swavoti/vula'));
  assert.ok(overlayScript.includes('SyntaxError: Unexpected token'));
  assert.ok(overlayScript.includes('app/page.tsx:12:4'));
});
