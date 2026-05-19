# Fix plan: Don't poison conversation history when a tool call fails validation

## TL;DR

When the agent's tool dispatcher rejects a tool call (e.g. the
arguments don't validate), smallcode currently keeps **both** the bad
assistant message and the error tool result in the conversation
history. The next LLM call sees its own broken output as recent
context, which biases the model toward producing more broken output
on the retry — a death spiral.

The fix: when an entire turn's tool calls all return validation
errors, replace the bad assistant message + error tool results with
a single `user`-role correction note before making the next LLM call.
The model gets a clean retry shot with explicit guidance.

**Estimated effort:** ~1 hour including verification.
**Files touched:** `bin/smallcode.js` only.

---

## Background

Smallcode is an interactive coding agent driven by small local LLMs.
Its agent loop, in `bin/smallcode.js` around line 612, looks like
this (simplified):

```javascript
while (toolCallsThisTurn < MAX_TOOL_CALLS) {
  const response = await chatCompletion(config, conversationHistory);
  if (!response) break;
  const message = response.choices?.[0]?.message;
  if (!message) break;

  if (message.tool_calls?.length > 0) {
    conversationHistory.push(message);                    // ← (A) assistant w/ tool_calls
    for (const tc of message.tool_calls) {
      const result = executeTool(...);
      conversationHistory.push({                          // ← (B) tool result
        role: 'tool',
        tool_call_id: tc.id,
        content: result.error || result.result,
      });
    }
    continue;
  }
  // ...
  break;
}
```

Tool dispatch happens in `bin/executor.js`. After the recent
"executor args validation" fix (see `tool-fail-fix-plan.md`),
handlers like `patch`, `read_and_patch`, and `create_and_run` return
`{ error: "patch: missing or non-string arg(s): path, old_str, new_str. received: {}" }`
when the model produces malformed arguments — rather than crashing.

## The bug this addresses

After landing the args-validation fix, the bad assistant message
(with the malformed tool_call) and the tool error message both stay
in `conversationHistory`. The next LLM call is sent with that history.
Two observed effects:

1. **The model often emits *another* malformed tool call on the retry.**
   The presence of its own bad output in context biases sampling
   toward similar bad output. With temperature > 0 we'd expect
   occasional recovery, but in practice the failure can cascade
   across several turns and exhaust other safety nets (timeouts,
   server-side parse limits).

2. **The retry's failure mode is sometimes *worse* than the first.**
   In production runs we've seen the next response contain tool-call
   arguments so badly malformed that the LLM server returns HTTP 500
   from its own tool-call JSON parser (e.g.
   `"Failed to parse tool call arguments as JSON: parse error at line 1, column 3267"`).
   That's a separate issue with retry policy (see
   `api-500-retry-fix-plan.md`), but the root cause is upstream: the
   model was already off-rails because we kept its earlier bad
   output in the conversation.

The cleaner approach is to never give the model a chance to see its
own validation failures as context.

---

## Recommended fix

### Strategy

Track whether *every* tool call in the current assistant turn produced
a validation error (i.e. an `error` field that came from the executor's
arg guard, not from a legitimate "file not found" / "old_str not found"
runtime error). If so, before the next LLM call:

1. Pop the bad assistant message and the error tool results from
   `conversationHistory`.
2. Push a single `user`-role correction message in their place
   explaining what was wrong.

The model's next turn sees: prior good context, then a `user` message
saying "your previous response had invalid arguments — try again with
correct ones." No bad assistant output in history.

### Distinguishing "validation failure" from other tool errors

Not every error should trigger this. `File not found` and
`old_str not found in foo.py` are legitimate runtime errors the model
*should* see and reason about. The validation guards introduced in
`tool-fail-fix-plan.md` are a distinct category — they indicate the
model failed to produce a well-formed tool call at all.

Two options:

- **Option A (recommended): mark validation errors with a sentinel.**
  In `bin/executor.js`, change the validation guards to return
  `{ error: "...", kind: "validation" }`. The agent loop checks for
  `result.kind === 'validation'` to decide whether this is a
  history-poisoning case. Other errors don't get the marker and are
  treated as normal runtime errors.

- **Option B: string-match the error prefix.** The validation errors
  all start with `"<tool_name>: missing or non-string arg(s):"`.
  The agent loop can grep that prefix. Brittle but no executor change.

Option A is more durable. The diff is small.

### Concrete diffs

**`bin/executor.js`** — extend the validation guards (one per tool,
per `tool-fail-fix-plan.md`) to include the `kind` field:

```diff
       if (__missing.length) {
         return {
           error: `patch: missing or non-string arg(s): ${__missing.join(', ')}. ` +
                  `received: ${JSON.stringify(args).slice(0, 200)}`,
+          kind: 'validation',
         };
       }
```

**`bin/smallcode.js`** — in the agent loop's tool-dispatch block,
track validation failures across the turn and inject a correction.

Locate the inner `for (const tc of message.tool_calls)` loop (around
line 660). Wrap it like this:

