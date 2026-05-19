# Fix plan: Bump main-loop `max_tokens` from 4096 to 8192

## TL;DR

`bin/smallcode.js`'s main `chatCompletion` (line 1250) hard-codes
`max_tokens: 4096` in the request body. For reasoning models like
qwen3.6-27B, 4096 is often too tight: long `<think>` content can
exhaust the budget before the model emits the actual tool_call,
producing truncated/malformed output. Bump to 8192 (or make it
configurable). One-line change.

**Estimated effort:** ~10 minutes.
**Files touched:** `bin/smallcode.js` only.

---

## Background

Smallcode sends an OpenAI-compatible chat completion request on every
turn of its agent loop. The body is built around line 1273:

```javascript
const body = {
  model: config.model.name,
  messages: [systemMsg, ...processedMessages],
  tools: getAllTools(config, currentToolCategory),
  temperature: 0.1,
  max_tokens: 4096,
};
```

`max_tokens` is the upper bound on completion tokens the server will
emit. When the model exhausts the budget mid-response, the server
returns `finish_reason: "length"` with whatever was generated so far.

## Why this hurts

Modern reasoning models (qwen3, gpt-oss, deepseek-r1, etc.) emit
`<think>...</think>` blocks before producing their actual answer.
That reasoning content counts against `max_tokens`. A typical chain
for a non-trivial coding decision can run 2k–6k tokens of reasoning
alone, before any tool_call is emitted.

What we've seen in practice with qwen3.6-27B against a moderately
long file:

- `max_tokens: 4096` → reasoning consumes ~3500 tokens, response
  starts tool_call JSON, hits budget mid-arguments, output truncates
  to invalid JSON. Server returns 200 with `finish_reason: "length"`
  and a malformed `tool_calls[]` entry; agent loop pushes garbage
  into history; subsequent turn often fails worse.
- Some servers (notably `llama-server`) detect the malformed tool
  call and return **HTTP 500** instead of the truncated 200. Either
  way, the agent loop loses ground.

Both modes are caused by the same thing: insufficient output budget.

## Fix

`bin/smallcode.js`, around line 1279:

```diff
     const body = {
       model: config.model.name,
       messages: [systemMsg, ...processedMessages],
       tools: getAllTools(config, currentToolCategory),
       temperature: 0.1,
-      max_tokens: 4096,
+      max_tokens: 8192,
     };
```

8192 is enough headroom for ~6k tokens of reasoning + ~2k of tool-call
output, covering ~95% of observed reasoning paths for 27B-class
models. Going higher (e.g. 16384) is fine if you want more cushion;
the cost is bounded by what the model actually emits, not by the cap.

### Optional: env var override

If you want to tune per-deployment without rebuilding:

```diff
+    const maxTokens = parseInt(process.env.SMALLCODE_MAX_TOKENS) || 8192;
     const body = {
       ...
-      max_tokens: 4096,
+      max_tokens: maxTokens,
     };
```

Then operators set `SMALLCODE_MAX_TOKENS=16384` (or whatever) in their
`.env` for smaller/larger contexts.

### Also: the `streamFinalResponse` fallback

`bin/smallcode.js:1384` has another `max_tokens: 256` for the short
"summarize what you did" call. Leave that alone — it's intentionally
small because the summary should be 1–2 sentences.

`bin/smallcode.js:1478` has another `max_tokens: 4096` for what looks
like a "decompose" or retry path. Bump that one too for consistency:

```diff
@@ around line 1478
-          max_tokens: 4096,
+          max_tokens: 8192,
```

(Confirm by reading the surrounding context — this should also be a
main reasoning call, not a constrained sub-prompt.)

---

## Style notes

- Plain CommonJS. No TypeScript.
- If you go with the env var option, parse safely: `parseInt(undefined)`
  is `NaN`, so the `|| 8192` fallback handles it.
- Don't introduce a config knob that's hidden inside the user's
  `.env` if the change is meant to be the new default — make 8192
  the default-default.

---

## Verification

### 1. Syntax check

```sh
node --check bin/smallcode.js
```

### 2. Behavioral check

Run smallcode against a reasoning-model setup on a non-trivial task
that previously truncated. Check the model's response in the trace
log (`.smallcode/traces/*.json`): a successful run shows a tool_call
with complete, parseable arguments. Failure shows partial JSON or a
`finish_reason: "length"` at the end of the assistant message.

The most direct check is the LLM server's own log (e.g. llama-server's
`print_timing` lines). A line like:

```
eval time = ... / 4096 tokens (...)
```

with `n_decoded` hitting exactly the cap is the "hit length limit"
signal. After the bump, `n_decoded` should typically be well under
the new cap.

### 3. Smoke

If smallcode's main caller has an integration test or eval harness,
re-run a small batch (5–10 trials). Failure modes related to truncated
tool calls should disappear or substantially reduce.

---

## Out of scope

- **Smarter "reasoning budget" management.** Some servers (llama.cpp)
  let clients pass `reasoning_budget` separately from `max_tokens`,
  capping reasoning while keeping output flexible. Worth exploring
  but a much larger change.
- **Per-tool max_tokens.** Some tool calls need very few output
  tokens (e.g. a simple `read_file`); others need many. Static cap
  is fine for now.
- **Auto-detection of model context window.** Smallcode already does
  some of this elsewhere (the mid-turn context-eviction block);
  pinning `max_tokens` separately is consistent with the rest of
  the codebase.

---

## When to ship

Trivial standalone change. No dependencies on other fixes in this
repo.
