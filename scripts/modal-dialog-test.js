#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const {
  DESTRUCTIVE_TOOLS,
  METHOD_BY_TOOL,
  MUTATING_TOOLS,
  TOOLS,
} = require('../lib/tool-registry');

const getTool = TOOLS.find((tool) => tool.name === 'chrome_get_dialog');
const handleTool = TOOLS.find((tool) => tool.name === 'chrome_handle_dialog');
const clickTool = TOOLS.find((tool) => tool.name === 'chrome_click');
assert(getTool, 'chrome_get_dialog tool definition missing');
assert(handleTool, 'chrome_handle_dialog tool definition missing');
assert.deepEqual(handleTool.inputSchema.required, ['accept']);
assert.equal(handleTool.inputSchema.properties.accept.type, 'boolean');
assert.deepEqual(clickTool.inputSchema.properties.onDialog.enum, ['accept', 'dismiss']);
assert.equal(METHOD_BY_TOOL.chrome_get_dialog, 'cdp.getDialog');
assert.equal(METHOD_BY_TOOL.chrome_handle_dialog, 'cdp.handleDialog');
assert.equal(MUTATING_TOOLS.has('chrome_get_dialog'), false);
assert.equal(MUTATING_TOOLS.has('chrome_handle_dialog'), true);
assert.equal(DESTRUCTIVE_TOOLS.has('chrome_handle_dialog'), true);

function eventTarget() {
  const listeners = new Set();
  return {
    addListener(listener) {
      listeners.add(listener);
    },
    removeListener(listener) {
      listeners.delete(listener);
    },
    emit(...args) {
      for (const listener of [...listeners]) listener(...args);
    },
  };
}

function loadWorker({ contentMissing = false } = {}) {
  const events = {
    debuggerEvent: eventTarget(),
    debuggerDetach: eventTarget(),
    message: eventTarget(),
    tabCreated: eventTarget(),
    tabRemoved: eventTarget(),
    tabUpdated: eventTarget(),
  };
  const steps = [];
  const scripts = [];
  const timers = [];
  let injected = !contentMissing;
  let onContentAction = null;
  const tab = {
    id: 7,
    windowId: 3,
    active: true,
    status: 'complete',
    title: 'Dialog fixture',
    url: 'https://example.test/dialog',
  };
  const port = {
    onMessage: eventTarget(),
    onDisconnect: eventTarget(),
    postMessage() {},
  };

  const hook = (entry) => events.message.emit(
    { type: 'agentChromeBridge.dialog', entry: { url: tab.url, at: Date.now(), ...entry } },
    { tab: { id: tab.id }, frameId: 0 },
  );

  const chrome = {
    runtime: {
      id: 'test-extension',
      getManifest: () => ({ manifest_version: 3, name: 'Agent Chrome Bridge', version: '0.8.0' }),
      connectNative: () => port,
      onInstalled: eventTarget(),
      onStartup: eventTarget(),
      onMessage: events.message,
      lastError: null,
    },
    tabs: {
      get: async (id) => {
        if (id !== tab.id) throw new Error(`No tab with id: ${id}.`);
        return tab;
      },
      remove: async () => {},
      query: async () => [tab],
      onCreated: events.tabCreated,
      onRemoved: events.tabRemoved,
      onUpdated: events.tabUpdated,
    },
    windows: { update: async () => {} },
    scripting: {
      executeScript: async (options) => {
        scripts.push(options);
        if (options.files) {
          steps.push(`inject:${options.files[0]}${options.world ? `@${options.world}` : ''}`);
          if (options.files[0] === 'content-bridge.js') injected = true;
          return [];
        }
        if (options.world === 'MAIN') {
          steps.push('arm');
          return [{ frameId: 0, result: null }];
        }
        if (!injected) return [{ frameId: 0, result: { __agentChromeBridgeMissing: true } }];
        const [method] = options.args;
        steps.push(`content:${method}`);
        if (onContentAction) await onContentAction(method, options.args);
        return [{
          frameId: 0,
          result: {
            clicked: true,
            target: { tag: 'button', text: 'Delete', selector: '#delete' },
            page: { url: tab.url, title: tab.title, modal: null },
          },
        }];
      },
    },
    debugger: {
      onEvent: events.debuggerEvent,
      onDetach: events.debuggerDetach,
      attach: async () => {
        steps.push('debugger-attached');
      },
      detach: async () => {
        steps.push('debugger-detached');
      },
      sendCommand: async (target, method, params = {}) => {
        steps.push(method);
        if (method === 'Page.handleJavaScriptDialog') {
          hook({ type: 'confirm', message: 'Delete?', phase: 'closed', accepted: params.accept, at: 1 });
        }
      },
    },
  };

  const context = {
    chrome,
    clearTimeout(timer) {
      if (timer) timer.cleared = true;
    },
    clearInterval,
    console,
    setInterval,
    // Record long timers (debugger idle detach) instead of waiting for them.
    setTimeout(callback, ms) {
      if (ms >= 1000) {
        const timer = { callback, ms, cleared: false };
        timers.push(timer);
        return timer;
      }
      return setTimeout(callback, ms);
    },
  };
  context.globalThis = context;
  vm.createContext(context);
  const worker = fs.readFileSync(path.join(__dirname, '..', 'extension', 'runtime-worker.js'), 'utf8');
  vm.runInContext(`${worker}\nglobalThis.__testDispatch = dispatch;`, context, { filename: 'runtime-worker.js' });
  return {
    dispatch: context.__testDispatch,
    events,
    hook,
    scripts,
    setContentAction(fn) {
      onContentAction = fn;
    },
    steps,
    tab,
    timers,
  };
}

