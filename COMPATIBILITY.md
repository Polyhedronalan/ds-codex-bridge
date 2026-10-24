# Bridge request compatibility (`compat.mjs`)

This file documents every rewrite the Bridge is allowed to make. It is the
reference the README points at, and it replaces guesswork with the two rules that
were actually observed to be necessary.

Principles:

* The Bridge rewrites **only the request copy that goes upstream**. Persisted
  threads, rollouts, SQLite and tool receipts are never modified.
* No rule executes a tool, fabricates a receipt, rewrites a streamed response or
  translates one tool protocol into another.
* When a request has no incompatibility, it is forwarded **byte for byte**
  (`request_body_shape.forwarded_identical_to_incoming: true` with
  `BRIDGE_DIAG_BODY=1`).
* Every rule fails open: on an unexpected error the original body is forwarded.
* Both rules are per-request and stateless; the Bridge keeps no history database.

## Rule 1 — DeepSeek reasoning replay into the ChatGPT upstream

Switch: `compat.deepseek_reasoning_replay` = `strip` (default) / `drop` / `off`.

A reasoning item produced by DeepSeek is rejected by the ChatGPT backend when it
is replayed as-is (`Invalid 'input[n].content': array too long` and
`invalid_encrypted_content`).

* Detection: the DeepSeek shape itself — `type: "reasoning"` with a non-empty
  plaintext `content` array. OpenAI-produced reasoning items never match.
* `strip`: `content` → `[]`, drop `encrypted_content`.
* `drop`: remove the item from `input`.
* Counters: `reasoning_items_normalized`, `encrypted_content_removed`.

## Rule 2 — Tool-contract history boundary (added 2026-10-14)

Switch: `compat.tool_contract_history` = `on` (default) / `off`.

Codex picks a tool surface per model: DeepSeek models get ordinary JSON function
tools, GPT code-mode models get a freeform `exec` wrapper. When one thread is
switched between those models, the harness replays the previous model's protocol
verbatim. Both directions were captured live on 2026-10-14:

```text
GPT code-mode turn  ->  DeepSeek request replaying `custom_tool_call exec`
DeepSeek turn       ->  GPT code-mode request replaying `function_call exec_command`
```

When a model imitated the foreign shape, the local dispatcher answered
`unsupported call: exec`, and each rejection became a new example in the
following request.

### What the boundary reads

The tool table of *this* request, and nothing else:

* top-level `tools` (`function`, `custom`, `namespace` children, `tool_search`,
  `web_search`);
* the code-mode `additional_tools` input item, including the nested tool names its
  `exec` description advertises (namespaced children are registered both bare and
  as `namespace.child`).

Derived per request: `mode` = `function` | `code_mode` | `unknown`. `unknown`
(no readable tool declaration) means passthrough — the Bridge never guesses.

### What it does to history

| history item | condition | action |
|---|---|---|
| call + receipt | tool name declared here, or reachable inside the declared code-mode wrapper | untouched (byte passthrough) |
| call + receipt | receipt is a local `unsupported call: ...` rejection | drop that exact pair and the reasoning item that immediately produced it |
| call + receipt | any other receipt, tool not declared here | replace the pair with one non-executable record (tool, call_id, input, result as text) |
| call, no receipt | tool declared here | untouched — the harness owns it |
| call, no receipt | tool not declared here | replace with an explicit **UNKNOWN** record (keeps tool, call_id, input, "assume nothing ran") |

