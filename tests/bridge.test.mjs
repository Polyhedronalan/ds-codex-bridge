/**
 * bridge/tests/bridge.test.mjs — minimal test set (node:test, zero dependencies).
 *
 * Run: node --test bridge/tests
 *
 * Every test spawns the real bridge entry point with a temporary config and
 * talks to it over HTTP, so config loading, startup checks, auth, routing,
 * normalization, retry policy and logging are all exercised for real.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Run the real source in an isolated directory. The production directory also
// holds DPAPI credentials, live quota policy/cache and lifecycle logs; stub tests
// must never read those, contact the account quota service, or write its state.
const SOURCE = path.join(HERE, '..');
const FIXTURE = mkdtempSync(path.join(tmpdir(), 'bridge-source-test-'));
for (const name of readdirSync(SOURCE)) {
  if (name.endsWith('.mjs')) copyFileSync(path.join(SOURCE, name), path.join(FIXTURE, name));
}
const BRIDGE = path.join(FIXTURE, 'bridge.mjs');
const LOCAL_KEY = 'test-local-key-0123456789abcdef';
const DEEPSEEK_KEY = 'test-deepseek-key-abcdefghijklmnop';

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** stub upstream: records requests, replies with `state.respond` */
async function startStub(respond) {
  const state = { requests: [], respond };
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    state.requests.push({ url: req.url, method: req.method, headers: req.headers, body });
    await state.respond(req, res, state);
  });
  const port = await freePort();
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return { state, server, port, url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

async function startBridge({ config = {}, env = {} } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'bridge-test-'));
  const port = await freePort();
  const cfg = {
    listen: { host: '127.0.0.1', port },
    log: { path: path.join(dir, 'bridge.jsonl') },
    ...config,
  };
  const cfgPath = path.join(dir, 'config.json');
  writeFileSync(cfgPath, JSON.stringify(cfg), 'utf8');
  const child = spawn(process.execPath, [BRIDGE], {
    windowsHide: true,
    env: {
      ...process.env,
      BRIDGE_CONFIG: cfgPath,
      DEEPSEEK_API_KEY: DEEPSEEK_KEY,
      BRIDGE_LOCAL_KEY: LOCAL_KEY,
      HTTPS_PROXY: '',
      HTTP_PROXY: '',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`bridge exited early (${child.exitCode}): ${stderr || stdout}`);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`);
      if (r.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`bridge did not start: ${stderr || stdout}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    port,
    dir,
    logPath: path.join(dir, 'bridge.jsonl'),
    base: `http://127.0.0.1:${port}`,
    get output() {
      return stdout + stderr;
    },
    stop: () =>
      new Promise((resolve) => {
        child.once('exit', resolve);
        child.kill();
      }),
  };
}

