#!/usr/bin/env node
// SmallCode — AI coding agent for small LLMs
// Entry point: parses args, boots the TUI or runs in non-interactive mode
//
// This is the bootstrap that loads until the Marrowscript runtime is ready.
// It provides the same interface the compiled .marrow output would.

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Load .env file (checks multiple locations, first found wins)
(function loadDotenv() {
  const os = require('os');
  const envPaths = [
    path.join(process.cwd(), '.env'),                          // project root
    path.join(process.cwd(), '.smallcode', '.env'),            // .smallcode dir
    path.join(os.homedir(), '.config', 'smallcode', '.env'),   // global config
    path.join(os.homedir(), '.smallcode', '.env'),             // global alt
  ];

  for (const envPath of envPaths) {
    if (!fs.existsSync(envPath)) continue;
    try {
      const content = fs.readFileSync(envPath, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        let value = trimmed.slice(eqIdx + 1).trim();
        // Remove surrounding quotes
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        // Don't override existing env vars
        if (!process.env[key]) process.env[key] = value;
      }
      break; // Use first found .env file
    } catch {}
  }
})();
const readline = require('readline');
const os = require('os');
const tui = require('./tui');
const chalk = tui.chalk;
const { loadConfig: loadConfigModule, checkEndpoint } = require('./config');
const { TOOLS, COMPOUND_TOOLS, getAllTools: _getAllToolsModule } = require('./tools');
const { runValidation: _runValidationModule } = require('./model_client');
const { mcpCall, initCodeGraph, killMCP, getMcpProcess } = require('./mcp_bridge');
const { executeTool: _executeToolModule } = require('./executor');
let McpMemoryStore;
try {
  McpMemoryStore = require('budget-aware-mcp/dist/memory/store.js').MemoryStore;
} catch {
  McpMemoryStore = null;
}
const { ToolScorer, checkAndEnforceHardFail, classifyTask, classifyTaskAsync } = require('./governor');
const { EscalationEngine } = require('./escalation');
const { EarlyStopDetector } = require('../src/governor/early_stop');
const { TokenMonitor } = require('./token_monitor');
const { TraceRecorder } = require('./trace_recorder');
const { EvalRunner } = require('./eval_runner');
const {
  repairToolCall,
  summarizeFileCompiled,
  assertWithinBudget,
  chargeBudget,
  getBudgetState,
  setApprovalHandler,
  awaitCheckpointDecision,
  submitCheckpointDecision,
  retrieveContext,
  validateEditCompiled,
} = (() => { try { return require('./features_adapter'); } catch { return {}; } })();
const { getProfile } = require('../src/model/profiles');
const { MCPClient } = require('../src/tools/mcp_client');
const { PluginLoader } = require('../src/plugins/loader');
const { SkillManager } = require('../src/plugins/skills');
const { SessionStore } = require('../src/session/persistence');
const { resolveReferences, formatReferencesForPrompt } = require('../src/session/references');
const { TokenTracker } = require('../src/session/tokens');
const { UndoStack } = require('../src/session/undo');
const { shouldInjectGitContext, getGitDiffContext } = require('../src/session/git_context');
const { routeModel } = require('../src/model/router');

// Initialize structured memory (budget-aware-mcp's SQLite + FTS5 store, falls back to JSON)
let memoryStore;
try {
  if (McpMemoryStore) {
    memoryStore = new McpMemoryStore(process.cwd());
  } else {
    throw new Error('budget-aware-mcp not available');
  }
} catch {
  const { MemoryStore } = require('./memory');
  memoryStore = new MemoryStore(process.cwd());
}

// Initialize governor (tool scoring + verification)
const toolScorer = new ToolScorer();
const earlyStop = new EarlyStopDetector();
const tokenMonitor = new TokenMonitor();
const traceRecorder = new TraceRecorder(process.cwd());
let currentToolCategory = null; // Set per-turn by compiled tool router
let currentTaskType = 'coding';
let config = null; // Set in main(), used by executeTool and chatCompletion

// Initialize escalation engine (lazy — resolves config at boot)
let escalationEngine = null; // created after config loads

// Initialize plugin + skill systems
let pluginLoader = null;
let skillManager = null;

// Session persistence + token tracking
let sessionStore = null;
let tokenTracker = null;

// Fullscreen TUI reference for streaming (set when fullscreen mode is active)
let _fullscreenRef = null;

const VERSION = '0.6.10';
const LOGO = `
  ⚡ SmallCode v${VERSION}
  AI coding agent for small LLMs
`;

// ─── Built-in MCP: code graph (delegated to mcp_bridge.js) ──────────────────
// mcpCall, initCodeGraph, killMCP imported from ./mcp_bridge

// ─── Arg Parsing ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flags = {};
const positional = [];

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '-h' || arg === '--help') flags.help = true;
  else if (arg === '--version') flags.version = true;
  else if (arg === '-V' || arg === '--verbose') flags.verbose = true;
  else if (arg === '-v') flags.version = true;
  else if (arg === '-r' || arg === '--resume') flags.resume = true;
  else if (arg === '--mcp') flags.mcp = true;
  else if (arg === '--acp') flags.acp = true;
  else if (arg === '--init' || arg === 'init') flags.init = true;
  else if (arg === '--non-interactive') flags.nonInteractive = true;
  else if (arg === '--classic') flags.classic = true;
  else if (arg === '-m' || arg === '--model') { flags.model = args[++i]; }
  else if (arg === '-p' || arg === '--provider') { flags.provider = args[++i]; }
  else if (arg === '-P' || arg === '--prompt') { flags.prompt = args[++i]; }
  else if (arg === '--eval') { flags.eval = args[++i] || 'classify_accuracy'; }
  else if (arg === '--trace') { flags.trace = args[++i]; }
  else positional.push(arg);
}

// ─── Quick exits ─────────────────────────────────────────────────────────────

if (flags.version) {
  console.log(`smallcode v${VERSION}`);
  process.exit(0);
}

if (flags.help) {
  console.log(`${LOGO}
USAGE:
  smallcode [OPTIONS] [PROMPT]

OPTIONS:
  -h, --help              Show this help
  -v, --version           Show version
  -V, --verbose           Verbose output (show tool I/O)
  -m, --model <NAME>      Model to use (default: qwen2.5-coder:14b)
  -p, --provider <NAME>   Provider (ollama, openai, anthropic, llamacpp)
  -P, --prompt <TEXT>     Run a single prompt non-interactively
  -r, --resume            Resume last active session
  --non-interactive       Run single prompt, no TUI
  --classic             Use classic readline TUI (no alternate screen)
  --mcp                   Run as MCP server (JSON-RPC over stdio)
  --eval <SUITE>          Run prompt evaluation suite
  --trace <ID>            Replay a recorded trace

COMMANDS (in TUI):
  /quit, /q       Exit
  /clear          Reset conversation
  /stats          Session statistics
  /memory         Show working memory
  /plan           Show task plan
  /undo           Revert last edit
  /sessions       List saved sessions
  /save           Save session
  /eval           Run prompt evaluation
  /budget         Show token budget
  /help           All commands

EXAMPLES:
  smallcode                                Start interactive TUI
  smallcode "fix the bug in main.ts"       Single prompt
  smallcode -m qwen3:8b                    Use specific model
  smallcode --resume                       Continue last session
  smallcode --mcp                          Start as MCP server
  echo "refactor" | smallcode --non-interactive
`);
  process.exit(0);
}

// ─── Config ──────────────────────────────────────────────────────────────────

// ─── Config ──────────────────────────────────────────────────────────────────

function loadConfig() {
  return loadConfigModule(flags);
}

// ─── Endpoint Check (delegated to config module) ─────────────────────────────

async function checkOllama(config) {
  return checkEndpoint(config);
}

// ─── TUI ─────────────────────────────────────────────────────────────────────

// Conversation history for multi-turn
const conversationHistory = [];
const improvementAttempts = {}; // filePath → attempt count

