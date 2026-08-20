#!/usr/bin/env node
'use strict';

const readline = require('node:readline');
const { request } = require('../lib/broker-client');
const { TOOLS, METHOD_BY_TOOL, MUTATING_TOOLS } = require('../lib/tool-registry');
const {
  DEFAULT_LAUNCH_ARGS,
  detectBinary,
  pollUntilConnected,
  spawnDetached,
} = require('../lib/chrome-launcher');
const { version: PACKAGE_VERSION } = require('../package.json');

const READ_ONLY = /^(1|true|yes)$/i.test(process.env.AGENT_CHROME_BRIDGE_READ_ONLY || '');

function respond(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function fail(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
}

function textResult(value) {
  return {
    content: [
      {
        type: 'text',
        text: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

// imageResult emits an MCP image content block (plus a small text summary)
// when a tool result carries a base64 data URL (e.g. chrome_screenshot's
// dataUrl). MCP clients that understand image content render it
// as an actual image to the model instead of a giant base64 text blob.
function dataUrlParts(dataUrl) {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl || '');
  if (!m) return null;
  const mimeType = m[1] || 'image/png';
  const isBase64 = Boolean(m[2]);
  if (!isBase64) return null; // only base64 data URLs become image blocks
  return { mimeType, data: m[3] };
}

function imageResult(value) {
  if (value && typeof value === 'object' && typeof value.dataUrl === 'string') {
    const parts = dataUrlParts(value.dataUrl);
    if (parts) {
      // Keep a compact text summary (drop the huge dataUrl), add the image.
      const summary = { ...value };
      delete summary.dataUrl;
      return {
        content: [
          { type: 'text', text: JSON.stringify(summary, null, 2) },
          { type: 'image', mimeType: parts.mimeType, data: parts.data },
        ],
      };
    }
  }
  return textResult(value);
}

function requestOptions(method, args) {
  if (method.startsWith('page.wait')) {
    const timeoutMs = Number(args?.timeoutMs || 10000);
    return { timeoutMs: Math.max(1000, timeoutMs + 5000) };
  }
  if (method === 'cdp.console') {
    const waitMs = Number(args?.waitMs || 1000);
    return { timeoutMs: Math.max(3000, waitMs + 5000) };
  }
  return {};
}

async function handle(message) {
  if (message.method === 'initialize') {
    respond(message.id, {
      protocolVersion: message.params?.protocolVersion || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'agent-chrome-bridge', version: PACKAGE_VERSION },
    });
    return;
  }

  if (message.method === 'notifications/initialized') return;

  if (message.method === 'ping') {
    respond(message.id, {});
    return;
  }

  if (message.method === 'tools/list') {
    respond(message.id, { tools: TOOLS });
    return;
  }

  if (message.method === 'tools/call') {
    const toolName = message.params?.name;
    const args = message.params?.arguments || {};

    // Tools handled locally inside the MCP server (not forwarded to the broker).
    const localHandler = LOCAL_TOOLS[toolName];

    if (!localHandler && !METHOD_BY_TOOL[toolName]) {
      respond(message.id, { ...textResult(`Unknown tool: ${toolName}`), isError: true });
      return;
    }

    if (READ_ONLY && MUTATING_TOOLS.has(toolName)) {
      respond(message.id, { ...textResult(`Bridge is in read-only mode; refusing ${toolName}.`), isError: true });
      return;
    }

    try {
      if (localHandler) {
        const result = await localHandler(args);
        respond(message.id, textResult(result));
        return;
      }

      const method = METHOD_BY_TOOL[toolName];
      const result = await request(method, args, requestOptions(method, args));
      respond(message.id, imageResult(result));
    } catch (error) {
      respond(message.id, { ...textResult(error.message), isError: true });
    }
    return;
  }

  if (message.id !== undefined) fail(message.id, -32601, `Unknown method: ${message.method}`);
}

async function chromeHealth(args = {}) {
  const result = await request('bridge.health', {});
  result.mcp = {
    version: PACKAGE_VERSION,
    readOnly: READ_ONLY,
    tools: TOOLS.length,
  };
  result.versions = {
    mcp: PACKAGE_VERSION,
    broker: result.broker?.version || null,
    nativeHost: result.nativeHost?.version || null,
    extension: null,
    background: null,
    contentScript: null,
  };

  if (!result.extensionConnected) return result;

  try {
    const extensionInfo = await request('bridge.info', args, { timeoutMs: 5000 });
    result.extension = extensionInfo.extension;
    result.contentScript = extensionInfo.contentScript;
    result.versions.extension = extensionInfo.extension?.version || null;
    result.versions.background = extensionInfo.extension?.backgroundVersion || null;
    result.versions.contentScript = extensionInfo.contentScript?.version || null;
  } catch (error) {
    result.extension = {
      ok: false,
      error: error.message || String(error),
    };
  }

  return result;
}

const LAUNCH_DEFAULT_TIMEOUT_MS = 15000;
const LAUNCH_MAX_TIMEOUT_MS = 60000;
const LAUNCH_POLL_INTERVAL_MS = 250;

/**
 * Check whether the bridge extension is currently connected via the broker.
 * Errors are treated as "not connected" so the launcher can keep polling
 * across broker restarts.
 *
 * @returns {Promise<boolean>}
 */
async function isExtensionConnected() {
  try {
    const result = await request('bridge.health', {}, { timeoutMs: 3000 });
    return Boolean(result?.extensionConnected);
  } catch {
    return false;
  }
}

/**
 * `chrome_launch` MCP tool implementation. Detects a Chromium-family browser,
 * spawns it detached so it outlives the MCP server, and polls the broker
 * until the bridge extension reconnects (or the timeout elapses).
 *
 * @param {object} [args]
 * @param {string} [args.binary]
 * @param {string[]} [args.args]
 * @param {string} [args.userDataDir]
 * @param {number} [args.waitForExtensionMs]
 * @param {boolean} [args.force]
 * @returns {Promise<object>}
 */
async function chromeLaunch(args = {}) {
  const force = args.force === true;

  if (!force && (await isExtensionConnected())) {
    return { status: 'already_connected', pid: null };
  }

  const detected = detectBinary({ binary: args.binary });
  if (!detected.binary) {
    return {
      status: 'error',
      error: `No Chromium-based browser found. Tried: ${detected.tried.join(', ')}. Pass \`binary\` to override.`,
      tried: detected.tried,
    };
  }

  const extraArgs = Array.isArray(args.args) ? args.args.slice() : DEFAULT_LAUNCH_ARGS.slice();
  if (args.userDataDir) extraArgs.push(`--user-data-dir=${args.userDataDir}`);

  const { pid, error: spawnError } = spawnDetached(detected.binary, extraArgs);
  if (spawnError) {
    return {
      status: 'spawn_error',
      binary: detected.binary,
      error: spawnError.message || String(spawnError),
      errno: spawnError.errno || null,
      code: spawnError.code || null,
    };
  }

  const waitMs = Math.max(
    1000,
    Math.min(LAUNCH_MAX_TIMEOUT_MS, Number(args.waitForExtensionMs) || LAUNCH_DEFAULT_TIMEOUT_MS),
  );

  const { connected, waitedMs } = await pollUntilConnected(isExtensionConnected, {
    timeoutMs: waitMs,
    intervalMs: LAUNCH_POLL_INTERVAL_MS,
  });

  if (connected) {
    return { status: 'launched', pid, binary: detected.binary, waitedMs };
  }

  return {
    status: 'timeout',
    pid,
    binary: detected.binary,
    waitedMs,
    hint: `Chrome started but the agent-chrome-bridge extension did not reconnect within ${waitMs}ms. Check chrome://extensions/ — extension may be disabled or uninstalled.`,
  };
}

const LOCAL_TOOLS = {
  chrome_health: chromeHealth,
  chrome_launch: chromeLaunch,
};

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    fail(null, -32700, `Parse error: ${error.message}`);
    return;
  }

  handle(message).catch((error) => fail(message.id, -32603, error.stack || error.message));
});
