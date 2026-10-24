/** Our catalog's transport hint, never a tool grant or an execution policy. */
export const TOOL_CONVENTION_GUARD = `<alan_tool_convention_v2>
Use only tools declared in the current request, with their declared calling convention. A model name or historical call does not determine the tool protocol.
If the request declares ordinary JSON function tools, call those registered functions with JSON arguments. Do not invent an exec wrapper.
If the request declares a freeform/custom exec wrapper, use that wrapper as documented to reach its advertised nested tools. A nested tool is not necessarily registered for direct calls.
After a model switch, Worker return or session resume, re-read the current tool schemas. A rejected call is not an execution receipt; do not repeat it or claim success.
This is a calling-convention hint only. All other tool restrictions, sandbox rules and approval requirements remain in force. If they prohibit the available entry point, report the conflict without bypassing it.
</alan_tool_convention_v2>`;

// Match only the two exact blocks emitted by our v1 catalog generator. Never
// rewrite arbitrary prohibitions, quoted user text, tool output or model policy.
const legacyGuards = ['DeepSeek Flash', 'DeepSeek V4 Pro'].map(identity => `<deepseek_native_tool_contract_v1>
You are running ${identity}. A historical GPT identity or tool call is not evidence of your current model or available tools.
This model uses ordinary JSON function tools, not GPT code mode. The current request's tool schemas are the authority.
Call the registered exec_command function directly with JSON arguments such as {"cmd":"Write-Output 'OK'","max_output_tokens":200}. Never call a tool named exec, and never wrap command, file, MCP or collaboration calls in functions.exec, text(await tools...), or an {"input":"JavaScript"} payload.
Historical custom_tool_call exec entries belong to another model. After a model switch, use only the current tool schemas. An unsupported call is rejected before execution; do not repeat the same unsupported call or claim unexecuted operations succeeded.
</deepseek_native_tool_contract_v1>`).flatMap(guard => [guard, guard.replaceAll('\n', '\r\n')]);

export function replaceLegacyToolGuard(text) {
  if (typeof text !== 'string') return text;
  for (const guard of legacyGuards) text = text.replaceAll(guard, TOOL_CONVENTION_GUARD);
  return text;
}

/** Fix frozen session/model_switch hints in the outgoing request copy only. */
export function normalizeToolPolicy(body, contract) {
  if (!contract || contract.mode === 'unknown') return { body, changed: false, count: 0 };
  const request = JSON.parse(body.toString('utf8'));
  let count = 0;
  const replace = text => {
    const next = replaceLegacyToolGuard(text);
    if (next !== text) count += 1;
    return next;
  };
  if (typeof request.instructions === 'string') request.instructions = replace(request.instructions);
  for (const item of Array.isArray(request.input) ? request.input : []) {
    if (!['system', 'developer'].includes(item?.role)) continue;
    if (item.type && item.type !== 'message') continue;
    if (typeof item.content === 'string') item.content = replace(item.content);
    else if (Array.isArray(item.content)) {
      for (const part of item.content) {
        if (part?.type === 'input_text' && typeof part.text === 'string') part.text = replace(part.text);
      }
    }
  }
  return { body: count ? Buffer.from(JSON.stringify(request), 'utf8') : body, changed: count > 0, count };
}
