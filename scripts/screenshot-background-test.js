#!/usr/bin/env node
'use strict';

// chrome_screenshot of a background tab goes through CDP and leaves the
// window's active tab alone; the visible tab keeps captureVisibleTab.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const listener = () => ({ addListener() {}, removeListener() {} });

function loadWorker({ stall = false } = {}) {
  const calls = [];
  const timers = [];
  const tabs = [
    { id: 7, windowId: 3, active: true, title: 'Owner', url: 'https://example.test/owner', width: 800, height: 600 },
    { id: 8, windowId: 3, active: false, title: 'Agent', url: 'https://example.test/agent', width: 800, height: 600 },
  ];
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
      get: async (id) => tabs.find((tab) => tab.id === id),
      query: async () => tabs,
      update: async (id, props) => {
        calls.push(`tabs.update:${id}`);
        if (props.active) for (const tab of tabs) tab.active = tab.id === id;
        return tabs.find((tab) => tab.id === id);
      },
      captureVisibleTab: async (windowId) => {
        calls.push(`captureVisibleTab:${tabs.find((tab) => tab.windowId === windowId && tab.active).id}`);
        return 'data:image/jpeg;base64,VISIBLE';
      },
    },
    windows: { update: async () => calls.push('windows.update') },
    debugger: {
      onDetach: listener(),
      attach: async (target) => calls.push(`attach:${target.tabId}`),
      detach: async () => {},
      sendCommand: async (target, method, params) => {
        calls.push(`${method}:${target.tabId}:${JSON.stringify(params)}`);
        return stall ? new Promise(() => {}) : { data: 'HIDDEN' };
      },
    },
  };
  const context = {
    chrome,
    console,
    clearTimeout(timer) {
      if (timer) timer.cleared = true;
    },
    // Record long timers (capture timeout, idle detach) instead of waiting.
    setTimeout(callback, ms) {
      const timer = { callback, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
  };
  context.globalThis = context;
  vm.createContext(context);
  const worker = fs.readFileSync(path.join(__dirname, '..', 'extension', 'runtime-worker.js'), 'utf8');
  vm.runInContext(`${worker}\nglobalThis.__testDispatch = dispatch;`, context, { filename: 'runtime-worker.js' });
  return { dispatch: context.__testDispatch, calls, tabs, timers };
}

(async () => {
  {
    const { dispatch, calls, tabs } = loadWorker();
    const shot = await dispatch({ method: 'page.screenshot', params: { tabId: 8 } });
    assert.equal(shot.dataUrl, 'data:image/jpeg;base64,HIDDEN');
    assert.equal(shot.tab.id, 8);
    assert.deepEqual(calls, ['attach:8', 'Page.captureScreenshot:8:{"format":"jpeg","quality":70}']);
    assert.equal(tabs.find((tab) => tab.active).id, 7, 'the window active tab changed');
  }

  {
    const { dispatch, calls } = loadWorker();
    const shot = await dispatch({ method: 'page.screenshot', params: { tabId: 7 } });
    assert.equal(shot.dataUrl, 'data:image/jpeg;base64,VISIBLE');
    assert.deepEqual(calls, ['captureVisibleTab:7']);
  }

  {
    const { dispatch, tabs, timers } = loadWorker({ stall: true });
    const pending = dispatch({ method: 'page.screenshot', params: { tabId: 8 } });
    await new Promise((resolve) => setImmediate(resolve));
    timers.find((timer) => timer.ms === 10000).callback();
    await assert.rejects(pending, /background tab 8: Page\.captureScreenshot timed out\. chrome_snapshot/);
    assert.equal(tabs.find((tab) => tab.active).id, 7);
  }

  process.stdout.write('Screenshot background OK\n');
})().catch((error) => {
  process.stderr.write(`Screenshot background test failed: ${error.stack || error.message}\n`);
  process.exit(1);
});
