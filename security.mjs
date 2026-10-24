/**
 * bridge/security.mjs — secret loading + local client authentication.
 *
 * Secret sources, in order:
 *   1. environment variable (preferred): DEEPSEEK_API_KEY, BRIDGE_LOCAL_KEY
 *   2. Windows DPAPI protected file (`secrets.dpapi.json`, user scope), decrypted
 *      once at startup through one PowerShell call. Never written back to disk.
 * Secrets are held in memory only, are registered with the logger for scrubbing,
 * and are never returned in HTTP responses or log fields.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';

export function generateLocalKey(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // still compare to keep timing flat for equal-length prefixes
    const pad = Buffer.alloc(bufA.length);
    timingSafeEqual(bufA, pad);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

function dpapiUnprotect(base64) {
  const script =
    "Add-Type -AssemblyName System.Security;" +
    "$ErrorActionPreference='Stop';" +
    "$b=[Convert]::FromBase64String($env:BRIDGE_DPAPI_BLOB);" +
    "$p=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser');" +
    '[Console]::Out.Write([Text.Encoding]::UTF8.GetString($p))';
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, BRIDGE_DPAPI_BLOB: base64 },
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
}

/** Reads `secrets.dpapi.json` (values are DPAPI-protected base64 blobs). */
export function loadDpapiSecrets(file) {
  if (!file || !existsSync(file)) return {};
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const out = {};
  for (const [key, blob] of Object.entries(raw)) {
    if (typeof blob !== 'string' || blob.length === 0) continue;
    try {
      out[key] = dpapiUnprotect(blob).trim();
    } catch (err) {
      const e = new Error(`failed to unprotect "${key}" from ${file}: ${err.message}`);
      e.code = 'BRIDGE_SECRET_UNREADABLE';
      throw e;
    }
  }
  return out;
}

/**
 * @returns {{deepseekApiKey: string|null, localKey: string|null, sources: object}}
 */
export function loadSecrets({ env = process.env, dpapiFile = null } = {}) {
  const sources = {};
  let fileSecrets = {};
  const wantFile = Boolean(env.BRIDGE_DPAPI_FILE?.trim() || dpapiFile);
  if (wantFile) {
    fileSecrets = loadDpapiSecrets(env.BRIDGE_DPAPI_FILE?.trim() || dpapiFile);
  }
  const deepseekApiKey = env.DEEPSEEK_API_KEY?.trim() || fileSecrets.DEEPSEEK_API_KEY || null;
  sources.deepseek = env.DEEPSEEK_API_KEY?.trim() ? 'env' : fileSecrets.DEEPSEEK_API_KEY ? 'dpapi' : 'missing';
  const localKey = env.BRIDGE_LOCAL_KEY?.trim() || fileSecrets.BRIDGE_LOCAL_KEY || null;
  sources.local = env.BRIDGE_LOCAL_KEY?.trim() ? 'env' : fileSecrets.BRIDGE_LOCAL_KEY ? 'dpapi' : 'missing';

  // Rotation grace window. During a key rotation the running Codex process may
  // still hold the previous key (it read config.toml before the switch), so the
  // previous key stays valid until `BRIDGE_LOCAL_KEY_PREVIOUS_UNTIL` (ISO-8601).
  // After that instant the old, possibly leaked, key is rejected automatically.
  // A previous key without a parseable expiry is never accepted.
  const previousLocalKey = env.BRIDGE_LOCAL_KEY_PREVIOUS?.trim() || fileSecrets.BRIDGE_LOCAL_KEY_PREVIOUS || null;
  const previousLocalKeyUntil =
    env.BRIDGE_LOCAL_KEY_PREVIOUS_UNTIL?.trim() || fileSecrets.BRIDGE_LOCAL_KEY_PREVIOUS_UNTIL || null;
  sources.localPrevious = previousLocalKey
    ? previousKeyActive(previousLocalKey, previousLocalKeyUntil)
      ? `grace_until_${previousLocalKeyUntil}`
      : 'present_but_expired_or_undated'
    : 'none';
  return { deepseekApiKey, localKey, previousLocalKey, previousLocalKeyUntil, sources };
}

export function previousKeyActive(previousKey, previousUntil, now = Date.now()) {
  if (!previousKey || !previousUntil) return false;
  const expiry = Date.parse(previousUntil);
  return Number.isFinite(expiry) && now < expiry;
}

/**
 * Local client authentication. Checks, in order: path prefix, header, query param.
 * Returns {ok, reason}. `reason` is safe to log (no secret material).
 */
export function checkLocalAuth(req, url, cfg, localKey, { previousKey = null, previousUntil = null, now = Date.now() } = {}) {
  if (!localKey) return { ok: true, skipped: true };
  const { mode, query_param: queryParam, header, path_prefix: prefix } = cfg.local_auth;
  const candidates = [];
  if (prefix) {
    const rawPrefix = '/' + String(prefix).replace(/^\/+|\/+$/g, '');
    if (url.pathname.startsWith(rawPrefix + '/')) {
      return { ok: true, via: 'path_prefix', strippedPath: url.pathname.slice(rawPrefix.length) };
    }
  }
  if (header) candidates.push(['header', req.headers[String(header).toLowerCase()]]);
  if (mode !== 'header' && queryParam) candidates.push(['query', url.searchParams.get(queryParam)]);
  for (const [via, value] of candidates) {
    if (typeof value === 'string' && constantTimeEqual(value, localKey)) return { ok: true, via };
  }
  if (previousKeyActive(previousKey, previousUntil, now)) {
    for (const [via, value] of candidates) {
      if (typeof value === 'string' && constantTimeEqual(value, previousKey)) {
        return { ok: true, via, previous: true };
      }
    }
  }
  if (!candidates.some(([, v]) => v != null)) return { ok: false, reason: 'missing' };
  return { ok: false, reason: 'mismatch' };
}
