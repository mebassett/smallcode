#!/usr/bin/env node
// SmallCode Agent Performance Benchmark
// Measures: token efficiency, response time, tool call overhead, context usage
// Run: node bench/bench_agent.js

const BASE_URL = 'http://10.0.0.20:1234/v1';
const MODEL = 'huihui-gemma-4-e4b-it-abliterated';

// ─── Utilities ───────────────────────────────────────────────────────────────

function countTokens(text) {
  return Math.ceil((text || '').length / 4);
}

async function chat(messages, tools = null) {
  const body = { model: MODEL, messages, max_tokens: 2048 };
  if (tools) body.tools = tools;

  const start = performance.now();
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const elapsed = performance.now() - start;
  const data = await res.json();

  const promptTokens = data.usage?.prompt_tokens || countTokens(JSON.stringify(messages));
  const completionTokens = data.usage?.completion_tokens || countTokens(data.choices?.[0]?.message?.content || '');

  return {
    elapsed,
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    hasToolCalls: !!(data.choices?.[0]?.message?.tool_calls?.length),
    content: data.choices?.[0]?.message?.content || '',
    toolCalls: data.choices?.[0]?.message?.tool_calls || [],
  };
}

// ─── SmallCode's System Prompt (what we actually send) ───────────────────────

const SMALLCODE_SYSTEM = `You are SmallCode, a coding assistant that operates in the user's project directory.

You have tools to read, write, and edit files, run shell commands, and search code.
You also have project memory: a persistent wiki of decisions, workflows, conventions, and gotchas.

Rules:
- ALWAYS read a file before editing it.
- Use the "patch" tool for edits (find and replace). Do NOT rewrite whole files unless creating new ones.
- Be concise — show what you did, not lengthy explanations.
- If a task has multiple steps, do them one at a time.
- When you're done, say what you accomplished in 1-2 sentences.
- Use memory_load before complex tasks to check for relevant project knowledge.
- Use memory_remember to save important decisions, gotchas, or workflows you discover.

Working directory: C:/Users/savag/Downloads/ExoCode`;

// ─── OpenCode's System Prompt (from their source, simplified) ────────────────

const OPENCODE_SYSTEM = `You are an AI coding assistant. You operate on the user's machine to help with coding tasks.

## Available Tools
You have access to these tools:
- bash: Execute shell commands
- read: Read files from the filesystem
- edit: Make targeted edits to files using search and replace
- write: Create or overwrite files
- glob: Find files matching a pattern
- grep: Search file contents with regex
- lsp: Language server operations (experimental)
- todo_write: Track tasks
- webfetch: Fetch content from URLs
- websearch: Search the web

## Guidelines
- When asked to edit or fix something, use the edit or write tool
- When you need to understand the codebase, use read, glob, and grep
- Always prefer edit over write for existing files
- Be concise in responses
- Use markdown formatting for readable output
- When you complete a task, briefly summarize what was done

## Environment
OS: win32
CWD: C:/Users/savag/Downloads/ExoCode
Shell: cmd`;

// ─── SmallCode's Tools (what we send) ────────────────────────────────────────

