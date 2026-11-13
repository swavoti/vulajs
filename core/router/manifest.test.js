const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');

const { generateClientRouteManifest, generateRouteManifest } = require('./manifest');

test('adds browser-relative client paths for static and dynamic pages', (t) => {
  const appDir = mkdtempSync(join(tmpdir(), 'vula-routes-'));
  t.after(() => rmSync(appDir, { recursive: true, force: true }));

  mkdirSync(join(appDir, 'users', '[id]'), { recursive: true });
  mkdirSync(join(appDir, 'users', 'settings'), { recursive: true });
  mkdirSync(join(appDir, 'docs', '[...rest]'), { recursive: true });
  writeFileSync(join(appDir, 'page.tsx'), 'export default function Home() {}');
  writeFileSync(join(appDir, 'users', '[id]', 'page.tsx'), 'export default function User() {}');
  writeFileSync(join(appDir, 'users', 'settings', 'page.tsx'), 'export default function Settings() {}');
  writeFileSync(join(appDir, 'docs', '[...rest]', 'page.tsx'), 'export default function Docs() {}');

  const { routes } = generateRouteManifest(appDir);
  assert.deepEqual(
    routes.map(({ path, clientPath }) => ({ path, clientPath })).sort((a, b) => a.path.localeCompare(b.path)),
    [
      { path: '/', clientPath: 'page.tsx' },
      { path: '/docs/*rest', clientPath: 'docs/[...rest]/page.tsx' },
      { path: '/users/:id', clientPath: 'users/[id]/page.tsx' },
      { path: '/users/settings', clientPath: 'users/settings/page.tsx' },
    ]
  );
  assert.ok(routes.every((route) => route.componentPath.startsWith(appDir)));
  assert.ok(routes.findIndex((route) => route.path === '/users/settings') < routes.findIndex((route) => route.path === '/users/:id'));

  const fullManifest = generateRouteManifest(appDir);
  fullManifest.apiRoutes.push({ path: '/api/private', handlerPath: join(appDir, 'api/private.ts') });
  fullManifest.serverComponents.push({ name: 'secret', path: join(appDir, 'secret.sever.comp.ts') });
  const clientManifest = generateClientRouteManifest(fullManifest);
  assert.deepEqual(Object.keys(clientManifest), ['routes']);
  assert.ok(clientManifest.routes.every((route) => Object.keys(route).sort().join(',') === 'clientPath,path'));
});
