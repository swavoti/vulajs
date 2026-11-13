#!/usr/bin/env node
require('../node/check-version.js');
const { checkDenoSecurity } = require('../deno/check-version.js');
checkDenoSecurity();
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const { generateClientRouteManifest, generateRouteManifest } = require('../core/router/manifest.js');

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
  fs.writeFileSync(
    path.join(process.cwd(), '.vula-routes.json'),
    JSON.stringify(manifest, null, 2)
  );
  fs.writeFileSync(
    path.join(process.cwd(), '.vula-routes.client.json'),
    JSON.stringify(generateClientRouteManifest(manifest))
  );

  const routeCount = manifest.routes.length;
  const apiCount = manifest.apiRoutes.length;
  const scCount = manifest.serverComponents.length;
  const streamCount = (manifest.streamSurfaces || []).length;
  const streamSuffix = streamCount ? `, ${streamCount} stream surfaces` : '';
  console.log(`[vula] Manifest: ${routeCount} pages, ${apiCount} API routes, ${scCount} server components${streamSuffix}`);
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

function parseAllowedScripts(rawContent) {
  const withoutComments = rawContent
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  const arrayMatch = withoutComments.match(/ALLOWED_SCRIPTS[^=]*=\s*\[([\s\S]*?)\]/);
  if (!arrayMatch) return [];
  const entries = [];
  const strRegex = /["']([^"']+)["']/g;
  let m;
  while ((m = strRegex.exec(arrayMatch[1])) !== null) {
    entries.push(m[1].trim());
  }
  return entries;
}

function isScriptSrcAllowed(src, allowedEntries) {
  if (typeof src !== 'string' || !src.trim()) return false;
  const trimmed = src.trim();
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) {
    return true;
  }
  let parsedSrc;
  try {
    parsedSrc = new URL(trimmed);
  } catch {
    return false;
  }
  if (parsedSrc.protocol !== 'https:' && parsedSrc.protocol !== 'http:') {
    return false;
  }
  return allowedEntries.some((entry) => {
    try {
      const parsedAllowed = new URL(entry);
      if (parsedSrc.origin !== parsedAllowed.origin) return false;
      if (!parsedAllowed.pathname || parsedAllowed.pathname === '/') return true;
      return parsedSrc.pathname === parsedAllowed.pathname ||
        parsedSrc.pathname.startsWith(parsedAllowed.pathname.endsWith('/') ? parsedAllowed.pathname : `${parsedAllowed.pathname}/`);
    } catch {
      return false;
    }
  });
}

