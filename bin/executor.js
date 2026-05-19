// SmallCode — Tool Executor
// Executes tool calls from the model. Accepts a context object for shared state.
//
// Usage:
//   const { executeTool } = require('./executor');
//   const result = await executeTool(name, args, ctx);
//
// ctx: { _fullscreenRef, mcpCall, memoryStore, pluginLoader, mcpClient, flags, config, tui }

const path = require('path');
const fs = require('fs');

function showMiniDiff(tui, filePath, oldStr, newStr, lineNum) {
  const diff = tui.renderDiff(filePath, oldStr, newStr, lineNum);
  if (diff) console.log(diff);
}

async function executeTool(name, args, ctx) {
  const { _fullscreenRef, mcpCall, memoryStore, pluginLoader, mcpClient, flags, config, tui } = ctx;
  const { execSync } = require('child_process');
  const cwd = process.cwd();

  switch (name) {
    case 'read_file': {
      // Normalize path (strip leading ./ and fix slashes)
      let reqPath = args.path.replace(/^\.\//, '').replace(/^\.\\/, '');
      const filePath = path.resolve(cwd, reqPath);
      if (!fs.existsSync(filePath)) return { error: `File not found: ${args.path} (checked: ${filePath})` };
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');
      const start = (args.start_line || 1) - 1;
      const end = args.end_line || lines.length;
      const slice = lines.slice(start, end);
      const numbered = slice.map((l, i) => `${String(start + i + 1).padStart(4)}│ ${l}`).join('\n');

      // Feature 2: summarize large files (>200 lines, no line range requested)
      // This saves context by replacing the full file with signatures + key logic
      if (lines.length > 200 && !args.start_line && !args.end_line) {
        try {
          const { summarizeFileCompiled } = require('./features_adapter');
          if (summarizeFileCompiled) {
            const summary = await summarizeFileCompiled(args.path, content, 600);
            if (summary && summary.length > 50) {
              return { result: `${args.path} (${lines.length} lines — summarized):\n${summary}` };
            }
          }
        } catch {} // fall through to full content on any error
      }

      return { result: `${args.path} (${lines.length} lines):\n${numbered}` };
    }

    case 'write_file': {
      let reqPath = args.path.replace(/^\.\//, '').replace(/^\.\\/, '');
      const filePath = path.resolve(cwd, reqPath);
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const existed = fs.existsSync(filePath);
      const oldContent = existed ? fs.readFileSync(filePath, 'utf-8') : null;
      fs.writeFileSync(filePath, args.content);
      const lineCount = args.content.split('\n').length;
      const action = existed ? 'Updated' : 'Created';
      if (_fullscreenRef && existed && oldContent) {
        const preview = oldContent.split('\n').slice(0, 5).join('\n');
        const newPreview = args.content.split('\n').slice(0, 5).join('\n');
        _fullscreenRef.addDiff(args.path, preview + '\n...', newPreview + '\n...', 1);
      }
      return { result: `${action} ${args.path} (${lineCount} lines)`, action, path: args.path, lines: lineCount };
    }

    case 'patch': {
      const __missing = ['path', 'old_str', 'new_str']
        .filter(k => typeof args[k] !== 'string');
      if (__missing.length) {
        return {
          error: `patch: missing or non-string arg(s): ${__missing.join(', ')}. ` +
                 `received: ${JSON.stringify(args).slice(0, 200)}`,
          kind: 'validation',
        };
      }
      let reqPath = args.path.replace(/^\.\//, '').replace(/^\.\\/, '');
      const filePath = path.resolve(cwd, reqPath);
      if (!fs.existsSync(filePath)) return { error: `File not found: ${args.path} (checked: ${filePath})` };
      let content = fs.readFileSync(filePath, 'utf-8');
      const count = content.split(args.old_str).length - 1;
      if (count === 0) return { error: `old_str not found in ${args.path}` };
      if (count > 1) return { error: `old_str matches ${count} locations. Include more context.` };
      content = content.replace(args.old_str, args.new_str);
      fs.writeFileSync(filePath, content);
      const lineNum = content.slice(0, content.indexOf(args.new_str)).split('\n').length;
      const oldLines = args.old_str.split('\n').length;
      const newLines = args.new_str.split('\n').length;
      if (_fullscreenRef) {
        _fullscreenRef.addDiff(args.path, args.old_str, args.new_str, lineNum);
      } else {
        showMiniDiff(tui, args.path, args.old_str, args.new_str, lineNum);
      }
      return { result: `Patched ${args.path}: replaced ${oldLines} lines with ${newLines} lines at line ${lineNum}`, action: 'Edited', path: args.path, line: lineNum };
    }

    case 'bash': {
      let command = args.command;

      // Detect commands that start long-running servers (will block and timeout)
      const blockingPatterns = /^(node|python|python3|ruby|php|go run|deno run|bun run)\s+.*\b(server|app|index|main)\b/i;
      const explicitServers = /\b(express|fastify|flask|django|uvicorn|gunicorn|rails\s+s|npm\s+start|yarn\s+start|npm\s+run\s+dev)\b/i;
      if (blockingPatterns.test(command) || explicitServers.test(command)) {
        // Check if it's actually a --check or test command (those are fine)
        if (!command.includes('--check') && !command.includes('--version') && !command.includes('test')) {
          return {
            result: `Refused: "${command}" would start a long-running server that blocks. Use "node --check <file>" to verify syntax, or describe what you want to test and I'll use a non-blocking approach.`,
            error: 'Blocking command detected',
            command,
          };
        }
      }

      // Detect scripts with interactive input (will EOF or block forever)
      const scriptMatch = command.match(/^(?:python3?|node|ruby)\s+["']?([^\s"']+)/);
      if (scriptMatch && !command.includes('--check') && !command.includes('-c') && !command.includes('-m')) {
        const targetFile = path.resolve(cwd, scriptMatch[1]);
        if (fs.existsSync(targetFile)) {
          const fc = fs.readFileSync(targetFile, 'utf-8');
          if (fc.includes('input(') || fc.includes('readline.question') || fc.includes('process.stdin.on')) {
            return {
              result: `Refused: "${command}" — file contains interactive input() calls that block in non-interactive mode. File created successfully. Verify syntax: python -m py_compile ${scriptMatch[1]}`,
              error: 'Interactive script detected',
              command,
            };
          }
        }
      }

      if (process.platform === 'win32') {
        command = command.replace(/^ls\b/, 'dir').replace(/^ls /, 'dir ').replace(/^cat /, 'type ').replace(/^rm -rf /, 'rmdir /s /q ').replace(/^rm /, 'del ').replace(/^touch /, 'echo.>').replace(/^cp /, 'copy ').replace(/^mv /, 'move ').replace(/^mkdir -p /, 'mkdir ');
      }
      if (flags && flags.verbose && _fullscreenRef) {
        _fullscreenRef.addTool('bash', 'ok', `$ ${command}`);
      }
      try {
        const output = execSync(command, { encoding: 'utf-8', timeout: 30000, cwd, maxBuffer: 1024 * 1024 });
        const maxOutput = (config && config.context?.detected_window || 128000) < 64000 ? 1500 : 3000;
        const trimmed = output.length > maxOutput ? output.slice(0, maxOutput - 500) + '\n...(truncated)...\n' + output.slice(-300) : output;
        if (flags && flags.verbose && _fullscreenRef && trimmed.trim()) {
          const lines = trimmed.split('\n').slice(0, 10);
          for (const line of lines) _fullscreenRef.addChat('system', '  ' + line);
        }
        return { result: trimmed || '(no output)', command };
      } catch (e) {
        const output = (e.stdout || '') + (e.stderr || '');
        const exitReason = (e.status === null || e.status === undefined) ? 'Timed out (killed after 30s)' : `Exit code ${e.status}`;
        if (flags && flags.verbose && _fullscreenRef && output.trim()) {
          const lines = output.split('\n').slice(0, 8);
          for (const line of lines) _fullscreenRef.addChat('system', '  ' + line);
        }
        return { result: output.slice(0, 2000) || e.message, error: exitReason, command };
      }
    }

    case 'search': {
      try {
        const searchPath = args.path || '.';
        const output = execSync(`rg --line-number --max-count 10 -C 1 "${args.pattern.replace(/"/g, '\\"')}" ${searchPath}`, { encoding: 'utf-8', timeout: 10000, cwd });
        return { result: output.slice(0, 3000) };
      } catch { return { result: 'No matches found.' }; }
    }

    case 'find_files': {
      try {
        const output = execSync(`rg --files --glob "${args.pattern}" --glob "!node_modules" --glob "!.git"`, { encoding: 'utf-8', timeout: 10000, cwd });
        const files = output.trim().split('\n').filter(Boolean).slice(0, 30);
        return { result: files.length ? `Found ${files.length} files:\n${files.join('\n')}` : 'No files found.' };
      } catch { return { result: 'No files found.' }; }
    }

    case 'list_projects': {
      const listResult = await mcpCall('tools/call', { name: 'list_repos', arguments: {} });
      if (listResult && listResult.content) {
        try {
          const data = JSON.parse(listResult.content[0]?.text || '{}');
          const repos = data.repos || [];
          if (repos.length === 0) return { result: 'No projects indexed yet. The code graph is empty.' };
          let output = `Workspace: ${repos.length} indexed projects\n\n`;
          for (const r of repos) {
            output += `• ${r.name} — ${r.file_count || '?'} files, ${r.symbol_count || '?'} symbols, ${(r.languages || []).slice(0, 4).join(', ') || '?'}\n`;
          }
          return { result: output };
        } catch (e) { return { result: listResult.content[0]?.text || 'Failed to parse repo list.' }; }
      }
      try {
        const entries = fs.readdirSync(process.cwd(), { withFileTypes: true });
        const dirs = entries.filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules');
        return { result: `Projects in ${process.cwd()}:\n${dirs.map(d => `  - ${d.name}/`).join('\n')}` };
      } catch { return { result: 'Could not list projects.' }; }
    }

    case 'graph_search': {
      const maxTokens = args.max_tokens || 4000;
      const graphResult = await mcpCall('tools/call', { name: 'search_graph', arguments: { query: args.query, max_tokens: maxTokens } });
      if (graphResult && graphResult.content) {
        const text = graphResult.content.map(c => c.text || '').join('\n');
        return { result: text || 'No results from code graph.' };
      }
      try {
        const output = execSync(`rg --line-number --max-count 5 "${args.query.replace(/"/g, '\\"')}" .`, { encoding: 'utf-8', timeout: 10000, cwd });
        return { result: output.slice(0, 3000) };
      } catch { return { result: 'No matches found in code graph or files.' }; }
    }

    case 'explain_symbol': {
      const graphResult = await mcpCall('tools/call', { name: 'explain_symbol', arguments: { symbol: args.symbol } });
      if (graphResult && graphResult.content) {
        const text = graphResult.content.map(c => c.text || '').join('\n');
        return { result: text || `Symbol "${args.symbol}" not found in code graph.` };
      }
      try {
        const output = execSync(`rg --line-number "\\b${args.symbol}\\b" . --max-count 10`, { encoding: 'utf-8', timeout: 10000, cwd });
        return { result: `References to ${args.symbol}:\n${output.slice(0, 2000)}` };
      } catch { return { result: `Symbol "${args.symbol}" not found.` }; }
    }

    case 'read_and_patch': {
      const __missing = ['path', 'old_str', 'new_str']
        .filter(k => typeof args[k] !== 'string');
      if (__missing.length) {
        return {
          error: `read_and_patch: missing or non-string arg(s): ${__missing.join(', ')}. ` +
                 `received: ${JSON.stringify(args).slice(0, 200)}`,
          kind: 'validation',
        };
      }
      const filePath = path.resolve(cwd, args.path);
      if (!fs.existsSync(filePath)) return { error: `File not found: ${args.path}` };
      let content = fs.readFileSync(filePath, 'utf-8');
      const count = content.split(args.old_str).length - 1;
      if (count === 0) {
        const lines = content.split('\n').slice(0, 50);
        const numbered = lines.map((l, i) => `${(i+1).toString().padStart(4)}| ${l}`).join('\n');
        return { error: `old_str not found. File content:\n${numbered}` };
      }
      if (count > 1) return { error: `old_str matches ${count} locations. Be more specific.` };
      content = content.replace(args.old_str, args.new_str);
      fs.writeFileSync(filePath, content);
      const lineNum = content.slice(0, content.indexOf(args.new_str)).split('\n').length;
      showMiniDiff(tui, args.path, args.old_str, args.new_str, lineNum);
      return { result: `Read and patched ${args.path} at line ${lineNum}`, action: 'Edited', path: args.path, line: lineNum };
    }

    case 'create_and_run': {
      const __missing = ['path', 'content']
        .filter(k => typeof args[k] !== 'string');
      if (__missing.length) {
        return {
          error: `create_and_run: missing or non-string arg(s): ${__missing.join(', ')}. ` +
                 `received: ${JSON.stringify(args).slice(0, 200)}`,
          kind: 'validation',
        };
      }
      const filePath = path.resolve(cwd, args.path);
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(filePath, args.content);
      const lines = args.content.split('\n').length;
      let output = `Created ${args.path} (${lines} lines)`;
      let cmdError = false;
      if (args.command) {
        // Check if the file contains interactive input calls that would block
        const hasInteractive = args.content && (
          args.content.includes('input(') ||     // Python input()
          args.content.includes('readline') ||    // Node readline
          args.content.includes('process.stdin') || // Node stdin
          args.content.includes('Scanner(') ||    // Java Scanner
          args.content.includes('gets') ||        // Ruby gets
          args.content.includes('read()')         // generic read
        );
        if (hasInteractive) {
          output += `\n⚠ File contains interactive input calls (input/readline/stdin). Skipping execution — the script would hang waiting for user input. Use node --check or python -c "import py_compile; py_compile.compile('${args.path}')" to verify syntax instead.`;
          return { result: output, action: 'Created', path: args.path, lines };
        }
        // Also check for server-start patterns
        const blockingPatterns = /^(node|python|python3|ruby|php)\s+.*\b(server|app)\b/i;
        const explicitServers = /\b(express|fastify|flask|django|uvicorn|npm\s+start)\b/i;
        if (blockingPatterns.test(args.command) || explicitServers.test(args.command)) {
          if (!args.command.includes('--check') && !args.command.includes('test')) {
            output += `\n⚠ Command would start a long-running server. Skipping execution.`;
            return { result: output, action: 'Created', path: args.path, lines };
          }
        }
        try {
          const cmdOut = execSync(args.command, { encoding: 'utf-8', timeout: 30000, cwd, maxBuffer: 1024*1024 });
          output += `\n$ ${args.command}\n${cmdOut.slice(0, 2000)}`;
        } catch (e) {
          cmdError = true;
          const errOut = (e.stdout || '') + (e.stderr || e.message || '');
          output += `\n$ ${args.command}\n${(e.status === null || e.status === undefined) ? 'TIMED OUT' : 'EXIT CODE ' + (e.status || 1)} — FAILED:\n${errOut.slice(0, 2000)}`;
        }
      }
      return { result: output, action: 'Created', path: args.path, lines, error: cmdError ? `Command failed: ${args.command}` : null };
    }

    case 'find_and_read': {
      try {
        const found = execSync(`rg --files --glob "${args.pattern}" --glob "!node_modules" --glob "!.git"`, { encoding: 'utf-8', timeout: 10000, cwd });
        const files = found.trim().split('\n').filter(Boolean);
        if (files.length === 0) return { result: 'No files found matching: ' + args.pattern };
        const target = files[0];
        const content = fs.readFileSync(path.resolve(cwd, target), 'utf-8');
        const maxLines = args.read_lines || 50;
        const lines = content.split('\n').slice(0, maxLines);
        const numbered = lines.map((l, i) => `${(i+1).toString().padStart(4)}| ${l}`).join('\n');
        let output = `Found ${files.length} files. Reading ${target} (${content.split('\n').length} lines):\n${numbered}`;
        if (files.length > 1) output += `\n\nOther matches: ${files.slice(1, 5).join(', ')}`;
        return { result: output };
      } catch { return { result: 'No files found matching: ' + args.pattern }; }
    }

    case 'search_and_read': {
      try {
        const readCtx = args.read_context || 10;
        const output = execSync(`rg --line-number -C ${readCtx} --max-count 3 "${args.pattern.replace(/"/g, '\\"')}" . --glob "!node_modules" --glob "!.git"`, { encoding: 'utf-8', timeout: 10000, cwd });
        return { result: output.slice(0, 4000) || 'No matches.' };
      } catch { return { result: 'No matches found for: ' + args.pattern }; }
    }

    case 'run': {
      // Check if the target file has interactive input that would block
      const runMatch = args.command.match(/^(?:python3?|node|ruby)\s+["']?([^\s"']+)/);
      if (runMatch) {
        const targetFile = path.resolve(cwd, runMatch[1]);
        if (fs.existsSync(targetFile)) {
          const fileContent = fs.readFileSync(targetFile, 'utf-8');
          if (fileContent.includes('input(') || fileContent.includes('readline') || fileContent.includes('process.stdin')) {
            return {
              result: `Refused: "${args.command}" — the file contains interactive input calls (input/readline/stdin) which cannot work in non-interactive mode. The file was created successfully. To verify syntax, use: python -m py_compile <file> or node --check <file>`,
              error: 'Interactive script detected',
              command: args.command,
            };
          }
        }
      }
      const timeout = (args.timeout || 30) * 1000;
      try {
        const output = execSync(args.command, { encoding: 'utf-8', timeout, cwd, maxBuffer: 1024*1024 });
        return { result: output.slice(0, 3000) || '(completed with no output)', command: args.command };
      } catch (e) {
        const errOut = (e.stdout || '') + (e.stderr || e.message || '');
        const exitReason = (e.status === null || e.status === undefined) ? 'Timed out (killed after 30s)' : `Exit code ${e.status || 1}`;
        return { result: `${exitReason.toUpperCase()} — FAILED:\n${errOut.slice(0, 2500)}`, error: `Command failed: ${exitReason}`, command: args.command };
      }
    }

    case 'memory_load':
    case 'memory_remember':
    case 'memory_list':
    case 'memory_forget': {
      if (name === 'memory_load') {
        const task = args.task || '';
        const maxTokens = args.max_tokens || 2000;
        const { objects, tokens_used } = memoryStore.loadForTask(task, maxTokens);
        if (objects.length === 0) return { result: 'No relevant memory found.' };
        const formatted = objects.map(o => `[${o.type}] ${o.title}: ${o.content}`).join('\n\n');
        return { result: `Loaded ${objects.length} memories (${tokens_used} tokens):\n\n${formatted}` };
      }
      if (name === 'memory_remember') {
        const obj = memoryStore.remember({ type: args.type || 'context', title: args.title || '', content: args.content || '', tags: args.tags || [], symbols: args.symbols || [], files: args.files || [] });
        if (obj.duplicate) return { result: `Already known (confirmed existing: ${obj.existing_id})` };
        return { result: `Remembered [${obj.type}] "${obj.title}" (${obj.id})` };
      }
      if (name === 'memory_list') {
        const objects = args.type ? memoryStore.byType(args.type) : memoryStore.all();
        if (objects.length === 0) return { result: 'No memory stored.' };
        return { result: objects.map(o => `[${o.id}] (${o.type}) ${o.title}`).join('\n') };
      }
      if (name === 'memory_forget') {
        const ok = memoryStore.forget(args.id);
        return { result: ok ? `Deleted ${args.id}` : `Not found: ${args.id}` };
      }
      return { result: '' };
    }

    case 'bone_compile': {
      const bonePath = path.resolve(cwd, args.path);
      if (!fs.existsSync(bonePath)) return { error: `File not found: ${args.path}` };
      if (!args.path.endsWith('.bone')) return { error: `Expected a .bone file, got: ${args.path}` };
      const target = args.target || 'express';
      const compilerPaths = [path.resolve(__dirname, '..', 'node_modules', 'bonescript-compiler', 'dist', 'cli.js'), path.resolve(__dirname, '..', '..', 'BoneScript', 'compiler', 'dist', 'cli.js')];
      let compiler = null;
      for (const cp of compilerPaths) { if (fs.existsSync(cp)) { compiler = cp; break; } }
      if (!compiler) return { error: 'BoneScript compiler not found.' };
      try {
        const output = execSync(`node "${compiler}" compile "${bonePath}" --target ${target}`, { encoding: 'utf-8', timeout: 30000, cwd });
        return { result: `Compiled ${args.path} → output/\n${output.slice(0, 2000)}`, action: 'Created', path: 'output/' };
      } catch (e) {
        return { error: `BoneScript compile failed:\n${((e.stdout || '') + (e.stderr || e.message || '')).slice(0, 2000)}` };
      }
    }

    case 'bone_check': {
      const bonePath = path.resolve(cwd, args.path);
      if (!fs.existsSync(bonePath)) return { error: `File not found: ${args.path}` };
      if (!args.path.endsWith('.bone')) return { error: `Expected a .bone file, got: ${args.path}` };
      const compilerPaths = [path.resolve(__dirname, '..', 'node_modules', 'bonescript-compiler', 'dist', 'cli.js'), path.resolve(__dirname, '..', '..', 'BoneScript', 'compiler', 'dist', 'cli.js')];
      let compiler = null;
      for (const cp of compilerPaths) { if (fs.existsSync(cp)) { compiler = cp; break; } }
      if (!compiler) return { error: 'BoneScript compiler not found.' };
      try {
        const output = execSync(`node "${compiler}" check "${bonePath}"`, { encoding: 'utf-8', timeout: 15000, cwd });
        return { result: output.trim() || '✓ No errors found.' };
      } catch (e) {
        return { error: `BoneScript validation errors:\n${((e.stdout || '') + (e.stderr || e.message || '')).slice(0, 2000)}` };
      }
    }

    case 'web_search': {
      if (process.env.SMALLCODE_WEB_BROWSE !== 'true') return { error: 'Web browsing disabled. Set SMALLCODE_WEB_BROWSE=true.' };
      const { webSearch } = require('../src/tools/builtin/web_browse');
      const results = await webSearch(args.query, 5);
      return { result: results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join('\n\n') || 'No results found.' };
    }

    case 'web_fetch': {
      if (process.env.SMALLCODE_WEB_BROWSE !== 'true') return { error: 'Web browsing disabled. Set SMALLCODE_WEB_BROWSE=true.' };
      const { webFetch } = require('../src/tools/builtin/web_browse');
      const content = await webFetch(args.url, 5000);
      return { result: content || 'Failed to fetch URL.' };
    }

    case 'select_category': {
      const category = args.category || 'read';
      return { result: `Category: ${category}. Proceed with your tool call.`, category };
    }

    default: {
      if (mcpClient && mcpClient.isMCPTool(name)) {
        const mcpResult = await mcpClient.callTool(name, args);
        if (mcpResult.error) return { error: mcpResult.error };
        return { result: mcpResult.result || '(no output)' };
      }
      if (pluginLoader) {
        const pluginResult = await pluginLoader.executeTool(name, args);
        if (pluginResult !== null) {
          if (pluginResult.error) return { error: pluginResult.error };
          return { result: typeof pluginResult === 'string' ? pluginResult : JSON.stringify(pluginResult) };
        }
      }
      return { error: `Unknown tool: ${name}` };
    }
  }
}

module.exports = { executeTool };
