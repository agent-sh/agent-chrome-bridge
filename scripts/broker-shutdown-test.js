#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chrome-bridge-shutdown-'));
const socketPath = path.join(tempDir, 'bridge.sock');
const broker = childProcess.spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'broker.js')], {
  env: {
    ...process.env,
    AGENT_CHROME_BRIDGE_LOG_DIR: tempDir,
    AGENT_CHROME_BRIDGE_SOCKET: socketPath,
  },
  stdio: ['ignore', 'ignore', 'pipe'],
});

let stderr = '';
broker.stderr.setEncoding('utf8');
broker.stderr.on('data', (chunk) => {
  stderr += chunk;
});

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForSocket() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (fs.existsSync(socketPath)) return;
    if (broker.exitCode !== null) throw new Error(`broker exited before listening: ${stderr}`);
    await delay(10);
  }
  throw new Error(`broker did not create its socket: ${stderr}`);
}

function connectClient() {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

function waitForExit(timeoutMs) {
  return Promise.race([
    new Promise((resolve) => {
      broker.once('exit', (code, signal) => resolve({ code, signal }));
    }),
    delay(timeoutMs).then(() => null),
  ]);
}

(async () => {
  let client = null;
  try {
    await waitForSocket();
    client = await connectClient();
    assert.equal(broker.kill('SIGTERM'), true);
    const exit = await waitForExit(2000);
    assert(exit, `broker did not exit with an open client: ${stderr}`);
    assert.equal(exit.code, 0);
    assert.equal(exit.signal, null);
    process.stdout.write('Broker shutdown OK\n');
  } finally {
    client?.destroy();
    if (broker.exitCode === null && broker.signalCode === null) broker.kill('SIGKILL');
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
})().catch((error) => {
  process.stderr.write(`Broker shutdown test failed: ${error.stack || error.message}\n`);
  process.exit(1);
});