async function runTUI(config) {
  const createCommandHandler = require('./commands');
  const handleCmd = createCommandHandler(config, conversationHistory, improvementAttempts, runAgentLoop, runValidation, MAX_IMPROVE_ITERATIONS, memoryStore, escalationEngine, tokenMonitor);

  const ok = await checkOllama(config);
  if (!ok && config.model.provider === 'ollama') {
    process.exit(1);
  }

  // Start built-in code graph MCP
  let graphOk = false;
  process.stdout.write(chalk.gray('  Code graph: '));
  graphOk = await initCodeGraph();
  if (graphOk) {
    console.log(chalk.green('✓ indexed'));
  } else {
    console.log(chalk.gray('disabled'));
  }

  // ─── FULLSCREEN TUI (default) ─────────────────────────────────────────
  if (!flags.classic) {
    const { FullScreenTUI } = require('../src/tui/fullscreen.js');

    const screen = new FullScreenTUI({
      model: config.model.name,
      theme: config.tui?.theme || 'dark',
      showToolPanel: (process.stdout.columns || 80) > 120,
      onSubmit: async (input) => {
        screen.setStreaming(true);
        await runAgentLoop(input, config);
        screen.setStreaming(false);
        // Update token counter in status bar
        if (tokenTracker) screen.setTokenInfo(tokenTracker.formatShort());
      },
      onCommand: async (cmd) => {
        if (cmd === '/quit' || cmd === '/q' || cmd === '/exit') {
          if (sessionStore) sessionStore.save(conversationHistory, { tokens: tokenTracker ? tokenTracker.stats() : undefined });
          screen.leave();
          killMCP()
          process.exit(0);
        }
        // Capture command output by temporarily redirecting stdout + console.log
        const origWrite = process.stdout.write.bind(process.stdout);
        const origConsoleLog = console.log;
        let captured = '';
        process.stdout.write = (chunk) => { captured += chunk.toString(); return true; };
        console.log = (...args) => { captured += args.join(' ') + '\n'; };
        // Create a mock rl for command handler
        const mockRl = { prompt: () => {}, close: () => { screen.leave(); process.exit(0); } };
        try {
          await handleCmd(cmd, mockRl);
        } catch (e) {
          captured += `Error: ${e.message}\n`;
        }
        process.stdout.write = origWrite;
        console.log = origConsoleLog;
        if (captured.trim()) {
          // Strip ANSI codes for clean display in chat panel
          const clean = captured.replace(/\x1b\[[0-9;]*m/g, '').trim();
          screen.addChat('system', clean);
        }
        screen.render();
      },
      onExit: () => {
        // Save session before exit
        if (sessionStore) {
          sessionStore.save(conversationHistory, { tokens: tokenTracker ? tokenTracker.stats() : undefined });
        }
        killMCP()
        process.exit(0);
      },
    });

    // Enter fullscreen FIRST (captures real stdout.write as _rawWrite)
    screen.enter();
    _fullscreenRef = screen;

    // Track current tool name for pairing stdout.write (tool start) with console.log (result)
    let _currentToolName = '';

    // Override console.log to push tool output to the screen with detail
    const origLog = console.log;
    console.log = (...args) => {
      const text = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
      const clean = text.replace(/\x1b\[[0-9;]*m/g, '').trim();
      if (!clean) return;
      // Skip turn summaries unless verbose
      if (clean.startsWith('───') && !flags.verbose) return;
      // Pair with current tool name for rich display
      if (_currentToolName) {
        const isError = clean.startsWith('✗') || clean.includes('Exit code') || clean.includes('Timed out');
        screen.addTool(_currentToolName, isError ? 'err' : 'ok', clean);
        _currentToolName = '';
      } else {
        screen.addTool('', 'ok', clean);
      }
    };

    // Override process.stdout.write — capture tool name from tui.toolStart calls
    const origStdoutWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk) => {
      const text = chunk.toString().replace(/\x1b\[[0-9;]*m/g, '').trim();
      if (!text) return true;
      // tui.toolStart outputs "  ⚙ toolName " — extract the tool name
      const toolMatch = text.match(/^⚙\s*(\S+)/);
      if (toolMatch) {
        _currentToolName = toolMatch[1];
      }
      return true;
    };

    return; // Event loop takes over via raw stdin
  }

  // ─── CLASSIC TUI (--classic flag) ─────────────────────────────────────
  console.log(tui.renderWelcome(config, graphOk));

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: chalk.cyan('› '),
  });

  rl.prompt();

  rl.on('line', async (line) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }

    if (input.startsWith('/')) {
      await handleCmd(input, rl);
      return;
    }

    console.log('');
    await runAgentLoop(input, config);
    console.log('');
    console.log(tui.renderStatus(config, conversationHistory.length));
    rl.prompt();
  });

  rl.on('close', () => {
    killMCP()
    console.log(chalk.gray('\n  Goodbye!\n'));
    process.exit(0);
  });
}

// ─── Model Communication ─────────────────────────────────────────────────────

// Tool definitions imported from bin/tools.js (TOOLS, COMPOUND_TOOLS, getAllTools)

// Show a compact inline diff for patch operations
function showMiniDiff(filePath, oldStr, newStr, lineNum) {
  const diff = tui.renderDiff(filePath, oldStr, newStr, lineNum);
  if (diff) console.log(diff);
}

// Execute a tool call — delegates to executor.js module
async function executeTool(name, args) {
  return _executeToolModule(name, args, {
    _fullscreenRef,
    mcpCall,
    memoryStore,
    pluginLoader,
    mcpClient: (typeof mcpClient !== 'undefined' ? mcpClient : null),
    flags,
    config,
    tui,
  });
}

// ─── COMPOUND TOOLS ──────────────────────────────────────────────────────────
// Tool definitions + routing loaded from bin/tools.js
// getAllTools delegates to the module with plugin/mcp context
function getAllTools(config, stage2Category) {
  return _getAllToolsModule(config, stage2Category, { pluginLoader, mcpClient: (typeof mcpClient !== 'undefined' ? mcpClient : null) });
}
let ALL_TOOLS = [...TOOLS, ...COMPOUND_TOOLS];

const MAX_TOOL_CALLS = 500;
const MAX_IMPROVE_ITERATIONS = 2;