function post(base, body, { key = LOCAL_KEY, param = 'bridge_key', headers = {} } = {}) {
  const url = new URL(base + '/responses');
  if (key !== null) url.searchParams.set(param, key);
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/** the bridge writes its request log from another process; poll until it appears */
async function waitForLog(logPath, predicate, { timeoutMs = 3000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const text = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
    if (predicate(text)) return text;
    if (Date.now() > deadline) {
      throw new Error(`log condition not met within ${timeoutMs}ms; log was:\n${text}`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

const sse = (payloads) => payloads.map((p) => `data: ${JSON.stringify(p)}\n\n`).join('');

test('zero concurrency limit admits eight simultaneous requests without a queue', async (t) => {
  const pending = [];
  const stub = await startStub((req, res) => { pending.push(res); });
  const bridge = await startBridge({ config: {
    limits: { max_concurrency: 0 },
    upstreams: { deepseek: { base_url: stub.url, proxy: null } },
  } });
  t.after(async () => { await bridge.stop(); stub.server.closeAllConnections(); await stub.close(); });
  const requests = Array.from({ length: 8 }, () => post(bridge.base, { model: 'deepseek-flash', input: [] }));
  const deadline = Date.now() + 3000;
  while (pending.length < 8 && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
  const admitted = pending.length;
  for (const res of pending) res.end('OK');
  const responses = await Promise.all(requests);
  assert.equal(admitted, 8, 'all requests must reach upstream before any completes');
  for (const response of responses) {
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'OK');
  }
});

for (const kind of ['idle', 'total', 'premature-close']) {
  test(`stream ${kind}: slot recovers without restarting bridge`, async (t) => {
    let first = true;
    const stub = await startStub((req, res) => {
      if (!first) { res.end('OK'); return; }
      first = false;
      res.writeHead(200); res.write('chunk');
      if (kind === 'premature-close') setTimeout(() => res.destroy(), 30);
    });
    const bridge = await startBridge({ config: {
      upstreams: { deepseek: { base_url: stub.url, proxy: null } },
      limits: { max_concurrency: 1, idle_timeout_ms: kind === 'idle' ? 100 : 5000,
        total_timeout_ms: kind === 'total' ? 150 : 5000 },
    } });
    t.after(async () => { await bridge.stop(); stub.server.closeAllConnections(); await stub.close(); });
    const res = await post(bridge.base, { model: 'deepseek-flash', input: [] });
    await assert.rejects(res.text());
    await waitForLog(bridge.logPath, text => text.includes('request_id'));
    const next = await post(bridge.base, { model: 'deepseek-flash', input: [] });
    assert.equal(next.status, 200); assert.equal(await next.text(), 'OK');
  });
}

for (const phase of ['before-headers', 'during-stream']) {
  test(`cancel ${phase}: upstream closes and concurrency slot recovers repeatedly`, async (t) => {
    let first = true;
    let closed = 0;
    let arrived;
    const stub = await startStub((req, res) => {
      if (!first) { res.end('OK'); return; }
      first = false;
      res.once('close', () => closed++);
      if (phase === 'during-stream') { res.writeHead(200); res.write('chunk'); }
      arrived();
    });
    const bridge = await startBridge({ config: {
      upstreams: { deepseek: { base_url: stub.url, proxy: null } },
      limits: { max_concurrency: 1 },
    } });
    t.after(async () => { await bridge.stop(); stub.server.closeAllConnections(); await stub.close(); });
    for (let round = 0; round < 5; round++) {
      first = true;
      const ready = new Promise(r => { arrived = r; });
      const req = http.request(bridge.base + '/responses', { method: 'POST', headers: {
        'content-type': 'application/json', 'x-codex-bridge-key': LOCAL_KEY,
      } }, res => res.on('error', () => {}));
      req.on('error', () => {});
      req.end(JSON.stringify({ model: 'deepseek-flash', input: [] }));
      await ready;
      req.destroy(); req.destroy();
      await waitForLog(bridge.logPath, text => text.split('\n').filter(l => l.includes('BRIDGE_CLIENT_CANCELLED')).length >= round + 1);
      const deadline = Date.now() + 2000;
      while (closed < round + 1 && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
      assert.equal(closed, round + 1, 'upstream must actually close');
      const next = await post(bridge.base, { model: 'deepseek-flash', input: [] });
      assert.equal(next.status, 200);
      assert.equal(await next.text(), 'OK');
    }
  });
}

test('health endpoint reports version and configuration flags', async (t) => {
  const bridge = await startBridge();
  t.after(() => bridge.stop());
  const res = await fetch(bridge.base + '/health');
  const json = await res.json();
  assert.equal(res.status, 200);
  assert.equal(json.status, 'ok');
  assert.equal(json.version, '0.1.0');
  assert.equal(json.deepseek_configured, true);
  assert.equal(json.proxy_configured, false);
  assert.equal(json.local_auth, 'configured');
});

test('routing: deepseek-* goes to the DeepSeek upstream with its own bearer', async (t) => {
  const stub = await startStub((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(sse([{ type: 'response.output_text.delta', delta: 'ok' }]));
  });
  const bridge = await startBridge({
    config: { upstreams: { deepseek: { base_url: stub.url, proxy: null } } },
  });
  t.after(async () => {
    await bridge.stop();
    await stub.close();
  });
  const res = await post(bridge.base, { model: 'deepseek-flash', input: [] }, { headers: { authorization: 'Bearer chatgpt-oauth-token', 'chatgpt-account-id': 'acct' } });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), sse([{ type: 'response.output_text.delta', delta: 'ok' }]));
  assert.equal(stub.state.requests.length, 1);
  const seen = stub.state.requests[0];
  assert.equal(seen.url, '/responses');
  assert.equal(seen.headers.authorization, `Bearer ${DEEPSEEK_KEY}`);
  assert.equal(seen.headers['chatgpt-account-id'], undefined, 'ChatGPT account header must not leak to DeepSeek');
  assert.ok(!seen.url.includes('bridge_key'), 'local auth param must be stripped before forwarding');
});

test('large normalized DeepSeek history keeps Unicode scalar values intact', async (t) => {
  const stub = await startStub((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  const bridge = await startBridge({
    config: { upstreams: { deepseek: { base_url: stub.url, proxy: null } } },
  });
  t.after(async () => {
    await bridge.stop();
    await stub.close();
  });

  const body = {
    model: 'deepseek-flash',
    tools: [{ type: 'function', name: 'exec_command' }],
    input: [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'x'.repeat(542_000) + '\\u' }],
      },
      { type: 'custom_tool_call', name: 'exec', call_id: 'foreign-call', input: 'a'.repeat(799) + '\u{1f600}tail' },
      { type: 'custom_tool_call_output', call_id: 'foreign-call', output: 'b'.repeat(1499) + '\u{1f600}tail' },
      { type: 'message', role: 'user', content: 'Finish the latest task' },
      { type: 'function_call', name: 'exec_command', call_id: 'current', arguments: '{}' },
      { type: 'function_call_output', call_id: 'current', output: 'Latest check passed' },
    ],
  };
  const response = await post(bridge.base, body);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });

  const seen = stub.state.requests[0];
  const forwarded = JSON.parse(seen.body.toString('utf8'));
  assert.ok(seen.body.length > 500_000);
  assert.equal(forwarded.input.find(i => i.role === 'user').content[0].text.endsWith('\\u'), true);
  const record = forwarded.input.find((item) => item.type === 'message' && item.role === 'assistant');
  assert.ok(record.content[0].text.isWellFormed(), 'strict JSON decoders must not receive lone surrogates');
  assert.deepEqual(forwarded.input.slice(-3), body.input.slice(-3), 'the actual forwarded request preserves the latest task and native receipt');
  assert.ok(forwarded.input.indexOf(record) < forwarded.input.length - 3, 'foreign history cannot become latest evidence');
  assert.equal(forwarded.input[0].role, 'developer', 'transport note stays before current work');
});

test('routing: gpt-* goes to the ChatGPT upstream with passthrough auth and body', async (t) => {
  const payload = { model: 'gpt-5.6-sol', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] }], stream: true };
  const stub = await startStub((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: [DONE]\n\n');
  });
  const bridge = await startBridge({ config: { upstreams: { chatgpt: { base_url: stub.url, proxy: null } } } });
  t.after(async () => {
    await bridge.stop();
    await stub.close();
  });
  const res = await post(bridge.base, payload, { headers: { authorization: 'Bearer chatgpt-oauth-token', 'chatgpt-account-id': 'acct-123' } });
  assert.equal(res.status, 200);
  const seen = stub.state.requests[0];
  assert.equal(seen.headers.authorization, 'Bearer chatgpt-oauth-token');
  assert.equal(seen.headers['chatgpt-account-id'], 'acct-123');
  assert.deepEqual(JSON.parse(seen.body.toString('utf8')), payload, 'compatible payload must be byte-for-byte passthrough');
});

