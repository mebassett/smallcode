# Fix plan: `executor.js` crashes when the model emits malformed tool args

## TL;DR

Three tool handlers in `bin/executor.js` blindly dereference required `args`
fields without checking they exist. When a small model emits a malformed
tool call (missing or non-string fields), Node throws e.g.
`TypeError: Cannot read properties of undefined (reading 'replace')` and the
**entire agent process exits non-zero**, throwing away all the work done so
far. The fix is a 3-line guard at the top of each affected `case` that
returns a structured `{ error: ... }` so the agent loop can feed the error
back to the model and let it retry.

This is squarely a contradiction of smallcode's headline value prop —
the README advertises a "Forgiving tool call parser: Small models produce
messy output. SmallCode parses tool calls from JSON, YAML, XML, Hermes
format, or plain text with auto-repair of common errors." The dispatcher
that runs the parsed tool calls needs to be just as forgiving.

**Estimated effort:** ~30 minutes including verification.
**Files touched:** `bin/executor.js` only.

---

## Background you need

### What smallcode is
SmallCode is a CLI coding agent designed to be driven by small,
locally-hosted LLMs (8B–35B param range). It's built around the assumption
that small models will produce noisy, sometimes-malformed tool-call output
and that the runtime should recover gracefully rather than blow up.

It exposes a set of tools (read_file, write_file, patch, bash, etc.) to the
model via OpenAI's function-calling format. The main agent loop:

1. Sends the conversation + tool definitions to the LLM.
2. Parses the LLM's response — including any tool_calls — through a
   "forgiving" parser that accepts multiple formats.
3. Dispatches each tool_call to the corresponding handler.
4. Feeds the tool's result back to the LLM and continues.

The tool dispatch happens in `bin/executor.js` — a big `switch` on the
tool name, one `case` per tool.

### What goes wrong
The forgiving parser can produce a `tool_call` with `arguments` that's
missing one or more of the fields the tool actually needs. The model
sometimes emits e.g. `{"new_str": "..."}` without `old_str` or `path`,
or emits arguments as a string that the parser couldn't reshape into the
expected schema.

The dispatch handlers — written under the assumption that args are
well-formed — call methods on those undefined fields directly:

- `args.path.replace(...)` when `args.path` is `undefined` → TypeError
- `content.split(args.old_str)` when `args.old_str` is `undefined` →
  no immediate crash (split on undefined returns [content]) but the
  subsequent semantics are wrong
- `content.replace(args.old_str, args.new_str)` likewise

Because none of these errors are caught in the executor, the
TypeError propagates up out of the agent loop and Node exits the process.
The user sees:

```
✗ Failed to parse args for patch
⚙ patch Fatal: Cannot read properties of undefined (reading 'replace')
```

…and **all the work the agent did before that turn is lost**. The agent
can't recover, retry, or even tell the model what went wrong.

### Why this is a real, observed bug

This crash has been observed in production-like runs using qwen3.6-27B
through smallcode. The model occasionally emits a partial `patch`
tool call (`new_str` set, `old_str` missing) and the entire run dies.
The user's terminal session shows the agent had been making good
progress — reading files, planning, even applying one or two edits —
and then a single bad tool call wipes the whole session.

---

## The fix

### Location

`bin/executor.js`, three case blocks:

| Tool             | Line (approx) | Required args                |
| ---------------- | ------------- | ---------------------------- |
| `patch`          | ~71           | `path`, `old_str`, `new_str` |
| `read_and_patch` | ~213          | `path`, `old_str`, `new_str` |
| `create_and_run` | ~234          | `path`, `content`            |

(Line numbers will drift; search by the `case 'patch':` etc. tokens.)

### Pattern

For each handler, insert a guard at the top that checks the required
fields are present and string-typed, and returns a structured error if
not. Match the existing style of error returns in the same file
(e.g. `return { error: 'File not found: ...' };`).

### Concrete diffs

**`bin/executor.js`, case `patch`:**

```diff
     case 'patch': {
+      const __missing = ['path', 'old_str', 'new_str']
+        .filter(k => typeof args[k] !== 'string');
+      if (__missing.length) {
+        return {
+          error: `patch: missing or non-string arg(s): ${__missing.join(', ')}. ` +
+                 `received: ${JSON.stringify(args).slice(0, 200)}`,
+        };
+      }
       let reqPath = args.path.replace(/^\.\//, '').replace(/^\.\\/, '');
       const filePath = path.resolve(cwd, reqPath);
       ...
```

**`bin/executor.js`, case `read_and_patch`:**

```diff
     case 'read_and_patch': {
+      const __missing = ['path', 'old_str', 'new_str']
+        .filter(k => typeof args[k] !== 'string');
+      if (__missing.length) {
+        return {
+          error: `read_and_patch: missing or non-string arg(s): ${__missing.join(', ')}. ` +
+                 `received: ${JSON.stringify(args).slice(0, 200)}`,
+        };
+      }
       const filePath = path.resolve(cwd, args.path);
       ...
```