async function runAgentLoop(userMessage, config) {
  // Reset early-stop state for new turn
  earlyStop.newTurn();

  // Start trace recording for this turn
  traceRecorder.start(userMessage, config.model.name);

  // Mark new turn in token monitor (next recordCall will start a new turn entry)
  tokenMonitor._nextCallIsNewTurn = true;

  // Feature 3: rate limiting — assert within budget before starting turn
  try {
    if (assertWithinBudget) assertWithinBudget('run_turn', {});
  } catch (e) {
    const msg = e.message || String(e);
    if (_fullscreenRef) _fullscreenRef.addTool('policy', 'err', msg);
    else console.log(`  \x1b[33m⚠ ${msg}\x1b[0m`);
    // Still proceed — rate limiting is advisory for local use
  }

  // Clarification loop — detect vague prompts before wasting tool calls
  const { needsClarification, getClarificationInstruction } = require('../src/session/clarify');
  if (needsClarification(userMessage)) {
    // Inject clarification instruction into this turn only
    conversationHistory.push({ role: 'user', content: userMessage });
    conversationHistory.push({ role: 'system', content: getClarificationInstruction() });
    // Let the model ask for clarification (no tools, just respond)
    const response = await chatCompletion(config, conversationHistory);
    const message = response?.choices?.[0]?.message;
    if (message?.content) {
      conversationHistory.push({ role: 'assistant', content: message.content });
      if (_fullscreenRef) {
        _fullscreenRef.addChat('assistant', message.content);
      } else {
        process.stdout.write(tui.renderMarkdown(message.content));
      }
    }
    return; // Wait for user to clarify
  }

  // Detect drag-and-dropped image files (bare path pasted into terminal)
  const { detectDroppedFile } = require('../src/session/images');
  const droppedPath = detectDroppedFile(userMessage);
  if (droppedPath) {
    // Convert bare path into an @reference prompt
    userMessage = `@${droppedPath} — I dropped this image. What would you like me to do with it?`;
    if (_fullscreenRef) _fullscreenRef.addTool('image', 'ok', `attached: ${path.basename(droppedPath)}`);
  }

  // Resolve @file references in user input
  const { text, files } = resolveReferences(userMessage, process.cwd());
  let augmented = files.length > 0
    ? text + formatReferencesForPrompt(files)
    : text;

  // Auto-inject git diff when message implies recent changes
  if (shouldInjectGitContext(userMessage)) {
    const gitCtx = getGitDiffContext(process.cwd(), 80);
    if (gitCtx) augmented += gitCtx;
  }

  conversationHistory.push({ role: 'user', content: augmented });

  // Governor: classify task type (determines verification strategy)
  // Uses MarrowScript-compiled classifier with regex fallback
  try {
    currentTaskType = await classifyTaskAsync(userMessage);
  } catch {
    currentTaskType = classifyTask(userMessage);
  }

  // Deterministic tool routing: classify intent → filter tool schemas
  // Zero tokens, zero latency — compiled from marrow/tool_router.marrow
  try {
    const { classifyToolCategory, categoryNeedsTools } = require('../src/compiled/tool_router');
    const routeResult = classifyToolCategory(userMessage);
    currentToolCategory = routeResult.category;
    if (_fullscreenRef && routeResult.confidence > 0.3) {
      _fullscreenRef.addTool('router', 'ok', `${routeResult.category} (${Math.round(routeResult.confidence * 100)}%)`);
    }
  } catch {
    currentToolCategory = null; // Fall back to all tools
  }

  // Feature 5: retrieve_context — auto-inject relevant files via code graph
  // Zero LLM calls; walks symbol graph from user message keywords
  try {
    if (retrieveContext && mcpCall) {
      const ctx = await retrieveContext(userMessage, mcpCall, 6);
      if (ctx && ctx.files && ctx.files.length > 0) {
        const contextHint = `[Auto-context: relevant files detected — ${ctx.files.slice(0, 4).join(', ')}]`;
        // Inject as a system hint into the last user message (non-intrusive)
        const lastUser = conversationHistory[conversationHistory.length - 1];
        if (lastUser && lastUser.role === 'user' && typeof lastUser.content === 'string') {
          lastUser.content = lastUser.content + '\n\n' + contextHint;
        }
        if (_fullscreenRef) _fullscreenRef.addTool('context', 'ok', `${ctx.files.length} files, ${ctx.symbols.length} symbols`);
      }
    }
  } catch {} // Never block on context retrieval

  // Multi-model routing: pick model based on task complexity (if configured)
  // Phase C: Marrowscript-compiled coding_router for tier-based dispatch.
  // Falls back to hand-rolled routeModel() if compiled router unavailable.
  if (config.models || process.env.SMALLCODE_USE_TIER_ROUTING === 'true') {
    let selectedModel = null;
    let selectedTier = null;
    try {
      const { routeToTier, estimateComplexity, isCompiledCognitionAvailable } = require('./cognition_adapter');
      if (isCompiledCognitionAvailable()) {
        const complexity = estimateComplexity(userMessage);
        const route = routeToTier(complexity);
        if (route) {
          // Map model_id back to actual model name from config.models if set,
          // otherwise use the SMALLCODE_MODEL env var (already configured per tier).
          if (config.models) {
            if (route.tier === 'trivial') selectedModel = config.models.fast;
            else if (route.tier === 'simple') selectedModel = config.models.default;
            else selectedModel = config.models.strong;
          }
          selectedTier = route.tier;
        }
      }
    } catch {}

    // Fallback: hand-rolled routeModel
    if (!selectedModel && config.models) {
      selectedModel = routeModel(userMessage, config);
    }

    if (selectedModel && selectedModel !== config.model.name) {
      config.model.name = selectedModel;
      if (_fullscreenRef) _fullscreenRef.addTool('router', 'ok', `→ ${selectedModel}${selectedTier ? ' (' + selectedTier + ')' : ''}`);
    }
  }

  // Auto-compact: estimate tokens and aggressively trim to stay within context window
  const estimatedTokens = conversationHistory.reduce((sum, m) => {
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
    return sum + Math.ceil(content.length / 4);
  }, 0);
  const maxContextTokens = (config.context?.detected_window || 128000) * ((config.context?.max_budget_pct || 70) / 100);

  if (estimatedTokens > maxContextTokens || conversationHistory.length > 30) {
    // Phase B: Try MarrowScript-compiled compress_history first.
    // It produces a semantic summary instead of just dropping messages.
    let compressedSuccessfully = false;
    if (conversationHistory.length > 10) {
      try {
        const { compressHistoryCompiled, isCompiledCognitionAvailable } = require('./cognition_adapter');
        if (isCompiledCognitionAvailable()) {
          // Take oldest non-system messages, leave most recent 6 intact
          const recentCount = 6;
          const oldStart = conversationHistory.findIndex(m => m.role !== 'system');
          const oldEnd = conversationHistory.length - recentCount;
          if (oldStart >= 0 && oldEnd > oldStart) {
            const oldMessages = conversationHistory.slice(oldStart, oldEnd);
            const oldSerialized = oldMessages
              .map(m => {
                const role = m.role || 'unknown';
                const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
                return `[${role}] ${content.slice(0, 1500)}`;
              })
              .join('\n\n');
            const targetTokens = Math.max(200, Math.floor(maxContextTokens * 0.1));
            const summary = await compressHistoryCompiled(oldSerialized, targetTokens);
            if (summary && summary.length > 0) {
              // Replace old messages with a single summary system message
              conversationHistory.splice(oldStart, oldEnd - oldStart, {
                role: 'system',
                content: `[Compressed summary of ${oldMessages.length} earlier messages]\n${summary}`,
              });
              compressedSuccessfully = true;
              console.log(tui.compacted(conversationHistory.length));
            }
          }
        }
      } catch {}
    }

    // Fallback: drop oldest non-system messages until under budget
    if (!compressedSuccessfully) {
      while (conversationHistory.length > 6) {
        const currentEst = conversationHistory.reduce((sum, m) => {
          const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
          return sum + Math.ceil(c.length / 4);
        }, 0);
        if (currentEst < maxContextTokens * 0.7 && conversationHistory.length <= 20) break;
        const removeIdx = conversationHistory.findIndex(m => m.role !== 'system');
        if (removeIdx === -1) break;
        conversationHistory.splice(removeIdx, 1);
      }
      const summary = `[Context compacted to fit ${Math.round(maxContextTokens)} token budget]`;
      conversationHistory.unshift({ role: 'system', content: summary });
      console.log(tui.compacted(conversationHistory.length));
    }
  }

  let toolCallsThisTurn = 0;

  while (toolCallsThisTurn < MAX_TOOL_CALLS) {
    // Mid-turn context check: if history is getting too large, evict old tool results
    // This prevents context overflow during long tool-call chains
    if (toolCallsThisTurn > 0 && toolCallsThisTurn % 3 === 0) {
      const midEst = conversationHistory.reduce((sum, m) => {
        const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
        return sum + Math.ceil(c.length / 4);
      }, 0);
      const maxBudget = (config.context?.detected_window || 128000) * 0.6;
      if (midEst > maxBudget) {
        // Evict oldest tool results (keep user/assistant messages intact)
        let evicted = 0;
        for (let i = 0; i < conversationHistory.length && midEst > maxBudget * 0.7; i++) {
          if (conversationHistory[i].role === 'tool') {
            const len = Math.ceil((conversationHistory[i].content || '').length / 4);
            conversationHistory.splice(i, 1);
            evicted++;
            i--;
          }
        }
      }
    }

    const response = await chatCompletion(config, conversationHistory);

    if (!response) {
      console.log('  \x1b[31m✗ No response from model\x1b[0m');
      break;
    }

    const message = response.choices?.[0]?.message;
    if (!message) break;

    // If model wants to call tools
    if (message.tool_calls && message.tool_calls.length > 0) {
      // After first tool call, widen to all tools for subsequent iterations
      // (model may need different categories mid-turn)
      currentToolCategory = null;

      // Add assistant message with tool calls to history
      conversationHistory.push(message);

      for (const tc of message.tool_calls) {
        toolCallsThisTurn++;
        const toolName = tc.function.name;
        let toolArgs;
        try {
          toolArgs = JSON.parse(tc.function.arguments);
        } catch {
          // Feature 1: repair malformed tool args via compiled repair_tool_call prompt
          let repaired = false;
          if (repairToolCall) {
            try {
              const toolDef = ALL_TOOLS.find(t => t.function.name === toolName);
              const schema = toolDef ? JSON.stringify(toolDef.function.parameters).slice(0, 500) : '';
              const repair = await repairToolCall(tc.function.arguments, 'Invalid JSON', schema);
              if (repair.ok && repair.repairedCall) {
                try {
                  toolArgs = JSON.parse(repair.repairedCall);
                  repaired = true;
                  if (_fullscreenRef) _fullscreenRef.addTool('repair', 'ok', `repaired ${toolName} args`);
                } catch {}
              }
            } catch {}
          }
          if (!repaired) {
            toolArgs = {};
            console.log(`  \x1b[31m✗ Failed to parse args for ${toolName}\x1b[0m`);
          }
        }

        // Show what's happening
        process.stdout.write(tui.toolStart(toolName));
        const toolStart2 = Date.now();

        const result = await executeTool(toolName, toolArgs);
        const toolMs = Date.now() - toolStart2;

        // Record trace step
        traceRecorder.recordToolCall(toolName, toolArgs, result.result || result.error || '', toolMs);

        // Show result indicators
        if (result.error) {
          console.log(tui.toolError(result.error));
        } else if (result.action === 'Created') {
          console.log(tui.toolCreated(result.path, result.lines, toolMs));
        } else if (result.action === 'Updated') {
          console.log(tui.toolUpdated(result.path, result.lines, toolMs));
        } else if (result.action === 'Edited') {
          console.log(tui.toolEdited(result.path, result.line, toolMs));
        } else if (result.command) {
          console.log(tui.toolBash(result.command, toolMs));
        } else {
          console.log(tui.toolSuccess('', toolMs));
        }

        // Add tool result to history (cap to prevent context explosion)
        // Default 4k chars per result — keeps 10 tool calls at ~10k tokens total
        const toolContent = result.result || result.error || '';
        const maxToolResultChars = 4000;
        const cappedContent = toolContent.length > maxToolResultChars
          ? toolContent.slice(0, maxToolResultChars - 200) + '\n\n...(truncated, ' + toolContent.length + ' chars total)...\n' + toolContent.slice(-200)
          : toolContent;
        conversationHistory.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: cappedContent,
        });

        // ── IMPROVEMENT LOOP: auto-validate writes and feed errors back ──
        // Uses MarrowScript-compiled bounded loop for iteration control + tracing
        if ((toolName === 'write_file' || toolName === 'patch') && !result.error) {
          const filePath = toolArgs.path;

          // Feature 6: self-critique the edit before running lint
          try {
            if (validateEditCompiled && filePath) {
              const fs = require('fs');
              const path = require('path');
              const written = fs.existsSync(path.resolve(process.cwd(), filePath))
                ? fs.readFileSync(path.resolve(process.cwd(), filePath), 'utf-8')
                : (toolArgs.content || '');
              const critique = await validateEditCompiled(filePath, written, userMessage);
              if (!critique.ok && critique.issues.length > 0) {
                if (_fullscreenRef) _fullscreenRef.addTool('critique', 'err', critique.issues[0].slice(0, 80));
                // Inject semantic issue as additional context for the improvement loop
                conversationHistory.push({ role: 'user', content: `[SEMANTIC-REVIEW] Potential issue in ${filePath}: ${critique.issues[0]}` });
              }
            }
          } catch {} // Never block on self-critique

          const validation = runValidation(filePath);
          if (validation && !validation.passed) {
            // Track how many times we've tried fixing this file
            if (!improvementAttempts[filePath]) improvementAttempts[filePath] = 0;
            improvementAttempts[filePath]++;

            // Token monitor: record validation failure (counts as improvement overhead)
            tokenMonitor.recordCompaction(); // Reuse compaction counter for improvement overhead tracking

            if (improvementAttempts[filePath] <= MAX_IMPROVE_ITERATIONS) {
              const attempt = improvementAttempts[filePath];
              console.log(tui.improvementLoop(validation.errors, attempt, MAX_IMPROVE_ITERATIONS));

              // Track attempt history for this file
              if (!improvementAttempts[`__history:${filePath}`]) improvementAttempts[`__history:${filePath}`] = [];
              improvementAttempts[`__history:${filePath}`].push({
                attempt,
                errors: validation.errors.slice(0, 3),
              });

              // Build fix prompt with full retry history
              let fixPrompt;
              const history = improvementAttempts[`__history:${filePath}`];
              const historyStr = history.length > 1
                ? `\n\nPrevious attempts (${history.length - 1} failed):\n` + history.slice(0, -1).map((h, i) => `  Attempt ${i + 1}: ${h.errors[0] || 'unknown error'}`).join('\n')
                : '';

              if (attempt <= 2) {
                fixPrompt = `[AUTO-VALIDATE] Errors in ${filePath} (attempt ${attempt}/${MAX_IMPROVE_ITERATIONS}):
${validation.errors.join('\n')}${historyStr}

Fix these errors. Do NOT repeat the same approach that failed before.`;
              } else {
                // Escalated: show the full file + errors + history
                let fileContent = '';
                try { fileContent = fs.readFileSync(path.resolve(process.cwd(), filePath), 'utf-8'); } catch {}
                fixPrompt = `[AUTO-VALIDATE] After ${attempt} attempts, ${filePath} still has errors.${historyStr}

FULL FILE CONTENT:
\`\`\`
${fileContent}
\`\`\`

ERRORS:
${validation.errors.join('\n')}

Read the FULL file above carefully. Fix ALL errors. Use the patch tool with the exact text from the file. Do NOT repeat previous failed approaches.`;
              }

              conversationHistory.push({ role: 'user', content: fixPrompt });
            } else {
              // DECOMPOSE instead of giving up — break the problem into chunks
              improvementAttempts[filePath] = 0;
              const { pickDecomposeStrategy } = require('./governor');
              let fileContent = '';
              try { fileContent = fs.readFileSync(path.resolve(process.cwd(), filePath), 'utf-8'); } catch {}
              const strategy = pickDecomposeStrategy(fileContent, validation.errors, filePath);
              
              // Track decompose attempts — if this is the 2nd decompose, escalate instead
              if (!improvementAttempts[`__decompose:${filePath}`]) improvementAttempts[`__decompose:${filePath}`] = 0;
              improvementAttempts[`__decompose:${filePath}`]++;

              if (improvementAttempts[`__decompose:${filePath}`] >= 2 && escalationEngine && escalationEngine.canEscalate()) {
                // Decompose has been tried and failed — ESCALATE to stronger model
                console.log(`  \x1b[35m⬆ ESCALATING to ${escalationEngine.provider} (${escalationEngine.model}) — local model exhausted\x1b[0m`);
                
                const escalationPrompt = `Fix these errors in ${filePath}. The code:\n\`\`\`\n${fileContent}\n\`\`\`\n\nErrors:\n${validation.errors.join('\n')}\n\nPrevious attempts failed. Fix it correctly.`;
                const escalationMessages = [
                  ...conversationHistory.slice(-6), // Recent context
                  { role: 'user', content: escalationPrompt },
                ];
                
                const escalatedResponse = await escalationEngine.escalate(escalationMessages, ALL_TOOLS);
                
                if (escalatedResponse && !escalatedResponse.error) {
                  // Inject the escalated response back into the conversation
                  if (escalatedResponse.tool_calls) {
                    conversationHistory.push(escalatedResponse);
                    // Execute the escalated model's tool calls
                    for (const tc of escalatedResponse.tool_calls) {
                      const eName = tc.function.name;
                      let eArgs;
                      try { eArgs = JSON.parse(tc.function.arguments); } catch { eArgs = {}; }
                      process.stdout.write(`  \x1b[35m⬆\x1b[0m `);
                      process.stdout.write(tui.toolStart(eName));
                      const eResult = await executeTool(eName, eArgs);
                      if (eResult.error) {
                        console.log(tui.toolError(eResult.error));
                      } else if (eResult.action) {
                        console.log(tui.toolSuccess(`${eResult.action} ${eResult.path || ''}`, 0));
                      } else {
                        console.log(tui.toolSuccess('', 0));
                      }
                      conversationHistory.push({ role: 'tool', tool_call_id: tc.id, content: eResult.result || eResult.error || '' });
                    }
                  } else if (escalatedResponse.content) {
                    conversationHistory.push({ role: 'assistant', content: escalatedResponse.content });
                    process.stdout.write(tui.renderMarkdown(escalatedResponse.content));
                  }
                  improvementAttempts[`__decompose:${filePath}`] = 0;
                } else {
                  // Escalation also failed — give up gracefully
                  const errMsg = escalatedResponse?.error || 'No response';
                  console.log(`  \x1b[31m✗ Escalation failed: ${errMsg}\x1b[0m`);
                  conversationHistory.push({
                    role: 'user',
                    content: `[ESCALATION FAILED] Even the stronger model couldn't fix this. Deliver the best version you have and explain what's still broken.`,
                  });
                }
              } else {
                // First decompose attempt — try the local model with a new strategy
                console.log(`  \x1b[33m◇ DECOMPOSE: ${strategy.reason}\x1b[0m`);
                console.log(`  \x1b[90m  Strategy: ${strategy.type}\x1b[0m`);
                
                conversationHistory.push({
                  role: 'user',
                  content: `[DECOMPOSE] After ${MAX_IMPROVE_ITERATIONS} failed fix attempts, changing strategy.\n\n${strategy.instruction}`,
                });
              }
            }
          } else if (validation && validation.passed) {
            if (improvementAttempts[filePath] > 0) {
              console.log(tui.improvementFixed(filePath, improvementAttempts[filePath]));
              improvementAttempts[filePath] = 0;
            }
          }
        }

        // ── IMPROVEMENT LOOP: auto-validate bash/run commands that fail ──
        if ((toolName === 'bash' || toolName === 'run' || toolName === 'create_and_run') && result.error) {
          if (!improvementAttempts['__bash']) improvementAttempts['__bash'] = 0;
          improvementAttempts['__bash']++;

          if (improvementAttempts['__bash'] <= 2) {
            conversationHistory.push({
              role: 'user',
              content: `[AUTO-FIX] The command FAILED (attempt ${improvementAttempts['__bash']}/2). Do NOT claim success. The error was:\n${(result.result || '').slice(0, 1500)}\n\nRead the error, identify the bug, and fix it.`,
            });
          } else {
            // DECOMPOSE: bash keeps failing, break the problem apart
            if (!improvementAttempts['__decompose:bash']) improvementAttempts['__decompose:bash'] = 0;
            improvementAttempts['__decompose:bash']++;

            if (improvementAttempts['__decompose:bash'] >= 2 && escalationEngine && escalationEngine.canEscalate()) {
              // Bash decompose failed twice — escalate
              console.log(`  \x1b[35m⬆ ESCALATING to ${escalationEngine.provider} (${escalationEngine.model}) — command keeps failing\x1b[0m`);
              improvementAttempts['__bash'] = 0;
              improvementAttempts['__decompose:bash'] = 0;

              const escalationMessages = [
                ...conversationHistory.slice(-8),
                { role: 'user', content: `The command keeps failing. Fix the underlying issue. Error: ${(result.result || '').slice(0, 1500)}` },
              ];
              
              const escalatedResponse = await escalationEngine.escalate(escalationMessages, ALL_TOOLS);
              if (escalatedResponse && !escalatedResponse.error) {
                if (escalatedResponse.tool_calls) {
                  conversationHistory.push(escalatedResponse);
                  for (const tc of escalatedResponse.tool_calls) {
                    const eName = tc.function.name;
                    let eArgs;
                    try { eArgs = JSON.parse(tc.function.arguments); } catch { eArgs = {}; }
                    process.stdout.write(`  \x1b[35m⬆\x1b[0m `);
                    process.stdout.write(tui.toolStart(eName));
                    const eResult = await executeTool(eName, eArgs);
                    if (eResult.error) {
                      console.log(tui.toolError(eResult.error));
                    } else {
                      console.log(tui.toolSuccess('', 0));
                    }
                    conversationHistory.push({ role: 'tool', tool_call_id: tc.id, content: eResult.result || eResult.error || '' });
                  }
                } else if (escalatedResponse.content) {
                  conversationHistory.push({ role: 'assistant', content: escalatedResponse.content });
                  process.stdout.write(tui.renderMarkdown(escalatedResponse.content));
                }
              } else {
                console.log(`  \x1b[31m✗ Escalation failed\x1b[0m`);
                conversationHistory.push({
                  role: 'user',
                  content: `[ESCALATION FAILED] Move on. Explain what you tried and what's still broken.`,
                });
              }
            } else {
              // First bash decompose — try local model with new strategy
              improvementAttempts['__bash'] = 0;
              const { pickDecomposeStrategy } = require('./governor');
              const errors = [(result.result || '').slice(0, 300)];
              const strategy = pickDecomposeStrategy('', errors, toolArgs.command || '');
              console.log(`  \x1b[33m◇ DECOMPOSE: Command keeps failing. Changing approach.\x1b[0m`);
              conversationHistory.push({
                role: 'user',
                content: `[DECOMPOSE] The command has failed 3 times. STOP retrying the same approach.\n\n${strategy.instruction}`,
              });
            }
          }
        } else if ((toolName === 'bash' || toolName === 'run') && !result.error) {
          improvementAttempts['__bash'] = 0;
        }

        // ── GOVERNOR: Record tool success/failure for Bayesian learning ──
        if (!result.error) {
          toolScorer.recordSuccess(toolName, currentTaskType, toolMs);
        } else {
          toolScorer.recordFailure(toolName, currentTaskType, result.error || 'unknown');
        }

        // ── EARLY-STOP: Detect patch spiral (model stuck on corrupted file) ──
        if (toolName === 'patch' || toolName === 'read_and_patch') {
          const patchSuccess = !result.error;
          const patchFile = toolArgs.path;
          const stopSignal = earlyStop.recordPatchResult(patchFile, patchSuccess, toolArgs.old_str, toolArgs.new_str);
          if (stopSignal) {
            console.log(`  \x1b[33m⚡ ${stopSignal.message}\x1b[0m`);
            conversationHistory.push({ role: 'user', content: stopSignal.injection });
            // Don't continue with normal flow — force model to rewrite
            break;
          }
        }

        // ── PLUGINS: Fire post_tool hooks ──
        if (pluginLoader && pluginLoader.hooks.length > 0) {
          for (const hook of pluginLoader.hooks) {
            if (hook.event === 'post_tool' && hook.handler) {
              if (hook.filter.length === 0 || hook.filter.includes(toolName)) {
                try { await hook.handler({ tool: toolName, args: toolArgs, result, ms: toolMs }); } catch {}
              }
            }
          }
        }
      }

      // Continue the loop — model may want to call more tools or fix errors
      continue;
    }

    // No tool calls — model is responding with text
    // Counter guard: if this is a coding/editing task and no tools were called,
    // the model may be prematurely answering instead of acting
    if (toolCallsThisTurn === 0 && (currentTaskType === 'coding' || currentTaskType === 'editing' || currentTaskType === 'backend')) {
      if (message.content && !message.content.includes('?') && message.content.length < 200) {
        // Model gave a short non-question response without using tools — push it to act
        conversationHistory.push({ role: 'assistant', content: message.content });
        conversationHistory.push({ role: 'user', content: '[SYSTEM] You responded without using any tools. This task requires file operations. Please use the appropriate tools (read_file, write_file, patch, etc.) to complete the task. Do not just describe what you would do — actually do it.' });
        continue;
      }
    }

    // Greeting guard: detect when model outputs a greeting after tool failures (lost context)
    if (toolCallsThisTurn > 0 && message.content) {
      const greetingSignal = earlyStop.checkGreeting(message.content, toolCallsThisTurn > 0);
      if (greetingSignal && conversationHistory.some(m => m.role === 'user' && !m.content.startsWith('['))) {
        conversationHistory.push({ role: 'assistant', content: message.content });
        conversationHistory.push({ role: 'user', content: greetingSignal.injection });
        continue;
      }
    }

    // Post-decompose give-up detection: if model responds with vague text after failures, notify user
    if (toolCallsThisTurn > 0 && message.content) {
      const lc = message.content.toLowerCase();
      const gaveUp = lc.includes('output is truncated') || lc.includes('let me try') || lc.includes('let me run') || (lc.length < 100 && !lc.includes('?') && toolCallsThisTurn > 3);
      const hadDecompose = conversationHistory.some(m => m.content && m.content.includes('[DECOMPOSE]'));
      if (gaveUp && hadDecompose && escalationEngine && escalationEngine.canEscalate()) {
        // Model is stuck after decompose — offer escalation
        if (_fullscreenRef) {
          _fullscreenRef.addTool('escalation', 'err', 'Model stuck after decompose. Attempting escalation...');
        }
        conversationHistory.push({ role: 'assistant', content: message.content });
        conversationHistory.push({ role: 'user', content: '[SYSTEM] You appear stuck. The decompose strategy did not work. Take a completely different approach or clearly explain what is blocking you and what you need from the user to proceed.' });
        continue;
      }
    }

    // Stream the final response for better UX
    if (message.content) {
      conversationHistory.push({ role: 'assistant', content: message.content });
      // Render with markdown highlighting
      if (_fullscreenRef) {
        _fullscreenRef.addChat('assistant', message.content);
      } else {
        process.stdout.write(tui.renderMarkdown(message.content));
      }
    } else if (toolCallsThisTurn === 0 && (!message.tool_calls || message.tool_calls.length === 0)) {
      // No content AND no tool calls AND no tools were called this turn — try streaming
      const streamedContent = await streamFinalResponse(config, conversationHistory);
      if (streamedContent) {
        conversationHistory.push({ role: 'assistant', content: streamedContent });
      }
    }
    // If tools were called but model returned empty content, that's fine — task is done.
    break;
  }

  if (toolCallsThisTurn >= MAX_TOOL_CALLS) {
    console.log(chalk.yellow('\n  ⚠ Reached tool call limit'));
  }

  if (toolCallsThisTurn > 0) {
    console.log(tui.turnSummary(toolCallsThisTurn));

    // Auto git commit if files were changed and we're in a git repo
    if (config.git?.auto_commit === true || process.env.SMALLCODE_AUTO_COMMIT === 'true') {
      try {
        const { execSync } = require('child_process');
        const status = execSync('git status --porcelain', { encoding: 'utf-8', cwd: process.cwd(), timeout: 5000 });
        if (status.trim()) {
          // Get a short summary from the first user message this turn
          const lastUser = [...conversationHistory].reverse().find(m => m.role === 'user' && !m.content.startsWith('['));
          const commitMsg = lastUser
            ? `smallcode: ${lastUser.content.slice(0, 50).replace(/\n/g, ' ')}`
            : 'smallcode: auto-commit';
          execSync('git add -A', { cwd: process.cwd(), timeout: 5000 });
          execSync(`git commit -m "${commitMsg.replace(/"/g, '\\"')}"`, { encoding: 'utf-8', cwd: process.cwd(), timeout: 10000 });
          if (_fullscreenRef) {
            _fullscreenRef.addTool('git', 'ok', `committed: ${commitMsg.slice(0, 60)}`);
          } else {
            console.log(chalk.green(`  ✓ git commit: ${commitMsg.slice(0, 60)}`));
          }
        }
      } catch {
        // Not a git repo or commit failed — silently skip
      }
    }
  }

  // Stop trace recording for this turn
  traceRecorder.stop();
}

