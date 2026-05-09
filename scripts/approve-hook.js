#!/usr/bin/env node
'use strict';

// PreToolUse hook: reads Claude Code's hook JSON from stdin, asks the broker
// whether the session should allow this tool call, then writes the required
// {hookSpecificOutput: {...}} response to stdout.

const net = require('node:net');
const { socketPath } = require('../lib/socket-path');

const SESSION_ID = process.env.AGENT_CHROME_BRIDGE_SESSION_ID;

function emit(decision, reason) {
  const payload = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
    },
  };
  if (reason) payload.hookSpecificOutput.permissionDecisionReason = reason;
  process.stdout.write(JSON.stringify(payload));
  process.stdout.write('\n');
}

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on('data', (chunk) => chunks.push(chunk));
    process.stdin.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8').trim();
        resolve(text ? JSON.parse(text) : {});
      } catch (error) {
        reject(error);
      }
    });
    process.stdin.on('error', reject);
  });
}

function askBroker(params, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath());
    let buffer = '';
    const id = `hook-${process.pid}-${Date.now()}`;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('Broker approval timed out'));
    }, timeoutMs);

    socket.setEncoding('utf8');
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ type: 'request', id, method: 'session.approve', params })}\n`);
    });
    socket.on('data', (chunk) => {
      buffer += chunk;
      for (;;) {
        const idx = buffer.indexOf('\n');
        if (idx === -1) break;
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== id) continue;
        clearTimeout(timer);
        socket.end();
        if (msg.error) reject(new Error(msg.error));
        else resolve(msg.result);
        return;
      }
    });
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function main() {
  if (!SESSION_ID) {
    // No session context (e.g. hook fired from a non-bridge Claude run). Allow.
    emit('allow', 'No AGENT_CHROME_BRIDGE_SESSION_ID set');
    return;
  }

  let hookInput;
  try {
    hookInput = await readStdin();
  } catch (error) {
    emit('deny', `Invalid hook input: ${error.message}`);
    process.exit(2);
    return;
  }

  try {
    const result = await askBroker({
      sessionId: SESSION_ID,
      toolName: hookInput.tool_name,
      input: hookInput.tool_input,
      toolUseId: hookInput.tool_use_id,
    });
    if (result?.decision === 'allow') {
      emit('allow', result.reason);
    } else {
      emit('deny', result?.reason || 'Denied');
    }
  } catch (error) {
    emit('deny', `Broker approval error: ${error.message}`);
    process.exit(2);
  }
}

main().catch((error) => {
  process.stderr.write(`approve-hook error: ${error.stack || error.message}\n`);
  emit('deny', `Hook crash: ${error.message}`);
  process.exit(2);
});
