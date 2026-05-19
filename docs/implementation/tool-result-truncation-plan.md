# Fix plan: Raise the per-tool-result truncation cap

## TL;DR

`bin/smallcode.js` (line 711) caps every tool result fed back to the
model at **4000 characters** with a `...(truncated, N chars total)...`
marker. For `read_file` on files larger than ~120 lines, this forces
the model to issue multiple `start_line` reads to see the rest. Each
extra read consumes a full LLM turn — exposure to variance, and a
chance to hit other failure modes (timeout, malformed tool call,
silent give-up). Raising the cap to 16000 chars (or making it
configurable) collapses most multi-read sequences into a single read.

**Estimated effort:** ~10 minutes.
**Files touched:** `bin/smallcode.js` only.

---

## Background

When the model invokes a tool (`read_file`, `bash`, etc.), smallcode
runs the tool and pushes the result back into the conversation as a
`role: 'tool'` message. To keep total context manageable across many
tool calls, smallcode caps each individual tool result at a fixed
character limit.

In `bin/smallcode.js` around line 710:

```javascript
// Add tool result to history (cap to prevent context explosion)
// Default 4k chars per result — keeps 10 tool calls at ~10k tokens total
const toolContent = result.result || result.error || '';
const maxToolResultChars = 4000;
const cappedContent = toolContent.length > maxToolResultChars
  ? toolContent.slice(0, maxToolResultChars - 200)
      + '\n\n...(truncated, ' + toolContent.length + ' chars total)...\n'
      + toolContent.slice(-200)
  : toolContent;
conversationHistory.push({
  role: 'tool',
  tool_call_id: tc.id,
  content: cappedContent,
});
```

4000 chars ≈ ~1000 tokens ≈ ~120 lines of typical source code.

## Why this is too aggressive for code-reading tasks

The most common smallcode workflow is: read a file, understand it,
edit it. For files larger than ~120 lines (which is *most* real-world
files), the model sees:

```
file.py (271 lines):
   1│ ...
   2│ ...
   ...
 100│ ...

...(truncated, 9754 chars total)...

 268│ ...
 269│ ...
 270│ ...
 271│ ...
```

So the model knows the file is 271 lines and sees the first ~100 and
last ~5. To plan an edit it needs to issue more `read_file` calls
with `start_line=95`, then `start_line=200`, etc. — each one a full
LLM round-trip.

Observed in production with a 271-line `test_ledger.py`:

- 4 separate `read_file` calls before the model has the full picture.
- Each call is one LLM turn (~30s with qwen3.6-27B at this hardware).
- 4 turns of pure exploration before any patching — burning context
  budget and exposing the run to several "model gives up / model
  emits malformed output / server times out" failure modes that
  scale with turn count.

A 16k-char cap covers ~480 lines, which fits most files in one read.

## Fix

`bin/smallcode.js`, around line 711:

```diff
     // Add tool result to history (cap to prevent context explosion)
-    // Default 4k chars per result — keeps 10 tool calls at ~10k tokens total
+    // Default 16k chars per result — most real files fit in one read.
+    // Multi-read sequences (each costing a full LLM turn) are the most
+    // common source of unforced agent failures.
     const toolContent = result.result || result.error || '';
-    const maxToolResultChars = 4000;
+    const maxToolResultChars = 16000;
```

### Optional: env var override

```diff
-    const maxToolResultChars = 16000;
+    const maxToolResultChars = parseInt(process.env.SMALLCODE_MAX_TOOL_RESULT_CHARS) || 16000;
```

Operators with tight context budgets (or models with small windows)
can dial it down.

### Why 16000 specifically

16k chars ≈ 4k tokens. Typical conversation budget breakdown for an
agent task:

- System prompt: ~500 tokens
- User instruction: ~200 tokens
- Tool definitions: ~1500 tokens
- 10 tool results × 4k tokens = ~40k tokens
- Reasoning + tool call assistant messages: ~10k tokens

Total: ~52k tokens, comfortably inside a 64k or 128k context window
that any modern local model exposes. The 4k-per-result cap was
calibrated for much smaller context windows (8k–16k) and is overly
conservative now.

For very large files, the existing truncation marker still fires —
it just kicks in for ~480-line files instead of ~120-line ones. The
"head + tail with marker" format is fine; just raise the threshold.

### Don't also change

- The 200-char head/tail preservation when truncation does happen.
  That format works; the issue is just that the cap is too low.
- The mid-turn context-eviction logic (around line 615 — evicts
  oldest `role: 'tool'` messages when total context blows past 60% of
  the detected window). That's a separate safety net and stays as-is.

---

## Style notes

- Plain CommonJS. No TypeScript.
- The `maxToolResultChars` constant is local to the tool-execution
  block. If you make it configurable via env, parse once at module
  load (not every iteration) by lifting the parse to a top-level
  constant:

```javascript
const MAX_TOOL_RESULT_CHARS =
  parseInt(process.env.SMALLCODE_MAX_TOOL_RESULT_CHARS) || 16000;
```

---

## Verification

### 1. Syntax check

```sh
node --check bin/smallcode.js
```

### 2. Behavioral check

Run smallcode against a task that previously required multiple
`read_file` calls on the same file. With the bump, the model should
issue **one** `read_file` and proceed to the next action.

Trace comparison — before:

```
1. read_file(README.md)
2. find_files(*test*)
3. read_file(test_ledger.py)         ← truncated at line ~120
4. read_file(test_ledger.py, start_line=95)  ← truncated
5. read_file(test_ledger.py, start_line=205) ← end of file
6. read_file(ledger.py)
7. patch(ledger.py, ...)
```

After:

```
1. read_file(README.md)
2. find_files(*test*)
3. read_file(test_ledger.py)         ← full file
4. read_file(ledger.py)
5. patch(ledger.py, ...)
```

Two fewer LLM turns. Two fewer chances to roll bad dice.

### 3. Smoke

Re-run an eval batch that has historically been borderline (e.g. the
ledger task at qwen3.6-27B). Median tool-call count per successful
run should drop noticeably; success rate should improve a few
percentage points.

---

## Out of scope

- **Smarter context-window-aware capping.** Could detect the model's
  context window and scale the cap proportionally. Useful but not
  required; 16k is reasonable across all common windows.
- **Per-tool truncation policies.** A `bash` command producing 50MB
  of `find /` output probably *should* be more aggressively
  truncated than a 10k-char source file. Worth exploring; not this
  fix.
- **The mid-turn eviction logic.** Independent safety net for cases
  where total context grows too large despite per-result caps.
  Leave it alone.

---

## When to ship

Standalone. No dependencies on other fixes in this repo. Can ship
alongside `max-tokens-bump-plan.md` — the two are complementary
(more tokens out per turn + fewer turns to get the same work done).