**`bin/executor.js`, case `create_and_run`:**

```diff
     case 'create_and_run': {
+      const __missing = ['path', 'content']
+        .filter(k => typeof args[k] !== 'string');
+      if (__missing.length) {
+        return {
+          error: `create_and_run: missing or non-string arg(s): ${__missing.join(', ')}. ` +
+                 `received: ${JSON.stringify(args).slice(0, 200)}`,
+        };
+      }
       const filePath = path.resolve(cwd, args.path);
       ...
```

### Why `return { error: ... }` and not `throw`

The executor's caller — the main agent loop in `bin/smallcode.js` — treats
`{ error: ... }` results from tool handlers as **expected feedback the
model needs to see**. Look at how the existing error returns (e.g.
`File not found: ...`, `old_str not found in ...`) are handled: they
get formatted as tool-result messages and fed back into the next LLM
turn, so the model knows what went wrong and can fix its next attempt.

Throwing would skip that path and kill the loop. The whole point of this
fix is to keep the loop alive so the model self-corrects, matching
smallcode's "forgiving" promise.

### Why include `JSON.stringify(args).slice(0, 200)` in the error

When the model produces a malformed tool call, seeing what it actually
sent is the single most useful piece of debug info — both for the model
(it gets to compare to what it should have sent) and for the engineer
investigating future failures. The 200-char cap keeps the result
payload manageable.

---

## Style notes (match the codebase)

- The file is plain CommonJS Node, no TypeScript, no `async`/`await` in
  these handlers — they're synchronous. Don't introduce ESM or Promises.
- Existing error returns use single quotes, template literals only for
  interpolation. The diffs above match.
- The `__` prefix on local guard variables matches the convention used
  for `__controller`, `__timer`, etc. in `src/compiled/cognition/`.

---

## Verification

After applying the diff, three checks. The first two are local; the
third requires the smallcode user to re-run their docker eval setup.

### 1. Syntax check (no setup required)

```sh
node --check bin/executor.js
```

Should exit 0 with no output.

### 2. Manual unit-style probe

The fastest way to confirm the guard fires correctly is to require the
executor and call it with malformed args. The `executeTool` function in
`bin/executor.js` is the dispatcher — check the file for the exact
function name exported (it might also be the default export). Then:

```sh
node -e '
  const { executeTool } = require("./bin/executor.js");
  // Adjust the function name above if executor.js exports differently.
  const r = executeTool({ tool: "patch", args: { new_str: "x" } }, { cwd: "/tmp" });
  console.log(JSON.stringify(r, null, 2));
'
```

You should see something like:
```json
{
  "error": "patch: missing or non-string arg(s): path, old_str. received: {\"new_str\":\"x\"}"
}
```

And critically: **no thrown exception, no process crash**.

If `executeTool` is called differently (e.g. takes the tool name and args
as separate parameters, or is async), adjust the invocation accordingly.
The `case 'patch':` block is inside a function — find that function and
look at how the existing test code (if any) or the main agent loop calls
it.

### 3. Full smoke (smallcode user will do this)

Re-run smallcode against a small local model on a task that previously
crashed (e.g. the "ledger" interview problem). Expected behavior:

- If the model emits a malformed patch call, smallcode prints an error
  line but the agent continues. The model gets the error message in the
  next turn and (usually) retries with corrected args.
- The session doesn't die. The agent reaches a normal stop condition
  (task complete, max turns, etc.) instead of crashing.

A successful run will produce something like:
```
  ⚙ patch ✗ Error: patch: missing or non-string arg(s): old_str. received: {...}
  ⚙ patch ✓ Edited foo.py:42 0ms
  ⚙ run $ pytest 624ms
All done. Here's a summary: ...
```

…rather than the previous fatal crash.

---

## Out of scope

These would be good follow-ups but are NOT part of this fix:

- **Comprehensive arg validation for every tool.** This fix targets the
  three handlers known to crash. Others (`read_file`, `write_file`,
  `bash`, etc.) may have similar latent bugs — worth auditing in a
  separate pass.
- **Centralized validation helper.** Once the pattern is in three places
  it's worth extracting a `requireArgs(args, ['path', 'old_str'])`
  helper. Leave that for a refactor.
- **Tests.** The codebase doesn't have a unit-test harness for executor.js
  as far as I can see. Adding one is a separate, larger piece of work.
- **The forgiving parser itself.** This fix sits downstream of the parser.
  Improving the parser to fill in defaults or reject malformed calls
  before dispatch is a separate, more invasive change.

---

## When to ship

Standalone fix — no other changes depend on it. The three diffs are
independent of each other; you can land them in one commit or three.

A single commit titled e.g. `executor: guard required args in patch /
read_and_patch / create_and_run handlers` is fine.
