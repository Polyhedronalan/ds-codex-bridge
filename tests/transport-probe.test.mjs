import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { probeTransport } from '../tools/test-transport.mjs';
const isolatedEnv = () => ({ BRIDGE_CHATGPT_PROXY: '', BRIDGE_CONFIG: path.join(os.tmpdir(), `absent-bridge-probe-${randomUUID()}.json`) });

test('transport probe sends HEAD without credentials and keeps TLS validation enabled', async () => {
  let destroyed = false;
  const result = await probeTransport('chatgpt', async options => {
    assert.equal(options.method, 'HEAD');
    assert.equal(options.body, null);
    assert.equal(options.tls.reject_unauthorized, true);
    assert.deepEqual(Object.keys(options.headers), ['user-agent']);
    assert.equal(new URL(options.url).search, '');
    return { status: 403, stream: { destroy() { destroyed = true; } } };
  }, isolatedEnv());
  assert.equal(destroyed, true);
  assert.equal(result.transport_reachable, true);
  assert.equal(result.scope, 'transport_only');
  assert.equal(result.status, 403);
  assert.match(result.reason, /not_model_verification/);
});

test('transport probe reports TLS failure without leaking error text or proxy credentials', async () => {
  const result = await probeTransport('chatgpt', async () => {
    const err = new Error('TLS failed https://user:fixture-password@example.test/?api_key=fixture-secret');
    err.code = 'BRIDGE_UPSTREAM_UNAVAILABLE'; throw err;
  }, isolatedEnv());
  assert.equal(result.transport_reachable, false);
  assert.equal(result.reason, 'tls_handshake_failure');
  assert.equal(JSON.stringify(result).includes('fixture-secret'), false);
  assert.equal(JSON.stringify(result).includes('fixture-password'), false);
});