test('unknown model is rejected locally with no upstream call', async (t) => {
  const stub = await startStub((req, res) => res.end('nope'));
  const bridge = await startBridge({
    config: { upstreams: { deepseek: { base_url: stub.url }, chatgpt: { base_url: stub.url } } },
  });
  t.after(async () => {
    await bridge.stop();
    await stub.close();
  });
  const res = await post(bridge.base, { model: 'llama-3', input: [] });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, 'BRIDGE_UNKNOWN_MODEL');
  assert.equal(stub.state.requests.length, 0);
  const log = await waitForLog(bridge.logPath, (t) => t.includes('"error_code":"BRIDGE_UNKNOWN_MODEL"'));
  assert.match(log, /"error_code":"BRIDGE_UNKNOWN_MODEL"/);
});

test('local auth: missing and wrong key are rejected, correct key passes', async (t) => {
  const stub = await startStub((req, res) => res.end('ok'));
  const bridge = await startBridge({ config: { upstreams: { deepseek: { base_url: stub.url } } } });
  t.after(async () => {
    await bridge.stop();
    await stub.close();
  });
  const missing = await post(bridge.base, { model: 'deepseek-flash' }, { key: null });
  assert.equal(missing.status, 401);
  assert.equal((await missing.json()).error.code, 'BRIDGE_AUTH_FAILED');
  const wrong = await post(bridge.base, { model: 'deepseek-flash' }, { key: 'wrong-key-wrong-key-wrong-key' });
  assert.equal(wrong.status, 401);
  const good = await post(bridge.base, { model: 'deepseek-flash' });
  assert.equal(good.status, 200);
  assert.equal(stub.state.requests.length, 1);
});