const controlOf = (script) => JSON.parse(script.args[3] || script.args[1]);

(async () => {
  {
    // Loading the worker and reading pages must not attach the debugger:
    // that is what shows Chrome's "started debugging this browser" bar.
    const { dispatch, events, steps } = loadWorker();
    events.tabUpdated.emit(7, { status: 'loading', url: 'https://example.test/next' }, {});
    await dispatch({ method: 'page.snapshot', params: { tabId: 7 } });
    await dispatch({ method: 'page.click', params: { tabId: 7, selector: '#delete' } });
    assert.equal(steps.includes('debugger-attached'), false);
  }

  {
    // The page hook reports a native dialog; the agent sees it without CDP.
    const { dispatch, hook, steps, timers } = loadWorker();
    hook({ type: 'confirm', message: 'Delete?', phase: 'opening', at: 1 });
    const seen = await dispatch({ method: 'cdp.getDialog', params: { tabId: 7, timeoutMs: 0 } });
    assert.deepEqual({ ...seen.dialog }, { type: 'confirm', message: 'Delete?' });
    const tabs = await dispatch({ method: 'tabs.list', params: {} });
    assert.equal(tabs[0].dialogOpen, true);
    await assert.rejects(dispatch({ method: 'page.snapshot', params: { tabId: 7 } }), /confirm dialog is open/);
    assert.equal(steps.includes('debugger-attached'), false);

    const handled = await dispatch({ method: 'cdp.handleDialog', params: { tabId: 7, accept: true } });
    assert.equal(handled.handled, true);
    assert.equal(handled.accepted, true);
    assert(steps.indexOf('Page.enable') < steps.indexOf('Page.handleJavaScriptDialog'));
    const idle = timers.find((timer) => timer.ms === 15000 && !timer.cleared);
    assert(idle, 'debugger idle detach was not scheduled');
    await idle.callback();
    assert.equal(steps.includes('debugger-detached'), true);
    const after = await dispatch({ method: 'cdp.getDialog', params: { tabId: 7, timeoutMs: 0 } });
    assert.equal(after.dialog, null);
    assert.equal(after.notices, undefined, 'agent-handled dialog should not be reported twice');
  }

  {
    // With nothing open, handle_dialog arms the hook for the next dialog.
    const { dispatch, scripts, steps } = loadWorker();
    await assert.rejects(dispatch({ method: 'cdp.handleDialog', params: { tabId: 7 } }), /accept must be true or false/);
    const armed = await dispatch({ method: 'cdp.handleDialog', params: { tabId: 7, accept: true, promptText: 'Codex', timeoutMs: 0 } });
    assert.equal(armed.armed, true);
    assert.equal(armed.handled, false);
    const arm = scripts.find((script) => script.world === 'MAIN' && !script.files);
    assert.deepEqual(controlOf(arm).policy, { accept: true, once: true, promptText: 'Codex' });
    assert.equal(steps.includes('debugger-attached'), false);
  }

  {
    // Actions arm the hook in the same content call; dialogs the hook
    // answered and popup tabs show up as notices on the action result.
    const { dispatch, events, hook, scripts, setContentAction } = loadWorker();
    setContentAction(async (method) => {
      if (method !== 'clickTarget') return;
      hook({ type: 'confirm', message: 'Delete?', phase: 'auto', accepted: true, policy: 'explicit' });
      events.tabCreated.emit({ id: 9, windowId: 4, openerTabId: 7, pendingUrl: 'https://example.test/popup' });
    });
    const click = await dispatch({ method: 'page.click', params: { tabId: 7, selector: '#delete', onDialog: 'accept' } });
    const call = scripts.find((script) => script.args?.[0] === 'clickTarget');
    assert.deepEqual(JSON.parse(call.args[4]).policy, { accept: true });
    assert.equal(click.target, 'button "Delete"');
    assert.deepEqual([...click.notices.map((notice) => notice.kind)], ['dialog', 'popup']);
    assert.equal(click.notices[0].handled, 'accepted');
    assert.equal(click.notices[0].by, 'onDialog');
    assert.equal(click.notices[1].tabId, 9);
    setContentAction(null);
    const again = await dispatch({ method: 'page.click', params: { tabId: 7, selector: '#delete' } });
    assert.equal(again.notices, undefined, 'notices are delivered once');
    await assert.rejects(
      dispatch({ method: 'page.click', params: { tabId: 7, selector: '#delete', onDialog: 'maybe' } }),
      /onDialog must be/,
    );
  }

  {
    // A default-dismissed confirm carries a hint to retry with onDialog.
    const { dispatch, hook, setContentAction } = loadWorker();
    setContentAction(async () => hook({ type: 'confirm', message: 'Leave?', phase: 'auto', accepted: false, policy: 'default' }));
    const click = await dispatch({ method: 'page.click', params: { tabId: 7, selector: '#leave' } });
    assert.equal(click.notices[0].handled, 'dismissed');
    assert.match(click.notices[0].hint, /onDialog/);
  }

  {
    // A native dialog that blocks mid-action is reported instead of hanging.
    const { dispatch, hook, setContentAction } = loadWorker();
    setContentAction(() => {
      hook({ type: 'alert', message: 'Blocked', phase: 'opening', at: 2 });
      return new Promise(() => {});
    });
    const click = await dispatch({ method: 'page.click', params: { tabId: 7, selector: '#blocked' } });
    assert.equal(click.dialogPending, true);
    assert.equal(click.completed, false);
    assert.equal(click.dialog.message, 'Blocked');
  }

  {
    // CDP input attaches on demand and schedules an idle detach.
    const { dispatch, steps, timers } = loadWorker();
    const result = await dispatch({ method: 'cdp.click', params: { tabId: 7, x: 10, y: 20 } });
    assert.equal(result.clicked, true);
    assert(steps.includes('debugger-attached'));
    assert(steps.includes('arm'), 'CDP input should arm the dialog hook');
    assert(timers.some((timer) => timer.ms === 15000 && !timer.cleared));
  }

  {
    // Tabs opened before the extension loaded get the bridge injected once.
    const { dispatch, steps } = loadWorker({ contentMissing: true });
    await dispatch({ method: 'page.click', params: { tabId: 7, selector: '#delete' } });
    assert(steps.includes('inject:content-bridge.js'));
    assert(steps.includes('inject:page-hook.js@MAIN'));
    assert.equal(steps.filter((step) => step === 'content:clickTarget').length, 1);
  }

  {
    // A tab that closed itself (an auth popup) is already closed: chrome_close_tab succeeds.
    const { dispatch } = loadWorker();
    const gone = await dispatch({ method: 'tabs.close', params: { tabId: 99 } });
    assert.equal(gone.alreadyClosed, true);
    assert.equal(gone.tabId, 99);
  }

  process.stdout.write('Modal dialog OK\n');
})().catch((error) => {
  process.stderr.write(`Modal dialog test failed: ${error.stack || error.message}\n`);
  process.exit(1);
});
