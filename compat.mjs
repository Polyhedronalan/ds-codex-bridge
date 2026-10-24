import { normalizeToolContractHistory, readToolContract } from './deepseek-history.mjs';
import { normalizeToolPolicy } from './tool-policy.mjs';
/**
 * bridge/compat.mjs — conservative request compatibility rules.
 *
 * Default behaviour is pure passthrough. Only incompatibilities that were actually
 * observed are rewritten, and only for the upstream that rejected them.
 *
 *   Both upstreams — tool-contract history (see deepseek-history.mjs)
 *     A thread switched between a GPT code-mode model and a DeepSeek
 *     function-tool model replays the previous model's tool protocol. History
 *     calls this request cannot represent are handled in the outgoing copy only:
 *     already-rejected pairs are dropped, executed foreign calls become
 *     non-executable records, and one developer note names the tools this request
 *     actually declares. `compat.tool_contract_history: "off"` keeps the
 *     rejected-pair cleanup and disables the rest.
 *
 *   DeepSeek -> ChatGPT replay (reasoning items)
 *     A) `reasoning.content` is a non-empty plaintext array
 *        -> ChatGPT backend: "Invalid 'input[n].content': array too long.
 *           Expected an array with maximum length 0"
 *     B) `reasoning.encrypted_content` is a DeepSeek opaque value that OpenAI
 *        cannot decrypt
 *        -> ChatGPT backend: "invalid_encrypted_content"
 *     Action (`strip`): content -> [], drop encrypted_content.
 *     Action (`drop`):  remove the item from `input`.
 *
 * The detection signal is the DeepSeek shape itself (non-empty plaintext
 * reasoning content), so OpenAI-produced reasoning items are never touched.
 *
 * No prompt, response, reasoning text or encrypted_content value is ever
 * logged or copied anywhere.
 */

export const EMPTY_COUNTS = { reasoning_items_normalized: 0, encrypted_content_removed: 0 };

export function isDeepSeekShapedReasoning(item) {
  return Boolean(
    item &&
      typeof item === 'object' &&
      item.type === 'reasoning' &&
      Array.isArray(item.content) &&
      item.content.length > 0,
  );
}

/**
 * @param {Buffer} body
 * @param {{upstream: string, mode: 'strip'|'drop'|'off', toolContract?: 'on'|'off'}} opts
 * @returns {{body: Buffer, counts: object, changed: boolean}}
 */
export function normalizeRequest(body, { upstream, mode, toolContract = 'on' }) {
  let current = body;
  let counts = { ...EMPTY_COUNTS };
  let changed = false;

  // 1) Tool-contract history compatibility, in the outgoing copy only. A null
  //    result means "this request has no incompatible history" -> byte passthrough.
  if (upstream === 'deepseek' || upstream === 'chatgpt') {
    // Frozen v1 catalog hints survive model switches and compaction. Repair only
    // our exact owned hint; never change tool tables or unrelated restrictions.
    try {
      const policy = normalizeToolPolicy(current, readToolContract(JSON.parse(current.toString('utf8'))));
      if (policy.changed) {
        current = policy.body;
        counts.tool_policy_guards_normalized = policy.count;
        changed = true;
      }
    } catch { /* unreadable requests remain passthrough */ }
    const repaired = normalizeToolContractHistory(current, { contract: toolContract });
    if (repaired?.changed) {
      current = repaired.body;
      counts = { ...counts, ...repaired.counts };
      changed = true;
    } else if (repaired) {
      // Nothing rewritten: keep only the cheap tool-mode diagnostic, so ordinary
      // requests do not grow zero-valued counters in the log.
      counts = { ...counts, tool_contract_mode: repaired.counts.tool_contract_mode };
    }
  }

  // 2) DeepSeek reasoning replay normalization for the ChatGPT upstream.
  if (mode === 'off' || upstream !== 'chatgpt' || current.length === 0) {
    return { body: current, counts, changed };
  }
  let json;
  try {
    json = JSON.parse(current.toString('utf8'));
  } catch {
    return { body: current, counts, changed };
  }
  if (!json || !Array.isArray(json.input)) {
    return { body: current, counts, changed };
  }

  const input = [];
  for (const item of json.input) {
    if (!isDeepSeekShapedReasoning(item)) {
      input.push(item);
      continue;
    }
    counts.reasoning_items_normalized += 1;
    if (mode === 'drop') continue;
    if (Array.isArray(item.content) && item.content.length > 0) item.content = [];
    if ('encrypted_content' in item) {
      delete item.encrypted_content;
      counts.encrypted_content_removed += 1;
    }
    input.push(item);
  }
  if (counts.reasoning_items_normalized === 0) {
    return { body: current, counts, changed };
  }
  json.input = input;
  return { body: Buffer.from(JSON.stringify(json), 'utf8'), counts, changed: true };
}
