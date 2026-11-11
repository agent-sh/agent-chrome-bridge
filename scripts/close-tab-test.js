#!/usr/bin/env node
'use strict';

// chrome_close_tab never closes the last tab of the last normal window:
// Chrome quits when its last window closes. It leaves a background blank
// tab there first, and changes nothing when other tabs are left.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const listener = () => ({ addListener() {}, removeListener() {} });

function loadWorker(tabs) {
  const calls = [];
  const windows = [{ id: 3, type: 'normal' }, { id: 5, type: 'popup' }, { id: 6, type: 'devtools' }];
  let nextId = 100;
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const chrome = {
    runtime: {
      id: 'test-extension',
      getManifest: () => ({ manifest_version: 3, name: 'Agent Chrome Bridge', version: '0.9.0' }),
      connectNative: () => ({ onMessage: listener(), onDisconnect: listener(), postMessage() {} }),
      onInstalled: listener(),
      onStartup: listener(),
      lastError: null,
    },
    tabs: {
      get: async (id) => {
        const tab = tabs.find((entry) => entry.id === id);
        if (!tab) throw new Error(`No tab with id: ${id}`);
        return { ...tab };
      },
      create: async (options) => {
        calls.push(`create:${JSON.stringify(options)}`);
        const tab = { id: nextId++, windowId: options.windowId, active: options.active, url: 'chrome://newtab/' };
        tabs.push(tab);
        return { ...tab };
      },
      remove: async (id) => {
        await tick();
        calls.push(`remove:${id}`);
        tabs.splice(tabs.findIndex((tab) => tab.id === id), 1);
      },
    },
    windows: {
      getAll: async ({ windowTypes = ['normal', 'popup'] } = {}) => {
        await tick();
        return windows
          .filter((win) => windowTypes.includes(win.type))
          .map((win) => ({ ...win, tabs: tabs.filter((tab) => tab.windowId === win.id) }))
          .filter((win) => win.tabs.length > 0);
      },
    },
  };
  const context = { chrome, console, setTimeout, clearTimeout };
  context.globalThis = context;
  vm.createContext(context);
  const worker = fs.readFileSync(path.join(__dirname, '..', 'extension', 'runtime-worker.js'), 'utf8');
  vm.runInContext(`${worker}\nglobalThis.__testDispatch = dispatch;`, context, { filename: 'runtime-worker.js' });
  const close = (tabId) => context.__testDispatch({ method: 'tabs.close', params: { tabId } });
  return { close, calls, tabs };
}

(async () => {
  {
    // Last tab of the last normal window (a popup and devtools are open too).
    const { close, calls, tabs } = loadWorker([
      { id: 8, windowId: 3, active: true, title: 'Agent', url: 'https://example.test/agent' },
      { id: 9, windowId: 5, active: true, title: 'Popup', url: 'https://example.test/popup' },
      { id: 10, windowId: 6, active: true, title: 'DevTools', url: 'devtools://devtools' },
    ]);
    const result = await close(8);
    assert.deepEqual(calls, ['create:{"windowId":3,"active":false}', 'remove:8']);
    assert.equal(result.blankTabId, 100);
    assert.match(result.notice, /blank new tab was left/);
    assert.deepEqual(tabs.filter((tab) => tab.windowId === 3).map((tab) => tab.id), [100]);
  }

  {
    // One of two tabs: plain close, no new tab.
    const { close, calls } = loadWorker([
      { id: 7, windowId: 3, active: true, title: 'Owner', url: 'https://example.test/owner' },
      { id: 8, windowId: 3, active: false, title: 'Agent', url: 'https://example.test/agent' },
    ]);
    const result = await close(8);
    assert.deepEqual(calls, ['remove:8']);
    assert.equal(result.blankTabId, undefined);
  }

  {
    // Two agents close the last two tabs at once: one blank tab is left.
    const { close, calls, tabs } = loadWorker([
      { id: 7, windowId: 3, active: true, title: 'A', url: 'https://example.test/a' },
      { id: 8, windowId: 3, active: false, title: 'B', url: 'https://example.test/b' },
    ]);
    await Promise.all([close(7), close(8)]);
    assert.deepEqual(calls, ['remove:7', 'create:{"windowId":3,"active":false}', 'remove:8']);
    assert.deepEqual(tabs.map((tab) => tab.id), [100]);
  }

  process.stdout.write('Close tab OK\n');
})().catch((error) => {
  process.stderr.write(`Close tab test failed: ${error.stack || error.message}\n`);
  process.exit(1);
});
