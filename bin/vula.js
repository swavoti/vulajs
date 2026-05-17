#!/usr/bin/env node
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const { generateRouteManifest } = require('../core/router/manifest.js');

const command = process.argv[2];

// Detect runtime from package.json
let runtime = "node";
const pkgPath = path.join(process.cwd(), 'package.json');
if (fs.existsSync(pkgPath)) {
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  if (pkg.runtime === 'deno') runtime = 'deno';
}

// --- Manifest ---
function ensureManifest() {
  const appDir = path.join(process.cwd(), 'app');
  if (!fs.existsSync(appDir)) {
    console.log('[vula] No app/ directory found. Skipping manifest.');
    return;
  }
  const manifest = generateRouteManifest(appDir);
  const out = path.join(process.cwd(), '.vula-routes.json');
  fs.writeFileSync(out, JSON.stringify(manifest, null, 2));

  const routeCount = manifest.routes.length;
  const apiCount = manifest.apiRoutes.length;
  const scCount = manifest.serverComponents.length;
  console.log(`[vula] Manifest: ${routeCount} pages, ${apiCount} API routes, ${scCount} server components`);
  if (manifest.middleware) console.log('[vula] Middleware detected');
}

// --- Security ---
function ensureSecurityConfig() {
  const configPath = path.join(process.cwd(), 'vula.scripts.allow.ts');
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, `// Vula.js Script Allow List
// Scripts not listed here will cause the build to fail.
export const ALLOWED_SCRIPTS: string[] = [
  "https://fonts.googleapis.com",
];
`);
    console.log('[vula] Created vula.scripts.allow.ts');
  }
}

function checkSecurity() {
  ensureSecurityConfig();

  const appDir = path.join(process.cwd(), 'app');
  if (!fs.existsSync(appDir)) return;

  const allowListPath = path.join(process.cwd(), 'vula.scripts.allow.ts');
  const allowList = fs.readFileSync(allowListPath, 'utf8');

  const scriptRegex = /<script[^>]*src=["']([^"']+)["'][^>]*>/g;
  const files = fs.readdirSync(appDir, { recursive: true });

  for (const file of files) {
    if (typeof file !== 'string') continue;
    if (!file.endsWith('.tsx') && !file.endsWith('.jsx')) continue;

    const fullPath = path.join(appDir, file);
    if (fs.lstatSync(fullPath).isDirectory()) continue;

    const content = fs.readFileSync(fullPath, 'utf8');
    let match;
    while ((match = scriptRegex.exec(content)) !== null) {
      const src = match[1];
      if (!allowList.includes(src)) {
        console.error(`[vula] BLOCKED: Unverified script in ${file}: ${src}`);
        console.error(`[vula] Add it to vula.scripts.allow.ts or remove it.`);
        process.exit(1);
      }
    }
  }
}

function runChecks() {
  checkSecurity();

  // Run eslint if available
  const eslintBin = path.join(process.cwd(), 'node_modules', '.bin', 'eslint');
  if (fs.existsSync(eslintBin)) {
    try {
      execSync('npx eslint app --ext .ts,.tsx', { stdio: 'inherit' });
    } catch (err) {
      console.error('[vula] Lint errors detected.');
      process.exit(1);
    }
  }
}

// --- Commands ---
if (command === 'dev') {
  runChecks();
  ensureManifest();

  process.env.NODE_ENV = 'development';
  const { startServer } = require('../core/server.js');
  startServer(3000);

} else if (command === 'build') {
  runChecks();
  ensureManifest();
  console.log(`[vula] Building for production (${runtime})...`);

  const args = runtime === 'deno'
    ? ['run', '-A', 'npm:@rspack/cli', 'build']
    : ['rspack', 'build'];

  const child = spawn(runtime === 'deno' ? 'deno' : 'npx', args, {
    stdio: 'inherit',
    shell: true,
  });
  child.on('exit', (code) => process.exit(code));

} else {
  console.log('Vula.js CLI');
  console.log('');
  console.log('Commands:');
  console.log('  vula dev                Start development server');
  console.log('  vula build              Build for production');
}

