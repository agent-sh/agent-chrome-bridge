#!/usr/bin/env node
'use strict';

// A click that loads a new page unloads the content script before it can
// reply. The click reports navigated:true at once instead of waiting for the
// broker timeout; a click that stays on the page keeps its usual result.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SAVED = 'https://example.test/saved';

function eventTarget() {
  const listeners = new Set();
  return {
    addListener: (listener) => listeners.add(listener),
    removeListener: (listener) => listeners.delete(listener),
    emit: (details) => [...listeners].forEach((listener) => listener(details)),
  };
}

function loadWorker() {
  const nav = {
    onBeforeNavigate: eventTarget(),
    onCommitted: eventTarget(),
    onErrorOccurred: eventTarget(),
    onCreatedNavigationTarget: eventTarget(),
  };
  const tab = { id: 7, windowId: 3, active: true, status: 'complete', title: 'Edit', url: 'https://example.test/edit' };
  const reply = () => ({ clicked: true, target: { tag: 'button', text: 'Save' }, page: { url: tab.url, title: tab.title, modal: null } });
  let input = reply;
  const timers = [];
  // The tab starts loading /saved and commits it now, after commitMs, or
  // never (Infinity).
  const navigate = (commitMs = 0) => {
    nav.onBeforeNavigate.emit({ tabId: 7, frameId: 0, url: SAVED });
    const commit = () => {
      Object.assign(tab, { url: SAVED, title: 'Saved', status: 'loading' });
      nav.onCommitted.emit({ tabId: 7, frameId: 0, url: SAVED });
    };
    if (commitMs === Infinity) return;
    if (commitMs) setTimeout(commit, commitMs);
    else commit();
  };
  // Run a recorded long timer once the worker has set it.
  const fireTimer = async (ms) => {
    for (let tick = 0; tick < 100; tick += 1) {
      const timer = timers.find((entry) => entry.ms === ms && !entry.cleared);
      if (timer) return timer.callback();
      await new Promise((resolve) => setImmediate(resolve));
    }
    throw new Error(`the worker set no ${ms} ms timer`);
  };
  const chrome = {
    runtime: {
      id: 'test-extension',
      getManifest: () => ({ manifest_version: 3, name: 'Agent Chrome Bridge', version: '0.9.0' }),
      connectNative: () => ({ onMessage: eventTarget(), onDisconnect: eventTarget(), postMessage() {} }),
      onInstalled: eventTarget(),
      onStartup: eventTarget(),
      onMessage: eventTarget(),
      lastError: null,
    },
    tabs: {
      get: async () => ({ ...tab }),
      query: async () => [tab],
      onCreated: eventTarget(),
      onRemoved: eventTarget(),
      onUpdated: eventTarget(),
    },
    scripting: {
      executeScript: async (options) => (options.world === 'MAIN' ? [] : [{ frameId: 0, result: await input() }]),
    },
    debugger: {
      onDetach: eventTarget(),
      onEvent: eventTarget(),
      attach: async () => {},
      detach: async () => {},
      sendCommand: async (target, method, params) => {
        if (params.type === 'mouseReleased') input();
      },
    },
    webNavigation: nav,
  };
  const context = {
    chrome,
    console,
    clearInterval,
    setInterval,
    // Record long timers (load timeout, debugger idle detach) instead of
    // waiting for them.
    setTimeout(callback, ms) {
      if (ms < 1000) return setTimeout(callback, ms);
      const timer = { callback, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      if (timer?.callback) timer.cleared = true;
      else clearTimeout(timer);
    },
  };
  context.globalThis = context;
  vm.createContext(context);
  const worker = fs.readFileSync(path.join(__dirname, '..', 'extension', 'runtime-worker.js'), 'utf8');
  vm.runInContext(`${worker}\nglobalThis.__testDispatch = dispatch;`, context, { filename: 'runtime-worker.js' });
  return { dispatch: context.__testDispatch, navigate, fireTimer, setInput: (fn) => { input = fn; }, reply };
}

// The broker would wait 30 s; anything near that is the old hang.
function within2s(promise) {
  let timer;
  const limit = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('no reply within 2 s: the click waits for a page that unloaded')), 2000);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

const click = (worker) => within2s(worker.dispatch({ method: 'page.click', params: { tabId: 7, selector: '#save' } }));

(async () => {
  {
    // The new document commits and the old one never replies.
    const worker = loadWorker();
    worker.setInput(() => {
      worker.navigate();
      return new Promise(() => {});
    });
    const result = await click(worker);
    assert.equal(result.clicked, true);
    assert.equal(result.navigated, true);
    assert.equal(result.url, SAVED);
    assert.equal(result.tab.url, SAVED);
  }

  {
    // A slow server: the page replies first, the commit follows.
    const worker = loadWorker();
    worker.setInput(() => {
      worker.navigate(50);
      return worker.reply();
    });
    const result = await click(worker);
    assert.equal(result.navigated, true);
    assert.equal(result.url, SAVED);
    assert.equal(result.target, 'button "Save"');
  }

  {
    // The server is slower than the load timeout: nothing committed, so the
    // result must not claim the new page.
    const worker = loadWorker();
    worker.setInput(() => {
      worker.navigate(Infinity);
      return worker.reply();
    });
    const pending = click(worker);
    await worker.fireTimer(15000);
    const result = await pending;
    assert.equal(result.navigated, false);
    assert.equal(result.navigationPending, true);
    assert.equal(result.url, SAVED);
    assert.equal(result.target, 'button "Save"');
  }

  {
    // A click that fails while another page load starts reports its error.
    const worker = loadWorker();
    worker.setInput(() => {
      worker.navigate(Infinity);
      throw new Error('Target resolved to no element');
    });
    await assert.rejects(click(worker), /Target resolved to no element/);
  }

  {
    // A click that stays on the page keeps today's result.
    const result = await click(loadWorker());
    assert.equal(result.clicked, true);
    assert.equal(result.target, 'button "Save"');
    assert.equal(result.tab.url, 'https://example.test/edit');
    assert.equal(result.navigated, undefined);
  }

  {
    // A CDP click that loads a page reports it the same way.
    const worker = loadWorker();
    worker.setInput(() => worker.navigate(20));
    const result = await within2s(worker.dispatch({ method: 'cdp.click', params: { tabId: 7, x: 10, y: 20 } }));
    assert.equal(result.navigated, true);
    assert.equal(result.url, SAVED);
  }

  process.stdout.write('Click navigation OK\n');
})().catch((error) => {
  process.stderr.write(`Click navigation test failed: ${error.stack || error.message}\n`);
  process.exit(1);
});
