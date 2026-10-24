/**
 * bridge/deepseek-history.mjs — tool-contract history compatibility.
 *
 * Scope: only the *request copy that goes upstream*. Persisted threads, rollouts
 * and SQLite are never touched, no tool is executed here, and no receipt is
 * fabricated.
 *
 * Why this exists
 * ---------------
 * Codex picks a tool surface per model: DeepSeek models get ordinary JSON function
 * tools, GPT code-mode models get a freeform `exec` wrapper. When one thread is
 * switched between those models the harness replays the previous model's history
 * verbatim, so the new model sees calls it cannot represent. Both directions were
 * captured live on 2026-10-14:
 *
 *   GPT code-mode turn  -> DeepSeek request replaying `custom_tool_call exec`
 *   DeepSeek turn       -> GPT code-mode request replaying `function_call exec_command`
 *
 * and, when a model imitated the foreign shape, the local dispatcher answered
 * `unsupported call: exec` for a `function_call exec` that was never registered.
 *
 * What it does
 * ------------
 * 1. Reads the *current* request's tool table (top-level `tools` plus the code-mode
 *    `additional_tools` input item) to learn what this request can actually call.
 * 2. Classifies each history call item:
 *      - name declared here, or reachable inside a declared code-mode wrapper
 *        -> untouched, so compatible history stays byte-for-byte passthrough;
 *      - receipt is a local `unsupported call: ...` rejection -> that exact pair is
 *        dropped together with the reasoning item that immediately produced it;
 *      - any other receipt -> the pair is replaced by one non-executable record
 *        keeping tool name, call_id, input and result as text;
 *      - no receipt at all -> kept as an explicit UNKNOWN record: the outcome must
 *        not be guessed, but an unpaired call item makes the upstream reject the
 *        whole request (observed: "No tool output found for tool call ...").
 * 3. Keeps each record at its historical receipt boundary, outside retained tool
 *    call/result batches. A contract note derived only from this request's tool
 *    table is prefixed, never appended after the current turn. Historical text
 *    and tool output are never promoted into that note.
 *
 * Ordering rule learned the hard way (2026-10-14): the harness interleaves a
 * foreign call between a registered `function_call` and its `function_call_output`,
 * and DeepSeek requires those two to stay adjacent. Records inside such a batch
 * are deferred only to that batch's end, never past a subsequent user message.
 *
 * All work is bounded (per-record text, total text, record count) so a long thread
 * cannot produce an unbounded request, and the entry point fails open: any
 * unexpected error forwards the original body unchanged.
 */

const RECORD_INPUT_CHARS = 800;
const RECORD_OUTPUT_CHARS = 1500;
const TEXT_BUDGET_CHARS = 40_000;
const MAX_RECORDS = 120;
/** Rejected pairs seen in one request before the model is told to stop retrying. */
const REJECTED_ESCALATION = 3;

const CALL_TYPES = {
  function_call: 'function_call_output',
  custom_tool_call: 'custom_tool_call_output',
};
const OUTPUT_TYPES = new Set(Object.values(CALL_TYPES));

/** Text of a Responses output item (plain string or content-part array). */
function outputText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => (typeof part?.text === 'string' ? part.text : part?.type ? `[${part.type}]` : ''))
      .join('');
  }
  if (value && typeof value === 'object' && typeof value.text === 'string') return value.text;
  return '';
}

function rejectionReceipt(text) {
  const m = /^\s*unsupported call:\s*(\S*)\s*$/i.exec(text);
  return m ? m[1] || null : null;
}

function clampText(value, max) {
  const text = String(value ?? '');
  if (text.length <= max) return { text, truncated: false };
  // Keep the UTF-16 budget, but never split a Unicode surrogate pair. Node's
  // JSON.stringify permits a lone surrogate; strict upstream JSON decoders do not.
  let end = max;
  const before = text.charCodeAt(end - 1);
  const after = text.charCodeAt(end);
  if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) end -= 1;
  return { text: text.slice(0, end), truncated: true };
}

