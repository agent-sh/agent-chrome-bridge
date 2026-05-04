#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { version: packageVersion } = require('../package.json');

const source = fs.readFileSync(path.join(__dirname, '..', 'extension', 'content-bridge.js'), 'utf8');
const bodyText = 'abcdef '.repeat(40).trim();
const document = {
  title: 'Options Test',
  readyState: 'complete',
  body: null,
  documentElement: { lang: 'en' },
  querySelectorAll: () => [],
};
document.body = {
  innerText: bodyText,
  textContent: bodyText,
  querySelectorAll: () => [],
  getRootNode: () => document,
};

const context = {
  CSS: { escape: String },
  Node: { ELEMENT_NODE: 1 },
  clearInterval,
  document,
  getSelection: () => '',
  innerHeight: 768,
  innerWidth: 1024,
  location: { href: 'https://example.test/options' },
  MutationObserver: class {
    observe() {}
    disconnect() {}
  },
  scrollX: 0,
  scrollY: 0,
  setInterval,
};
context.globalThis = context;
context.window = context;

vm.runInNewContext(source, context, { filename: 'content-bridge.js' });

const bridge = context.__agentChromeBridge;
assert.equal(bridge.version, packageVersion);
assert.equal(bridge.bridgeInfo().version, packageVersion);
assert.equal(bridge.bridgeInfo().url, 'https://example.test/options');
assert.equal(bridge.snapshotPage({ maxText: 0 }).text, '');
assert.equal(bridge.snapshotPage({ maxText: 6 }).text, bodyText.slice(0, 6));
assert.equal(bridge.snapshotPage({ maxText: undefined }).text, bodyText);
assert.equal(bridge.readArticle({ maxText: 0 }).text, '');
assert.equal(bridge.readArticle({ maxText: 6 }).text, bodyText.slice(0, 6));
assert.equal(bridge.readArticle({ maxText: 0 }).textLength, bodyText.length);

process.stdout.write('Content options OK\n');