test('request body limit is enforced', async (t) => {
  const stub = await startStub((req, res) => res.end('ok'));
  const bridge = await startBridge({
    config: { limits: { max_body_bytes: 2048 }, upstreams: { deepseek: { base_url: stub.url } } },
  });
  t.after(async () => {
    await bridge.stop();
    await stub.close();
  });
  const res = await post(bridge.base, { model: 'deepseek-flash', pad: 'x'.repeat(4096) });
  assert.equal(res.status, 413);
  assert.equal((await res.json()).error.code, 'BRIDGE_REQUEST_TOO_LARGE');
  assert.equal(stub.state.requests.length, 0);
});

test('upstream timeout surfaces as BRIDGE_UPSTREAM_TIMEOUT without retry storm', async (t) => {
  const stub = await startStub(() => {
    /* never respond */
  });
  const bridge = await startBridge({
    config: {
      limits: { headers_timeout_ms: 300, total_timeout_ms: 600, idle_timeout_ms: 600 },
      retry: { max_retries_transient: 0 },
      upstreams: { deepseek: { base_url: stub.url } },
    },
  });
  t.after(async () => {
    await bridge.stop();
    await stub.close();
  });
  const res = await post(bridge.base, { model: 'deepseek-flash' });
  assert.equal(res.status, 504);
  assert.equal((await res.json()).error.code, 'BRIDGE_UPSTREAM_TIMEOUT');
  assert.equal(stub.state.requests.length, 1, 'must not retry with max_retries_transient=0');
});

test('DeepSeek reasoning replay is normalized for the ChatGPT upstream', async (t) => {
  const stub = await startStub((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: [DONE]\n\n');
  });
  const bridge = await startBridge({ config: { upstreams: { chatgpt: { base_url: stub.url, proxy: null } } } });
  t.after(async () => {
    await bridge.stop();
    await stub.close();
  });
  const body = {
    model: 'gpt-5.6-sol',
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'x' }] },
      {
        type: 'reasoning',
        id: 'rs_deepseek',
        summary: [],
        content: [{ type: 'reasoning_text', text: 'private deepseek reasoning' }],
        encrypted_content: '98df30b0-f0b6-412b-8d05-006f9ea77833-0',
      },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'y' }] },
    ],
  };
  const res = await post(bridge.base, body);
  assert.equal(res.status, 200);
  const forwarded = JSON.parse(stub.state.requests[0].body.toString('utf8'));
  const reasoning = forwarded.input.find((i) => i.type === 'reasoning');
  assert.deepEqual(reasoning.content, [], 'DeepSeek reasoning content must be emptied');
  assert.equal('encrypted_content' in reasoning, false, 'unverifiable encrypted_content must be removed');
  assert.equal(forwarded.input.length, 3, 'strip mode keeps the item');
  const log = await waitForLog(bridge.logPath, (t) => t.includes('"reasoning_items_normalized":1'));
  assert.match(log, /"reasoning_items_normalized":1/);
  assert.match(log, /"encrypted_content_removed":1/);
  assert.ok(!log.includes('private deepseek reasoning'), 'reasoning text must never be logged');
  assert.ok(!log.includes('98df30b0'), 'encrypted_content must never be logged');
});

