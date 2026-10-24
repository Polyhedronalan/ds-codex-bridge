import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeToolContractHistory, readToolContract } from '../deepseek-history.mjs';

/**
 * Shapes below are trimmed copies of real 2026-10-14 captures:
 *  - `flashTools` is the DeepSeek function-tool table (no `exec`).
 *  - `codeModeTools` mirrors the `additional_tools` item of a GPT code-mode request
 *    (`custom exec` wrapping nested `exec_command`).
 */
const flashTools = [
  { type: 'function', name: 'exec_command' },
  { type: 'function', name: 'view_image' },
  { type: 'custom', name: 'apply_patch' },
  { type: 'namespace', name: 'collaboration', tools: [{ type: 'function', name: 'spawn_agent' }] },
];
const codeModeExec = {
  type: 'custom',
  name: 'exec',
  description:
    'Run JavaScript code to orchestrate/compose tool calls\n- All nested tools are available on the global `tools` object, ' +
    'for example `await tools.exec_command(...)`.\n\n### `exec_command`\nRuns a command in a PTY.\n',
};
const codeModeTools = [
  { type: 'namespace', name: 'functions', tools: [codeModeExec, { type: 'function', name: 'wait' }] },
];

const base = {
  model: 'deepseek-flash',
  tools: flashTools,
  input: [
    { role: 'user', content: 'Keep the original task' },
    { type: 'custom_tool_call', name: 'exec', call_id: 'gpt-work', input: "await tools.exec_command({cmd:'ok'})" },
    { type: 'custom_tool_call_output', call_id: 'gpt-work', output: 'Script completed\nexit 0\nreal work' },
    { type: 'reasoning', content: [{ text: 'attempt an invalid wrapper' }] },
    { type: 'function_call', name: 'exec', call_id: 'bad', arguments: '{}' },
    { type: 'function_call_output', call_id: 'bad', output: 'unsupported call: exec' },
    { type: 'function_call', name: 'exec_command', call_id: 'native', arguments: '{"cmd":"ok"}' },
    { type: 'function_call_output', call_id: 'native', output: 'real native output' },
  ],
};

const body = (value) => Buffer.from(JSON.stringify(value));
const inputOf = (result) => JSON.parse(result.body.toString('utf8')).input;
const noteOf = (result) => inputOf(result).find(i => i.role === 'developer' && i.content?.[0]?.text?.startsWith('Tool contract note')).content[0].text;
/** `null` (nothing analysable) or `changed: false` both mean byte passthrough. */
function assertUntouched(value, label) {
  const raw = body(value);
  const result = normalizeToolContractHistory(raw);
  if (result === null) return;
  assert.equal(result.changed, false, label);
  assert.equal(result.body, raw, `${label}: bytes must be untouched`);
}

test('rejected pair and its reasoning are dropped; real work is kept as a non-executable record', () => {
  const result = normalizeToolContractHistory(body(base));
  assert.equal(result.changed, true);
  assert.equal(result.counts.rejected_exec_items_removed, 3);
  assert.equal(result.counts.tool_contract_items_removed, 2);
  const input = inputOf(result);
  const record = input.find((i) => i.type === 'message' && i.role === 'assistant');
  assert.ok(record, 'the GPT code-mode exec call must be preserved as a record');
  assert.equal(record.content[0].type, 'output_text');
  assert.match(record.content[0].text, /Non-executable record/);
  assert.match(record.content[0].text, /call_id: gpt-work/, 'the original call id must stay traceable');
  assert.match(record.content[0].text, /real work/, 'the recorded result must be preserved');
  assert.equal(input.some((i) => i.type === 'custom_tool_call'), false, 'foreign wrapper must not be replayed');
  assert.equal(input.some((i) => i.type === 'function_call' && i.name === 'exec'), false, 'rejected call must be gone');
  assert.equal(input.some((i) => i.type === 'reasoning'), false, 'the thought that produced the rejection is dropped');
  assert.ok(input.some((i) => i.type === 'function_call' && i.name === 'exec_command'), 'registered call is kept');
  assert.match(noteOf(result), /^Tool contract note/);
  const again = normalizeToolContractHistory(result.body);
  assert.equal(again.changed, false, 'normalizing twice must be a no-op');
  assert.equal(again.body, result.body, 'and must return the same bytes');
});

