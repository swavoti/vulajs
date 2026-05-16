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

} else if (command === 'create-app') {
  const appName = process.argv[3];
  if (!appName) {
    console.error('[vula] Usage: vula create-app <name>');
    process.exit(1);
  }

  if (fs.existsSync(appName)) {
    console.error(`[vula] "${appName}" already exists.`);
    process.exit(1);
  }

  // Scaffold directories
  fs.mkdirSync(appName);
  fs.mkdirSync(path.join(appName, 'app'));
  fs.mkdirSync(path.join(appName, 'app', 'api'));
  fs.mkdirSync(path.join(appName, 'src'));
  fs.mkdirSync(path.join(appName, 'public'));

  // app/page.tsx
  fs.writeFileSync(path.join(appName, 'app', 'page.tsx'),
`export default function Page() {
  return (
    <div style={{ padding: '4rem', fontFamily: 'system-ui' }}>
      <h1>Your Vula App</h1>
      <p>Edit <code>app/page.tsx</code> to get started.</p>
    </div>
  );
}
`);

  // app/api/hello.ts
  fs.writeFileSync(path.join(appName, 'app', 'api', 'hello.ts'),
`export async function GET(req, res) {
  res.json({ status: "ok", message: "Hello from your API" });
}
`);

  // vula.scripts.allow.ts
  fs.writeFileSync(path.join(appName, 'vula.scripts.allow.ts'),
`export const ALLOWED_SCRIPTS: string[] = [];
`);

  // tsconfig.json
  fs.writeFileSync(path.join(appName, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      target: "ESNext",
      lib: ["DOM", "DOM.Iterable", "ESNext"],
      jsx: "react-jsx",
      types: ["react", "react-dom"],
      moduleResolution: "Node",
      strict: true,
      baseUrl: ".",
      paths: { "@app/*": ["app/*"] },
    },
  }, null, 2));

  // deno.json
  fs.writeFileSync(path.join(appName, 'deno.json'), JSON.stringify({
    compilerOptions: {
      jsx: "react-jsx",
      jsxImportSource: "react",
      strict: false,
    },
    nodeModulesDir: "auto",
  }, null, 2));

  // package.json
  fs.writeFileSync(path.join(appName, 'package.json'), JSON.stringify({
    name: appName,
    version: "1.0.0",
    scripts: { dev: "vula dev", build: "vula build" },
    dependencies: {
      "@swavoti/vula": "latest",
      "react": "^19.2.6",
      "react-dom": "^19.2.6",
    },
  }, null, 2));

  console.log(`[vula] Created ${appName}/`);
  console.log(`  cd ${appName} && deno install && vula dev`);

} else {
  console.log('Vula.js CLI');
  console.log('');
  console.log('Commands:');
  console.log('  vula dev                Start development server');
  console.log('  vula build              Build for production');
  console.log('  vula create-app <name>  Scaffold a new project');
}