// ─── Validation for Improvement Loop ────────────────────────────────────────

// LSP client instance (lazy-initialized on first validation)
let _lspClient = null;
let _lspAttempted = false;

async function initLSP() {
  if (_lspAttempted) return _lspClient;
  _lspAttempted = true;
  try {
    const { LSPClient } = require('../src/lsp/client');
    const client = new LSPClient(process.cwd());
    const ok = await client.start();
    if (ok) {
      _lspClient = client;
      if (_fullscreenRef) _fullscreenRef.addTool('lsp', 'ok', `${client.serverInfo.language} language server connected`);
    }
  } catch {}
  return _lspClient;
}

function runValidation(filePath) {
  const { execSync } = require('child_process');
  const ext = path.extname(filePath);
  const cwd = process.cwd();

  let cmd = null;
  let parseErrors = null;

  // TypeScript
  if ((ext === '.ts' || ext === '.tsx') && fs.existsSync(path.join(cwd, 'tsconfig.json'))) {
    cmd = 'npx tsc --noEmit --pretty false 2>&1';
    parseErrors = (output) => {
      return output.split('\n')
        .filter(l => l.includes(filePath) && l.includes('error'))
        .slice(0, 5);
    };
  }
  // Python
  else if (ext === '.py') {
    cmd = `python -m py_compile "${filePath}" 2>&1`;
    parseErrors = (output) => output.trim() ? [output.trim()] : [];
  }
  // Rust
  else if (ext === '.rs' && fs.existsSync(path.join(cwd, 'Cargo.toml'))) {
    cmd = 'cargo check --message-format short 2>&1';
    parseErrors = (output) => {
      return output.split('\n')
        .filter(l => l.startsWith('error'))
        .slice(0, 5);
    };
  }
  // Go
  else if (ext === '.go' && fs.existsSync(path.join(cwd, 'go.mod'))) {
    cmd = 'go build ./... 2>&1';
    parseErrors = (output) => {
      return output.split('\n')
        .filter(l => l.includes(filePath))
        .slice(0, 5);
    };
  }
  // JavaScript/Node (eslint or basic syntax check)
  else if (ext === '.js' || ext === '.mjs') {
    cmd = `node --check "${filePath}" 2>&1`;
    parseErrors = (output) => output.trim() ? [output.trim()] : [];
  }
  // JSON validation
  else if (ext === '.json') {
    try {
      JSON.parse(fs.readFileSync(path.resolve(process.cwd(), filePath), 'utf-8'));
      return { passed: true, errors: [] };
    } catch (e) {
      return { passed: false, errors: [e.message] };
    }
  }
  // BoneScript validation
  else if (ext === '.bone') {
    const compilerPaths = [
      path.resolve(__dirname, '..', 'node_modules', 'bonescript-compiler', 'dist', 'cli.js'),
      path.resolve(__dirname, '..', '..', 'BoneScript', 'compiler', 'dist', 'cli.js'),
    ];
    let compiler = null;
    for (const cp of compilerPaths) {
      if (fs.existsSync(cp)) { compiler = cp; break; }
    }
    if (!compiler) return null; // No validator available
    // Try bone_check — if it crashes (not installed properly), skip validation
    try {
      const { execSync } = require('child_process');
      execSync(`node "${compiler}" --version`, { encoding: 'utf-8', timeout: 5000, cwd: process.cwd() });
    } catch {
      return null; // Compiler not working, skip .bone validation
    }
    cmd = `node "${compiler}" check "${filePath}" 2>&1`;
    parseErrors = (output) => output.split('\n').filter(l => l.includes('error')).slice(0, 5);
  }

  if (!cmd) return null;  // No validator for this file type

  try {
    execSync(cmd, { encoding: 'utf-8', timeout: 20000, cwd });
    return { passed: true, errors: [] };
  } catch (e) {
    const output = (e.stdout || '') + (e.stderr || '');
    const errors = parseErrors(output).filter(Boolean);
    if (errors.length === 0) return { passed: true, errors: [] };
    return { passed: false, errors };
  }
}

