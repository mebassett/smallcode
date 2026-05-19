// SmallCode — Model Client
// Handles all communication with the LLM endpoint:
// - chatCompletion (non-streaming, for tool use)
// - streamFinalResponse (streaming summary after tool turns)
// - sendToModel (streaming direct response)
// - runValidation (file validation for improvement loop)

const path = require('path');
const fs = require('fs');
const { buildAuthHeaders } = require('./config');

/**
 * Make a chat completion request (non-streaming, for tool use).
 * @param {object} ctx - Shared context { config, conversationHistory, memoryStore, skillManager, pluginLoader, currentTaskType, tokenTracker, sessionStore, getAllTools, _fullscreenRef }
 */
async function chatCompletion(ctx) {
  const { config, conversationHistory, tokenTracker, sessionStore } = ctx;
  const baseUrl = config.model.baseUrl;

  const systemMsg = {
    role: 'system',
    content: buildSystemPrompt(ctx),
  };

  try {
    const { extractImages, formatImagesForAPI, modelSupportsVision } = require('../src/session/images');
    const processedMessages = conversationHistory.map(msg => {
      if (msg.role !== 'user' || typeof msg.content !== 'string') return msg;
      const images = extractImages(msg.content, process.cwd());
      if (images.length === 0 || !modelSupportsVision(config.model.name)) return msg;
      return { ...msg, content: [{ type: 'text', text: msg.content }, ...formatImagesForAPI(images)] };
    });

    const body = {
      model: config.model.name,
      messages: [systemMsg, ...processedMessages],
      tools: ctx.getAllTools(config),
      max_tokens: 4096,
    };

    const headers = buildAuthHeaders(config);

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const err = await response.text();
      if (response.status >= 400 && response.status < 500) {
        await new Promise(r => setTimeout(r, 2000));
        try {
          const retry = await fetch(`${baseUrl}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body) });
          if (retry.ok) return await retry.json();
        } catch {}
      }
      console.log(`  \x1b[31m✗ API error ${response.status}: ${err.slice(0, 200)}\x1b[0m`);
      return null;
    }

    const data = await response.json();

    if (tokenTracker && data?.usage) {
      tokenTracker.record(data, config.model.name);
    }
    if (sessionStore) {
      sessionStore.save(conversationHistory, { tokens: tokenTracker ? tokenTracker.stats() : undefined });
      sessionStore.autoTitle(conversationHistory);
    }

    return data;
  } catch (err) {
    console.log(`  \x1b[31m✗ ${err.message}\x1b[0m`);
    return null;
  }
}

/**
 * Stream a final text response (no tools, just summarize).
 */
async function streamFinalResponse(ctx) {
  const { config, earlyStop, _fullscreenRef } = ctx;
  const baseUrl = config.model.baseUrl;

  const systemMsg = { role: 'system', content: 'You are SmallCode, a coding assistant. Summarize what you just did in 1-2 sentences. Be concise.' };

  try {
    const headers = buildAuthHeaders(config);
    const messages = ctx.conversationHistory;

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: config.model.name,
        messages: [systemMsg, ...messages.slice(-6)],
        stream: true,
        max_tokens: 256,
      }),
    });

    if (!response.ok) return null;

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullContent = '';

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
            if (_fullscreenRef) _fullscreenRef.streamToken(delta.content);
            else process.stdout.write(delta.content);
            fullContent += delta.content;

            if (earlyStop) {
              const stopSignal = earlyStop.checkRepetition(fullContent);
              if (stopSignal) {
                if (_fullscreenRef) { _fullscreenRef.endStream(); _fullscreenRef.setStreaming(false); }
                else console.log(`\n  \x1b[33m⚡ ${stopSignal.message}\x1b[0m`);
                return fullContent;
              }
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

/**
 * Validate a file (compile check, syntax check, etc.).
 */
function runValidation(filePath) {
  const { execSync } = require('child_process');
  const ext = path.extname(filePath);
  const cwd = process.cwd();

  let cmd = null;
  let parseErrors = null;

  if ((ext === '.ts' || ext === '.tsx') && fs.existsSync(path.join(cwd, 'tsconfig.json'))) {
    cmd = 'npx tsc --noEmit --pretty false 2>&1';
    parseErrors = (output) => output.split('\n').filter(l => l.includes(filePath) && l.includes('error')).slice(0, 5);
  } else if (ext === '.py') {
    cmd = `python -m py_compile "${filePath}" 2>&1`;
    parseErrors = (output) => output.trim() ? [output.trim()] : [];
  } else if (ext === '.rs' && fs.existsSync(path.join(cwd, 'Cargo.toml'))) {
    cmd = 'cargo check --message-format short 2>&1';
    parseErrors = (output) => output.split('\n').filter(l => l.startsWith('error')).slice(0, 5);
  } else if (ext === '.go' && fs.existsSync(path.join(cwd, 'go.mod'))) {
    cmd = 'go build ./... 2>&1';
    parseErrors = (output) => output.split('\n').filter(l => l.includes(filePath)).slice(0, 5);
  } else if (ext === '.js' || ext === '.mjs') {
    cmd = `node --check "${filePath}" 2>&1`;
    parseErrors = (output) => output.trim() ? [output.trim()] : [];
  } else if (ext === '.json') {
    try { JSON.parse(fs.readFileSync(path.resolve(cwd, filePath), 'utf-8')); return { passed: true, errors: [] }; }
    catch (e) { return { passed: false, errors: [e.message] }; }
  } else if (ext === '.bone') {
    const compilerPaths = [
      path.resolve(__dirname, '..', 'node_modules', 'bonescript-compiler', 'dist', 'cli.js'),
      path.resolve(__dirname, '..', '..', 'BoneScript', 'compiler', 'dist', 'cli.js'),
    ];
    let compiler = null;
    for (const cp of compilerPaths) { if (fs.existsSync(cp)) { compiler = cp; break; } }
    if (!compiler) return null;
    try { execSync(`node "${compiler}" --version`, { encoding: 'utf-8', timeout: 5000, cwd }); } catch { return null; }
    cmd = `node "${compiler}" check "${filePath}" 2>&1`;
    parseErrors = (output) => output.split('\n').filter(l => l.includes('error')).slice(0, 5);
  }

  if (!cmd) return null;

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

// ─── Helpers ─────────────────────────────────────────────────────────────────

function buildSystemPrompt(ctx) {
  const { config, conversationHistory, currentTaskType } = ctx;
  const memCtx = getMemoryContext(ctx);
  const skillCtx = getSkillContext(ctx);
  const pluginCtx = getPluginPrompts(ctx);

  let prompt = `You are SmallCode, a coding assistant that operates in the user's project directory.

You have tools to read, write, and edit files, run shell commands, and search code.
You also have project memory and compound tools that do multiple operations in one call.
You have a CODE GRAPH indexed for this project — use it for understanding questions.

IMPORTANT — Code Graph (use these FIRST for understanding/analysis questions):
- list_projects: Lists ALL projects in the workspace with stats. Use FIRST when asked "what projects are here".
- graph_search: Search for a specific symbol/function/class in the graph.
- explain_symbol: Get full explanation of a function/class.
- memory_load: Load relevant project memory.

IMPORTANT — Environment:
- OS: ${process.platform === 'win32' ? 'Windows (cmd.exe shell)' : process.platform === 'darwin' ? 'macOS (zsh)' : 'Linux (bash)'}
${process.platform === 'win32' ? '- Use "dir" not "ls", "type" not "cat", "del" not "rm"\n- Do NOT use bash-specific commands (touch, export, chmod)' : ''}

Rules:
- PREFER compound tools to reduce back-and-forth.
- Use "patch" for edits. Do NOT rewrite whole files.
- Be concise — show what you did, not lengthy explanations.
- If a tool fails, explain what went wrong. Do NOT output a greeting.
- Create files with write_file directly. Do NOT run mkdir first.`;

  if (currentTaskType === 'backend') {
    prompt += `\n\nBONESCRIPT MODE — For Node.js/TypeScript backends, use BoneScript.`;
  }

  prompt += `\nWorking directory: ${process.cwd()}`;
  prompt += memCtx + skillCtx + pluginCtx;
  return prompt;
}

function getMemoryContext(ctx) {
  try {
    const { memoryStore, conversationHistory } = ctx;
    if (!memoryStore || !memoryStore.loadForTask) return '';
    const lastUser = [...conversationHistory].reverse().find(m => m.role === 'user');
    if (!lastUser) return '';
    const { objects } = memoryStore.loadForTask(lastUser.content, 800);
    if (objects.length === 0) return '';
    return '\n\nRelevant project memory:\n' + objects.map(o => `[${o.type}] ${o.title}: ${o.content}`).join('\n');
  } catch { return ''; }
}

function getSkillContext(ctx) {
  if (!ctx.skillManager) return '';
  try {
    const lastUser = [...ctx.conversationHistory].reverse().find(m => m.role === 'user');
    if (!lastUser) return '';
    const skills = ctx.skillManager.getAutoSkills(lastUser.content);
    return ctx.skillManager.formatForPrompt(skills);
  } catch { return ''; }
}

function getPluginPrompts(ctx) {
  if (!ctx.pluginLoader) return '';
  try {
    const injection = ctx.pluginLoader.getPromptInjections(ctx.currentTaskType);
    return injection ? '\n\n' + injection : '';
  } catch { return ''; }
}

module.exports = { chatCompletion, streamFinalResponse, runValidation, buildSystemPrompt };
