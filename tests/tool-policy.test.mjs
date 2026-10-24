import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeRequest } from '../compat.mjs';
import { TOOL_CONVENTION_GUARD } from '../tool-policy.mjs';

const old = JSON.parse(readFileSync(new URL('./fixtures/tool-policy-legacy-guard.json', import.meta.url))).guard;
const custom = { type: 'namespace', name: 'functions', tools: [{ type: 'custom', name: 'exec', description: '### `exec_command`\nRun terminal commands.' }] };
const shape = mode => mode === 'code_mode'
  ? { tools: [], input: [{ type: 'additional_tools', role: 'developer', tools: [custom] }] }
  : { tools: [{ type: 'function', name: 'exec_command' }], input: [] };
const repair = q => normalizeRequest(Buffer.from(JSON.stringify(q)), { upstream: q.model.startsWith('gpt') ? 'chatgpt' : 'deepseek', mode: 'strip' });

test('frozen incident base and switch hints follow declared tools in either mode', () => {
  for (const mode of ['function', 'code_mode']) {
    const q = { model: mode === 'function' ? 'deepseek-flash' : 'gpt-6.1-sol', ...shape(mode) };
    q.instructions = old + '\nDo not run commands outside the authorized workspace.';
    q.input.push({ role: 'developer', content: [{ type: 'input_text', text: `<model_switch>\n${old}\n</model_switch>` }] });
    q.input.push({ role: 'developer', content: 'Never use functions.exec in this task.' });
    q.input.push({ role: 'user', content: old });
    q.input.push({ role: 'assistant', content: old });
    const before = JSON.stringify(q);
    const r = repair(q), after = JSON.parse(r.body);
    assert.equal(r.counts.tool_policy_guards_normalized, 2);
    assert.equal(after.instructions, TOOL_CONVENTION_GUARD + '\nDo not run commands outside the authorized workspace.');
    assert.equal(after.input.at(-3).content, 'Never use functions.exec in this task.');
    assert.equal(after.input.at(-2).content, old);
    assert.equal(after.input.at(-1).content, old);
    assert.deepEqual(after.tools, q.tools);
    if (mode === 'code_mode') assert.deepEqual(after.input[0], q.input[0]);
    assert.equal(JSON.stringify(q), before);
    const again = normalizeRequest(r.body, { upstream: 'chatgpt', mode: 'strip' });
    assert.equal(again.changed, false);
    assert.equal(again.body, r.body);
  }
});

test('unknown contracts and changed or unrelated prohibitions remain byte-identical', () => {
  const cases = [
    { model: 'gpt-6.1-sol', instructions: old, input: [] },
    { model: 'gpt-6.1-sol', ...shape('code_mode'), instructions: old.replace('Never call', 'NEVER call') },
    { model: 'gpt-6.1-sol', ...shape('code_mode'), instructions: 'Never use functions.exec.' },
  ];
  for (const q of cases) {
    const raw = Buffer.from(JSON.stringify(q));
    const r = normalizeRequest(raw, { upstream: 'chatgpt', mode: 'strip' });
    assert.equal(r.changed, false);
    assert.equal(r.body, raw);
  }
});

test('Windows CRLF serialization of the exact owned guard is repaired without altering surrounding text', () => {
  const q = { model: 'gpt-6.1-sol', ...shape('code_mode'), instructions: 'Keep\r\n' + old.replaceAll('\n', '\r\n') + '\r\nSafety policy' };
  const r = repair(q);
  assert.equal(r.counts.tool_policy_guards_normalized, 1);
  assert.equal(JSON.parse(r.body).instructions, 'Keep\r\n' + TOOL_CONVENTION_GUARD + '\r\nSafety policy');
});

test('repair preserves successful current calls and does not fabricate tools or receipts', () => {
  const q = { model: 'gpt-6.1-sol', ...shape('code_mode'), instructions: old };
  q.input.push({ type: 'custom_tool_call', name: 'exec', call_id: 'real', input: 'text(await tools.exec_command({cmd:"pwd"}))' });
  q.input.push({ type: 'custom_tool_call_output', call_id: 'real', output: 'real exit 0' });
  const r = repair(q), after = JSON.parse(r.body);
  assert.deepEqual(after.input, q.input);
  assert.deepEqual(after.tools, q.tools);
});

test('synthetic GPT-after-Flash fixture keeps exact tool tables and original disk bytes', () => {
  const file = new URL('./fixtures/gpt-after-deepseek.json', import.meta.url);
  const raw = readFileSync(file), q = JSON.parse(raw), r = normalizeRequest(raw, { upstream: 'chatgpt', mode: 'strip' });
  const after = JSON.parse(r.body);
  assert.ok(r.counts.tool_policy_guards_normalized > 0);
  assert.deepEqual(after.tools, q.tools);
  assert.deepEqual(after.input.filter(i => i.type === 'additional_tools'), q.input.filter(i => i.type === 'additional_tools'));
  assert.deepEqual(readFileSync(file), raw);
});