// Build a compact system prompt — only includes sections relevant to the task type
function buildCompactSystemPrompt(taskType, messages) {
  const os = process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux';
  const osHint = process.platform === 'win32' ? '\nUse "dir" not "ls", "type" not "cat". No bash-only commands.' : '';

  let prompt = `You are SmallCode, a coding agent. Working directory: ${process.cwd()}
OS: ${os}${osHint}

Rules: Use patch for edits (not full rewrites). Prefer compound tools. Be concise. ACT immediately — do not ask for confirmation unless the task is genuinely ambiguous. If asked to read a file, read it. If asked to create something, create it.`;

  // Only add tool-use instructions for tasks that need tools
  if (taskType !== 'explanation') {
    prompt += `\nUse graph_search/explain_symbol for "how does X work" questions. Use list_projects for workspace overview.`;
  }

  // Only add BoneScript for backend tasks
  if (taskType === 'backend') {
    prompt += `\n\nFor Node.js backends: write a .bone file → bone_check → bone_compile. Don't hand-write routes.`;
  }

  // Add memory/skills/plugins (already compact)
  prompt += getMemoryContext(messages) + getSkillContext(messages) + getPluginPrompts();

  return prompt;
}

// Auto-load relevant memory for the current task (injected into system prompt)
function getMemoryContext(messages) {
  try {
    // Get the last user message to find relevant memory
    const lastUser = [...messages].reverse().find(m => m.role === 'user');
    if (!lastUser || !memoryStore.loadForTask) return '';

    const { objects, tokens_used } = memoryStore.loadForTask(lastUser.content, 800);
    if (objects.length === 0) return '';

    return '\n\nRelevant project memory:\n' + objects.map(o => `[${o.type}] ${o.title}: ${o.content}`).join('\n');
  } catch {
    return '';
  }
}