function checkSecurity() {
  ensureSecurityConfig();

  const allowListPath = path.join(process.cwd(), 'vula.scripts.allow.ts');
  const allowedEntries = parseAllowedScripts(fs.readFileSync(allowListPath, 'utf8'));

  const scriptTagRegex = /<script\b([^>]*)>/gi;
  const srcAttrRegex = /\bsrc\s*=\s*["']([^"']+)["']/i;
  const dirsToScan = [path.join(process.cwd(), 'app'), path.join(process.cwd(), 'src')];

  for (const baseDir of dirsToScan) {
    if (!fs.existsSync(baseDir)) continue;
    const files = fs.readdirSync(baseDir, { recursive: true });

    for (const file of files) {
      if (typeof file !== 'string') continue;
      if (!file.endsWith('.tsx') && !file.endsWith('.jsx')) continue;

      const fullPath = path.join(baseDir, file);
      if (fs.lstatSync(fullPath).isDirectory()) continue;

      const content = fs.readFileSync(fullPath, 'utf8');
      const scriptTagRegex = /<script\b([^>]*)>/gi;
      let match;
      while ((match = scriptTagRegex.exec(content)) !== null) {
        const attrs = match[1] || '';
        const srcMatch = attrs.match(srcAttrRegex);
        if (!srcMatch) {
          console.error(`[vula] BLOCKED: Inline <script> tag found in ${file}.`);
          console.error(`[vula] Move script logic to a module or use CSP nonces.`);
          process.exit(1);
        }
        const src = srcMatch[1];
        if (!isScriptSrcAllowed(src, allowedEntries)) {
          console.error(`[vula] BLOCKED: Unverified script in ${file}: ${src}`);
          console.error(`[vula] Add its exact URL or origin to ALLOWED_SCRIPTS in vula.scripts.allow.ts.`);
          process.exit(1);
        }
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

// --- Update Checker ---
function checkForUpdates() {
  const https = require('https');
  const pkgPath = path.join(__dirname, '../package.json');
  if (!fs.existsSync(pkgPath)) return;
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const currentVersion = pkg.version;
  const packageName = pkg.name;

  https.get(`https://registry.npmjs.org/${packageName}/latest`, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      try {
        const latest = JSON.parse(data).version;
        if (latest && latest !== currentVersion) {
          console.log(`\n\x1b[33m[vula] Notice: A new version of ${packageName} is available! (${currentVersion} -> ${latest})\x1b[0m`);
          console.log(`\x1b[33m[vula] Run 'npx vula upgrade-check' to automatically update.\x1b[0m\n`);
        }
      } catch (e) {}
    });
  }).on('error', () => {}); // Fail silently in background
}

function upgradeCheck() {
  console.log(`[vula] Checking for updates...`);
  const https = require('https');
  
  https.get(`https://registry.npmjs.org/@swavoti/vula/latest`, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      try {
        const latest = JSON.parse(data).version;
        if (!latest) {
          console.log(`[vula] Could not determine latest version.`);
          process.exit(1);
        }
        
        const localPkgPath = path.join(__dirname, '../package.json');
        let currentVersion = 'unknown';
        if (fs.existsSync(localPkgPath)) {
          currentVersion = JSON.parse(fs.readFileSync(localPkgPath, 'utf8')).version;
        }

        if (latest === currentVersion) {
          console.log(`[vula] You are already on the latest version (v${currentVersion}).`);
          process.exit(0);
        }

        console.log(`[vula] Latest version is ${latest} (current: ${currentVersion}). Installing...`);
        const args = runtime === 'deno' 
          ? ['add', 'npm:@swavoti/vula@latest'] 
          : ['install', '@swavoti/vula@latest', '--save'];
        const cmd = runtime === 'deno' ? 'deno' : 'npm';
        
        const child = spawn(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32' });
        child.on('exit', (code) => {
          if (code === 0) {
            console.log(`\x1b[32m[vula] Successfully updated to v${latest}!\x1b[0m`);
          } else {
            console.error(`\x1b[31m[vula] Update failed with code ${code}.\x1b[0m`);
          }
          process.exit(code);
        });
      } catch (e) {
        console.error(`[vula] Failed to parse registry response:`, e.message);
        process.exit(1);
      }
    });
  }).on('error', (err) => {
    console.error(`[vula] Network error while checking for updates:`, err.message);
    process.exit(1);
  });
}

