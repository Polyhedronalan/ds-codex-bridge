#!/usr/bin/env node
/**
 * bridge/bridge.mjs — Production Candidate v0.1
 *
 * A very thin Codex Responses compatibility bridge:
 *   receive Codex Responses request
 *   -> pick upstream by model
 *   -> minimal compatibility normalization
 *   -> stream the upstream response back unchanged
 *
 * There is no fallback of any kind: an unknown model is rejected, and a failed
 * upstream is reported as a failure (never silently re-routed to another
 * provider, never to api.openai.com).
 *
 * Run: node bridge.mjs        (config: ./config.json, secrets: env or DPAPI file)
 */
import http from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, isLoopback } from './config.mjs';
import { GptQuotaGate } from './gpt-quota-gate.mjs';
import { createLogger } from './logger.mjs';
import { rotateBeforeAppend } from './log-rotation.mjs';
import { loadSecrets, checkLocalAuth } from './security.mjs';
import { normalizeRequest, EMPTY_COUNTS } from './compat.mjs';
import { selectUpstream, resolveProxySpec, checkProxy, performRequest } from './upstreams.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const gptQuotaGate = new GptQuotaGate(HERE);
const LIFECYCLE_LOG = path.join(HERE, 'logs', 'lifecycle.jsonl');
let lifecycleExitReason = 'process_exit';
let lifecycleExitWritten = false;

function sanitizedFatalKind(value) {
  const kind =
    value && typeof value === 'object'
      ? value.code || value.name || value.constructor?.name
      : typeof value;
  return String(kind || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80);
}

function writeLifecycleExit(exitCode, reason) {
  if (lifecycleExitWritten) return;
  lifecycleExitWritten = true;
  const record = {
    timestamp: new Date().toISOString(),
    event: 'bridge_exit',
    supervisor_pid: process.ppid || null,
    bridge_pid: process.pid,
    parent_pid: process.ppid || null,
    exit_code: Number.isInteger(exitCode) ? exitCode : null,
    restart_count: null,
    reason: String(reason || 'process_exit').slice(0, 120),
    health: '',
  };
  try {
    mkdirSync(path.dirname(LIFECYCLE_LOG), { recursive: true });
    const text = JSON.stringify(record) + '\n';
    rotateBeforeAppend(LIFECYCLE_LOG, Buffer.byteLength(text));
    appendFileSync(LIFECYCLE_LOG, text);
  } catch {
    // Fatal lifecycle logging must not replace the original exit reason.
  }
}

process.once('uncaughtException', (err) => {
  lifecycleExitReason = `uncaughtException:${sanitizedFatalKind(err)}`;
  process.stderr.write(`bridge fatal: ${lifecycleExitReason}\n`);
  process.exit(1);
});

process.once('unhandledRejection', (reason) => {
  lifecycleExitReason = `unhandledRejection:${sanitizedFatalKind(reason)}`;
  process.stderr.write(`bridge fatal: ${lifecycleExitReason}\n`);
  process.exit(1);
});

process.once('exit', (code) => {
  writeLifecycleExit(code, lifecycleExitReason);
});

const HOP_BY_HOP = new Set([
  'host',
  'connection',
  'content-length',
  'transfer-encoding',
  'keep-alive',
  'proxy-connection',
  'proxy-authorization',
  'te',
  'trailer',
  'upgrade',
  'accept-encoding',
]);
const RESPONSE_DROP = new Set(['connection', 'content-length', 'transfer-encoding', 'keep-alive']);

const cfg = loadConfig();
const logger = createLogger({
  path: cfg.log.path,
  rotation: { maxBytes: cfg.log.max_bytes, maxFiles: cfg.log.max_files },
});
// Diagnostics are opt-in through the environment and only ever emit *shape*
// information (event/item type names, request field names) - never content.
const DIAG_BODY = process.env.BRIDGE_DIAG_BODY === '1';
const DIAG_RESPONSE = process.env.BRIDGE_DIAG_RESPONSE === '1';
// DPAPI file resolution: an explicit config path wins; otherwise the default file next to
// bridge.mjs is used when it exists (env vars still take precedence inside loadSecrets).
const secrets = loadSecrets({ dpapiFile: cfg.local_auth?.dpapi_file ?? path.join(HERE, 'secrets.dpapi.json') });
if (secrets.deepseekApiKey) logger.registerSecret(secrets.deepseekApiKey);
if (secrets.localKey) logger.registerSecret(secrets.localKey);
if (secrets.previousLocalKey) logger.registerSecret(secrets.previousLocalKey);

