/**
 * bridge/upstreams.mjs — upstream selection, proxy resolution and request execution.
 *
 * Proxying is explicit and per upstream (DeepSeek can stay direct while ChatGPT
 * goes through a local proxy). No dependency: an HTTP CONNECT tunnel is opened
 * with node:http and upgraded with node:tls, then handed to node:https as the
 * connection factory.
 */
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';

export function selectUpstream(model) {
  const m = typeof model === 'string' ? model : '';
  if (m.startsWith('deepseek-')) return 'deepseek';
  if (m.startsWith('gpt-')) return 'chatgpt';
  return null;
}

function proxyError(message, code = 'BRIDGE_PROXY_UNAVAILABLE') {
  const err = new Error(message);
  err.code = code;
  return err;
}

function hostMatchesNoProxy(host, noProxy) {
  if (!noProxy) return false;
  const list = String(noProxy)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return list.some((entry) => {
    if (entry === '*') return true;
    const e = entry.startsWith('.') ? entry.slice(1) : entry;
    return host === e || host.endsWith('.' + e);
  });
}

/**
 * spec: null | 'none' | 'env:VAR' | 'http://host:port'
 */
export function resolveProxySpec(spec, { env = process.env, host } = {}) {
  if (!spec || spec === 'none') return null;
  let url = null;
  if (typeof spec === 'string' && spec.startsWith('env:')) {
    const name = spec.slice(4);
    const value = env[name] || env[name.toLowerCase()] || null;
    if (!value) return null;
    url = value;
  } else if (typeof spec === 'string') {
    url = spec;
  } else if (typeof spec === 'object' && spec.url) {
    url = spec.url;
  }
  if (!url) return null;
  if (host && hostMatchesNoProxy(host, spec?.no_proxy ?? env.NO_PROXY ?? env.no_proxy)) return null;
  return url;
}

export function checkProxy(proxyUrl, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(proxyUrl);
    } catch {
      reject(proxyError(`proxy url is not parseable: ${proxyUrl}`));
      return;
    }
    const socket = net.connect({ host: parsed.hostname, port: Number(parsed.port || 80) });
    const done = (fn, arg) => {
      socket.removeAllListeners();
      socket.destroy();
      fn(arg);
    };
    socket.setTimeout(timeoutMs, () => done(reject, proxyError(`proxy ${parsed.host}:${parsed.port} did not accept a connection within ${timeoutMs}ms`)));
    socket.once('connect', () => done(resolve));
    socket.once('error', (err) => done(reject, proxyError(`proxy ${parsed.host}:${parsed.port} unreachable: ${err.message}`)));
  });
}

function openTunnel(proxyUrl, target, { connectTimeoutMs, rejectUnauthorized, signal }) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const proxy = new URL(proxyUrl);
    const headers = { host: `${target.host}:${target.port}` };
    if (proxy.username || proxy.password) {
      const creds = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
      headers['proxy-authorization'] = 'Basic ' + Buffer.from(creds).toString('base64');
    }
    const req = http.request({
      host: proxy.hostname,
      port: Number(proxy.port || 80),
      method: 'CONNECT',
      path: `${target.host}:${target.port}`,
      headers,
      agent: false,
      signal,
    });
    req.setTimeout(connectTimeoutMs, () => {
      req.destroy();
      reject(proxyError(`proxy CONNECT to ${target.host}:${target.port} timed out after ${connectTimeoutMs}ms`));
    });
    req.once('error', (err) => reject(proxyError(`proxy ${proxy.host}:${proxy.port} error: ${err.message}`)));
    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(proxyError(`proxy CONNECT rejected with status ${res.statusCode}`));
        return;
      }
      socket.setNoDelay(true);
      const secure = tls.connect({ socket, servername: target.host, rejectUnauthorized: rejectUnauthorized !== false });
      const abort = () => secure.destroy(signal.reason);
      signal?.addEventListener('abort', abort, { once: true });
      const cleanup = () => signal?.removeEventListener('abort', abort);
      secure.once('close', cleanup);
      secure.setTimeout(connectTimeoutMs, () => secure.destroy(proxyError('proxy TLS handshake timed out')));
      secure.once('secureConnect', () => {
        secure.setTimeout(0);
        cleanup();
        resolve(secure);
      });
      secure.once('error', (err) => {
        const e = new Error(`tls through proxy failed for ${target.host}: ${err.message}`);
        e.code = 'BRIDGE_UPSTREAM_UNAVAILABLE';
        reject(e);
      });
      if (signal?.aborted) abort();
    });
    req.end();
  });
}