test('structured unsupported receipt is recognised', () => {
  const value = structuredClone(base);
  value.input[5].output = [{ type: 'input_text', text: 'unsupported call: exec' }];
  assert.equal(normalizeToolContractHistory(body(value)).counts.rejected_exec_items_removed, 3);
});

test('compatible requests stay untouched', () => {
  const cases = {
    'no tool calls': { ...base, input: [{ role: 'user', content: 'hi' }] },
    'registered command tool': { ...base, input: [base.input[6], base.input[7]] },
    'namespaced child tool': {
      ...base,
      input: [
        { type: 'function_call', name: 'spawn_agent', call_id: 'n', arguments: '{}' },
        { type: 'function_call_output', call_id: 'n', output: 'child spawned' },
      ],
    },
    'custom apply_patch is native here': {
      ...base,
      input: [
        { type: 'custom_tool_call', name: 'apply_patch', call_id: 'p', input: '*** Begin Patch\n' },
        { type: 'custom_tool_call_output', call_id: 'p', output: 'done' },
      ],
    },
    'code mode request replaying its own wrapper': {
      model: 'gpt-6.1-sol',
      tools: [],
      input: [
        { type: 'additional_tools', role: 'developer', id: 'at_1', tools: codeModeTools },
        base.input[1],
        base.input[2],
      ],
    },
    'code mode request replaying a nested function call': {
      model: 'gpt-6.1-sol',
      tools: [],
      input: [
        { type: 'additional_tools', role: 'developer', id: 'at_1', tools: codeModeTools },
        base.input[6],
        base.input[7],
      ],
    },
    'request without any readable tool table': { model: 'gpt-6.1-sol', input: [base.input[4], base.input[5]] },
  };
  for (const [label, value] of Object.entries(cases)) {
    assertUntouched(value, label);
  }
});

test('a foreign call with no recorded result becomes an explicit UNKNOWN record', () => {
  const value = { ...base, input: [{ type: 'function_call', name: 'exec', call_id: 'dangling', arguments: '{}' }] };
  const result = normalizeToolContractHistory(body(value));
  assert.equal(result.changed, true, 'an unpaired foreign call must not stay a call item');
  const input = inputOf(result);
  assert.equal(result.counts.tool_contract_unknown_calls, 1);
  assert.equal(result.counts.tool_contract_records, 0);
  const record = input.find((i) => i.type === 'message' && i.role === 'assistant');
  assert.match(record.content[0].text, /status: UNKNOWN/);
  assert.match(record.content[0].text, /call_id: dangling/);
  assert.equal(input.some((i) => i.type === 'function_call'), false, 'the unpaired call is no longer a call');
  assert.match(noteOf(result), /UNKNOWN/);
});

test('a registered call with no receipt is left to the harness', () => {
  const value = { ...base, input: [{ type: 'function_call', name: 'exec_command', call_id: 'native-open', arguments: '{}' }] };
  assert.equal(normalizeToolContractHistory(body(value)).changed, false);
});

test('a registered call keeps its output adjacent when a foreign pair sits between them', () => {
  // Real harness order seen on a switched thread: the foreign code-mode pair is
  // interleaved inside a run of registered calls, and DeepSeek rejects the request
  // ("No tool output found for tool call ...") if a record is inserted there.
  const value = {
    ...base,
    input: [
      { type: 'function_call', name: 'exec_command', call_id: 'keep', arguments: '{"cmd":"a"}' },
      { type: 'custom_tool_call', name: 'exec', call_id: 'foreign', input: 'await tools.exec_command({cmd:"b"})' },
      { type: 'custom_tool_call_output', call_id: 'foreign', output: 'Script completed' },
      { type: 'function_call_output', call_id: 'keep', output: 'real output' },
    ],
  };
  const input = inputOf(normalizeToolContractHistory(body(value)));
  const callIndex = input.findIndex((i) => i.call_id === 'keep');
  assert.equal(input[callIndex + 1].call_id, 'keep', 'call and its output must stay adjacent');
  assert.equal(input[callIndex + 1].type, 'function_call_output');
  assert.equal(input.some((i) => i.call_id === 'foreign'), false, 'foreign pair removed');
  const record = input.filter((i) => i.type === 'message' && i.role === 'assistant');
  assert.equal(record.length, 1);
  assert.equal(input.indexOf(record[0]), input.length - 1, 'record follows the complete retained batch');
  assert.equal(input[0].role, 'developer', 'transport metadata does not become the latest instruction');
});