/** Nested tool names advertised by a code-mode wrapper (`exec`) description. */
function nestedToolNames(description) {
  const found = new Set();
  if (typeof description !== 'string' || description.length === 0) return found;
  for (const m of description.matchAll(/tools\.([A-Za-z_$][\w$]*)\s*\(/g)) found.add(m[1]);
  for (const m of description.matchAll(/^### `([^`]+)`$/gm)) found.add(m[1].trim());
  return found;
}

/**
 * The tool table of one request, read from that request.
 *
 * `functions` and `customs` are declared callable names (namespaced children are
 * listed both bare and as `namespace.child`); `nested` holds names a code-mode
 * wrapper advertises inside its JavaScript surface. This is a request view, not the
 * harness registry: a name missing here only means "not declared in this request".
 */
export function readToolContract(request) {
  const functions = new Set();
  const customs = new Set();
  const nested = new Set();
  let codeModeWrapper = false;

  const visit = (tools) => {
    for (const tool of Array.isArray(tools) ? tools : []) {
      const type = tool?.type;
      if (type === 'namespace') {
        for (const child of Array.isArray(tool.tools) ? tool.tools : []) {
          if (!child?.name) continue;
          functions.add(child.name);
          functions.add(`${tool.name}.${child.name}`);
          if (child.type === 'custom') {
            customs.add(child.name);
            if (child.name === 'exec') codeModeWrapper = true;
            for (const name of nestedToolNames(child.description)) nested.add(name);
          }
        }
        continue;
      }
      if (!tool?.name) continue;
      if (type === 'custom') {
        customs.add(tool.name);
        if (tool.name === 'exec') codeModeWrapper = true;
        for (const name of nestedToolNames(tool.description)) nested.add(name);
        continue;
      }
      // `function`, plus tool_search / web_search style declarations.
      functions.add(tool.name);
    }
  };

  visit(request.tools);
  for (const item of Array.isArray(request.input) ? request.input : []) {
    if (item?.type === 'additional_tools') visit(item.tools);
  }

  const reachable = (name) => Boolean(name) && (functions.has(name) || customs.has(name) || nested.has(name));
  const mode = codeModeWrapper ? 'code_mode' : functions.size > 0 || customs.size > 0 ? 'function' : 'unknown';
  return { functions, customs, nested, codeModeWrapper, mode, reachable };
}

function summarizeRecord({ name, callType, callId, status, input, output }) {
  return [
    '[bridge history record] Non-executable record of an earlier tool call this request cannot represent.',
    `tool: ${name} (${callType}; not declared in this request)`,
    `call_id: ${callId}`,
    `status: ${status} (historical tool receipt; preserve its evidence and do not execute this record)`,
    'input:',
    input.text + (input.truncated ? ' ...[truncated]' : ''),
    'output:',
    output.text + (output.truncated ? ' ...[truncated]' : ''),
    '[end of bridge history record]',
  ].join('\n');
}

function summarizeCompact({ name, callType, callId, status }) {
  return (
    `[bridge history record] Non-executable record: earlier ${callType} "${name}" (call_id ${callId}, status ` +
    `"${status}"). Its input and output were omitted to stay within the bridge text budget; the original record is ` +
    'unchanged on disk.'
  );
}

/**
 * A foreign call with no recorded result. The outcome is unknown, so nothing is
 * claimed and nothing is replayed; it is kept as an explicit UNKNOWN record
 * because an unpaired call item is not a representable request (DeepSeek answers
 * "No tool output found for tool call ...", observed on the incident thread's own
 * rollout). Registered calls are never touched here.
 */
function summarizeUnknownRecord({ name, callType, callId, input }) {
  return [
    '[bridge history record] Non-executable record of an earlier tool call this request cannot represent.',
    `tool: ${name} (${callType}; not declared in this request)`,
    `call_id: ${callId}`,
    'status: UNKNOWN - no result was ever recorded for this call, so it may or may not have run. Do not assume',
    'success, do not replay it, and read back any side effect you depend on before continuing.',
    'input:',
    input.text + (input.truncated ? ' ...[truncated]' : ''),
    '[end of bridge history record]',
  ].join('\n');
}

function contractNote({ model, upstream, contract, foreignNames, removedRejected, records, unknown, notes }) {
  const list = (set, limit) => {
    const all = [...set];
    const head = all.slice(0, limit).join(', ');
    return all.length > limit ? `${head} (+${all.length - limit} more)` : head;
  };
  const lines = [
    `Tool contract note (generated by the local bridge from this request only; model ${model}, upstream ${upstream}).`,
    `- tool mode of this request: ${contract.mode}`,
  ];
  if (contract.functions.size > 0) lines.push(`- callable as JSON function tools: ${list(contract.functions, 14)}`);
  if (contract.customs.size > 0) lines.push(`- freeform/custom tools: ${list(contract.customs, 6)}`);
  if (contract.nested.size > 0) lines.push(`- reachable inside a code-mode wrapper: ${list(contract.nested, 14)}`);
  if (foreignNames.length > 0) {
    lines.push(`- history here referenced tools not declared in this request: ${foreignNames.join(', ')}`);
  }
  const actions = [];
  if (removedRejected > 0) actions.push(`${removedRejected} already-rejected call pair(s) were dropped`);
  if (records > 0) actions.push(`${records} executed call(s) were kept as non-executable records`);
  if (unknown > 0) actions.push(`${unknown} call(s) without any recorded result were kept as UNKNOWN records`);
  if (actions.length > 0) {
    lines.push(
      `- ${actions.join('; ')}. Nothing was re-executed, no result was invented, and this note changes only the copy ` +
        'of the conversation sent to the model.',
    );
  }
  if (unknown > 0) lines.push('- UNKNOWN historical records have no recorded outcome: do not infer success or failure, and do not replay them.');
  lines.push(
    '- call only the tools declared in this request, in the calling convention of this request. Do not re-emit an ' +
      'unregistered tool name or another model tool-mode wrapper, and do not claim an operation ran without a receipt.',
    '- this note is transport metadata, not a new task or a request to verify prior work again. Recorded outputs ' +
      'remain evidence of prior execution; a completed call can still report failure. Continue from the latest ' +
      'user request and tool results. Recheck only an unresolved fact needed for the next action, not merely ' +
      'because a call was converted into a historical record.',
  );
  for (const note of notes) lines.push(`- ${note}`);
  return lines.join('\n');
}

/**
 * Request-only repair.
 *
 * @param {Buffer} body
 * @param {{contract?: 'on'|'off'}} [options] `off` keeps only the previously
 *   validated rejected-call cleanup and leaves other foreign history untouched.
 * @returns {{body: Buffer, counts: object, changed: boolean}|null} null only when the
 *   body is not a request we can read; `changed: false` means byte passthrough.
 */
export function normalizeToolContractHistory(body, { contract = 'on' } = {}) {
  try {
    return normalizeRequestHistory(body, { contractMode: contract });
  } catch {
    // Compatibility work must never break a request.
    return null;
  }
}

function normalizeRequestHistory(body, { contractMode }) {
  let request;
  try {
    request = JSON.parse(body.toString('utf8'));
  } catch {
    return null;
  }
  if (!request || typeof request !== 'object') return null;
  const input = request.input;
  const model = request.model;
  if (!Array.isArray(input) || typeof model !== 'string' || model === '') return null;

  const table = readToolContract(request);
  // With no readable tool declaration we cannot tell what is callable, so the
  // request is passed through untouched.
  if (table.mode === 'unknown') return null;
  const upstream = model.startsWith('deepseek-') ? 'deepseek' : model.startsWith('gpt-') ? 'chatgpt' : 'unknown';

  const outputIndexByCallId = new Map();
  input.forEach((item, index) => {
    if (OUTPUT_TYPES.has(item?.type) && item.call_id && !outputIndexByCallId.has(item.call_id)) {
      outputIndexByCallId.set(item.call_id, index);
    }
  });

  // Remove foreign pairs without splitting retained call/result batches. Each
  // replacement is anchored at its receipt, not at the end of the whole request.
  const plan = new Map(); // index -> {action: 'remove', reason}
  const records_ = [];
  const foreignNames = new Set();
  let rejectedItems = 0;
  let convertedItems = 0;
  let rejectedCalls = 0;
  let records = 0;
  let unknownCalls = 0;
  let capped = 0;
  let textBudget = TEXT_BUDGET_CHARS;

  input.forEach((item, index) => {
    if (!CALL_TYPES[item?.type]) return;
    const name = item.name;
    if (!name || table.reachable(name)) return;
    foreignNames.add(name);
    const receiptIndex = item.call_id ? outputIndexByCallId.get(item.call_id) : undefined;
    const receipt = receiptIndex === undefined ? null : input[receiptIndex];
    if (!receipt) {
      // No recorded outcome. The old patch left this alone; it stays UNKNOWN either
      // way, but an unpaired call item makes the whole request invalid upstream, so
      // the fact is preserved as an explicit UNKNOWN record instead.
      unknownCalls += 1;
      if (contractMode === 'off') return;
      if (records + unknownCalls > MAX_RECORDS) {
        capped += 1;
        plan.set(index, { action: 'remove', reason: 'capped' });
        return;
      }
      const payload = {
        name,
        callType: item.type,
        callId: item.call_id ?? '(none)',
        status: 'unknown',
        input: clampText(item.input ?? item.arguments ?? '', RECORD_INPUT_CHARS),
      };
      const full = summarizeUnknownRecord(payload);
      const text = full.length <= textBudget ? full : summarizeCompact(payload);
      textBudget -= text.length;
      plan.set(index, { action: 'remove', reason: 'converted' });
      records_.push({ text, gap: index + 1 });
      return;
    }
    if (rejectionReceipt(outputText(receipt.output))) {
      // The call never reached a dispatcher, so this pair carries no execution
      // fact. Drop it, plus the thought that immediately produced it.
      rejectedCalls += 1;
      for (const target of [index, receiptIndex]) plan.set(target, { action: 'remove', reason: 'rejected' });
      if (index > 0 && input[index - 1]?.type === 'reasoning') {
        plan.set(index - 1, { action: 'remove', reason: 'rejected' });
      }
      return;
    }
    if (contractMode === 'off') return;
    if (records >= MAX_RECORDS) {
      capped += 1;
      plan.set(index, { action: 'remove', reason: 'capped' });
      plan.set(receiptIndex, { action: 'remove', reason: 'capped' });
      return;
    }
    const payload = {
      name,
      callType: item.type,
      callId: item.call_id ?? '(none)',
      status: typeof item.status === 'string' && item.status !== '' ? item.status : 'unknown',
      input: clampText(item.input ?? item.arguments ?? '', RECORD_INPUT_CHARS),
      output: clampText(outputText(receipt.output), RECORD_OUTPUT_CHARS),
    };
    const full = summarizeRecord(payload);
    const text = full.length <= textBudget ? full : summarizeCompact(payload);
    textBudget -= text.length;
    plan.set(index, { action: 'remove', reason: 'converted' });
    plan.set(receiptIndex, { action: 'remove', reason: 'converted' });
    records_.push({ text, gap: Math.max(index, receiptIndex) + 1 });
    records += 1;
  });

  // A gap after a retained call and before its receipt cannot accept a message.
  // Overlapping ranges also protect parallel call/result batches as a whole.
  const gapDeltas = new Int32Array(input.length + 2);
  input.forEach((item, index) => {
    if (!CALL_TYPES[item?.type] || plan.has(index)) return;
    const end = outputIndexByCallId.get(item.call_id);
    if (end === undefined || end <= index || plan.has(end)) return;
    gapDeltas[index + 1] += 1;
    gapDeltas[end + 1] -= 1;
  });
  const protectedGaps = new Uint8Array(input.length + 1);
  let openCalls = 0;
  for (let gap = 0; gap <= input.length; gap += 1) {
    openCalls += gapDeltas[gap];
    protectedGaps[gap] = openCalls > 0 ? 1 : 0;
  }
  const safeGaps = new Int32Array(input.length + 1);
  let nextSafeGap = input.length;
  for (let gap = input.length; gap >= 0; gap -= 1) {
    if (!protectedGaps[gap]) nextSafeGap = gap;
    safeGaps[gap] = nextSafeGap;
  }
  const recordsAtGap = new Map();
  for (const record of records_) {
    const gap = safeGaps[record.gap];
    // An incomplete/malformed retained batch must not move old evidence across
    // user work. Fail open rather than silently change conversational chronology.
    for (let index = record.gap; index < gap; index += 1) {
      if (input[index]?.role === 'user') throw new Error('history record crosses user boundary');
    }
    if (!recordsAtGap.has(gap)) recordsAtGap.set(gap, []);
    recordsAtGap.get(gap).push(record.text);
  }
  const next = [];
  input.forEach((item, index) => {
    for (const text of recordsAtGap.get(index) ?? []) {
      next.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
    }
    const entry = plan.get(index);
    if (!entry) {
      next.push(item);
      return;
    }
    if (entry.reason === 'rejected') rejectedItems += 1;
    else convertedItems += 1;
  });
  for (const text of recordsAtGap.get(input.length) ?? []) {
    next.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
  }

  const counts = {
    rejected_exec_items_removed: rejectedItems,
    tool_contract_items_removed: convertedItems,
    rejected_calls: rejectedCalls,
    tool_contract_records: records,
    tool_contract_records_capped: capped,
    tool_contract_unknown_calls: unknownCalls,
    tool_contract_mode: table.mode,
    tool_contract_history_order: 'chronological-v2',
  };
  if (plan.size === 0) return { body, counts, changed: false };

  const notes = [];
  if (capped > 0) {
    notes.push(`${capped} further foreign call(s) were dropped without a record to stay within the bridge budget.`);
  }
  if (rejectedCalls >= REJECTED_ESCALATION) {
    notes.push(
      `this thread has produced ${rejectedCalls} calls the local dispatcher rejected before execution. Stop retrying ` +
        'them: report the failure to the user and either use a declared tool or end the turn.',
    );
  }
  next.unshift({
    role: 'developer',
    content: [
      {
        type: 'input_text',
        text: contractNote({
          model,
          upstream,
          contract: table,
          foreignNames: [...foreignNames],
          removedRejected: rejectedCalls,
          records,
          unknown: unknownCalls,
          notes,
        }),
      },
    ],
  });

  request.input = next;
  return {
    body: Buffer.from(JSON.stringify(request), 'utf8'),
    counts,
    changed: true,
  };
}
