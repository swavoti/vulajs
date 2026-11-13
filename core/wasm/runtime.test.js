const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { createWasmRuntime, extractRouteParams } = require('./runtime');

const wasmPath = path.join(__dirname, 'vula-core.wasm');

test('matches static, dynamic, and catch-all routes through the WASM trie', async () => {
  const routes = [
    { path: '/users/:id' },
    { path: '/users/settings' },
    { path: '/docs/*rest' },
    { path: '/' },
  ];
  const runtime = await createWasmRuntime(wasmPath, routes);

  assert.equal(runtime.match('/'), 3);
  assert.equal(runtime.match('/users/settings'), 1);
  assert.equal(runtime.match('/USERS/SETTINGS'), 1);
  assert.equal(runtime.match('/users/42'), 0);
  assert.equal(runtime.match('/users/a%2Fb'), 0);
  assert.equal(runtime.match('/docs/a/nested/page'), 2);
  assert.equal(runtime.match('/users//42'), -1);
  assert.equal(runtime.match('/missing'), -1);
  assert.equal(runtime.match('/users/%E0%A4%A'), -1);
  assert.deepEqual(extractRouteParams('/users/:id', '/users/42'), { id: '42' });
  assert.deepEqual(extractRouteParams('/users/:id', '/users/a%2Fb'), { id: 'a/b' });
  assert.deepEqual(extractRouteParams('/docs/*rest', '/docs/a/nested/page'), { rest: 'a/nested/page' });
  runtime.setRoutes([{ path: '/fresh/:id' }]);
  assert.equal(runtime.match('/fresh/1'), 0);
  assert.equal(runtime.match('/users/42'), -1);
});

test('round-trips incompressible bytes', async () => {
  const runtime = await createWasmRuntime(wasmPath, [{ path: '/' }]);
  const input = Buffer.alloc(256 * 1024);
  let state = 0x9e3779b9;
  for (let index = 0; index < input.length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    input[index] = state & 0xff;
  }
  const compressed = runtime.compress(input);
  assert.ok(compressed);
  assert.ok(compressed.length > input.length);
  assert.deepEqual(Buffer.from(runtime.decompress(compressed)), input);
});

test('round-trips repetitive UTF-8 route HTML and rejects malformed payloads', async () => {
  const runtime = await createWasmRuntime(wasmPath, [{ path: '/' }]);
  const html = Buffer.from(
    '<main><h1>Vula route ✓</h1>' + '<p class="content">Repeated server-rendered content.</p>'.repeat(500),
    'utf8'
  );
  const compressed = runtime.compress(html);

  assert.ok(compressed);
  assert.ok(compressed.length < html.length / 2);
  assert.deepEqual(Buffer.from(runtime.decompress(compressed)), html);
  assert.throws(() => runtime.decompress(Buffer.from('not-vula')), /Invalid compressed Vula page payload/);
});

test('falls back to the original bytes when compression cannot fit its input buffer', async () => {
  const runtime = await createWasmRuntime(wasmPath, [{ path: '/' }]);
  const tooLarge = Buffer.alloc(256 * 1024 + 1, 0x61);
  assert.equal(runtime.compress(tooLarge), null);
});
