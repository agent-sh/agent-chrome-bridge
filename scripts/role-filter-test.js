#!/usr/bin/env node
'use strict';

// A role filter matches the element's implicit role, so `role: "button"` finds a native <button>.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'extension', 'content-bridge.js'), 'utf8');

function element(localName, text, attrs = {}, extra = {}) {
  return {
    localName,
    nodeType: 1,
    innerText: text,
    classList: [],
    parentElement: null,
    getAttribute: (name) => (name in attrs ? attrs[name] : null),
    getBoundingClientRect: () => ({ x: 1, y: 1, width: 80, height: 20, top: 1, bottom: 21, left: 1, right: 81 }),
    getRootNode: () => document,
    closest: () => null,
    ...extra,
  };
}

const nodes = [
  element('button', 'Connect device to tailnet'),
  element('a', 'Docs', {}, { href: 'https://example.test/docs' }),
  element('div', 'Custom', { role: 'button', tabindex: '0' }),
  element('input', 'Subscribe', { type: 'submit' }, { type: 'submit' }),
];
const document = { title: 't', readyState: 'complete', documentElement: {}, querySelectorAll: (s) => (s === '*' ? [] : nodes) };
document.body = { innerText: '', textContent: '', querySelectorAll: () => [], getRootNode: () => document };

const context = {
  CSS: { escape: String },
  Node: { ELEMENT_NODE: 1 },
  clearInterval,
  document,
  getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
  getSelection: () => '',
  innerHeight: 768,
  innerWidth: 1024,
  location: { href: 'https://example.test/' },
  MutationObserver: class { observe() {} disconnect() {} },
  scrollX: 0,
  scrollY: 0,
  setInterval,
};
context.globalThis = context;
context.window = context;
vm.runInNewContext(source, context, { filename: 'content-bridge.js' });
const bridge = context.__agentChromeBridge;

const texts = (options) => [...bridge.findElements(options).elements].map((e) => e.text);
assert.deepEqual(texts({ text: 'Connect device', role: 'button' }), ['Connect device to tailnet']);
assert.deepEqual(texts({ role: 'button' }), ['Connect device to tailnet', 'Custom', 'Subscribe']);
assert.deepEqual(texts({ role: 'link' }), ['Docs']);
// The snapshot names a native element by its tag, so the tag works as a role too.
assert.deepEqual(texts({ role: 'a' }), ['Docs']);

process.stdout.write('Role filter OK\n');