const PROXY_ARCHIVE = Object.fromEntries(
  Object.entries(cfg.upstreams).map(([name, up]) => [
    name,
    resolveProxySpec(up.proxy, { host: new URL(up.base_url).hostname }),
  ]),
);

function fail(code, message, status) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}

// Failures that are worth one more attempt: the upstream socket never came up,
// the upstream went silent, or the local proxy was not ready. Proxy warm-up
// (Clash/mihomo starting with the session) is the common cause, and the client
// sees a 502 for the whole window without this.
const TRANSIENT_UPSTREAM_CODES = new Set([
  'BRIDGE_UPSTREAM_UNAVAILABLE',
  'BRIDGE_UPSTREAM_TIMEOUT',
  'BRIDGE_PROXY_UNAVAILABLE',
]);
const TRANSIENT_RETRY_DELAY_MS = Number(process.env.BRIDGE_TRANSIENT_RETRY_DELAY_MS ?? 400);
const sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sendJson(res, status, code, message) {
  const payload = JSON.stringify({ error: { code, message } });
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
  res.end(payload);
}

function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let overflowed = false;
    req.on('data', (chunk) => {
      if (overflowed) return;
      total += chunk.length;
      if (total > maxBytes) {
        overflowed = true;
        chunks.length = 0;
        // Stop reading but do not destroy the socket: the 413 response must reach
        // the client first (the caller destroys it once the response is flushed).
        req.pause();
        reject(fail('BRIDGE_REQUEST_TOO_LARGE', `request body exceeds ${maxBytes} bytes`, 413));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!overflowed) resolve(Buffer.concat(chunks));
    });
    req.on('error', reject);
  });
}

function buildUpstreamHeaders(incoming, upstreamName, secretsForUpstream) {
  const headers = {};
  for (const [k, v] of Object.entries(incoming)) {
    const key = k.toLowerCase();
    if (HOP_BY_HOP.has(key)) continue;
    if (key === cfg.local_auth.header?.toLowerCase()) continue;
    if (key.startsWith('x-codex-bridge')) continue;
    headers[key] = v;
  }
  if (upstreamName === 'deepseek') {
    headers.authorization = `Bearer ${secretsForUpstream.deepseekApiKey}`;
    delete headers['chatgpt-account-id'];
  }
  return headers;
}

/** Shape-only description of an outgoing Responses request (no text content). */
function describeRequestShape(bodyBuf) {
  const out = { bytes: bodyBuf.length };
  let json;
  try {
    json = JSON.parse(bodyBuf.toString('utf8'));
  } catch {
    out.parse = 'failed';
    return out;
  }
  if (!json || typeof json !== 'object') return out;
  out.keys = Object.keys(json).sort().join(',');
  out.stream = json.stream ?? null;
  out.store = json.store ?? null;
  out.reasoning = json.reasoning === undefined ? null : JSON.stringify(json.reasoning);
  out.include = Array.isArray(json.include) ? json.include.join(',') : null;
  out.tool_choice = json.tool_choice ?? null;
  out.parallel_tool_calls = json.parallel_tool_calls ?? null;
  out.text = json.text === undefined ? null : JSON.stringify(json.text);
  out.prompt_cache_key = typeof json.prompt_cache_key === 'string' ? '(set)' : null;
  out.instructions_chars = typeof json.instructions === 'string' ? json.instructions.length : null;
  out.tools = Array.isArray(json.tools)
    ? json.tools.map((t) => (t?.type === 'function' ? t.name ?? 'function' : t?.type ?? '?')).join(',')
    : null;
  out.tools_count = Array.isArray(json.tools) ? json.tools.length : null;
  out.input_count = Array.isArray(json.input) ? json.input.length : null;
  out.input_types = Array.isArray(json.input)
    ? json.input.map((i) => (typeof i === 'string' ? 'string' : i?.type ?? '?')).join(',')
    : null;
  return out;
}

/** Counts upstream SSE `type` values (names only) without touching the bytes. */
function createResponseShapeScanner() {
  const counts = new Map();
  const timeline = [];
  let buf = '';
  let truncated = false;
  return {
    push(chunk) {
      buf += chunk.toString('utf8');
      if (buf.length > 262144) {
        buf = buf.slice(-131072);
        truncated = true;
      }
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let key = '(unparseable)';
        let itemType = null;
        let partType = null;
        try {
          const obj = JSON.parse(payload);
          key = obj?.type ?? '(no type)';
          itemType = obj?.item?.type ?? null;
          partType = obj?.part?.type ?? null;
        } catch {
          /* keep (unparseable) */
        }
        counts.set(key, (counts.get(key) ?? 0) + 1);
        if (timeline.length < 400) {
          timeline.push(key + (itemType ? `@${itemType}` : '') + (partType ? `#${partType}` : ''));
        }
      }
    },
    summary() {
      return {
        truncated,
        events: Object.fromEntries([...counts.entries()].sort((a, b) => b[1] - a[1])),
        timeline,
      };
    },
  };
}