// --- Router Auto-Fix ---
function ensureRouterFix() {
  const routerPath = path.join(process.cwd(), 'src', 'index.tsx');
  if (!fs.existsSync(routerPath)) return;

  let content = fs.readFileSync(routerPath, 'utf8');

  // The new Vula router is intentional; don't replace it with React Router.
  if (content.includes('VulaRouter')) return;

  // Check if already fully upgraded to BrowserRouter + hydrateRoot
  if (content.includes('BrowserRouter')) {
    // Still check if createRoot needs upgrading to hydrateRoot
    if (content.includes('ReactDOM.createRoot') || (content.includes('createRoot(') && !content.includes('hydrateRoot'))) {
      content = content
        .replace(/import ReactDOM from 'react-dom\/client';\s*/g, '')
        .replace(/const root = ReactDOM\.createRoot\(([^)]+)\);\s*root\.render\(/g, 'import { hydrateRoot } from \'react-dom/client\';\nhydrateRoot(\n  $1,')
        .replace(/ReactDOM\.createRoot\(([^)]+)\)\.render\(/g, 'hydrateRoot($1,');
      fs.writeFileSync(routerPath, content, 'utf8');
      console.log('\x1b[32m[vula] Upgraded src/index.tsx to use hydrateRoot for SSR!\x1b[0m');
    }
    return;
  }

  console.log('[vula] Upgrading router to use react-router-dom...');

  try {
    const args = runtime === 'deno' 
      ? ['add', 'npm:react-router-dom@latest'] 
      : ['install', 'react-router-dom', '--save'];
    const cmd = runtime === 'deno' ? 'deno' : 'npm';
    execSync(`${cmd} ${args.join(' ')}`, { stdio: 'inherit' });
  } catch (err) {
    console.error('[vula] Failed to install react-router-dom. Please run `npm install react-router-dom` manually.');
  }

  // Remove old react imports that we won't need, add new ones
  if (!content.includes("import { BrowserRouter")) {
    content = "import { BrowserRouter, Routes, Route } from 'react-router-dom';\n" + content;
  }

  const startIndex = content.indexOf('class ErrorOverlay');
  const endIndex = content.indexOf('const root = ReactDOM.createRoot');

  if (startIndex === -1 || endIndex === -1) {
    return; // Could not find bounds, skip auto-upgrade
  }

  const newRouterBlock = `class ErrorOverlay extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          backgroundColor: 'rgba(0,0,0,0.85)', color: '#ff5555',
          padding: '2rem', zIndex: 9999, fontFamily: 'monospace',
          whiteSpace: 'pre-wrap', overflow: 'auto'
        }}>
          <h2 style={{ color: '#ff5555' }}>⚠ Runtime Error</h2>
          <strong>{this.state.error.message}</strong>
          <br /><br />
          {this.state.error.stack}
          <br />
          <button onClick={() => this.setState({ error: null })} style={{
            marginTop: '1rem', padding: '0.5rem 1rem', background: '#333',
            color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer'
          }}>Dismiss</button>
        </div>
      );
    }
    return this.props.children;
  }
}
const componentCache: Record<string, React.ComponentType<any>> = {};

function Router() {
  return (
    <BrowserRouter>
      <Routes>
        {manifest.routes.map((route: any) => {
          const relativePath = route.componentPath.split('/app/')[1];
          if (!componentCache[relativePath]) {
            componentCache[relativePath] = lazy(() => import(\`@app/\${relativePath}\`));
          }
          const Component = componentCache[relativePath];
          const path = route.path.replace(/\\[(.*?)\\]/g, ':$1');
          return (
            <Route 
              key={route.path} 
              path={path} 
              element={
                <Suspense fallback={null}>
                  <Component />
                </Suspense>
              } 
            />
          );
        })}
        <Route path="*" element={
          <div style={{ padding: '4rem', textAlign: 'center', fontFamily: 'system-ui' }}>
            <h1 style={{ fontSize: '3rem', marginBottom: '1rem' }}>404</h1>
            <p>Page not found.</p>
          </div>
        } />
      </Routes>
    </BrowserRouter>
  );
}
`;

  const newContent = content.slice(0, startIndex) + newRouterBlock + content.slice(endIndex);
  fs.writeFileSync(routerPath, newContent, 'utf8');
  console.log('\x1b[32m[vula] Upgraded src/index.tsx to use react-router-dom!\x1b[0m');
}
// --- Upgrade Script for Streaming UI ---
function ensureStreamingUpgrade() {
  const configPath = path.join(process.cwd(), 'rspack.config.js');
  if (!fs.existsSync(configPath)) return;

  let content = fs.readFileSync(configPath, 'utf8');
  let changed = false;

  if (content.includes("'dist'")) {
    content = content.replace(/'dist'/g, "'.swvula'");
    changed = true;
  }

  // Set filename to .vula.cache.js for the main bundle
  if (!content.includes("filename: '.vula.cache.js'")) {
    content = content.replace(
      /path: path\.resolve\(__dirname,\s*'\.swvula'\),/g,
      "path: path.resolve(__dirname, '.swvula'),\n    filename: '.vula.cache.js',"
    );
    changed = true;
  }

  // Set chunkFilename so async chunks (lazy routes) get clean branded URLs
  // like /chunks/vula-app-page.js instead of ugly 606..vula.cache.js
  if (!content.includes("chunkFilename: 'chunks/vula-")) {
    // Remove any old chunkFilename first to avoid duplicates
    content = content.replace(/\s*chunkFilename:\s*['"][^'"]*['"],?/g, '');
    content = content.replace(
      /filename: '\.vula\.cache\.js',/g,
      "filename: '.vula.cache.js',\n    chunkFilename: 'chunks/vula-[name].js',"
    );
    changed = true;
  }

  // Ensure publicPath is / so chunks load from root regardless of current URL
  if (!content.includes("publicPath: '/'")) {
    content = content.replace(
      /chunkFilename: 'chunks\/vula-\[name\]\.js',/g,
      "chunkFilename: 'chunks/vula-[name].js',\n    publicPath: '/',"
    );
    changed = true;
  }

  // Disable splitChunks + use named chunkIds for readable chunk file names
  if (content.includes('splitChunks') && !content.includes('splitChunks: false')) {
    content = content.replace(
      /optimization:\s*\{[\s\S]*?splitChunks:\s*\{[\s\S]*?\}[\s\S]*?\},?/g,
      'optimization: { splitChunks: false, chunkIds: \'named\' },'
    );
    changed = true;
  } else if (!content.includes('chunkIds')) {
    content = content.replace(
      /optimization:\s*\{\s*splitChunks:\s*false\s*\}/g,
      "optimization: { splitChunks: false, chunkIds: 'named' }"
    );
    changed = true;
  }

  if (content.includes("new rspack.HtmlRspackPlugin")) {
    content = content.replace(/new rspack\.HtmlRspackPlugin\([^)]*\),?/g, '');
    changed = true;
  }

  if (changed) {
    fs.writeFileSync(configPath, content, 'utf8');
    console.log('\x1b[32m[vula] Upgraded rspack.config.js for new streaming UI architecture!\x1b[0m');
  }
}

