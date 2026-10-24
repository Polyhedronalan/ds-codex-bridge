/**
 * bridge/config.mjs — configuration loading + validation.
 *
 * Precedence: explicit env overrides > config.json > built-in defaults.
 * Secrets are never read from the config file (see security.mjs).
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULTS = {
  version: '0.1.0',
  listen: { host: '127.0.0.1', port: 8799 },
  local_auth: {
    // `query` is the only channel current Codex custom providers can carry
    // (ModelProviderInfo has query_params but no custom header field).
    mode: 'query',
    query_param: 'bridge_key',
    header: 'x-codex-bridge-key',
    path_prefix: null,
    allow_health_without_auth: true,
  },
  upstreams: {
    deepseek: {
      base_url: 'https://api.deepseek.com',
      proxy: null,
      auth: { type: 'env_bearer', env: 'DEEPSEEK_API_KEY' },
    },
    chatgpt: {
      base_url: 'https://chatgpt.com/backend-api/codex',
      proxy: 'env:HTTPS_PROXY',
      auth: { type: 'passthrough' },
    },
  },
  limits: {
    max_body_bytes: 16 * 1024 * 1024,
    max_concurrency: 4,
    connect_timeout_ms: 10_000,
    headers_timeout_ms: 300_000,
    idle_timeout_ms: 300_000,
    total_timeout_ms: 1_800_000,
  },
  retry: { max_retries_transient: 1 },
  compat: { deepseek_reasoning_replay: 'strip', tool_contract_history: 'on' },
  startup: { proxy_check: true, proxy_check_timeout_ms: 3_000, require_deepseek_key: true },
  tls: { reject_unauthorized: true },
  log: { path: 'logs/bridge.jsonl', diag_header_names: false, max_bytes: 10 * 1024 * 1024, max_files: 5 },
};

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

function deepMerge(base, override) {
  if (override === undefined || override === null) return base;
  if (Array.isArray(base) || Array.isArray(override) || typeof base !== 'object' || typeof override !== 'object') {
    return override;
  }
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) out[k] = deepMerge(base[k], v);
  return out;
}

export function loadConfig({ env = process.env, cwd = process.cwd() } = {}) {
  const file = env.BRIDGE_CONFIG?.trim() || path.join(HERE, 'config.json');
  let fromFile = {};
  if (existsSync(file)) {
    fromFile = JSON.parse(readFileSync(file, 'utf8'));
  }
  const cfg = deepMerge(DEFAULTS, fromFile);

  if (env.BRIDGE_HOST) cfg.listen.host = env.BRIDGE_HOST;
  if (env.BRIDGE_PORT) cfg.listen.port = Number(env.BRIDGE_PORT);
  if (env.BRIDGE_LOG) cfg.log.path = env.BRIDGE_LOG;
  if (env.BRIDGE_LOG === '') cfg.log.path = null;
  if (env.BRIDGE_DIAG === '1') cfg.log.diag_header_names = true;
  if (env.BRIDGE_LOG_MAX_BYTES) cfg.log.max_bytes = Number(env.BRIDGE_LOG_MAX_BYTES);
  if (env.BRIDGE_LOG_MAX_FILES) cfg.log.max_files = Number(env.BRIDGE_LOG_MAX_FILES);
  if (env.BRIDGE_MAX_CONCURRENCY) cfg.limits.max_concurrency = Number(env.BRIDGE_MAX_CONCURRENCY);
  if (env.BRIDGE_MAX_BODY_BYTES) cfg.limits.max_body_bytes = Number(env.BRIDGE_MAX_BODY_BYTES);
  if (env.BRIDGE_DEEPSEEK_BASE_URL) cfg.upstreams.deepseek.base_url = env.BRIDGE_DEEPSEEK_BASE_URL;
  if (env.BRIDGE_CHATGPT_BASE_URL) cfg.upstreams.chatgpt.base_url = env.BRIDGE_CHATGPT_BASE_URL;
  if (env.BRIDGE_DEEPSEEK_PROXY !== undefined) cfg.upstreams.deepseek.proxy = env.BRIDGE_DEEPSEEK_PROXY || null;
  if (env.BRIDGE_CHATGPT_PROXY !== undefined) cfg.upstreams.chatgpt.proxy = env.BRIDGE_CHATGPT_PROXY || null;
  if (env.BRIDGE_REASONING_MODE) cfg.compat.deepseek_reasoning_replay = env.BRIDGE_REASONING_MODE;
  if (env.BRIDGE_TOOL_CONTRACT_HISTORY) cfg.compat.tool_contract_history = env.BRIDGE_TOOL_CONTRACT_HISTORY;
  if (env.BRIDGE_TLS_INSECURE === '1') cfg.tls.reject_unauthorized = false;
  if (!path.isAbsolute(cfg.log.path ?? '')) cfg.log.path = cfg.log.path === null ? null : path.join(cwd, cfg.log.path);
  const dpapiFile = cfg.local_auth?.dpapi_file;
  if (dpapiFile && !path.isAbsolute(dpapiFile)) {
    cfg.local_auth.dpapi_file = path.resolve(path.dirname(file), dpapiFile);
  }

  validateConfig(cfg);
  return cfg;
}

export function validateConfig(cfg) {
  const errors = [];
  if (!LOOPBACK.has(String(cfg.listen.host))) {
    errors.push(`listen.host must be loopback (127.0.0.1 / ::1 / localhost), got "${cfg.listen.host}"`);
  }
  if (!Number.isInteger(cfg.listen.port) || cfg.listen.port < 1 || cfg.listen.port > 65535) {
    errors.push(`listen.port invalid: ${cfg.listen.port}`);
  }
  const concurrency = cfg.limits.max_concurrency;
  if (!Number.isInteger(concurrency) || concurrency < 0 || concurrency > 32) {
    errors.push(`limits.max_concurrency must be 0 (unlimited) or 1..32, got ${concurrency}`);
  }
  if (!Number.isFinite(cfg.limits.max_body_bytes) || cfg.limits.max_body_bytes < 1024) {
    errors.push(`limits.max_body_bytes invalid: ${cfg.limits.max_body_bytes}`);
  }
  if (!['strip', 'drop', 'off'].includes(cfg.compat.deepseek_reasoning_replay)) {
    errors.push(`compat.deepseek_reasoning_replay must be strip|drop|off, got ${cfg.compat.deepseek_reasoning_replay}`);
  }
  if (!['on', 'off'].includes(cfg.compat.tool_contract_history)) {
    errors.push(`compat.tool_contract_history must be on|off, got ${cfg.compat.tool_contract_history}`);
  }
  const retries = cfg.retry.max_retries_transient;
  if (!Number.isInteger(retries) || retries < 0 || retries > 2) {
    errors.push(`retry.max_retries_transient must be 0..2, got ${retries}`);
  }
  if (!Number.isSafeInteger(cfg.log.max_bytes) || cfg.log.max_bytes < 1024) {
    errors.push(`log.max_bytes must be an integer >= 1024, got ${cfg.log.max_bytes}`);
  }
  if (!Number.isInteger(cfg.log.max_files) || cfg.log.max_files < 1 || cfg.log.max_files > 100) {
    errors.push(`log.max_files must be 1..100, got ${cfg.log.max_files}`);
  }
  for (const [name, up] of Object.entries(cfg.upstreams)) {
    try {
      new URL(up.base_url);
    } catch {
      errors.push(`upstreams.${name}.base_url is not a URL: ${up.base_url}`);
    }
  }
  if (errors.length > 0) {
    const err = new Error('invalid bridge configuration:\n  - ' + errors.join('\n  - '));
    err.code = 'BRIDGE_CONFIG_INVALID';
    throw err;
  }
  return cfg;
}

export function isLoopback(host) {
  return LOOPBACK.has(String(host));
}