function classifyUpstreamFailure(upstreamName, status) {
  if (status === 401 || status === 403) {
    return upstreamName === 'deepseek' ? 'BRIDGE_DEEPSEEK_AUTH_FAILED' : 'BRIDGE_CHATGPT_AUTH_FAILED';
  }
  if (status === 429) return 'BRIDGE_UPSTREAM_RATE_LIMITED';
  if (status >= 500) return 'BRIDGE_UPSTREAM_ERROR';
  if (status === 400) return 'BRIDGE_PAYLOAD_INCOMPATIBLE';
  return 'BRIDGE_UPSTREAM_ERROR';
}

let inFlight = 0;

const server = http.createServer(async (req, res) => {
  const startedAt = Date.now();
  const requestId = String(req.headers['x-client-request-id'] || req.headers['x-request-id'] || randomUUID());
  const url = new URL(req.url ?? '/', `http://${cfg.listen.host}:${cfg.listen.port}`);
  let model = null;
  let upstreamName = null;
  let retryCount = 0;
  let counts = { ...EMPTY_COUNTS };
  let errorCode = null;

  if (req.method === 'GET' && url.pathname === '/health') {
    const payload = JSON.stringify({
      status: 'ok',
      version: cfg.version,
      deepseek_configured: Boolean(secrets.deepseekApiKey),
      proxy_configured: Boolean(PROXY_ARCHIVE.chatgpt),
      local_auth: secrets.localKey ? 'configured' : 'disabled',
      in_flight: inFlight,
      gpt_quota_gate: gptQuotaGate.status(),
    });
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) });
    res.end(payload);
    return;
  }

  const auth = checkLocalAuth(req, url, cfg, secrets.localKey, {
    previousKey: secrets.previousLocalKey,
    previousUntil: secrets.previousLocalKeyUntil,
  });
  if (!auth.ok) {
    errorCode = 'BRIDGE_AUTH_FAILED';
    sendJson(res, 401, errorCode, `local bridge authentication failed (${auth.reason})`);
    logger.log({ request_id: requestId, model, upstream: null, status: 401, latency_ms: Date.now() - startedAt, retry_count: 0, error_code: errorCode, normalization_counts: counts });
    return;
  }

  if (cfg.limits.max_concurrency > 0 && inFlight >= cfg.limits.max_concurrency) {
    errorCode = 'BRIDGE_BUSY';
    sendJson(res, 503, errorCode, `bridge busy: ${inFlight}/${cfg.limits.max_concurrency} requests in flight`);
    logger.log({ request_id: requestId, model, upstream: null, status: 503, latency_ms: Date.now() - startedAt, retry_count: 0, error_code: errorCode, normalization_counts: counts });
    return;
  }
  inFlight += 1;
  const cancellation = new AbortController();
  const cancelDisconnected = () => {
    if (!res.writableFinished) cancellation.abort();
  };
  res.once('close', cancelDisconnected);
  req.once('aborted', cancelDisconnected);

  try {
    let body = await readBody(req, cfg.limits.max_body_bytes);
    const incomingBodyHash = DIAG_BODY ? createHash('sha256').update(body).digest('hex').slice(0, 16) : null;

    try {
      model = JSON.parse(body.toString('utf8')).model ?? null;
    } catch {
      model = null;
    }
    upstreamName = selectUpstream(model);
    if (!upstreamName) {
      throw fail('BRIDGE_UNKNOWN_MODEL', `no upstream configured for model=${model === null ? 'null' : JSON.stringify(model)}`, 400);
    }
    if (upstreamName === 'chatgpt') {
      const admission = await gptQuotaGate.check(model);
      if (!admission.allowed) {
        const reset = admission.resume_after ? ` resetsAt=${admission.resume_after}.` : '';
        throw fail(admission.code, `${admission.reason}.${reset} GPT blocked locally to preserve 3% quota; choose DeepSeek or wait for official quota reset.`, 409);
      }
    }
    if (upstreamName === 'deepseek' && !secrets.deepseekApiKey) {
      // Provider isolation: a missing DeepSeek credential fails only this request.
      throw fail('BRIDGE_DEEPSEEK_KEY_MISSING', 'DeepSeek is not configured on this bridge (no API key)', 503);
    }

    const upstreamCfg = cfg.upstreams[upstreamName];
    const normalized = normalizeRequest(body, {
      upstream: upstreamName,
      mode: cfg.compat.deepseek_reasoning_replay,
      toolContract: cfg.compat.tool_contract_history,
    });
    body = normalized.body;
    counts = normalized.counts;

    if (DIAG_BODY) {
      const forwardedHash = createHash('sha256').update(body).digest('hex').slice(0, 16);
      logger.log({
        event: 'request_body_shape',
        request_id: requestId,
        model,
        upstream: upstreamName,
        status: null,
        message: JSON.stringify({
          ...describeRequestShape(body),
          incoming_body_txid: incomingBodyHash,
          forwarded_body_txid: forwardedHash,
          forwarded_identical_to_incoming: incomingBodyHash === forwardedHash,
        }),
      });
    }

    const targetPath = auth.strippedPath ?? url.pathname;
    const forwardUrl = new URL(upstreamCfg.base_url.replace(/\/+$/, '') + targetPath);
    for (const [k, v] of url.searchParams) {
      if (cfg.local_auth.query_param && k === cfg.local_auth.query_param) continue;
      forwardUrl.searchParams.append(k, v);
    }
    const headers = buildUpstreamHeaders(req.headers, upstreamName, secrets);
    const proxy = PROXY_ARCHIVE[upstreamName];
    const attemptsAllowed = 1 + cfg.retry.max_retries_transient;

    let response = null;
    let lastError = null;
    for (let attempt = 1; attempt <= attemptsAllowed; attempt += 1) {
      retryCount = attempt - 1;
      try {
        response = await performRequest({
          method: req.method,
          url: forwardUrl.toString(),
          headers,
          body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
          proxy,
          timeouts: cfg.limits,
          tls: cfg.tls,
          signal: cancellation.signal,
        });
      } catch (err) {
        cancellation.signal.throwIfAborted();
        lastError = err;
        const transient = TRANSIENT_UPSTREAM_CODES.has(err.code);
        if (transient && attempt < attemptsAllowed) {
          if (TRANSIENT_RETRY_DELAY_MS > 0) await sleepMs(TRANSIENT_RETRY_DELAY_MS);
          continue;
        }
        throw err;
      }
      if (response.status >= 500 && attempt < attemptsAllowed) {
        response.stream.resume();
        response.stream.destroy();
        response = null;
        continue;
      }
      break;
    }
    if (!response) throw lastError ?? fail('BRIDGE_UPSTREAM_UNAVAILABLE', 'upstream unavailable', 502);

    if (response.status >= 400) errorCode = classifyUpstreamFailure(upstreamName, response.status);
    const outHeaders = {};
    for (const [k, v] of Object.entries(response.headers)) {
      if (RESPONSE_DROP.has(k.toLowerCase())) continue;
      outHeaders[k] = v;
    }
    if (cfg.log.diag_header_names) {
      logger.log({
        event: 'request_shape',
        request_id: requestId,
        model,
        upstream: upstreamName,
        status: response.status,
        message: 'incoming_headers=' + Object.keys(req.headers).sort().join(','),
      });
    }
    if (cancellation.signal.aborted || res.destroyed) {
      response.stream.destroy();
      cancellation.signal.throwIfAborted();
      throw fail('BRIDGE_CLIENT_CANCELLED', 'client disconnected', 499);
    }
    res.writeHead(response.status, outHeaders);
    const shapeScanner = DIAG_RESPONSE ? createResponseShapeScanner() : null;
    if (shapeScanner) response.stream.on('data', (chunk) => shapeScanner.push(chunk));
    await new Promise((resolve) => {
      const settle = () => {
        res.removeListener('close', settle);
        res.removeListener('finish', settle);
        response.stream.removeListener('error', failed);
        response.stream.removeListener('close', upstreamClosed);
        if (!response.stream.readableEnded) response.stream.destroy();
        resolve();
      };
      const failed = () => res.destroy();
      const upstreamClosed = () => {
        if (!response.stream.readableEnded) res.destroy();
      };
      res.once('close', settle);
      res.once('finish', settle);
      response.stream.once('error', failed);
      response.stream.once('close', upstreamClosed);
      if (res.destroyed || res.writableFinished) settle();
      else response.stream.pipe(res);
    });
    if (shapeScanner) {
      logger.log({
        event: 'response_shape',
        request_id: requestId,
        model,
        upstream: upstreamName,
        status: response.status,
        message: JSON.stringify(shapeScanner.summary()),
      });
    }
    logger.log({
      request_id: requestId,
      model,
      upstream: upstreamName,
      status: cancellation.signal.aborted ? 499 : response.status,
      latency_ms: Date.now() - startedAt,
      retry_count: retryCount,
      error_code: cancellation.signal.aborted ? 'BRIDGE_CLIENT_CANCELLED' : errorCode,
      normalization_counts: counts,
    });
  } catch (err) {
    errorCode = cancellation.signal.aborted ? 'BRIDGE_CLIENT_CANCELLED' : err.code ?? 'BRIDGE_UPSTREAM_UNAVAILABLE';
    const status = cancellation.signal.aborted ? 499 : err.status ?? (errorCode === 'BRIDGE_UPSTREAM_TIMEOUT' ? 504 : 502);
    if (!res.headersSent && !res.destroyed) {
      if (errorCode === 'BRIDGE_REQUEST_TOO_LARGE') {
        res.setHeader('connection', 'close');
        sendJson(res, status, errorCode, err.message);
        res.once('finish', () => req.destroy());
      } else {
        sendJson(res, status, errorCode, err.message);
      }
    }
    logger.log({
      request_id: requestId,
      model,
      upstream: upstreamName,
      status,
      latency_ms: Date.now() - startedAt,
      retry_count: retryCount,
      error_code: errorCode,
      normalization_counts: counts,
    });
  } finally {
    res.removeListener('close', cancelDisconnected);
    req.removeListener('aborted', cancelDisconnected);
    inFlight -= 1;
  }
});