// Auto-load relevant skills based on the user's message
function getSkillContext(messages) {
  if (!skillManager) return '';
  try {
    const lastUser = [...messages].reverse().find(m => m.role === 'user');
    if (!lastUser) return '';
    const skills = skillManager.getAutoSkills(lastUser.content);
    return skillManager.formatForPrompt(skills);
  } catch {
    return '';
  }
}

// Get plugin prompt injections for the current task type
function getPluginPrompts() {
  if (!pluginLoader) return '';
  try {
    const injection = pluginLoader.getPromptInjections(currentTaskType);
    return injection ? '\n\n' + injection : '';
  } catch {
    return '';
  }
}

// Make a chat completion request (non-streaming for tool use, streaming for final response)
async function chatCompletion(config, messages) {
  const baseUrl = config.model.baseUrl;
  const systemMsg = {
    role: 'system',
    content: buildCompactSystemPrompt(currentTaskType, messages),
  };

  try {
    // Transform messages with images into multimodal format
    const { extractImages, formatImagesForAPI, modelSupportsVision } = require('../src/session/images');
    const processedMessages = messages.map(msg => {
      if (msg.role !== 'user' || typeof msg.content !== 'string') return msg;
      const images = extractImages(msg.content, process.cwd());
      if (images.length === 0 || !modelSupportsVision(config.model.name)) return msg;
      // Convert to multimodal content array
      return {
        ...msg,
        content: [
          { type: 'text', text: msg.content },
          ...formatImagesForAPI(images),
        ],
      };
    });

    const body = {
      model: config.model.name,
      messages: [systemMsg, ...processedMessages],
      tools: getAllTools(config, currentToolCategory),
      temperature: 0.1,
      max_tokens: 4096,
    };

    // Build headers — include Authorization if an API key is available
    const headers = { 'Content-Type': 'application/json' };
    const apiKey = process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.DEEPSEEK_API_KEY || config.model.apiKey;
    if (apiKey) {
      headers['Authorization'] = `Bearer ${apiKey}`;
    }
    // OpenRouter requires HTTP-Referer and X-Title headers
    if (baseUrl.includes('openrouter.ai')) {
      headers['HTTP-Referer'] = 'https://github.com/Doorman11991/smallcode';
      headers['X-Title'] = 'SmallCode';
    }

    // Timeout: abort if model doesn't respond in 120s (prevents permanent hang)
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1200000);

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timeout);

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

    const data = await response.json();

    // Track token usage
    if (tokenTracker && data?.usage) {
      tokenTracker.record(data, config.model.name);
    }
    if (data?.usage) {
      tokenMonitor.recordCall(data.usage.prompt_tokens, data.usage.completion_tokens);
      traceRecorder.recordTokens(data.usage.prompt_tokens, data.usage.completion_tokens);
      // Feature 3: charge token budget
      if (chargeBudget) {
        try { chargeBudget('run_turn', { tokens: (data.usage.prompt_tokens || 0) + (data.usage.completion_tokens || 0) }); } catch {}
      }
    }

    // Auto-save session periodically
    if (sessionStore) {
      sessionStore.save(conversationHistory, {
        tokens: tokenTracker ? tokenTracker.stats() : undefined,
      });
      sessionStore.autoTitle(conversationHistory);
    }

    return data;
  } catch (err) {
    console.log(`  \x1b[31m✗ ${err.message}\x1b[0m`);
    return null;
  }
}