test('compat drop mode removes the DeepSeek reasoning item entirely', async (t) => {
  const stub = await startStub((req, res) => res.end('ok'));
  const bridge = await startBridge({
    config: {
      compat: { deepseek_reasoning_replay: 'drop' },
      upstreams: { chatgpt: { base_url: stub.url, proxy: null } },
    },
  });
  t.after(async () => {
    await bridge.stop();
    await stub.close();
  });
  await post(bridge.base, {
    model: 'gpt-5.6-sol',
    input: [{ type: 'reasoning', content: [{ type: 'reasoning_text', text: 'r' }], encrypted_content: 'x' }],
  });
  const forwarded = JSON.parse(stub.state.requests[0].body.toString('utf8'));
  assert.equal(forwarded.input.length, 0);
});

test('SSE streaming is passed through unchanged', async (t) => {
  const frames = [
    { type: 'response.created' },
    { type: 'response.output_text.delta', delta: 'hello ' },
    { type: 'response.output_text.delta', delta: 'world' },
    { type: 'response.completed' },
  ];
  const stub = await startStub(async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    for (const f of frames) {
      res.write(`data: ${JSON.stringify(f)}\n\n`);
      await new Promise((r) => setTimeout(r, 10));
    }
    res.end();
  });
  const bridge = await startBridge({ config: { upstreams: { deepseek: { base_url: stub.url } } } });
  t.after(async () => {
    await bridge.stop();
    await stub.close();
  });
  const res = await post(bridge.base, { model: 'deepseek-flash', stream: true });
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  assert.equal(await res.text(), sse(frames));
});

test('retry policy: transient 5xx retried once, 4xx never retried', async (t) => {
  let calls = 0;
  const flaky = await startStub((req, res) => {
    calls += 1;
    if (calls === 1) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"error":"boom"}');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: [DONE]\n\n');
  });
  const bridge = await startBridge({
    config: { retry: { max_retries_transient: 1 }, upstreams: { deepseek: { base_url: flaky.url } } },
  });
  t.after(async () => {
    await bridge.stop();
    await flaky.close();
  });
  const ok = await post(bridge.base, { model: 'deepseek-flash' });
  assert.equal(ok.status, 200);
  assert.equal(flaky.state.requests.length, 2);
  await waitForLog(bridge.logPath, (t) => t.includes('"retry_count":1'));

  let badCalls = 0;
  const bad = await startStub((req, res) => {
    badCalls += 1;
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end('{"error":{"code":"invalid_request_error"}}');
  });
  const bridge2 = await startBridge({
    config: { retry: { max_retries_transient: 2 }, upstreams: { deepseek: { base_url: bad.url } } },
  });
  t.after(async () => {
    await bridge2.stop();
    await bad.close();
  });
  const res = await post(bridge2.base, { model: 'deepseek-flash' });
  assert.equal(res.status, 400);
  assert.equal(badCalls, 1, '4xx must not be retried');
  await waitForLog(bridge2.logPath, (t) => t.includes('"error_code":"BRIDGE_PAYLOAD_INCOMPATIBLE"'));
});

test('local proxy outage: retried once and reported as BRIDGE_PROXY_UNAVAILABLE', async (t) => {
  // A proxy that accepts the TCP connection but never answers CONNECT models the
  // real failure mode: the local proxy (Clash/mihomo) is up but not ready yet.
  const sockets = [];
  const accepted = [];
  const stalled = net.createServer((socket) => {
    accepted.push(Date.now());
    sockets.push(socket);
    socket.on('error', () => {});
  });
  const proxyPort = await freePort();
  await new Promise((r) => stalled.listen(proxyPort, '127.0.0.1', r));
  t.after(async () => {
    for (const s of sockets) s.destroy();
    await new Promise((r) => stalled.close(r));
  });

  const bridge = await startBridge({
    config: {
      startup: { proxy_check: false },
      limits: { connect_timeout_ms: 300 },
      retry: { max_retries_transient: 1 },
      upstreams: { chatgpt: { proxy: `http://127.0.0.1:${proxyPort}` } },
    },
  });
  t.after(() => bridge.stop());

  const res = await post(bridge.base, { model: 'gpt-5.6-sol' });
  assert.equal(res.status, 502);
  const body = await res.json();
  assert.equal(body.error.code, 'BRIDGE_PROXY_UNAVAILABLE');
  assert.equal(accepted.length, 2, 'a stalled local proxy must be retried once');
  await waitForLog(bridge.logPath, (text) => text.includes('"error_code":"BRIDGE_PROXY_UNAVAILABLE"'));
});