server.requestTimeout = 0;
server.headersTimeout = 0;
server.keepAliveTimeout = 0;
server.timeout = 0;

async function startupChecks() {
  if (!isLoopback(cfg.listen.host)) {
    throw fail('BRIDGE_CONFIG_INVALID', `refusing to listen on non-loopback host ${cfg.listen.host}`, 500);
  }
  if (!secrets.deepseekApiKey) {
    // Provider isolation (2026-10-14): a missing DeepSeek credential must not take the whole
    // bridge down. Start degraded - the ChatGPT passthrough keeps working, /health reports
    // deepseek_configured=false, and deepseek-* requests get a precise per-request error.
    const message = cfg.startup.require_deepseek_key
      ? 'DEEPSEEK_API_KEY is not configured (env or DPAPI file); starting in degraded mode - deepseek-* requests will be refused'
      : 'DEEPSEEK_API_KEY is not configured; the deepseek branch is unavailable';
    logger.log({ event: 'startup_degraded', error_code: 'BRIDGE_DEEPSEEK_KEY_MISSING', message });
    process.stderr.write(`bridge degraded [BRIDGE_DEEPSEEK_KEY_MISSING]: ${message}\n`);
  }
  if (cfg.startup.proxy_check && PROXY_ARCHIVE.chatgpt) {
    await checkProxy(PROXY_ARCHIVE.chatgpt, cfg.startup.proxy_check_timeout_ms);
  }
}

