#!/usr/bin/env node
'use strict';

// chrome_screenshot of a tab that is not on screen goes through CDP and
// leaves the window and its active tab alone; the on-screen tab keeps
// captureVisibleTab.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const listener = () => ({ addListener() {}, removeListener() {} });
const CDP_CALL = (id) => `Page.captureScreenshot:${id}:{"format":"jpeg","quality":70}`;

function loadWorker({ stall = false, windowState = 'normal', onCapture = null } = {}) {
  const calls = [];
  const timers = [];
  const tabs = [
    { id: 7, windowId: 3, active: true, title: 'Owner', url: 'https://example.test/owner', width: 800, height: 600 },
    { id: 8, windowId: 3, active: false, title: 'Agent', url: 'https://example.test/agent', width: 800, height: 600 },
    { id: 9, windowId: 3, active: false, discarded: true, title: 'Old', url: 'https://example.test/old' },
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
      get: async (id) => ({ ...tabs.find((tab) => tab.id === id) }),
      query: async () => tabs,
      update: async (id) => calls.push(`tabs.update:${id}`),
      captureVisibleTab: async (windowId) => {
        calls.push(`captureVisibleTab:${tabs.find((tab) => tab.windowId === windowId && tab.active).id}`);
        if (windowState === 'minimized') throw new Error('image readback failed');
        onCapture?.(tabs);
        return 'data:image/jpeg;base64,VISIBLE';
      },
    },
    windows: {
      get: async (id) => ({ id, state: windowState }),
      update: async () => calls.push('windows.update'),
    },
    debugger: {
      onDetach: listener(),
      attach: async (target) => calls.push(`attach:${target.tabId}`),
      detach: async (target) => calls.push(`detach:${target.tabId}`),
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
  const shot = (tabId) => context.__testDispatch({ method: 'page.screenshot', params: { tabId } });
  return { shot, calls, tabs, timers };
}

(async () => {
  {
    // Background tab: CDP, and the owner's tab stays active.
    const { shot, calls, tabs } = loadWorker();
    const result = await shot(8);
    assert.equal(result.dataUrl, 'data:image/jpeg;base64,HIDDEN');
    assert.equal(result.tab.id, 8);
    assert.deepEqual(calls, ['attach:8', CDP_CALL(8)]);
    assert.equal(tabs.find((tab) => tab.active).id, 7, 'the window active tab changed');
  }

  {
    // On-screen tab: captureVisibleTab, no debugger.
    const { shot, calls } = loadWorker();
    assert.equal((await shot(7)).dataUrl, 'data:image/jpeg;base64,VISIBLE');
    assert.deepEqual(calls, ['captureVisibleTab:7']);
  }

  {
    // Active tab of a minimized window: CDP, nothing focused.
    const { shot, calls } = loadWorker({ windowState: 'minimized' });
    assert.equal((await shot(7)).dataUrl, 'data:image/jpeg;base64,HIDDEN');
    assert(calls.includes(CDP_CALL(7)));
    assert(!calls.some((call) => /update/.test(call)), `focused something: ${calls}`);
  }

  {
    // The owner switches tabs during captureVisibleTab: drop that image.
    const switchTo8 = (tabs) => tabs.forEach((tab) => { tab.active = tab.id === 8; });
    const { shot, calls } = loadWorker({ onCapture: switchTo8 });
    assert.equal((await shot(7)).dataUrl, 'data:image/jpeg;base64,HIDDEN');
    assert.deepEqual(calls, ['captureVisibleTab:7', 'attach:7', CDP_CALL(7)]);
  }

  {
    // Discarded tab: fail at once and point at chrome_reload.
    const { shot, calls } = loadWorker();
    await assert.rejects(shot(9), /Tab 9 is discarded.*chrome_reload/);
    assert.deepEqual(calls, []);
  }

  {
    // A stalled capture times out, and the debugger still detaches.
    const { shot, calls, tabs, timers } = loadWorker({ stall: true });
    const pending = shot(8);
    await new Promise((resolve) => setImmediate(resolve));
    timers.find((timer) => timer.ms === 10000).callback();
    await assert.rejects(pending, /background tab 8: Page\.captureScreenshot timed out\. chrome_snapshot/);
    assert.equal(tabs.find((tab) => tab.active).id, 7);
    const idle = timers.find((timer) => timer.ms === 15000 && !timer.cleared);
    assert(idle, 'debugger idle detach was not scheduled');
    await idle.callback();
    assert(calls.includes('detach:8'));
  }

  process.stdout.write('Screenshot background OK\n');
})().catch((error) => {
  process.stderr.write(`Screenshot background test failed: ${error.stack || error.message}\n`);
  process.exit(1);
});
