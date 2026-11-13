const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const sourceDir = path.join(root, 'core', 'wasm', 'c');
const output = path.join(root, 'core', 'wasm', 'vula-core.wasm');
const compiler = process.env.CC || 'clang';

const result = spawnSync(compiler, [
  '--target=wasm32-unknown-unknown',
  '-std=c11',
  '-O3',
  '-nostdlib',
  '-Wl,--no-entry',
  '-Wl,--export-memory',
  '-Wl,--initial-memory=2097152',
  '-Wl,--max-memory=16777216',
  '-Wl,--strip-all',
  ...[
    'vula_route_table_ptr',
    'vula_route_table_capacity',
    'vula_path_ptr',
    'vula_path_capacity',
    'vula_init_routes',
    'vula_match_path',
    'vula_compression_input_ptr',
    'vula_compression_input_capacity',
    'vula_compression_output_ptr',
    'vula_compression_output_capacity',
    'vula_compress',
    'vula_decompress',
  ].map((symbol) => `-Wl,--export=${symbol}`),
  '-I', sourceDir,
  path.join(sourceDir, 'memory.c'),
  path.join(sourceDir, 'router.c'),
  path.join(sourceDir, 'compression.c'),
  '-o', output,
], { encoding: 'utf8' });

if (result.error) {
  console.error(`[vula] Could not start ${compiler}: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) {
  process.stderr.write(result.stderr);
  process.exit(result.status || 1);
}

const stat = fs.statSync(output);
console.log(`[vula] Built core WASM module (${stat.size} bytes): ${path.relative(root, output)}`);