try {
  await startupChecks();
} catch (err) {
  lifecycleExitReason = `startup_failed:${sanitizedFatalKind(err)}`;
  logger.log({ event: 'startup_failed', error_code: err.code ?? 'BRIDGE_STARTUP_FAILED', message: err.message });
  process.stderr.write(`bridge startup failed [${err.code ?? 'BRIDGE_STARTUP_FAILED'}]: ${err.message}\n`);
  process.exit(2);
}

server.listen(cfg.listen.port, cfg.listen.host, () => {
  logger.log({
    event: 'bridge_listen',
    version: cfg.version,
    host: cfg.listen.host,
    port: cfg.listen.port,
    message:
      `deepseek_key=${secrets.sources.deepseek} local_key=${secrets.sources.local} ` +
      `local_key_previous=${secrets.sources.localPrevious} ` +
      `chatgpt_proxy=${PROXY_ARCHIVE.chatgpt ? 'configured' : 'direct'} deepseek_proxy=${PROXY_ARCHIVE.deepseek ? 'configured' : 'direct'}`,
  });
  process.stdout.write(`bridge v${cfg.version} listening on http://${cfg.listen.host}:${cfg.listen.port}\n`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    lifecycleExitReason = signal;
    logger.log({ event: 'bridge_stop', message: signal });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