The last row exists because an unpaired call item makes the upstream reject the
whole request (`No tool output found for tool call ...`, observed on the incident
thread's own rollout). The outcome is never guessed and nothing is replayed.

**Ordering rule (corrected 2026-10-20).** A record stays at the historical
receipt boundary. The harness can interleave a foreign pair inside a retained
call/result batch; a message must not split that batch. Overlapping retained
call/result ranges therefore defer the record only to the end of that batch,
before subsequent user work. If malformed retained history makes that impossible,
normalization fails open without moving evidence across the user boundary.

The old implementation appended all historical records after the latest user
request and current tool results. The two 2026-10-19 incident threads repeatedly
received 40 and 9 old records at the tail and entered repeated status checks.
Moving history to the tail is no longer allowed; current compatible receipts are
preserved, and persisted histories remain untouched.

### The prefixed note

When (and only when) something changed, one `developer` item is prefixed. It names
the tools read out of this same request, says which history was dropped or turned
into records, and instructs the model to use only the declared tools in the
declared calling convention. It explicitly preserves prior receipt evidence and
does not request a fresh verification merely because a record was converted.
UNKNOWN outcomes remain unknown. Tool output, file content and other untrusted
text is never promoted into it. From the third rejected pair in one thread it
also says to stop retrying and report the failure.

### Bounds

Per record: 800 chars of input, 1500 chars of result. Whole request: 40 000 chars
of records, at most 120 records; beyond that, records become compact (facts and
call ids, bodies elided) and then dropped with a count. This keeps a long thread
from turning into an unbounded request.

### Counters (`normalization_counts` in `bridge.jsonl`)

```text
rejected_exec_items_removed   items dropped with a rejected pair (call, receipt, reasoning)
rejected_calls                rejected pairs seen
tool_contract_items_removed   items removed because they were turned into records
tool_contract_records         executed foreign calls kept as records
tool_contract_unknown_calls   foreign calls without any recorded result (kept as UNKNOWN)
tool_contract_records_capped  items dropped only because a bound was hit
tool_contract_mode            function | code_mode (present on every request)
```

### Boundaries this rule does not cross

* It cannot abort a Codex-internal tool loop; the escalation note and the
  harness's own failure feedback are the only levers (documented, not invented).
* It never renames one tool protocol into another (`custom_tool_call exec` is not
  rewritten into `function_call exec_command`).
* A tool that is only registered through `tool_search` in a *later* request may
  look "not declared here" in this one; its history then becomes a record instead
  of a call. Facts are preserved, structure is not.
* Unknown item types and unknown tool modes are always passthrough.

## Switching and rollback

1. In-flight switch (no code change): set `compat.tool_contract_history` to `off`
   in `config.json` (or `BRIDGE_TOOL_CONTRACT_HISTORY=off`) and restart the Bridge.
   The rejected-pair cleanup of Rule 2 stays active, exactly as it behaved before
   the boundary existed.
2. Full rollback: restore `compat.mjs`, `deepseek-history.mjs`, `config.mjs`,
   `config.json` and `bridge.mjs` from the pre-change backup, then restart with
   `stop-production.ps1` / `start-production.ps1`.

Historical private deployment evidence is not distributed. The package includes
local synthetic regression tests; real upstream acceptance is environment-specific.

## Catalog transport hints after switch, compaction and resume (2026-10-15)

The old catalog `<deepseek_native_tool_contract_v1>` guard unconditionally banned
`exec` / `functions.exec`. A thread created on Flash can retain that initial
instruction after switching to GPT code mode and after compaction. History-call
compatibility alone does not remove this conflicting instruction.

The catalog generator now uses the shared `<alan_tool_convention_v2>` hint from
`tool-policy.mjs`: choose the convention from current tool schemas and
continue to respect all independent restrictions, sandbox rules and approvals.
It does not change model selection or tool registration.

For existing frozen sessions, `compat.mjs` replaces only the two exact owned v1
blocks (Flash / V4 Pro, LF or CRLF) in `instructions` or system/developer message
text in the outgoing request copy, when a current tool contract is readable.
Unknown contracts, modified/unrecognized blocks, user/assistant text, outputs,
tool definitions and unrelated prohibitions are untouched. No persistent rollout
or SQLite change is required. `tool_policy_guards_normalized` counts changed text
fields, without logging their contents. This rule is separate from
`compat.tool_contract_history`, whose existing semantics remain unchanged.

The catalog generator belongs to a separate local integration and is not included
in this package. Restore matching source and catalog configuration together when
rolling back an integration; do not alter session history.
