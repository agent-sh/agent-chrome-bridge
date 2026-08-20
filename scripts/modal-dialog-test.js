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
assert(getTool, 'chrome_get_dialog tool definition missing');
assert(handleTool, 'chrome_handle_dialog tool definition missing');
assert.deepEqual(handleTool.inputSchema.required, ['accept']);
assert.equal(handleTool.inputSchema.properties.accept.type, 'boolean');
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

function loadBackground({ dialogOnEnable = false, dialogOnClick = false } = {}) {
  const debuggerEvents = eventTarget();
  const debuggerDetach = eventTarget();
  const commands = [];
  const steps = [];
  const source = { tabId: 7 };
  const port = {
    onMessage: eventTarget(),
    onDisconnect: eventTarget(),
    postMessage() {},
  };
  const tab = {
    id: 7,
    windowId: 3,
    active: true,
    highlighted: true,
    pinned: false,
    audible: false,
    status: 'complete',
    title: 'Dialog fixture',
    url: 'https://example.test/dialog',
  };
  let resolveBlockedClick = null;

  const openDialog = () => {
    steps.push('dialog-open');
    debuggerEvents.emit(source, 'Page.javascriptDialogOpening', {
      type: 'prompt',
      message: 'Name?',
      defaultPrompt: 'Avi',
      url: tab.url,
      hasBrowserHandler: true,
    });
  };

  const chrome = {
    runtime: {
      id: 'test-extension',
      getManifest: () => ({
        manifest_version: 3,
        name: 'Agent Chrome Bridge',
        version: '0.7.1',
      }),
      connectNative: () => port,
      onInstalled: eventTarget(),
      onStartup: eventTarget(),
      lastError: null,
    },
    tabs: {
      get: async () => tab,
      query: async () => [tab],
    },
    windows: {
      update: async () => {},
    },
    scripting: {
      executeScript: async (options) => {
        if (options.files) {
          steps.push('content-injected');
          return [];
        }
        steps.push('content-action');
        if (!dialogOnClick) {
          return [{ frameId: 0, result: { clicked: true } }];
        }
        openDialog();
        return new Promise((resolve) => {
          resolveBlockedClick = () => resolve([{
            frameId: 0,
            result: { clicked: true, target: { selector: '#prompt' } },
          }]);
        });
      },
    },
    debugger: {
      onEvent: debuggerEvents,
      onDetach: debuggerDetach,
      attach: async () => {
        steps.push('debugger-attached');
      },
      detach: async () => {
        steps.push('debugger-detached');
      },
      sendCommand: async (target, method, params = {}) => {
        commands.push({ target, method, params });
        steps.push(method);
        if (method === 'Page.enable' && dialogOnEnable) openDialog();
        if (method === 'Page.handleJavaScriptDialog') {
          const dialogIsOpen = dialogOnEnable || dialogOnClick;
          if (!dialogIsOpen) throw new Error('No dialog is showing');
          debuggerEvents.emit(source, 'Page.javascriptDialogClosed', {
            result: params.accept,
            userInput: params.promptText || '',
          });
          resolveBlockedClick?.();
        }
      },
    },
  };

  const context = {
    chrome,
    clearTimeout,
    console,
    setTimeout,
  };
  context.globalThis = context;
  vm.createContext(context);
  const background = fs.readFileSync(path.join(__dirname, '..', 'extension', 'runtime-worker.js'), 'utf8');
  vm.runInContext(
    `${background}\nglobalThis.__testDispatch = dispatch;`,
    context,
    { filename: 'runtime-worker.js' },
  );
  return { commands, dispatch: context.__testDispatch, steps };
}

(async () => {
  {
    const { commands, dispatch, steps } = loadBackground({ dialogOnEnable: true });
    const result = await dispatch({
      method: 'cdp.getDialog',
      params: { tabId: 7, timeoutMs: 5 },
    });
    assert.equal(result.dialog.type, 'prompt');
    assert.equal(result.dialog.message, 'Name?');
    assert.equal(result.dialog.defaultPrompt, 'Avi');
    assert.equal(result.metadataObserved, true);
    assert.equal(commands.some((entry) => entry.method === 'Page.enable'), true);
    assert.equal(commands.some((entry) => entry.method === 'Page.handleJavaScriptDialog'), false);
    assert.equal(steps.includes('debugger-detached'), false);
  }

  {
    const { commands, dispatch } = loadBackground({ dialogOnEnable: true });
    const result = await dispatch({
      method: 'cdp.handleDialog',
      params: { tabId: 7, accept: true, promptText: 'Codex', timeoutMs: 5 },
    });
    const handle = commands.find((entry) => entry.method === 'Page.handleJavaScriptDialog');
    assert.equal(handle.params.accept, true);
    assert.equal(handle.params.promptText, 'Codex');
    assert.equal(result.handled, true);
    assert.equal(result.accepted, true);
    assert.equal(result.result.accepted, true);
    assert.equal(result.result.userInput, 'Codex');
  }

  {
    const { dispatch } = loadBackground();
    const result = await dispatch({
      method: 'cdp.getDialog',
      params: { tabId: 7, timeoutMs: 0 },
    });
    assert.equal(result.dialog, null);
    assert.equal(result.metadataObserved, false);
    assert.match(result.note, /monitoring remains active/i);
    await assert.rejects(
      dispatch({ method: 'cdp.handleDialog', params: { tabId: 7 } }),
      /accept must be true or false/,
    );
    await assert.rejects(
      dispatch({ method: 'cdp.handleDialog', params: { tabId: 7, accept: false, timeoutMs: 0 } }),
      /No dialog is showing/,
    );
  }

  {
    const { commands, dispatch, steps } = loadBackground({ dialogOnClick: true });
    const click = await dispatch({
      method: 'page.click',
      params: { tabId: 7, selector: '#prompt' },
    });
    assert.equal(click.dialogPending, true);
    assert.equal(click.completed, false);
    assert.equal(click.dialog.type, 'prompt');
    assert(steps.indexOf('Page.enable') < steps.indexOf('content-action'), 'Page domain was not enabled before click');

    const handled = await dispatch({
      method: 'cdp.handleDialog',
      params: { tabId: 7, accept: true, promptText: 'Live value', timeoutMs: 0 },
    });
    assert.equal(handled.handled, true);
    assert.equal(handled.result.userInput, 'Live value');
    assert.equal(commands.filter((entry) => entry.method === 'Page.enable').length, 1);
    assert.equal(steps.includes('debugger-detached'), false);
  }

  process.stdout.write('Modal dialog OK\n');
})().catch((error) => {
  process.stderr.write(`Modal dialog test failed: ${error.stack || error.message}\n`);
  process.exit(1);
});