// Stream a final text response (no tools, just text output)
async function streamFinalResponse(config, messages) {
  const baseUrl = config.model.baseUrl;
  const systemMsg = {
    role: 'system',
    content: `You are SmallCode, a coding assistant. Summarize what you just did in 1-2 sentences. Be concise.`
  };

  try {
    const headers = { 'Content-Type': 'application/json' };
    const apiKey = process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.DEEPSEEK_API_KEY || config.model.apiKey;
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    if (baseUrl.includes('openrouter.ai')) {
      headers['HTTP-Referer'] = 'https://github.com/Doorman11991/smallcode';
      headers['X-Title'] = 'SmallCode';
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000); // 30s timeout for summary

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: config.model.name,
        messages: [systemMsg, ...messages.slice(-6)],
        stream: true,
        temperature: 0.1,
        max_tokens: 256,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) return null;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullContent = '';

    // Start streaming display
    if (_fullscreenRef) _fullscreenRef.setStreaming(true);

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim() || !line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data === '[DONE]') {
          if (_fullscreenRef) { _fullscreenRef.endStream(); _fullscreenRef.setStreaming(false); }
          else console.log('');
          return fullContent;
        }
        try {
          const chunk = JSON.parse(data);
          const delta = chunk.choices?.[0]?.delta;
          if (delta?.content) {
            if (_fullscreenRef) {
              _fullscreenRef.streamToken(delta.content);
            } else {
              process.stdout.write(delta.content);
            }
            fullContent += delta.content;

            // Early-stop: check for repetition loops during streaming
            const stopSignal = earlyStop.checkRepetition(fullContent);
            if (stopSignal) {
              if (_fullscreenRef) { _fullscreenRef.endStream(); _fullscreenRef.setStreaming(false); }
              else console.log(`\n  \x1b[33m⚡ ${stopSignal.message}\x1b[0m`);
              return fullContent;
            }
          }
        } catch {}
      }
    }
    if (_fullscreenRef) { _fullscreenRef.endStream(); _fullscreenRef.setStreaming(false); }
    else console.log('');
    return fullContent;
  } catch {
    return null;
  }
}

