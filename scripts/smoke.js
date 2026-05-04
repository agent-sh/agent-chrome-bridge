#!/usr/bin/env node
'use strict';

const childProcess = require('node:child_process');
const path = require('node:path');
const { version: packageVersion } = require('../package.json');

const server = childProcess.spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'mcp-server.js')], {
  stdio: ['pipe', 'pipe', 'pipe'],
});

let output = '';
let stderr = '';
server.stdout.on('data', (chunk) => {
  output += chunk.toString('utf8');
});
server.stderr.on('data', (chunk) => {
  stderr += chunk.toString('utf8');
});

function send(message) {
  server.stdin.write(`${JSON.stringify(message)}\n`);
}

send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });

setTimeout(() => {
  server.kill('SIGTERM');
  const lines = output.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const init = lines.find((message) => message.id === 1);
  const tools = lines.find((message) => message.id === 2);

  if (!init?.result?.serverInfo?.name) {
    process.stderr.write(`Missing initialize result\n${output}\n${stderr}\n`);
    process.exit(1);
  }

  if (init.result.serverInfo.version !== packageVersion) {
    process.stderr.write(`Expected server version ${packageVersion}, got ${init.result.serverInfo.version}\n${output}\n${stderr}\n`);
    process.exit(1);
  }

  if (!Array.isArray(tools?.result?.tools) || tools.result.tools.length < 30) {
    process.stderr.write(`Missing tools/list result\n${output}\n${stderr}\n`);
    process.exit(1);
  }

  process.stdout.write(`Smoke OK: ${tools.result.tools.length} tools exposed\n`);
}, 250);
