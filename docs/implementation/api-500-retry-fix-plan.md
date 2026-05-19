# Fix plan: `chatCompletion` doesn't retry on 5xx errors from the LLM server

## TL;DR

`bin/smallcode.js`'s `chatCompletion` function retries failed LLM API
requests on **4xx** responses only, and silently kills the agent loop on
**5xx**. That's backwards for the failure modes that actually matter
in practice — 5xx from a local LLM server is usually transient and
recovers on a second attempt. The fix is a one-character widening of
the retry condition (drop the `< 500` upper bound), with an optional
extension to multiple retries + exponential backoff.

**Estimated effort:** ~10 minutes for the minimal fix; ~30 minutes for
the extended version with backoff and tests.

**Files touched:** `bin/smallcode.js` only.

---

## Background

### What smallcode is
SmallCode is a CLI coding agent designed to be driven by small,
locally-hosted LLMs (8B–35B param range). It talks to an
OpenAI-compatible chat-completions endpoint (typically `llama-server`,
`vLLM`, or `LM Studio` running on `localhost`). The agent loop
repeatedly:

1. Sends the conversation + tool definitions to the LLM.
2. Receives an assistant message with optional `tool_calls`.
3. Executes any tool calls and feeds the results back.
4. Repeats until the model stops emitting tool calls.

The HTTP call to the LLM server happens inside `chatCompletion` in
`bin/smallcode.js` (around line 1250). The agent loop is the `while`
loop that follows; it calls `chatCompletion` once per turn.

### What happens when the LLM server returns a non-OK response

Current behavior (`bin/smallcode.js`, around line 1306):