// --- Commands ---
if (command === 'dev') {
  checkForUpdates();
  ensureRouterFix();
  ensureStreamingUpgrade();
  runChecks();
  ensureManifest();

  // Write a temporary wrapper config that disables lazy compilation.
  // Rspack's lazy compilation proxy chunks POST to /_rspack/lazy/trigger — an endpoint
  // that only exists on Rspack's own built-in HTTP server, NOT on our custom Express server.
  // This causes 404s that break hydration. Disabling it here is the framework-level fix
  // so users never need to configure it themselves.
  const userConfigPath = path.join(process.cwd(), 'rspack.config.js');
  const wrapperConfigPath = path.join(process.cwd(), '.vula-rspack.config.js');
  fs.writeFileSync(wrapperConfigPath, [
    '// Auto-generated by Vula CLI — do not edit',
    `const base = require(${JSON.stringify(userConfigPath)});`,
    'const cfg = base && base.default ? base.default : base;',
    'module.exports = { ...cfg, experiments: { ...(cfg.experiments || {}), lazyCompilation: false } };',
  ].join('\n'));
  process.on('exit', () => { try { fs.unlinkSync(wrapperConfigPath); } catch (_) {} });

  const rspackPkg = require.resolve('@rspack/cli/package.json');
  const rspackBin = path.join(rspackPkg, '../bin/rspack.js');
  const buildArgs = runtime === 'deno'
  ? ['run', '-A', rspackBin, 'serve', '--mode', 'development', '--config', wrapperConfigPath]
  : [rspackBin, 'serve', '--mode', 'development', '--config', wrapperConfigPath];

  const buildChild = spawn(runtime === 'deno' ? 'deno' : process.execPath, buildArgs, {
    stdio: ['inherit', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
    env: { ...process.env, NODE_ENV: 'development' },
  });

  let serverStarted = false;

  const parseOutput = (data) => {
    let str = data.toString();
    if (str.toLowerCase().includes('error')) {
      str = str.replace(/rspack error/gi, '\x1b[31m[Vula Error]\x1b[0m')
               .replace(/error/gi, '\x1b[31m[Vula Error]\x1b[0m');
    }
    process.stdout.write(str);
    
    // Start server once the first build completes successfully
    if (!serverStarted && (str.toLowerCase().includes('compiled') || str.toLowerCase().includes('built'))) {
      serverStarted = true;
      console.log(`\x1b[32m[vula] Build complete. Starting dev server...\x1b[0m`);
      const { startServer } = require('../core/server.js');
      startServer();
    }
  };

  buildChild.stdout.on('data', parseOutput);
  buildChild.stderr.on('data', parseOutput);

  // Fallback in case Rspack output doesn't match and server doesn't start
  setTimeout(() => {
    if (!serverStarted) {
      serverStarted = true;
      console.log(`\x1b[33m[vula] Starting dev server (timeout fallback)...\x1b[0m`);
      const { startServer } = require('../core/server.js');
      startServer();
    }
  }, 5000);

} else if (command === 'build') {
  checkForUpdates();
  ensureRouterFix();
  ensureStreamingUpgrade();
  runChecks();
  ensureManifest();
  console.log(`[vula] Building for production (${runtime})...`);

  const rspackPkg = require.resolve('@rspack/cli/package.json');
  const rspackBin = path.join(rspackPkg, '../bin/rspack.js');
  const args = runtime === 'deno'
    ? ['run', '-A', rspackBin, 'build', '--mode', 'production']
    : [rspackBin, 'build', '--mode', 'production'];

  const child = spawn(runtime === 'deno' ? 'deno' : process.execPath, args, {
    stdio: ['inherit', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
    env: { ...process.env, NODE_ENV: 'production' },
  });

  const parseOutput = (data) => {
    let str = data.toString();
    if (str.toLowerCase().includes('error')) {
      str = str.replace(/rspack error/gi, '\x1b[31m[Vula Error]\x1b[0m')
               .replace(/error/gi, '\x1b[31m[Vula Error]\x1b[0m');
    }
    process.stdout.write(str);
  };

  child.stdout.on('data', parseOutput);
  child.stderr.on('data', parseOutput);
  
  child.on('exit', (code) => process.exit(code));

} else if (command === 'upgrade-check') {
  upgradeCheck();
} else if (command === 'help' || !command) {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8'));
  const version = pkg.version;

  console.log('');
  console.log('\x1b[1m\x1b[36m  ██╗   ██╗██╗   ██╗██╗      █████╗ \x1b[0m');
  console.log('\x1b[1m\x1b[36m  ██║   ██║██║   ██║██║     ██╔══██╗\x1b[0m');
  console.log('\x1b[1m\x1b[36m  ██║   ██║██║   ██║██║     ███████║\x1b[0m');
  console.log('\x1b[1m\x1b[36m  ╚██╗ ██╔╝██║   ██║██║     ██╔══██║\x1b[0m');
  console.log('\x1b[1m\x1b[36m   ╚████╔╝ ╚██████╔╝███████╗██║  ██║\x1b[0m');
  console.log('\x1b[1m\x1b[36m    ╚═══╝   ╚═════╝ ╚══════╝╚═╝  ╚═╝\x1b[0m');
  console.log('');
  console.log(`  \x1b[1mVula.js\x1b[0m \x1b[2mv${version}\x1b[0m  —  The React SSR Framework`);
  console.log(`  \x1b[2mhttps://github.com/swavoti/vulajs\x1b[0m`);
  console.log('');
  console.log('\x1b[1m  USAGE\x1b[0m');
  console.log('  \x1b[36mvula\x1b[0m \x1b[33m<command>\x1b[0m [options]');
  console.log('');
  console.log('\x1b[1m  COMMANDS\x1b[0m');
  console.log('');
  console.log('  \x1b[36mvula dev\x1b[0m');
  console.log('    Start the development server with SSR streaming and HMR');
  console.log('    Watches app/ for changes and auto-reloads the browser');
  console.log('');
  console.log('  \x1b[36mvula build\x1b[0m');
  console.log('    Build your app for production (outputs to .swvula/)');
  console.log('    Runs linting, security checks, and RSC compilation');
  console.log('');
  console.log('  \x1b[36mvula upgrade-check\x1b[0m');
  console.log('    Check if a newer version of Vula.js is available');
  console.log('    Automatically installs the latest version if outdated');
  console.log('');
  console.log('  \x1b[36mvula help\x1b[0m');
  console.log('    Show this help message');
  console.log('');
  console.log('\x1b[1m  EXAMPLES\x1b[0m');
  console.log('');
  console.log('  \x1b[2m$ npx vula dev\x1b[0m          Start dev server on http://localhost:3000');
  console.log('  \x1b[2m$ npx vula build\x1b[0m        Build for production');
  console.log('  \x1b[2m$ npx vula upgrade-check\x1b[0m Check for updates');
  console.log('');
  console.log('\x1b[1m  RUNTIME\x1b[0m');
  console.log(`  Detected: \x1b[33m${runtime}\x1b[0m  (set \x1b[2m"runtime": "deno"\x1b[0m in package.json to switch)`);
  console.log('');
} else {
  console.error(`\x1b[31m[vula] Unknown command: "${command}"\x1b[0m`);
  console.error(`  Run \x1b[36mvula help\x1b[0m to see all available commands.`);
  process.exit(1);
}
