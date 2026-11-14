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
    'ssr': true,
  },
  streaming: {
    enabled: true,
    global: true,
    codec: 'vp8',
    quality: 'hd',
    fps: 30,
    'max-width': 1920,
    'max-height': 1080,
    'idle-timeout-ms': 60000,
    'max-sessions': 64,
    'allow-console-logs': false,
    'dynamic-loading': true,
  },
  experimental: {},
};

const STREAMING_LEGACY_MAP = [
  ['enabled', ['stream', 'webrtc-stream']],
  ['global', ['stream-global', 'webrtc-stream-global']],
  ['codec', ['stream-codec', 'webrtc-stream-codec']],
  ['quality', ['stream-quality', 'webrtc-stream-quality']],
  ['fps', ['stream-fps', 'webrtc-stream-fps']],
  ['max-width', ['stream-max-width', 'webrtc-stream-max-width']],
  ['max-height', ['stream-max-height', 'webrtc-stream-max-height']],
  ['idle-timeout-ms', ['stream-idle-timeout-ms', 'webrtc-stream-idle-timeout-ms']],
  ['max-sessions', ['stream-max-sessions', 'webrtc-stream-max-sessions']],
  ['allow-console-logs', ['allow-console-logs']],
  ['dynamic-loading', ['dynamic-loading']],
];

function resolveStreamingConfig(cfgOrSub = {}) {
  const isRoot = Boolean(cfgOrSub && (cfgOrSub.streaming || cfgOrSub.experimental || cfgOrSub.app || cfgOrSub.server || cfgOrSub.security));
  const streaming = isRoot ? (cfgOrSub.streaming || {}) : (cfgOrSub || {});
  const exp = isRoot ? (cfgOrSub.experimental || {}) : (cfgOrSub || {});

  const out = { ...DEFAULTS.streaming };
  for (const [key, legacyKeys] of STREAMING_LEGACY_MAP) {
    if (streaming[key] !== undefined) {
      out[key] = streaming[key];
      continue;
    }
    for (const lk of legacyKeys) {
      if (exp[lk] !== undefined) {
        out[key] = exp[lk];
        break;
      }
    }
  }
  out.enabled = Boolean(out.enabled);
  out.global = Boolean(out.global);
  out['allow-console-logs'] = Boolean(out['allow-console-logs']);
  out['dynamic-loading'] = out['dynamic-loading'] !== false;
  return out;
}

function normalizeConfig(cfg, parsedRoot = null) {
  if (!cfg || typeof cfg !== 'object') return cfg;
  cfg.streaming = cfg.streaming ? { ...DEFAULTS.streaming, ...cfg.streaming } : { ...DEFAULTS.streaming };
  const s = cfg.streaming;
  const parsedStreaming = parsedRoot && typeof parsedRoot.streaming === 'object' ? parsedRoot.streaming : null;
  const parsedExp = parsedRoot && typeof parsedRoot.experimental === 'object' ? parsedRoot.experimental : null;
  const exp = cfg.experimental && typeof cfg.experimental === 'object' ? cfg.experimental : (cfg.experimental = {});

  for (const [key, legacyKeys] of STREAMING_LEGACY_MAP) {
    const hasExplicitNew = Boolean(parsedStreaming && parsedStreaming[key] !== undefined);
    if (!hasExplicitNew) {
      for (const lk of legacyKeys) {
        if (parsedExp && parsedExp[lk] !== undefined) {
          s[key] = parsedExp[lk];
          break;
        }
        if (!parsedRoot && exp[lk] !== undefined) {
          s[key] = exp[lk];
          break;
        }
      }
    }
  }

  const rawEnabled = s.enabled;
  const isGlobalString =
    typeof rawEnabled === 'string' &&
    ['--global', 'global'].includes(rawEnabled.trim().toLowerCase());

  if (isGlobalString) {
    s.enabled = true;
    s.global = true;
  } else if (process.env.VULA_STREAM_GLOBAL === '1' || process.env.VULA_WEBRTC_GLOBAL === '1') {
    if (s.enabled !== false) {
      s.enabled = true;
      s.global = true;
    }
  } else {
    s.enabled = Boolean(s.enabled);
    s.global = Boolean(s.enabled && s.global);
  }

  s['allow-console-logs'] = Boolean(s['allow-console-logs']);
  s['dynamic-loading'] = s['dynamic-loading'] !== false;

  return cfg;
}

function loadConfig(cwd = process.cwd()) {
  const configPath = path.join(cwd, CONFIG_FILE);
  if (!fs.existsSync(configPath)) {
    return normalizeConfig(deepMerge({}, DEFAULTS));
  }
  try {
    const yaml = require('js-yaml');
    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = yaml.load(raw);
    return normalizeConfig(deepMerge(DEFAULTS, parsed || {}), parsed || null);
  } catch (err) {
    console.warn(`[vula] Failed to parse ${CONFIG_FILE}:`, err.message);
    return normalizeConfig(deepMerge({}, DEFAULTS));
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

module.exports = { loadConfig, resolveStreamingConfig };