const SMALLCODE_TOOLS = [
  { type: 'function', function: { name: 'read_file', description: 'Read a file. Returns content with line numbers.', parameters: { type: 'object', properties: { path: { type: 'string' }, start_line: { type: 'integer' }, end_line: { type: 'integer' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'write_file', description: 'Create or overwrite a file.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'patch', description: 'Edit file by replacing old_str with new_str.', parameters: { type: 'object', properties: { path: { type: 'string' }, old_str: { type: 'string' }, new_str: { type: 'string' } }, required: ['path', 'old_str', 'new_str'] } } },
  { type: 'function', function: { name: 'bash', description: 'Run shell command.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
  { type: 'function', function: { name: 'search', description: 'Search code with regex.', parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] } } },
  { type: 'function', function: { name: 'find_files', description: 'Find files by glob.', parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } } },
  { type: 'function', function: { name: 'graph_search', description: 'Search code graph for a symbol.', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'memory_load', description: 'Load relevant project memory.', parameters: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'] } } },
  { type: 'function', function: { name: 'memory_remember', description: 'Save knowledge to memory.', parameters: { type: 'object', properties: { type: { type: 'string' }, title: { type: 'string' }, content: { type: 'string' } }, required: ['type', 'title', 'content'] } } },
];

// ─── OpenCode's Tools (from their source — all 10+) ──────────────────────────

const OPENCODE_TOOLS = [
  { type: 'function', function: { name: 'bash', description: 'Execute a shell command on the system. Use this to run programs, install packages, or perform system operations. Commands run in a persistent shell session.', parameters: { type: 'object', properties: { command: { type: 'string', description: 'The shell command to execute' }, timeout: { type: 'number', description: 'Timeout in milliseconds' } }, required: ['command'] } } },
  { type: 'function', function: { name: 'read', description: 'Read the contents of a file from the filesystem. Use this to examine source code, configuration files, or any text-based file. Supports reading specific line ranges for large files.', parameters: { type: 'object', properties: { file_path: { type: 'string', description: 'Absolute path to the file to read' }, offset: { type: 'number', description: 'Line offset to start reading from' }, limit: { type: 'number', description: 'Max lines to read' } }, required: ['file_path'] } } },
  { type: 'function', function: { name: 'edit', description: 'Make targeted edits to a file using a search and replace block. Each edit replaces one occurrence of old_string with new_string.', parameters: { type: 'object', properties: { file_path: { type: 'string', description: 'Absolute path' }, old_string: { type: 'string', description: 'The exact string to find' }, new_string: { type: 'string', description: 'The replacement string' } }, required: ['file_path', 'old_string', 'new_string'] } } },
  { type: 'function', function: { name: 'write', description: 'Write content to a file. Creates the file if it does not exist, or overwrites if it does.', parameters: { type: 'object', properties: { file_path: { type: 'string', description: 'Absolute path' }, content: { type: 'string', description: 'Full content to write' } }, required: ['file_path', 'content'] } } },
  { type: 'function', function: { name: 'glob', description: 'Find files matching a glob pattern. Returns paths relative to the project root.', parameters: { type: 'object', properties: { pattern: { type: 'string', description: 'Glob pattern' }, path: { type: 'string', description: 'Directory to search from' } }, required: ['pattern'] } } },
  { type: 'function', function: { name: 'grep', description: 'Search file contents using regex. Returns matching lines with file paths and line numbers.', parameters: { type: 'object', properties: { pattern: { type: 'string', description: 'Regex pattern' }, path: { type: 'string', description: 'Directory or file' }, include: { type: 'string', description: 'File glob to include' } }, required: ['pattern'] } } },
  { type: 'function', function: { name: 'todo_write', description: 'Create or update the todo list for tracking tasks.', parameters: { type: 'object', properties: { todos: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, content: { type: 'string' }, status: { type: 'string' } } } } }, required: ['todos'] } } },
  { type: 'function', function: { name: 'webfetch', description: 'Fetch content from a URL.', parameters: { type: 'object', properties: { url: { type: 'string', description: 'URL to fetch' } }, required: ['url'] } } },
  { type: 'function', function: { name: 'websearch', description: 'Search the web for information.', parameters: { type: 'object', properties: { query: { type: 'string', description: 'Search query' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'skill', description: 'Load a specialized skill for domain-specific tasks.', parameters: { type: 'object', properties: { name: { type: 'string', description: 'Skill name' } }, required: ['name'] } } },
];

// ─── Benchmark Tasks ─────────────────────────────────────────────────────────

const TASKS = [
  "What files are in this project?",
  "Read the README.md file",
  "Find all TypeScript files in the src directory",
  "Create a file called hello.ts with a hello world function",
  "Fix a typo: change 'teh' to 'the' in README.md",
];

// ─── Run Benchmark ───────────────────────────────────────────────────────────

async function runBenchmark() {
  console.log("╔══════════════════════════════════════════════════════════════════╗");
  console.log("║  SmallCode vs OpenCode — Token Efficiency Benchmark             ║");
  console.log("║  Model: " + MODEL.slice(0, 50).padEnd(54) + "║");
  console.log("║  Endpoint: " + BASE_URL.padEnd(51) + "║");
  console.log("╚══════════════════════════════════════════════════════════════════╝\n");

  // Measure system prompt sizes
  const scSystemTokens = countTokens(SMALLCODE_SYSTEM);
  const ocSystemTokens = countTokens(OPENCODE_SYSTEM);
  const scToolsTokens = countTokens(JSON.stringify(SMALLCODE_TOOLS));
  const ocToolsTokens = countTokens(JSON.stringify(OPENCODE_TOOLS));

  console.log("─── Context Overhead (before any user message) ───────────────────");
  console.log(`  SmallCode system prompt: ${scSystemTokens} tokens`);
  console.log(`  OpenCode system prompt:  ${ocSystemTokens} tokens`);
  console.log(`  SmallCode tools schema:  ${scToolsTokens} tokens (${SMALLCODE_TOOLS.length} tools)`);
  console.log(`  OpenCode tools schema:   ${ocToolsTokens} tokens (${OPENCODE_TOOLS.length} tools)`);
  console.log(`  SmallCode TOTAL overhead: ${scSystemTokens + scToolsTokens} tokens`);
  console.log(`  OpenCode TOTAL overhead:  ${ocSystemTokens + ocToolsTokens} tokens`);
  console.log(`  Savings: ${Math.round((1 - (scSystemTokens + scToolsTokens) / (ocSystemTokens + ocToolsTokens)) * 100)}% less context\n`);

  // Run actual LLM calls
  console.log("─── Live Inference Test ──────────────────────────────────────────");
  console.log("  (hitting " + BASE_URL + " with " + MODEL + ")\n");

  const scResults = [];
  const ocResults = [];

  for (const task of TASKS) {
    // SmallCode style
    const scMessages = [{ role: 'system', content: SMALLCODE_SYSTEM }, { role: 'user', content: task }];
    const sc = await chat(scMessages, SMALLCODE_TOOLS);
    scResults.push(sc);

    // OpenCode style
    const ocMessages = [{ role: 'system', content: OPENCODE_SYSTEM }, { role: 'user', content: task }];
    const oc = await chat(ocMessages, OPENCODE_TOOLS);
    ocResults.push(oc);

    const winner = sc.totalTokens < oc.totalTokens ? '← SC wins' : sc.totalTokens > oc.totalTokens ? 'OC wins →' : 'tie';
    console.log(`  Task: "${task.slice(0, 45)}..."`);
    console.log(`    SmallCode: ${sc.totalTokens} tok, ${sc.elapsed.toFixed(0)}ms, tools: ${sc.hasToolCalls ? 'yes' : 'no'}`);
    console.log(`    OpenCode:  ${oc.totalTokens} tok, ${oc.elapsed.toFixed(0)}ms, tools: ${oc.hasToolCalls ? 'yes' : 'no'}`);
    console.log(`    ${winner}\n`);
  }

  // Aggregates
  const scTotal = scResults.reduce((s, r) => s + r.totalTokens, 0);
  const ocTotal = ocResults.reduce((s, r) => s + r.totalTokens, 0);
  const scAvgTime = scResults.reduce((s, r) => s + r.elapsed, 0) / scResults.length;
  const ocAvgTime = ocResults.reduce((s, r) => s + r.elapsed, 0) / ocResults.length;
  const scToolRate = scResults.filter(r => r.hasToolCalls).length / scResults.length * 100;
  const ocToolRate = ocResults.filter(r => r.hasToolCalls).length / ocResults.length * 100;

  console.log("═══════════════════════════════════════════════════════════════════");
  console.log("  RESULTS SUMMARY");
  console.log("═══════════════════════════════════════════════════════════════════");
  console.log(`                    SmallCode       OpenCode        Delta`);
  console.log(`  ─────────────────────────────────────────────────────────────`);
  console.log(`  Total tokens:     ${String(scTotal).padEnd(16)}${String(ocTotal).padEnd(16)}${Math.round((1 - scTotal/ocTotal) * 100)}% less`);
  console.log(`  Avg latency:      ${(scAvgTime).toFixed(0).padEnd(13)}ms ${(ocAvgTime).toFixed(0).padEnd(13)}ms ${Math.round((1 - scAvgTime/ocAvgTime) * 100)}% faster`);
  console.log(`  Tool call rate:   ${scToolRate.toFixed(0).padEnd(13)}%  ${ocToolRate.toFixed(0).padEnd(13)}%`);
  console.log(`  Context overhead:  ${(scSystemTokens+scToolsTokens).toString().padEnd(13)}tok ${(ocSystemTokens+ocToolsTokens).toString().padEnd(13)}tok ${Math.round((1 - (scSystemTokens+scToolsTokens)/(ocSystemTokens+ocToolsTokens)) * 100)}% less`);
  console.log("═══════════════════════════════════════════════════════════════════\n");
}

runBenchmark().catch(console.error);
