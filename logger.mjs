/**
 * bridge/logger.mjs — allowlist logger.
 *
 * Only the fields below may ever reach a log line (see README §Logging).
 * Everything else is dropped, and any known secret value is scrubbed from
 * free-text fields as defence in depth.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { rotateBeforeAppend } from './log-rotation.mjs';

const ALLOWED_FIELDS = new Set([
  'ts',
  'event',
  'request_id',
  'model',
  'upstream',
  'status',
  'latency_ms',
  'retry_count',
  'normalization_counts',
  'error_code',
  'version',
  'host',
  'port',
  'message',
]);

// Defence in depth for the case where a URL carrying a credential is logged
// before that credential has been registered: redact well-known secret query
// parameters unconditionally, not only when the value is already known.
const SECRET_QUERY_PARAM = /([?&](?:bridge_key|api[_-]?key|access[_-]?token|auth[_-]?token|token|key)=)[^&\s"']+/gi;

export function createLogger({ path, enabled = true, rotation = {} } = {}) {
  const secrets = new Set();
  if (path && enabled) mkdirSync(dirname(path), { recursive: true });

  function scrub(value) {
    if (typeof value !== 'string') return value;
    let out = value.replace(SECRET_QUERY_PARAM, '$1[redacted]');
    for (const s of secrets) {
      if (s && s.length >= 8) out = out.split(s).join('[redacted]');
    }
    return out;
  }

  return {
    registerSecret(secret) {
      if (typeof secret === 'string' && secret.length > 0) secrets.add(secret);
    },
    log(fields) {
      const line = {};
      for (const [k, v] of Object.entries(fields)) {
        if (!ALLOWED_FIELDS.has(k)) continue;
        line[k] = scrub(v);
      }
      if (!line.ts) line.ts = new Date().toISOString();
      const text = JSON.stringify(line);
      if (path && enabled) {
        try {
          rotateBeforeAppend(path, Buffer.byteLength(text + '\n'), rotation);
          appendFileSync(path, text + '\n');
        } catch {
          /* logging must never break the bridge */
        }
      }
      return text;
    },
  };
}

export const LOG_FIELDS = ALLOWED_FIELDS;
