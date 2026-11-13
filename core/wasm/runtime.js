const fs = require('node:fs/promises');

async function createWasmRuntime(wasmPath, routes) {
  const bytes = await fs.readFile(wasmPath);
  const { instance } = await WebAssembly.instantiate(bytes);
  const wasm = instance.exports;
  const memory = wasm.memory;
  const encoder = new TextEncoder();

  function setRoutes(nextRoutes) {
    const routeTable = encoder.encode(nextRoutes.map((route) => route.path).join('\n'));
    if (routeTable.length > wasm.vula_route_table_capacity()) {
      throw new Error('Vula route table exceeds the WASM routing capacity');
    }
    new Uint8Array(memory.buffer, wasm.vula_route_table_ptr(), routeTable.length).set(routeTable);
    const routeCount = wasm.vula_init_routes(routeTable.length);
    if (routeCount !== nextRoutes.length) {
      throw new Error(`Vula WASM route table initialization failed (${routeCount})`);
    }
    routes = nextRoutes;
  }
  setRoutes(routes);

  return {
    setRoutes,
    match(pathname) {
      const path = normalizePath(pathname);
      if (path === null) return -1;
      const encodedPath = encoder.encode(path);
      if (encodedPath.length > wasm.vula_path_capacity() || encodedPath.length > VULA_MAX_PATH_LENGTH) return -1;
      new Uint8Array(memory.buffer, wasm.vula_path_ptr(), encodedPath.length).set(encodedPath);
      const index = wasm.vula_match_path(encodedPath.length);
      return index >= 0 && index < routes.length ? index : -1;
    },
    compress(input) {
      if (input.length > wasm.vula_compression_input_capacity()) return null;
      new Uint8Array(memory.buffer, wasm.vula_compression_input_ptr(), input.length).set(input);
      const length = wasm.vula_compress(input.length);
      if (length < 0) return null;
      return new Uint8Array(
        new Uint8Array(memory.buffer, wasm.vula_compression_output_ptr(), length)
      );
    },
    decompress(input) {
      if (input.length > wasm.vula_compression_input_capacity()) {
        throw new Error('Compressed Vula page exceeds the WASM decompression capacity');
      }
      new Uint8Array(memory.buffer, wasm.vula_compression_input_ptr(), input.length).set(input);
      const length = wasm.vula_decompress(input.length);
      if (length < 0) throw new Error('Invalid compressed Vula page payload');
      return new Uint8Array(
        new Uint8Array(memory.buffer, wasm.vula_compression_output_ptr(), length)
      );
    },
  };
}

const VULA_MAX_PATH_LENGTH = 16 * 1024;

function normalizePath(pathname) {
  if (typeof pathname !== 'string' || !pathname.startsWith('/') || pathname.startsWith('//')) return null;
  const segments = pathname.slice(1).split('/');
  if (segments.length === 1 && segments[0] === '') return '/';
  if (segments[segments.length - 1] === '') segments.pop();
  if (segments.some((segment) => segment === '')) return null;
  const decoded = [];
  try {
    for (const segment of segments) {
      const value = decodeURIComponent(segment).replaceAll('/', '\0');
      decoded.push(value);
    }
  } catch {
    return null;
  }
  return `/${decoded.join('/')}`;
}

function extractRouteParams(routePath, pathname) {
  const normalizedPath = normalizePath(pathname);
  if (normalizedPath === null) return null;
  const patternSegments = routePath.split('/').filter(Boolean);
  const pathSegments = [];
  const encodedSegments = normalizedPath === '/' ? [] : pathname.slice(1).split('/');
  if (encodedSegments[encodedSegments.length - 1] === '') encodedSegments.pop();
  try {
    for (const segment of encodedSegments) {
      pathSegments.push(decodeURIComponent(segment));
    }
  } catch {
    return null;
  }
  const params = {};
  let pathIndex = 0;

  for (let index = 0; index < patternSegments.length; index++) {
    const pattern = patternSegments[index];
    if (pattern.startsWith('*')) {
      params[pattern.slice(1) || 'wildcard'] = pathSegments.slice(pathIndex).join('/');
      pathIndex = pathSegments.length;
      break;
    }
    if (pathIndex >= pathSegments.length) return null;
    if (pattern.startsWith(':')) {
      params[pattern.slice(1)] = pathSegments[pathIndex];
    }
    pathIndex++;
  }

  return pathIndex === pathSegments.length ? params : null;
}

module.exports = { createWasmRuntime, extractRouteParams, normalizePath };