test('contract off keeps the validated rejection cleanup only', () => {
  const result = normalizeToolContractHistory(body(base), { contract: 'off' });
  const input = inputOf(result);
  assert.equal(result.counts.rejected_exec_items_removed, 3);
  assert.equal(result.counts.tool_contract_records, 0);
  assert.ok(input.some((i) => i.type === 'custom_tool_call' && i.name === 'exec'), 'foreign history untouched');
  assert.equal(input.some((i) => i.type === 'function_call' && i.name === 'exec'), false);
});

test('repeated rejections escalate to an explicit stop instruction', () => {
  const many = {
    ...base,
    input: [
      { role: 'user', content: 'task' },
      ...[1, 2].flatMap((n) => [
        { type: 'function_call', name: 'exec', call_id: `bad${n}`, arguments: '{}' },
        { type: 'function_call_output', call_id: `bad${n}`, output: 'unsupported call: exec' },
      ]),
    ],
  };
  assert.doesNotMatch(noteOf(normalizeToolContractHistory(body(many))), /Stop retrying/);
  many.input.push(
    { type: 'function_call', name: 'exec', call_id: 'bad3', arguments: '{}' },
    { type: 'function_call_output', call_id: 'bad3', output: 'unsupported call: exec' },
  );
  const escalated = normalizeToolContractHistory(body(many));
  assert.match(noteOf(escalated), /Stop retrying/);
  assert.equal(escalated.counts.rejected_calls, 3);
});

test('tool contract reader classifies both request representations', () => {
  const flash = readToolContract({ model: 'deepseek-flash', tools: flashTools, input: [] });
  assert.equal(flash.mode, 'function');
  assert.equal(flash.reachable('exec_command'), true);
  assert.equal(flash.reachable('spawn_agent'), true);
  assert.equal(flash.reachable('exec'), false);
  const code = readToolContract({
    model: 'gpt-6.1-sol',
    tools: [],
    input: [{ type: 'additional_tools', tools: codeModeTools }],
  });
  assert.equal(code.mode, 'code_mode');
  assert.equal(code.reachable('exec'), true);
  assert.equal(code.reachable('exec_command'), true, 'nested tools advertised by the wrapper are reachable');
  assert.equal(code.reachable('some_removed_tool'), false);
});

test('history truncation never splits a surrogate pair at either text budget', () => {
  for (const model of ['deepseek-flash', 'gpt-6.1-sol']) {
    // Use a genuinely foreign name for GPT too; its own exec remains untouched.
    const name = model.startsWith('deepseek-') ? 'exec' : 'retired_function';
    for (const offset of [-1, 0, 1]) {
      for (const hasReceipt of [true, false]) {
        const call = {
          type: 'custom_tool_call', name, call_id: 'unicode',
          input: 'a'.repeat(800 + offset) + '\u{1f600}tail',
        };
        const receipt = {
          type: 'custom_tool_call_output', call_id: 'unicode',
          output: 'b'.repeat(1500 + offset) + '\u{1f1ef}tail',
        };
        const value = {
          model, tools: model.startsWith('deepseek-') ? flashTools : codeModeTools,
          input: hasReceipt ? [call, receipt] : [call],
        };
        const original = body(value);
        const result = normalizeToolContractHistory(original);
        assert.equal(result.changed, true);
        const text = inputOf(result).find(i => i.role === 'assistant').content[0].text;
        assert.ok(text.isWellFormed(), `${model}: offset ${offset}, receipt ${hasReceipt}`);
        assert.match(text, /a+ \.\.\.\[truncated\]/);
        if (hasReceipt) assert.match(text, /b+ \.\.\.\[truncated\]/);
        else assert.match(text, /status: UNKNOWN/);
        assert.deepEqual(original, body(value), 'the original evidence must not change');
        assert.equal(normalizeToolContractHistory(result.body).changed, false);
      }
    }
  }
});

test('records and the developer note stay bounded on a long foreign history', () => {
  const many = {
    ...base,
    input: Array.from({ length: 200 }, (_, n) => [
      { type: 'custom_tool_call', name: 'exec', call_id: `c${n}`, input: 'x'.repeat(3000), status: 'completed' },
      { type: 'custom_tool_call_output', call_id: `c${n}`, output: 'y'.repeat(5000) },
    ]).flat(),
  };
  const result = normalizeToolContractHistory(body(many));
  const input = inputOf(result);
  const records = input.filter((i) => i.type === 'message' && i.role === 'assistant');
  assert.equal(records.length, 120, 'record count is capped');
  assert.equal(result.counts.tool_contract_records_capped, 80);
  assert.ok(JSON.stringify(input).length < 260_000, 'output stays bounded');
  assert.match(noteOf(result), /budget/);
});

