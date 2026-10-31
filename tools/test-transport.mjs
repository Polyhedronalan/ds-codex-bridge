/** Credential-free HTTP/TLS probe. A response proves transport only, never model access. */
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadConfig } from '../config.mjs';
import { resolveProxySpec, performRequest } from '../upstreams.mjs';

export async function probeTransport(upstream, request = performRequest, env = process.env) {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const cfg = loadConfig({ env: { ...env, BRIDGE_CONFIG: env.BRIDGE_CONFIG || path.join(root, 'config.json') }, cwd: root });
  if (!['chatgpt', 'deepseek'].includes(upstream)) throw Error('unsupported upstream');
  const url = new URL(cfg.upstreams[upstream].base_url.replace(/\/$/, '') + '/responses');
  if (url.username || url.password || url.search) throw Error('probe requires a credential-free base URL');
  const proxy = resolveProxySpec(cfg.upstreams[upstream].proxy, { env, host: url.hostname });
  const result = { upstream, proxy: proxy ? 'configured' : 'direct', transport_reachable: false, scope: 'transport_only' };
  try {
    const response = await request({ method: 'HEAD', url: url.href,
      headers: { 'user-agent': 'CodexBridge-TransportCheck' }, body: null, proxy,
      timeouts: { connect_timeout_ms: 3500, headers_timeout_ms: 5000, idle_timeout_ms: 3000, total_timeout_ms: 7000 },
      tls: { reject_unauthorized: true } });
    response.stream.destroy();
    return { ...result, transport_reachable: true, status: response.status, reason: 'http_response_received_not_model_verification' };
  } catch (error) {
    // Never print raw errors/URLs: proxy URLs may carry credentials.
    let reason = 'connection_failure';
    if (/tls|certificate/i.test(error.message || '')) reason = 'tls_handshake_failure';
    else if (/timeout|timed out/i.test(error.message || '')) reason = 'timeout';
    else if (error.code === 'BRIDGE_PROXY_UNAVAILABLE') reason = 'proxy_connect_failure';
    return { ...result, reason };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await probeTransport(process.argv[2] || 'chatgpt');
    process.stdout.write(JSON.stringify(result) + '\n');
    process.exitCode = result.transport_reachable ? 0 : 2;
  } catch {
    process.stdout.write(JSON.stringify({ scope: 'transport_only', transport_reachable: false, reason: 'configuration_or_probe_error' }) + '\n');
    process.exitCode = 1;
  }
}
