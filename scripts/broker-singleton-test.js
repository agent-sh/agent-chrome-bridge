#!/usr/bin/env node
'use strict';

// A second broker must yield to a live one instead of unlinking its socket,
// and a stale socket file (no listener) must be replaced.

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chrome-bridge-singleton-'));
const socketPath = path.join(tempDir, 'bridge.sock');
const env = { ...process.env, AGENT_CHROME_BRIDGE_LOG_DIR: tempDir, AGENT_CHROME_BRIDGE_SOCKET: socketPath };
const brokerJs = path.join(__dirname, '..', 'bin', 'broker.js');
const children = [];

function spawnBroker() {
  const child = childProcess.spawn(process.execPath, [brokerJs], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderrText = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { child.stderrText += chunk; });
  children.push(child);
  return child;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function connects() {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

async function waitForListener(child) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await connects()) return;
    if (child.exitCode !== null) throw new Error(`broker exited early: ${child.stderrText}`);
    await delay(10);
  }
  throw new Error(`broker never listened: ${child.stderrText}`);
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return Promise.race([
    new Promise((resolve) => child.once('exit', (code) => resolve(code))),
    delay(timeoutMs).then(() => null),
  ]);
}

(async () => {
  try {
    const first = spawnBroker();
    await waitForListener(first);

    const second = spawnBroker();
    assert.equal(await waitForExit(second, 3000), 0, `second broker should yield: ${second.stderrText}`);
    assert.equal(first.exitCode, null, 'first broker must keep running');
    assert.equal(await connects(), true, 'first broker socket must survive');

    first.kill('SIGKILL');
    await waitForExit(first, 2000);
    assert.equal(fs.existsSync(socketPath), true, 'SIGKILL leaves a stale socket file');

    const third = spawnBroker();
    await waitForListener(third);
    assert.equal(third.exitCode, null, 'broker must replace a stale socket');

    process.stdout.write('Broker singleton OK\n');
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
})().catch((error) => {
  process.stderr.write(`Broker singleton test failed: ${error.stack || error.message}\n`);
  process.exit(1);
});
