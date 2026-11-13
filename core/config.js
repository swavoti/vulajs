const fs = require('fs');
const path = require('path');

const CONFIG_FILE = 'vulaism.config.yaml';

const DEFAULTS = {
  app: {
    name: 'Vula App',
    icon: 'assets/vula.jpeg',
    lang: 'en',
  },
  optimization: {
    'text-opt': true,
    'font-preload': true,
    'font-display': 'swap',
    'font-subset': true,
    'image-compression': true,
    'minify-html': false,
  },
  security: {
    csrf: true,
    'allowed-origins': [],
    'content-security-policy': true,
    'server-component-auth': true,
  },
  proxy: {
    enabled: false,
    target: 'http://localhost:8080',
    prefix: '/proxy',
  },
  server: {
    port: 3000,
    'compression': true,
    'trust-proxy': false,
  },
  modules: {
    'video-opti': true,
    'image-opti': true,
    'ssr': false,
  },
  experimental: {
    'webrtc-stream': false,
    'webrtc-stream-codec': 'vp8',
    'webrtc-stream-fps': 30,
    'webrtc-stream-max-width': 1920,
    'webrtc-stream-max-height': 1080,
    'webrtc-stream-idle-timeout-ms': 60000,
    'webrtc-stream-max-sessions': 64,
    'webrtc-ice-servers': [],
  },
};

function loadConfig(cwd = process.cwd()) {
  const configPath = path.join(cwd, CONFIG_FILE);
  if (!fs.existsSync(configPath)) {
    return DEFAULTS;
  }
  try {
    const yaml = require('js-yaml');
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = yaml.load(raw);
    return deepMerge(DEFAULTS, parsed || {});
  } catch (err) {
    console.warn(`[vula] Failed to parse ${CONFIG_FILE}:`, err.message);
    return DEFAULTS;
  }
}

function deepMerge(base, override) {
  const result = { ...base };
  for (const key of Object.keys(override)) {
    if (
      typeof override[key] === 'object' &&
      override[key] !== null &&
      !Array.isArray(override[key]) &&
      typeof base[key] === 'object'
    ) {
      result[key] = deepMerge(base[key], override[key]);
    } else {
      result[key] = override[key];
    }
  }
  return result;
}

module.exports = { loadConfig };