// Streaming version for when no tools are needed (direct responses)
async function sendToModel(message, config) {
  const baseUrl = config.model.baseUrl || process.env.OLLAMA_HOST || 'http://localhost:11434';
  const systemPrompt = `You are SmallCode, a coding assistant. You help users by reading, editing, and creating code files.
Rules:
- Read files before editing them.
- Use search-and-replace for edits. Never rewrite entire files.
- Keep responses concise and focused.
- If a task is complex, break it into steps.`;

  // OpenAI-compatible (LM Studio, vLLM, etc.)
  if (config.model.provider === 'openai' || baseUrl.includes('/v1')) {
    try {
      const headers = { 'Content-Type': 'application/json' };
      const apiKey = process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.DEEPSEEK_API_KEY || config.model.apiKey;
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
      if (baseUrl.includes('openrouter.ai')) {
        headers['HTTP-Referer'] = 'https://github.com/Doorman11991/smallcode';
        headers['X-Title'] = 'SmallCode';
      }

      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: config.model.name,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: message },
          ],
          stream: true,
          temperature: 0.1,
          max_tokens: 4096,
        }),
      });

      if (!response.ok) {
        const err = await response.text();
        console.log(`  ✗ LM Studio error: ${response.status} ${err.slice(0, 200)}`);
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.trim() || !line.startsWith('data: ')) continue;
          const data = line.slice(6);
          if (data === '[DONE]') { console.log(''); return; }
          try {
            const chunk = JSON.parse(data);
            const delta = chunk.choices?.[0]?.delta;
            if (delta?.content) {
              process.stdout.write(delta.content);
            }
          } catch {}
        }
      }
      console.log('');
    } catch (err) {
      console.log(`  ✗ Error: ${err.message}`);
    }
    return;
  }

  // Ollama native endpoint
  try {
    const host = process.env.OLLAMA_HOST || 'http://localhost:11434';
    const response = await fetch(`${host}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: config.model.name,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: message },
        ],
        stream: true,
      }),
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const chunk = JSON.parse(line);
          if (chunk.message && chunk.message.content) {
            process.stdout.write(chunk.message.content);
          }
          if (chunk.done) { console.log(''); return; }
        } catch {}
      }
    }
  } catch (err) {
    console.log(`  ✗ Error: ${err.message}`);
  }
}

// ─── Non-Interactive Mode ────────────────────────────────────────────────────

async function runNonInteractive(config, prompt) {
  if (!prompt) {
    // Read from stdin
    const chunks = [];
    for await (const chunk of process.stdin) {
      chunks.push(chunk);
    }
    prompt = Buffer.concat(chunks).toString().trim();
  }

  if (!prompt) {
    console.error('No prompt provided.');
    process.exit(1);
  }

  await runAgentLoop(prompt, config);
}

// ─── MCP Server Mode ─────────────────────────────────────────────────────────

function runMCP() {
  // Minimal MCP server implementation over stdio
  const rl = readline.createInterface({ input: process.stdin });

  rl.on('line', (line) => {
    try {
      const request = JSON.parse(line);
      const response = handleMCPRequest(request);
      console.log(JSON.stringify(response));
    } catch (err) {
      console.log(JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' }
      }));
    }
  });
}

function handleMCPRequest(request) {
  const { id, method } = request;
  switch (method) {
    case 'initialize':
      return { jsonrpc: '2.0', id, result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'smallcode', version: VERSION },
      }};
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: [
        { name: 'smallcode_read_file', description: 'Read file contents', inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'File path' } }, required: ['path'] } },
        { name: 'smallcode_search', description: 'Search code with regex', inputSchema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] } },
        { name: 'smallcode_patch', description: 'Edit file via search-and-replace', inputSchema: { type: 'object', properties: { path: { type: 'string' }, old_str: { type: 'string' }, new_str: { type: 'string' } }, required: ['path', 'old_str', 'new_str'] } },
        { name: 'smallcode_bash', description: 'Run shell command', inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
        { name: 'smallcode_memory_load', description: 'Load relevant project memory for a task', inputSchema: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'] } },
        { name: 'smallcode_memory_remember', description: 'Save knowledge to project memory', inputSchema: { type: 'object', properties: { type: { type: 'string' }, title: { type: 'string' }, content: { type: 'string' } }, required: ['type', 'title', 'content'] } },
        { name: 'smallcode_agent', description: 'Send a prompt to SmallCode agent', inputSchema: { type: 'object', properties: { message: { type: 'string' } }, required: ['message'] } },
      ]}};
    case 'tools/call':
      return handleMCPToolCall(id, request.params);
    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method: ${method}` }};
  }
}

function handleMCPToolCall(id, params) {
  const { name, arguments: args } = params;
  let result = '';

  switch (name) {
    case 'smallcode_read_file':
      try { result = fs.readFileSync(path.resolve(args.path), 'utf-8'); }
      catch (e) { return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true }}; }
      break;
    case 'smallcode_bash':
      try {
        const { execSync } = require('child_process');
        result = execSync(args.command, { encoding: 'utf-8', timeout: 30000, cwd: process.cwd() });
      } catch (e) { result = e.stdout || e.message; }
      break;
    case 'smallcode_search':
      try {
        const { execSync } = require('child_process');
        result = execSync(`rg --line-number --max-count 10 "${args.pattern}" ${args.path || '.'}`, { encoding: 'utf-8', timeout: 10000, cwd: process.cwd() });
      } catch { result = 'No matches'; }
      break;
    case 'smallcode_patch':
      try {
        const filePath = path.resolve(args.path);
        let content = fs.readFileSync(filePath, 'utf-8');
        if (!content.includes(args.old_str)) { result = 'Error: old_str not found'; break; }
        content = content.replace(args.old_str, args.new_str);
        fs.writeFileSync(filePath, content);
        result = `Patched ${args.path}`;
      } catch (e) { result = `Error: ${e.message}`; }
      break;
    case 'smallcode_memory_load': {
      const { objects, tokens_used } = memoryStore.loadForTask(args.task || '', 2000);
      result = objects.length > 0 
        ? objects.map(o => `[${o.type}] ${o.title}: ${o.content}`).join('\n\n')
        : 'No relevant memory found.';
      break;
    }
    case 'smallcode_memory_remember': {
      const obj = memoryStore.remember({ type: args.type || 'context', title: args.title || '', content: args.content || '', tags: args.tags || [] });
      result = obj.duplicate ? `Already known (${obj.existing_id})` : `Remembered: [${obj.type}] ${obj.title}`;
      break;
    }
    default:
      result = `Unknown tool: ${name}`;
  }

  return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: result }] }};
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  config = loadConfig();

  // Check model is configured
  if (!config.model.name) {
    console.error('\n  ✗ No model configured.');
    console.error('  Set SMALLCODE_MODEL in .env, or add [model] name = "..." to smallcode.toml');
    console.error('  See .env.example for setup instructions.\n');
    process.exit(1);
  }

  // Initialize escalation engine
  escalationEngine = new EscalationEngine(config.escalation || {});

  // Detect model profile (drives routing mode, tool format, context budget)
  const modelProfile = getProfile(config.model.name, config.context.detected_window);
  if (modelProfile.matched_key) {
    // Apply profile-detected context window if not already set
    if (!config.context.detected_window && modelProfile.context_length) {
      config.context.detected_window = modelProfile.context_length;
    }
  }

  // Initialize plugins and skills
  pluginLoader = new PluginLoader(process.cwd()).loadAll();
  skillManager = new SkillManager(process.cwd());

  // Initialize MCP client (connect to external MCP servers)
  let mcpClient = null;
  const mcpClientInstance = new MCPClient(process.cwd());
  if (mcpClientInstance.loadConfig() > 0) {
    mcpClient = mcpClientInstance;
    // Connect asynchronously — don't block boot
    mcpClient.connectAll().then(toolCount => {
      if (toolCount > 0 && _fullscreenRef) {
        _fullscreenRef.addTool('mcp-client', 'ok', `${toolCount} external tools from ${mcpClient.servers.size} servers`);
      }
    }).catch(() => {});
  }

  // Initialize session + token tracking
  sessionStore = new SessionStore(process.cwd());
  tokenTracker = new TokenTracker();

  // Resume or create session
  if (flags.resume) {
    const resumed = sessionStore.resume();
    if (resumed) {
      conversationHistory.push(...resumed.messages);
    }
  }
  if (!sessionStore.current) {
    sessionStore.create(config.model.name);
  }

  if (flags.mcp) {
    runMCP();
    return;
  }

  if (flags.init) {
    require('./init');
    return;
  }

  // Eval mode: run prompt evaluation suites
  if (flags.eval) {
    const { EvalRunner } = require('./eval_runner');
    const evalRunner = new EvalRunner(config);
    console.log(`\n  Running evaluation: ${flags.eval}\n`);
    const results = await evalRunner.run(flags.eval, { chatCompletionFn: chatCompletion });
    if (results.error) {
      console.log(`  \x1b[31m✗ ${results.error}\x1b[0m`);
    } else {
      console.log(EvalRunner.format(results));
      console.log('');
    }
    process.exit(results.error ? 1 : 0);
  }

  if (flags.acp) {
    const { ACPAdapter } = require('../src/adapters/acp');
    const adapter = new ACPAdapter(runAgentLoop, config);
    adapter.start();
    return;
  }

  if (flags.nonInteractive || flags.prompt || positional.length > 0) {
    const prompt = flags.prompt || positional.join(' ');
    await runNonInteractive(config, prompt);
    return;
  }

  await runTUI(config);
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