test('concurrency limit returns BRIDGE_BUSY', async (t) => {
  const stub = await startStub(async (req, res) => {
    await new Promise((r) => setTimeout(r, 400));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: [DONE]\n\n');
  });
  const bridge = await startBridge({
    config: { limits: { max_concurrency: 1 }, upstreams: { deepseek: { base_url: stub.url } } },
  });
  t.after(async () => {
    await bridge.stop();
    await stub.close();
  });
  const [a, b] = await Promise.all([post(bridge.base, { model: 'deepseek-flash' }), post(bridge.base, { model: 'deepseek-flash' })]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 503]);
  const busy = a.status === 503 ? a : b;
  assert.equal((await busy.json()).error.code, 'BRIDGE_BUSY');
});

test('startup fails closed on non-loopback host and on unreachable proxy', async (t) => {
  const badHost = await startBridge({ config: { listen: { host: '0.0.0.0' } } }).catch((e) => e);
  assert.ok(badHost instanceof Error, 'bridge must refuse a non-loopback listener');
  assert.match(String(badHost.message), /exited early/);

  const dir = mkdtempSync(path.join(tmpdir(), 'bridge-test-'));
  const cfgPath = path.join(dir, 'config.json');
  writeFileSync(cfgPath, JSON.stringify({ listen: { host: '127.0.0.1', port: await freePort() }, log: { path: path.join(dir, 'log.jsonl') } }));
  const child = spawn(process.execPath, [BRIDGE], {
    env: { ...process.env, BRIDGE_CONFIG: cfgPath, DEEPSEEK_API_KEY: DEEPSEEK_KEY, BRIDGE_LOCAL_KEY: LOCAL_KEY, BRIDGE_CHATGPT_PROXY: 'http://127.0.0.1:1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  const code = await new Promise((r) => child.once('exit', r));
  assert.equal(code, 2);
  assert.match(stderr, /BRIDGE_PROXY_UNAVAILABLE/);
  assert.match(readFileSync(path.join(dir, 'log.jsonl'), 'utf8'), /BRIDGE_PROXY_UNAVAILABLE/);
});

test('logging allowlist: no secret values and only allowed fields', async (t) => {
  const stub = await startStub((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: [DONE]\n\n');
  });
  const bridge = await startBridge({ config: { upstreams: { deepseek: { base_url: stub.url } } } });
  t.after(async () => {
    await bridge.stop();
    await stub.close();
  });
  await post(bridge.base, { model: 'deepseek-flash', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'top-secret-prompt-body' }] }] }, {
    headers: { authorization: 'Bearer super-secret-oauth-token', 'chatgpt-account-id': 'acct-should-not-be-logged' },
  });
  await waitForLog(bridge.logPath, (t) => t.trim().split('\n').filter(Boolean).length >= 2);
  const raw = readFileSync(bridge.logPath, 'utf8');
  const lines = raw.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(lines.length >= 2);
  const allowed = new Set(['ts', 'event', 'request_id', 'model', 'upstream', 'status', 'latency_ms', 'retry_count', 'normalization_counts', 'error_code', 'version', 'host', 'port', 'message']);
  for (const line of lines) {
    for (const key of Object.keys(line)) assert.ok(allowed.has(key), `unexpected log field: ${key}`);
  }
  for (const secret of [LOCAL_KEY, DEEPSEEK_KEY, 'super-secret-oauth-token', 'top-secret-prompt-body', 'acct-should-not-be-logged']) {
    assert.ok(!raw.includes(secret), `secret leaked into log: ${secret}`);
  }
  assert.ok(existsSync(bridge.logPath));
});