/**
 * Executes one upstream request (no retry here — policy lives in bridge.mjs).
 * @returns {Promise<{status:number, headers:object, stream:import('node:stream').Readable}>}
 */
export async function performRequest({ method, url, headers, body, proxy, timeouts, tls: tlsCfg, signal }) {
  signal?.throwIfAborted();
  const target = new URL(url);
  const isHttps = target.protocol === 'https:';
  const port = target.port ? Number(target.port) : isHttps ? 443 : 80;

  let agent;
  if (proxy && isHttps) {
    const socket = await openTunnel(proxy, { host: target.hostname, port }, {
      connectTimeoutMs: timeouts.connect_timeout_ms,
      rejectUnauthorized: tlsCfg?.reject_unauthorized,
      signal,
    });
    agent = new https.Agent({ keepAlive: false });
    agent.createConnection = () => socket;
  } else if (proxy) {
    // plain http through proxy: absolute-form request URI
    agent = new http.Agent({ keepAlive: false });
  }

  const mod = isHttps ? https : http;
  const requestOptions = {
    signal,
    method,
    host: target.hostname,
    port,
    path: target.pathname + target.search,
    headers,
    agent: agent ?? (isHttps ? new https.Agent({ keepAlive: false }) : new http.Agent({ keepAlive: false })),
  };
  if (proxy && !isHttps) {
    requestOptions.path = url; // absolute form
    const p = new URL(proxy);
    requestOptions.host = p.hostname;
    requestOptions.port = Number(p.port || 80);
  }

  return await new Promise((resolve, reject) => {
    const req = mod.request(requestOptions);
    const timeoutError = (what) => {
      const err = new Error(`upstream ${what} timeout after ${timeouts[what + '_timeout_ms']}ms (${target.host})`);
      err.code = 'BRIDGE_UPSTREAM_TIMEOUT';
      return err;
    };
    let headersTimer = setTimeout(() => {
      req.destroy(timeoutError('headers'));
      reject(timeoutError('headers'));
    }, timeouts.headers_timeout_ms);
    const totalTimer = setTimeout(() => {
      req.destroy(timeoutError('total'));
      reject(timeoutError('total'));
    }, timeouts.total_timeout_ms);

    req.once('response', (res) => {
      clearTimeout(headersTimer);
      res.setTimeout(timeouts.idle_timeout_ms, () => {
        res.destroy(timeoutError('idle'));
      });
      res.once('close', () => clearTimeout(totalTimer));
      resolve({ status: res.statusCode ?? 502, headers: res.headers, stream: res });
    });
    req.once('error', (err) => {
      clearTimeout(headersTimer);
      clearTimeout(totalTimer);
      if (err.code === 'ECONNREFUSED' || err.code === 'EHOSTUNREACH' || err.code === 'ENETUNREACH' || err.code === 'ENOTFOUND' || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.code === 'EAI_AGAIN') {
        const e = new Error(`upstream ${target.host} unreachable: ${err.code}`);
        e.code = 'BRIDGE_UPSTREAM_UNAVAILABLE';
        reject(e);
        return;
      }
      reject(err);
    });
    if (body && body.length > 0) req.write(body);
    req.end();
  });
}
