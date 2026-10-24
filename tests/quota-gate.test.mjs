import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GptQuotaGate, evaluate } from '../gpt-quota-gate.mjs';

const snapshot = (used = 50) => ({ status: 'measured', measured_at: Date.now() / 1000,
  primary: { usedPercent: used, resetsAt: Date.now() / 1000 + 3600 },
  secondary: { usedPercent: 40, resetsAt: Date.now() / 1000 + 7200 } });

test('fresh distribution has no native quota dependency; DeepSeek bypasses an enabled gate', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bridge-gate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const gate = new GptQuotaGate(dir, () => { throw new Error('must not read native quota'); });
  assert.equal((await gate.check('gpt-test')).allowed, true);
  writeFileSync(path.join(dir, 'gpt-quota-gate.json'), JSON.stringify({ enabled: true, reserve_percent: 3 }));
  assert.equal((await gate.check('deepseek-test')).allowed, true);
});

test('quota boundary rejects 3% remaining and stale or incomplete official evidence', () => {
  assert.equal(evaluate(snapshot(97)).code, 'BRIDGE_GPT_QUOTA_RESERVE');
  assert.equal(evaluate(snapshot(96)).allowed, true);
  const stale = snapshot(); stale.measured_at -= 31;
  assert.equal(evaluate(stale).code, 'BRIDGE_GPT_QUOTA_UNKNOWN');
  const missing = snapshot(); delete missing.secondary;
  assert.equal(evaluate(missing).allowed, false);
});

test('enabled gate preserves the bounded cache on read failure and blocks without evidence', async t => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bridge-gate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, 'gpt-quota-gate.json'), JSON.stringify({ enabled: true, reserve_percent: 3 }));
  let fail = false;
  const gate = new GptQuotaGate(dir, async () => { if (fail) throw new Error('offline'); return snapshot(); });
  gate.retryDelayMs = 0;
  assert.equal((await gate.check('gpt-test')).allowed, true);
  fail = true;
  assert.equal((await gate.check('gpt-test')).code, 'BRIDGE_GPT_QUOTA_CACHED');
  gate.lastGood.saved_at -= 901;
  assert.equal((await gate.check('gpt-test')).code, 'BRIDGE_GPT_QUOTA_UNKNOWN');
});
