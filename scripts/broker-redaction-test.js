#!/usr/bin/env node
'use strict';

// Request params arrive from extension native-messaging JSON and are copied
// into request records through redactParams. The copy must redact secret-looking
// keys, drop prototype-pollution keys entirely, and never expose a mutated
// prototype, no matter what keys the untrusted payload carries.

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chrome-bridge-redaction-'));
const socketPath = path.join(tempDir, 'bridge.sock');
const env = { ...process.env, AGENT_CHROME_BRIDGE_LOG_DIR: tempDir, AGENT_CHROME_BRIDGE_SOCKET: socketPath };
const brokerJs = path.join(__dirname, '..', 'bin', 'broker.js');
const children = [];

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function spawnBroker() {
  const child = childProcess.spawn(process.execPath, [brokerJs], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderrText = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { child.stderrText += chunk; });
  children.push(child);
  return child;
}

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

function request(socket, pending, payload) {
  return new Promise((resolve, reject) => {
    pending.set(payload.id, { resolve, reject });
    socket.write(`${JSON.stringify(payload)}\n`);
    setTimeout(() => {
      if (pending.delete(payload.id)) reject(new Error(`timed out waiting for response ${payload.id}`));
    }, 5000).unref();
  });
}

(async () => {
  try {
    const broker = spawnBroker();
    await waitForListener(broker);

    // A fake extension host so the broker records and forwards the request.
    const extension = net.createConnection(socketPath);
    extension.setEncoding('utf8');
    const extensionSeen = [];
    let extensionBuffer = '';
    const extensionHello = new Promise((resolve, reject) => {
      extension.once('error', reject);
      extension.once('connect', () => {
        extension.write(`${JSON.stringify({ type: 'hello', role: 'extension-host', pid: 1, version: 'redaction-test' })}\n`);
        resolve();
      });
    });
    extension.on('data', (chunk) => {
      extensionBuffer += chunk;
      let index;
      while ((index = extensionBuffer.indexOf('\n')) !== -1) {
        const line = extensionBuffer.slice(0, index);
        extensionBuffer = extensionBuffer.slice(index + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        extensionSeen.push(message);
        if (message.id) {
          extension.write(`${JSON.stringify({ type: 'response', id: message.id, result: { ok: true } })}\n`);
        }
      }
    });
    await extensionHello;

    const socket = net.createConnection(socketPath);
    socket.setEncoding('utf8');
    const pending = new Map();
    let buffer = '';
    socket.on('data', (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        const waiter = pending.get(message.id);
        if (waiter) {
          pending.delete(message.id);
          waiter.resolve(message);
        }
      }
    });
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });

    // Built with JSON.parse so "__proto__" is an own data property, exactly
    // like a hostile native-messaging payload.
    const hostile = JSON.parse('{"password":"hunter2","api_token":"abc123","auth":{"cookie":"z"},"__proto__":{"evil":true},"constructor":{"danger":true},"prototype":1,"note":"keep","nested":{"password":"inner","count":2}}');
    hostile.items = [JSON.parse('{"__proto__":{"evil":true},"constructor":1,"prototype":2,"secret":{"value":"hidden"},"count":3}'), null, 'keep'];
    await request(socket, pending, { type: 'request', id: 'r1', method: 'test.redaction', params: hostile });
    const log = await request(socket, pending, { type: 'request', id: 'r2', method: 'bridge.log', params: { limit: 10 } });

    const recorded = (log.result.recentRequests || []).find((entry) => entry.id === 'r1');
    assert.ok(recorded, `redacted request must appear in recentRequests: ${JSON.stringify(log.result)}`);
    const params = recorded.params;

    assert.equal(params.password, '[redacted string length=7]');
    assert.equal(params.api_token, '[redacted string length=6]');
    assert.equal(params.auth.cookie, '[redacted string length=1]');
    assert.equal(params.nested.password, '[redacted string length=5]');
    assert.equal(params.nested.count, 2);
    assert.equal(params.note, 'keep');
    assert.deepEqual(params.items, [{ secret: '[redacted]', count: 3 }, null, 'keep']);

    assert.equal(Object.prototype.hasOwnProperty.call(params, '__proto__'), false, '__proto__ key must be dropped');
    assert.equal(Object.prototype.hasOwnProperty.call(params, 'constructor'), false, 'constructor key must be dropped');
    assert.equal(Object.prototype.hasOwnProperty.call(params, 'prototype'), false, 'prototype key must be dropped');
    assert.equal(params.evil, undefined, 'prototype pollution must not leak into the record');
    assert.equal(JSON.stringify(recorded.params).includes('__proto__'), false, 'dropped keys must not serialize');
    assert.equal(JSON.parse(JSON.stringify(params)).note, 'keep', 'redacted copy must stay JSON-serializable');

    const forwarded = extensionSeen.find((message) => message.id === 'r1');
    assert.ok(forwarded, 'request must be forwarded to the extension host');
    assert.equal(forwarded.params.password, 'hunter2', 'forwarding must keep raw params (redaction is log-only)');
    assert.deepEqual(forwarded.params, hostile, 'forwarding must preserve every raw key and nested value');

    socket.destroy();
    extension.destroy();
    broker.kill('SIGKILL');
    process.stdout.write('Broker redaction OK\n');
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
})().catch((error) => {
  process.stderr.write(`Broker redaction test failed: ${error.stack || error.message}\n`);
  process.exitCode = 1;
});
