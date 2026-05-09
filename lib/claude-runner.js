'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

const MODEL_ALIAS = {
  sonnet: 'global.anthropic.claude-sonnet-4-6',
  opus: 'global.anthropic.claude-opus-4-7',
  haiku: 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
};

const DEFAULT_SYSTEM = `You are a browser agent controlling the user's Chrome through the agent-chrome-bridge MCP server. Available tools are the mcp__agent-chrome-bridge__chrome_* family: read tabs, find elements, click, type, navigate, scroll, screenshot, and capture console output.

Rules:
- Use read-only tools (chrome_snapshot, chrome_find, chrome_read_article) to learn the page before acting.
- To target an element, run chrome_find first and reuse the returned elementId with chrome_click or chrome_type. Hand-written CSS selectors are fragile.
- Keep tool calls minimal. One focused call beats five speculative ones.
- When a question does not require browser actions, just answer.`;

const BRIDGE_TOOL_GLOB = 'mcp__agent-chrome-bridge__*';
const APPROVAL_TOOL_GLOB = 'mcp__agent-chrome-bridge__chrome_(click|type|navigate|close_tab|cdp_click|cdp_key|cdp_type)';
const ROOT = path.resolve(__dirname, '..');
const MCP_SERVER = path.join(ROOT, 'bin', 'mcp-server.js');
const APPROVE_HOOK = path.join(ROOT, 'scripts', 'approve-hook.js');

function resolveModel(model) {
  if (!model) return MODEL_ALIAS.sonnet;
  return MODEL_ALIAS[model] || model;
}

function writeMcpConfig(dir) {
  const configPath = path.join(dir, 'mcp.json');
  const body = {
    mcpServers: {
      'agent-chrome-bridge': {
        type: 'stdio',
        command: process.execPath,
        args: [MCP_SERVER],
      },
    },
  };
  fs.writeFileSync(configPath, JSON.stringify(body, null, 2));
  return configPath;
}

function writeSettings(dir, sessionId) {
  if (!sessionId) return null;
  const settingsPath = path.join(dir, 'settings.json');
  const body = {
    hooks: {
      PreToolUse: [
        {
          matcher: APPROVAL_TOOL_GLOB,
          hooks: [
            {
              type: 'command',
              command: `${process.execPath} ${APPROVE_HOOK}`,
            },
          ],
        },
      ],
    },
  };
  fs.writeFileSync(settingsPath, JSON.stringify(body, null, 2));
  return settingsPath;
}

function buildArgs(options) {
  const args = [
    '-p',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--no-session-persistence',
    '--strict-mcp-config',
    '--mcp-config', options.mcpConfigPath,
    '--allowedTools', BRIDGE_TOOL_GLOB,
    '--model', options.model,
    '--system-prompt', options.system,
  ];

  if (options.settingsPath) {
    args.push('--settings', options.settingsPath);
  }

  if (options.permissionMode && options.permissionMode !== 'ask') {
    args.push('--permission-mode', options.permissionMode);
  }

  if (options.includePartialMessages) {
    args.push('--include-partial-messages');
  }

  args.push('--replay-user-messages');

  return args;
}

function spawnClaude(options) {
  const env = {
    ...process.env,
    CLAUDE_CODE_USE_BEDROCK: '1',
    AWS_REGION: options.awsRegion,
    ANTHROPIC_MODEL: options.model,
    ANTHROPIC_SMALL_FAST_MODEL: options.smallModel || MODEL_ALIAS.haiku,
  };
  if (options.sessionId) {
    env.AGENT_CHROME_BRIDGE_SESSION_ID = options.sessionId;
  }
  return childProcess.spawn('claude', buildArgs(options), {
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
  });
}

function createRunner(userOptions = {}) {
  const model = resolveModel(userOptions.model);
  const awsRegion = userOptions.awsRegion || process.env.AWS_REGION || 'us-east-1';
  const system = userOptions.system || DEFAULT_SYSTEM;
  const permissionMode = userOptions.permissionMode || 'bypassPermissions';
  const includePartialMessages = userOptions.includePartialMessages === true;
  const onEvent = typeof userOptions.onEvent === 'function' ? userOptions.onEvent : () => {};

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chrome-bridge-'));
  const mcpConfigPath = writeMcpConfig(tmpDir);
  const settingsPath = writeSettings(tmpDir, userOptions.sessionId);

  const child = spawnClaude({
    sessionId: userOptions.sessionId,
    model,
    awsRegion,
    system,
    permissionMode,
    includePartialMessages,
    mcpConfigPath,
    settingsPath,
  });

  const stderrBuf = [];
  child.stderr.on('data', (chunk) => {
    stderrBuf.push(chunk.toString('utf8'));
  });

  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let event;
    try {
      event = JSON.parse(line);
    } catch (error) {
      onEvent({ type: 'parse_error', raw: line, error: error.message });
      return;
    }
    onEvent(event);
  });

  const exitPromise = new Promise((resolve) => {
    child.on('exit', (code, signal) => {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
      resolve({ code, signal, stderr: stderrBuf.join('') });
    });
  });

  function send(userText) {
    const line = {
      type: 'user',
      message: { role: 'user', content: userText },
    };
    child.stdin.write(`${JSON.stringify(line)}\n`);
  }

  function end() {
    if (!child.stdin.destroyed) child.stdin.end();
  }

  function abort() {
    child.kill('SIGTERM');
  }

  return { send, end, abort, exit: exitPromise, model, awsRegion };
}

module.exports = { createRunner, MODEL_ALIAS, DEFAULT_SYSTEM };
