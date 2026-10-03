#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'extension', 'page-hook.js'), 'utf8');

function load() {
  const listeners = new Map();
  const reports = [];
  const nativeCalls = [];
  const document = {
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    dispatchEvent(event) {
      if (event.type === '__agent_chrome_bridge_dialog') reports.push(JSON.parse(event.detail));
      listeners.get(event.type)?.(event);
      return true;
    },
  };
  const window = {
    alert: (message) => nativeCalls.push(['alert', message]),
    confirm: (message) => {
      nativeCalls.push(['confirm', message]);
      return true;
    },
    prompt: (message) => {
      nativeCalls.push(['prompt', message]);
      return 'typed';
    },
    open: () => null,
  };
  const context = {
    CustomEvent: class {
      constructor(type, init) {
        this.type = type;
        this.detail = init.detail;
      }
    },
    Date,
    URL,
    document,
    location: { href: 'https://example.test/page' },
    window,
  };
  vm.runInNewContext(source, context, { filename: 'page-hook.js' });
  const control = (value) => document.dispatchEvent({ type: '__agent_chrome_bridge_control', detail: JSON.stringify(value) });
  return { control, nativeCalls, reports, window };
}

{
  // Outside an agent window the native dialog runs and is reported around it.
  const { nativeCalls, reports, window } = load();
  assert.equal(window.confirm('Delete?'), true);
  assert.deepEqual(nativeCalls, [['confirm', 'Delete?']]);
  assert.deepEqual(reports.map((entry) => entry.phase), ['opening', 'closed']);
  assert.equal(reports[1].accepted, true);
  assert.equal(String(window.confirm), 'function confirm() { [native code] }');
}

{
  // Inside an agent window: no native dialog, safe defaults, reported.
  const { control, nativeCalls, reports, window } = load();
  control({ windowMs: 5000, policy: null });
  assert.equal(window.alert('Saved'), undefined);
  assert.equal(window.confirm('Delete?'), false);
  assert.equal(window.prompt('Name?', 'Avi'), null);
  assert.deepEqual(nativeCalls, []);
  assert.deepEqual(reports.map((entry) => [entry.type, entry.phase, entry.accepted, entry.policy]), [
    ['alert', 'auto', true, 'default'],
    ['confirm', 'auto', false, 'default'],
    ['prompt', 'auto', false, 'default'],
  ]);
}

{
  // An explicit policy answers; a once-policy falls back to defaults after.
  const { control, reports, window } = load();
  control({ windowMs: 5000, policy: { accept: true, promptText: 'Zed', once: true } });
  assert.equal(window.prompt('Name?', 'Avi'), 'Zed');
  assert.equal(reports[0].userInput, 'Zed');
  assert.equal(window.confirm('Again?'), false);
  control({ windowMs: 5000, policy: { accept: true } });
  assert.equal(window.prompt('Name?', 'Avi'), 'Avi');
  assert.equal(window.confirm('Sure?'), true);
}

{
  // Blocked popups are reported; an expired window shows natives again.
  const { control, nativeCalls, reports, window } = load();
  assert.equal(window.open('/next'), null);
  assert.deepEqual([reports[0].phase, reports[0].url], ['blocked', 'https://example.test/next']);
  control({ windowMs: 0, policy: null });
  window.alert('hi');
  assert.deepEqual(nativeCalls, [['alert', 'hi']]);
}

process.stdout.write('Page hook OK\n');
