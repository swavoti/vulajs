let matcherPromise = null;
let matcherKey = '';
let wasmExportsPromise = null;

function loadWasmExports() {
  if (!wasmExportsPromise) {
    wasmExportsPromise = fetch('/_vula/wasm', { cache: 'no-store' })
      .then((response) => {
        if (!response.ok) throw new Error(`Could not load Vula WASM routing core (${response.status})`);
        return response.arrayBuffer();
      })
      .then((bytes) => WebAssembly.instantiate(bytes))
      .then(({ instance }) => instance.exports)
      .catch((error) => {
        wasmExportsPromise = null;
        throw error;
      });
  }
  return wasmExportsPromise;
}

function decompressWithWasm(wasm, input) {
  if (input.length > wasm.vula_compression_input_capacity()) {
    throw new Error('Compressed Vula page exceeds the WASM decompression capacity');
  }
  new Uint8Array(wasm.memory.buffer, wasm.vula_compression_input_ptr(), input.length).set(input);
  const length = wasm.vula_decompress(input.length);
  if (length < 0) throw new Error('Invalid compressed Vula page payload');
  return new Uint8Array(
    new Uint8Array(wasm.memory.buffer, wasm.vula_compression_output_ptr(), length)
  );
}

/**
 * Decompresses an LZSS payload returned by `/_vula/route` without loading a site-wide route table.
 */
export async function decompressVulaPayload(input) {
  const wasm = await loadWasmExports();
  return decompressWithWasm(wasm, input);
}

export function getVulaRouteMatcher(routes) {
  const nextKey = JSON.stringify(routes.map(({ path, clientPath }) => [path, clientPath]));
  if (!matcherPromise || matcherKey !== nextKey) {
    matcherKey = nextKey;
    matcherPromise = initializeMatcher(routes).catch((error) => {
      matcherPromise = null;
      matcherKey = '';
      throw error;
    });
  }
  return matcherPromise;
}

async function initializeMatcher(routes) {
  const wasm = await loadWasmExports();
  const encoder = new TextEncoder();
  const routeTable = encoder.encode(routes.map((route) => route.path).join('\n'));

  if (routeTable.length > wasm.vula_route_table_capacity()) {
    throw new Error('Vula route table exceeds the WASM routing capacity');
  }
  new Uint8Array(wasm.memory.buffer, wasm.vula_route_table_ptr(), routeTable.length).set(routeTable);
  const routeCount = wasm.vula_init_routes(routeTable.length);
  if (routeCount !== routes.length) {
    throw new Error(`Vula WASM route table initialization failed (${routeCount})`);
  }

  return {
    match(pathname) {
      const path = normalizePath(pathname);
      if (path === null) return null;
      const encodedPath = encoder.encode(path);
      if (encodedPath.length > wasm.vula_path_capacity()) return null;
      new Uint8Array(wasm.memory.buffer, wasm.vula_path_ptr(), encodedPath.length).set(encodedPath);
      const index = wasm.vula_match_path(encodedPath.length);
      return index >= 0 && index < routes.length ? routes[index] : null;
    },
    decompress(input) {
      return decompressWithWasm(wasm, input);
    },
  };
}

function normalizePath(pathname) {
  if (!pathname.startsWith('/') || pathname.startsWith('//')) return null;
  const segments = pathname.slice(1).split('/');
  if (segments.length === 1 && segments[0] === '') return '/';
  if (segments[segments.length - 1] === '') segments.pop();
  if (segments.some((segment) => segment === '')) return null;
  const decoded = [];
  try {
    for (const segment of segments) {
      decoded.push(decodeURIComponent(segment).replaceAll('/', '\0'));
    }
  } catch {
    return null;
  }
  return `/${decoded.join('/')}`;
}
