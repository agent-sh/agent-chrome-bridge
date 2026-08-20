#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.writes = [];
  }

  write(value) {
    this.writes.push(value);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.emit('close');
  }
}

const sockets = [];
const spawned = [];
const timers = [];
const stdin = new EventEmitter();
const stdout = { write() {} };
const stderr = { write() {} };

const fakeProcess = {
  env: {},
  execPath: '/usr/bin/node',
  exit(code) {
    throw new Error(`unexpected process.exit(${code})`);
  },
  pid: 1234,
  stdin,
  stdout,
  stderr,
};

const fakeRequire = (specifier) => {
  switch (specifier) {
    case 'node:child_process':
      return {
        spawn(binary, args, options) {
          spawned.push({ binary, args, options });
          return { unref() {} };
        },
      };
    case 'node:fs':
      return {
        appendFileSync() {},
        mkdirSync() {},
      };
    case 'node:net':
      return {
        createConnection() {
          const socket = new FakeSocket();
          sockets.push(socket);
          return socket;
        },
      };
    case 'node:os':
      return { homedir: () => '/home/test' };
    case 'node:path':
      return path;
    case '../lib/socket-path':
      return { socketPath: () => '/tmp/agent-chrome-bridge-test.sock' };
    case '../package.json':
      return { version: '0.7.1' };
    default:
      throw new Error(`unexpected require: ${specifier}`);
  }
};

const context = {
  __dirname: path.join(__dirname, '..', 'bin'),
  Buffer,
  console,
  process: fakeProcess,
  require: fakeRequire,
  setTimeout(callback, delayMs) {
    const timer = { callback, delayMs };
    timers.push(timer);
    return timer;
  },
};
context.globalThis = context;
vm.createContext(context);
const source = fs.readFileSync(path.join(__dirname, '..', 'bin', 'native-host.js'), 'utf8');
vm.runInContext(source, context, { filename: 'native-host.js' });

assert.equal(sockets.length, 1, 'native host should connect immediately');

const first = sockets[0];
const refused = new Error('connection refused');
refused.code = 'ECONNREFUSED';
first.emit('error', refused);
assert.equal(spawned.length, 1, 'first refusal should start a broker');
assert.equal(timers.length, 1, 'first refusal should schedule one reconnect');

timers.shift().callback();
assert.equal(sockets.length, 2);
const second = sockets[1];
second.emit('connect');
assert.match(second.writes[0], /"role":"extension-host"/);

second.emit('close');
assert.equal(timers.length, 1, 'established broker close should schedule a reconnect');
assert.equal(timers[0].delayMs, 100);

timers.shift().callback();
assert.equal(sockets.length, 3);
const third = sockets[2];
third.emit('error', refused);
assert.equal(spawned.length, 2, 'reconnect refusal should replace the dead broker');
assert.equal(timers.length, 1);

timers.shift().callback();
const fourth = sockets[3];
fourth.emit('connect');
assert.match(fourth.writes[0], /"version":"0.7.1"/);

process.stdout.write('Native host reconnect OK\n');
