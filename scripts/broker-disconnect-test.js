#!/usr/bin/env node
'use strict';

// With no extension attached, the broker words its error by what it knows:
// the install hint only if the extension never connected, otherwise the last
// connected time, and "Chrome is not running" once the browser pid is gone.

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chrome-bridge-disconnect-'));
const socketPath = path.join(tempDir, 'bridge.sock');
const broker = childProcess.spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'broker.js')], {
  env: { ...process.env, AGENT_CHROME_BRIDGE_LOG_DIR: tempDir, AGENT_CHROME_BRIDGE_SOCKET: socketPath },
  stdio: ['ignore', 'ignore', 'pipe'],
});
let stderr = '';
broker.stderr.setEncoding('utf8');
broker.stderr.on('data', (chunk) => { stderr += chunk; });

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const INSTALL_HINT = /Load the extension/;

function connect() {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    socket.setEncoding('utf8');
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

async function waitForListener() {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const socket = await connect().catch(() => null);
    if (socket) return socket;
    if (broker.exitCode !== null) throw new Error(`broker exited early: ${stderr}`);
    await delay(10);
  }
  throw new Error(`broker never listened: ${stderr}`);
}

let nextId = 0;
function call(socket, method) {
  const id = `r${nextId += 1}`;
  return new Promise((resolve, reject) => {
    let buffer = '';
    const onData = (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop();
      const message = lines.filter((line) => line.trim()).map((line) => JSON.parse(line)).find((entry) => entry.id === id);
      if (!message) return;
      socket.off('data', onData);
      resolve(message);
    };
    socket.on('data', onData);
    socket.write(`${JSON.stringify({ type: 'request', id, method, params: {} })}\n`);
    setTimeout(() => reject(new Error(`timed out waiting for ${method}`)), 5000).unref();
  });
}

// Connect a fake extension host for the given browser pid, then drop it.
async function connectAndLeave(client, browserPid) {
  const extension = await connect();
  extension.write(`${JSON.stringify({ type: 'hello', role: 'extension-host', pid: 1, browserPid, version: 'test' })}\n`);
  for (let attempt = 0; attempt < 200 && !(await call(client, 'bridge.health')).result.extensionConnected; attempt += 1) await delay(10);
  extension.destroy();
  for (let attempt = 0; attempt < 200 && (await call(client, 'bridge.health')).result.extensionConnected; attempt += 1) await delay(10);
}

(async () => {
  let client = null;
  try {
    client = await waitForListener();

    // Never connected: the install hint.
    assert.match((await call(client, 'tabs.list')).error, INSTALL_HINT);

    // Connected once, browser still alive: name the time, no install hint.
    await connectAndLeave(client, process.pid);
    const afterLeave = (await call(client, 'tabs.list')).error;
    assert.match(afterLeave, /has not connected since \d{4}-\d\d-\d\dT[\d:.]+Z; Chrome may be closed/);
    assert.match(afterLeave, /do not relaunch/);
    assert.doesNotMatch(afterLeave, INSTALL_HINT);
    const health = (await call(client, 'bridge.health')).result;
    assert.equal(health.extensionError, afterLeave);
    assert.ok(health.lastExtensionHost.disconnectedAt);

    // The browser process is gone: say Chrome is not running.
    const browser = childProcess.spawn(process.execPath, ['-e', '']);
    await new Promise((resolve) => browser.once('exit', resolve));
    await connectAndLeave(client, browser.pid);
    const gone = (await call(client, 'tabs.list')).error;
    assert.match(gone, /^Chrome is not running; the extension was last connected at \d{4}-/);
    assert.doesNotMatch(gone, INSTALL_HINT);

    process.stdout.write('Broker disconnect OK\n');
  } finally {
    client?.destroy();
    if (broker.exitCode === null && broker.signalCode === null) broker.kill('SIGKILL');
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
})().catch((error) => {
  process.stderr.write(`Broker disconnect test failed: ${error.stack || error.message}\n`);
  process.exit(1);
});