```diff
     if (message.tool_calls?.length > 0) {
       conversationHistory.push(message);

+      const __turnToolCallCount = message.tool_calls.length;
+      const __validationErrors = [];
       for (const tc of message.tool_calls) {
         // ... existing tool execution + push tool result ...
+        if (result.kind === 'validation') {
+          __validationErrors.push(`${tc.function.name}: ${result.error}`);
+        }
       }

+      // If every tool call in this turn was a validation failure,
+      // strip the poisoned messages and inject a correction prompt
+      // so the model gets a clean retry attempt.
+      if (__validationErrors.length === __turnToolCallCount) {
+        // Pop the tool results we just pushed (one per tool_call)
+        for (let i = 0; i < __turnToolCallCount; i++) conversationHistory.pop();
+        // Pop the assistant message
+        conversationHistory.pop();
+        // Push a user-role correction
+        conversationHistory.push({
+          role: 'user',
+          content: '[SYSTEM] Your previous response contained ONLY invalid ' +
+                   'tool-call arguments:\n' +
+                   __validationErrors.map(e => '  - ' + e).join('\n') +
+                   '\n\nRe-read the tool schemas and try again with valid arguments.',
+        });
+      }

       continue;
     }
```

A couple of caveats embedded in the diff:

- We only strip the assistant + tool results when **all** tool calls
  in the turn failed validation. If the model emitted 3 tool calls and
  2 succeeded, the partial success is still valid context — leave it
  alone. Mixed turns are uncommon for the failure modes we've seen.
- We use a `user`-role message rather than `system` for the
  correction. Reason: most chat templates handle a mid-conversation
  `system` message inconsistently (some treat it as a new system
  prompt, some inject it into a template slot that confuses the model).
  `user` is portable.

### What NOT to do

- **Don't pop on a single failed call when other tool calls in the
  same turn succeeded.** The successful tool results carry information
  the model needs. Only purge when the entire turn was wasted.
- **Don't lower temperature for the retry.** The whole point of
  resampling is hoping for different output; pinning temperature
  defeats it. Keep `temperature: 0.1`.
- **Don't recurse / re-invoke the model from inside the dispatch
  block.** The outer `while` loop already handles the next call after
  `continue`. Adding another `await chatCompletion(...)` inside the
  block tangles the control flow.

---

## Style notes (match the codebase)

- `bin/smallcode.js` is plain CommonJS. No TypeScript.
- The existing code uses `__` prefix for loop-local variables
  (`__attempt`, `__controller`). The diff above follows that.
- `console.log(chalk.yellow(...))` or similar is used for soft
  notifications; consider adding `console.log(chalk.yellow('  ⚠
  All tool calls invalidated — retrying with clean history'))` so the
  user can see the intervention happen.

---

## Verification

### 1. Syntax check (no setup required)

```sh
node --check bin/smallcode.js
node --check bin/executor.js
```

Both should exit 0.

### 2. Manual probe

The fastest way to confirm the cleanup fires: stub the model to emit
an invalid `patch` tool call once, then a valid one. Use a tiny mock
server (similar to the one in `api-500-retry-fix-plan.md`) that
returns:

- Call 1 → tool_calls: `[{ function: { name: 'patch', arguments: '{}' } }]`
- Call 2 → tool_calls: `[]`, content: `'ok done'`

After running smallcode against the mock, dump the conversation
history (or log it via `console.log` inside the loop) and verify:

- The bad assistant message (from call 1) is **not** present.
- The bad tool result (from call 1) is **not** present.
- A `user`-role correction message **is** present in their place.
- The history's tail is: `..., user(correction), assistant(empty, no tool_calls)`.

### 3. Full smoke

Production reproduction: the smallcode user who reported this has an
eval harness where ~20% of trials end with a server 500 caused by
this exact death spiral. After landing the fix, that failure rate
should drop substantially (probably to whatever the residual
single-call validation-failure rate is, ~5%).

A run that previously crashed should now look like:

```
  ⚙ patch ✗ patch: missing or non-string arg(s): path, old_str, new_str. received: {}
  ⚠ All tool calls invalidated — retrying with clean history
  ⚙ patch ✓ Edited foo.py:42 0ms
  ⚙ run $ pytest 624ms
All done. ...
```

…rather than the chained 500 → exit.

---

## Out of scope

- **Cap how many consecutive validation-failure turns to tolerate.**
  If the model emits invalid args repeatedly, smallcode should
  eventually give up rather than loop forever. Not needed for the
  observed failure (it usually recovers on the first retry), but a
  reasonable defensive add.
- **Smarter parsing in the upstream "forgiving" tool-call parser.**
  Catching malformed args at the parser layer is a separate, more
  invasive change.
- **Telemetry on validation-failure rates.** Worth adding to
  understand how often each tool gets bad args, but not this fix.

---

## When to ship

Depends on `tool-fail-fix-plan.md` (the args-validation guards). If
landing both, do that one first since this builds on its `kind` field.

The agent-loop change is independent of `api-500-retry-fix-plan.md`
and they're complementary: this fix reduces *when* 5xx happens; the
retry fix handles 5xx *when* it still happens. Ship in any order.