```javascript
if (!response.ok) {
  const err = await response.text();
  // Retry once on 4xx (handles LM Studio model reload / rate limit)
  if (response.status >= 400 && response.status < 500) {
    await new Promise(r => setTimeout(r, 2000));
    try {
      const retry = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
      if (retry.ok) return await retry.json();
    } catch {}
  }
  console.log(`  \x1b[31m✗ API error ${response.status}: ${err.slice(0, 200)}\x1b[0m`);
  return null;
}
```

So:
- **4xx**: wait 2s, retry once. If the retry succeeds, returns its
  data and the agent continues. If the retry also fails, falls through
  to logging + `return null`.
- **5xx**: no retry. Logs the error and returns null immediately.
- `chatCompletion` returning `null` is interpreted by the agent loop as
  "no response from model" — the loop breaks and the agent exits.

## Why this is a bug

The retry logic is targeted at the wrong class of error.

- **4xx is usually a structural request error** (bad headers, malformed
  body, model name not recognized, etc.). The next request with the
  *same* body will almost always fail the same way. Retrying is rarely
  productive.
- **5xx is usually a transient server-side error**. For an
  OpenAI-compatible LLM server, the most common 5xx causes are:
  - The model emitted output that the server's tool-call parser
    couldn't turn into valid JSON. With temperature > 0 (smallcode's
    main loop uses `temperature: 0.1`), the **very next sampling pass
    will almost certainly produce parseable output** because the
    sampling RNG seed differs each request.
  - Server briefly hit an internal limit (queue, context, KV cache).
  - Server is mid-restart / hot-swap.

All three of these recover on a retry.

### Observed failure

In a production-like eval setup (qwen3.6-27B served by `llama-server`,
smallcode driving it through a coding task), the server returned:

```
HTTP 500
{"error":{"code":500,"message":"Failed to parse tool call arguments as JSON:
[json.exception.parse_error.101] parse error at line 1, column 3267:
syntax error while parsing value - invalid string: mis..."}}
```

This is exactly the "model emitted malformed tool-call JSON one time"
case. The model had been making valid tool calls for ~8 prior turns.
A simple retry would have produced a valid response on the next pass.
Instead, smallcode logged the error, returned null, and the agent loop
broke — wiping all the progress made up to that point.

The same agent, driving the same model on the same machine via a
non-harbor path, succeeded on adjacent runs because the model happened
not to emit malformed JSON those times. With `temperature: 0.1`, that
output variance is inherent to the setup. The runtime needs to be
robust to it; the runtime is not.

---

## Recommended fix

### Minimal fix (one-character change, validates the theory)

`bin/smallcode.js`, in the `chatCompletion` error block:

```diff
       // Retry once on 4xx (handles LM Studio model reload / rate limit)
-      if (response.status >= 400 && response.status < 500) {
+      if (response.status >= 400) {
         await new Promise(r => setTimeout(r, 2000));
         try {
           const retry = await fetch(`${baseUrl}/chat/completions`, {
             method: 'POST',
             headers,
             body: JSON.stringify(body),
           });
           if (retry.ok) return await retry.json();
         } catch {}
       }
```

Also update the surrounding comment so future readers understand the
intent:

```diff
-      // Retry once on 4xx (handles LM Studio model reload / rate limit)
+      // Retry once on any non-2xx response. 5xx from llama-server is
+      // often a one-off tool-call JSON parse failure that recovers on
+      // the next sampling pass; 4xx covers rate limit / model reload.
```

That's the whole minimal fix. Ships independently. No new dependencies,
no new state, no test setup required beyond what already exists.

### Optional extension: multiple retries with exponential backoff

One retry usually catches the transient case, but if the underlying
issue is "model produces bad JSON 30% of the time at this point in the
conversation," one retry isn't enough. Extending to N retries with
exponential backoff is a small additional change:

```javascript
if (!response.ok) {
  const err = await response.text();
  // Retry on any non-2xx with exponential backoff.
  if (response.status >= 400) {
    const maxRetries = 3;
    const baseDelayMs = 2000;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      await new Promise(r => setTimeout(r, baseDelayMs * Math.pow(2, attempt - 1)));
      try {
        const retry = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        });
        if (retry.ok) return await retry.json();
      } catch {
        // network error mid-retry — try the next attempt
      }
    }
  }
  console.log(`  \x1b[31m✗ API error ${response.status}: ${err.slice(0, 200)}\x1b[0m`);
  return null;
}
```

Backoff sequence at `baseDelayMs=2000`, `maxRetries=3` is **2s → 4s → 8s**,
total ~14s of waiting in the worst case before giving up. Reasonable
for a local-server failure that's almost always within the first
retry.

### What NOT to do

- **Don't make the retry depend on the response body or error message.**
  Parsing the server's error JSON to decide whether to retry is
  brittle (different LLM servers format errors differently) and not
  needed — the status code is enough signal.
- **Don't try to mutate the request body between retries.** Smallcode
  doesn't have visibility into *why* the model emitted bad JSON; just
  resending the same body is correct.
- **Don't lower the temperature for retries.** That sounds reasonable
  ("be more deterministic on retry") but it changes the agent's
  effective sampling profile across the conversation and makes traces
  hard to reason about. If the failure persists, it's a deeper issue.

---

## Style notes (match the codebase)

- `bin/smallcode.js` is plain CommonJS. No TS, no top-level `await`,
  no ESM.
- Existing error logging uses `\x1b[31m...\x1b[0m` for red text via
  `console.log`. Match that.
- The existing single-retry block has no logging on retry attempts —
  the extension above also stays silent until all retries are
  exhausted. Optional improvement: log `attempt N/N` on the way; not
  required.

---

## Verification

### 1. Syntax check (no setup required)

```sh
node --check bin/smallcode.js
```

Should exit 0 with no output.

### 2. Synthetic 500 from a mock server

The fastest way to confirm the retry actually fires is to point
smallcode at a tiny mock server that returns 500 once then succeeds.
This validates both the retry logic and that smallcode keeps running.

```js
// save as test-500-retry.js
const http = require('http');
let calls = 0;
http.createServer((req, res) => {
  calls++;
  if (calls === 1) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end('{"error":{"code":500,"message":"simulated transient failure"}}');
  } else {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [{ message: { content: 'ok', tool_calls: [] } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }));
  }
}).listen(19999, () => console.log('mock listening on 19999'));
```

Then run it alongside smallcode:

```sh
node test-500-retry.js &
MOCK_PID=$!

# Point smallcode at the mock
SMALLCODE_BASE_URL=http://localhost:19999/v1 \
SMALLCODE_MODEL=mock \
node bin/smallcode.js --non-interactive "hello"

kill $MOCK_PID
```

Expected behavior with the fix:
- First request returns 500.
- Smallcode waits 2s.
- Retry succeeds; smallcode prints the model's "ok" content and exits
  cleanly with rc=0.
- Console shows no "✗ API error" line (because the retry succeeded
  before falling through to the log).

Without the fix, you'd see `✗ API error 500: simulated transient
failure` and a non-zero exit.

### 3. Full smoke against the real failure (the smallcode user can do this)

The user who reported the original failure has a docker-based eval
harness that occasionally hits the production 500. After landing the
fix, several runs should now succeed where they previously failed —
in trace logs, look for the absence of the "Failed to parse tool call
arguments" 500 followed by an immediate abort. With the fix, the same
error will appear in the server's log but smallcode will keep going
silently (after the 2s delay) and the trial will complete normally.

---

## Out of scope

- **Server-side fix for the tool-call JSON parse bug.** llama-server
  could be more robust about generating tool_calls from messy model
  output. That's an upstream change in `ggml-org/llama.cpp`; not this
  fix.
- **Streaming response handling.** Smallcode's main chat call uses
  `stream: false`. Streaming has its own retry/resumption story; this
  fix only covers the single-response path.
- **Different retry policy by status code.** A more sophisticated
  client might retry indefinitely on 503, never on 501, etc. Not
  needed yet; the same simple policy (`>= 400, retry once`) works for
  all observed cases.

---

## When to ship

Standalone fix, no other changes depend on it. Land it as a single
commit titled e.g. `chatCompletion: retry on 5xx (not just 4xx)` —
short subject, the diff is one line.

If you also pick up the executor args-validation fix (separate plan
in this repo under `tool-fail-fix-plan.md`), the two are independent
and can ship in either order or together.