test('incident-sized histories stay before newer user work and latest native receipts', () => {
  for (const count of [9, 40]) {
    const earlier = Array.from({ length: count }, (_, n) => [
      { type: 'custom_tool_call', name: 'exec', call_id: `old${n}`, input: 'earlier check' },
      { type: 'custom_tool_call_output', call_id: `old${n}`, output: `earlier result ${n}` },
    ]).flat();
    const latest = { type: 'message', role: 'user', content: 'Finish the remaining document' };
    const value = { ...base, input: [{ role: 'user', content: 'Old task' }, ...earlier, latest, base.input[6], base.input[7]] };
    const raw = body(value), result = normalizeToolContractHistory(raw), input = inputOf(result);
    const userIndex = input.findIndex(i => i.content === latest.content);
    const records = input.flatMap((i, index) => i.role === 'assistant' ? [index] : []);
    assert.equal(records.length, count);
    assert.ok(records.every(index => index < userIndex));
    assert.deepEqual(input.slice(-3), [latest, base.input[6], base.input[7]], 'current task and its actual receipt remain at the tail');
    assert.equal(input[0].role, 'developer');
    assert.match(noteOf(result), /not a new task/);
    assert.deepEqual(raw, body(value), 'persisted source evidence is never modified');
    assert.equal(normalizeToolContractHistory(result.body).changed, false);
  }
});

test('records preserve each conversational interval across multiple users and tool modes', () => {
  for (const mode of ['function', 'code_mode']) {
    const tools = mode === 'function' ? flashTools : codeModeTools;
    const name = mode === 'function' ? 'exec' : 'retired_function';
    const first = { role: 'user', content: 'first task' }, second = { role: 'user', content: 'second task' }, last = { role: 'user', content: 'latest task' };
    const pair = id => [{ type: 'function_call', name, call_id: id, arguments: '{}' }, { type: 'function_call_output', call_id: id, output: `receipt ${id}` }];
    const input = inputOf(normalizeToolContractHistory(body({ model: mode === 'function' ? 'deepseek-flash' : 'gpt-6.1-sol', tools, input: [first, ...pair('one'), second, ...pair('two'), last] })));
    assert.deepEqual(input.filter(i => i.role === 'user'), [first, second, last]);
    assert.match(input[input.indexOf(input.find(i => i.content === second.content)) - 1].content[0].text, /call_id: one/);
    assert.match(input.at(-2).content[0].text, /call_id: two/);
    assert.deepEqual(input.at(-1), last);
  }
});

test('overlapping native call batches stay intact without deferring history past the next user', () => {
  const user = { role: 'user', content: 'new task' };
  const c1 = { type: 'function_call', name: 'exec_command', call_id: 'a', arguments: '{}' };
  const c2 = { ...c1, call_id: 'b' };
  const o1 = { type: 'function_call_output', call_id: 'a', output: 'a done' };
  const o2 = { ...o1, call_id: 'b', output: 'b done' };
  const input = inputOf(normalizeToolContractHistory(body({ ...base, input: [c1, base.input[1], c2, base.input[2], o1, o2, user] })));
  assert.deepEqual(input.slice(1, 5), [c1, c2, o1, o2]);
  assert.match(input[5].content[0].text, /call_id: gpt-work/);
  assert.deepEqual(input[6], user);
});

test('an UNKNOWN outcome remains historical and cannot displace a newer user request', () => {
  const user = { role: 'user', content: 'new task' };
  const input = inputOf(normalizeToolContractHistory(body({ ...base, input: [base.input[1], user] })));
  assert.match(input[1].content[0].text, /status: UNKNOWN/);
  assert.deepEqual(input.at(-1), user);
  assert.equal(input.some(i => i.type === 'custom_tool_call_output'), false);
});

test('a malformed native batch cannot move foreign evidence across a user boundary', () => {
  const input = [base.input[6], base.input[1], base.input[2], { role: 'user', content: 'new task' }, base.input[7]];
  assert.equal(normalizeToolContractHistory(body({ ...base, input })), null, 'fall back to original bytes rather than misorder user work');
});
