#!/usr/bin/env node
'use strict';

// Focused test for chrome_cdp_key modifier support.
//
// extension/runtime-worker.js depends on chrome.* globals and can't be required in
// plain Node, so we validate two things:
//   1. The MCP tool registry exposes the new `modifiers` and `modifierKeys`
//      params on chrome_cdp_key with correct types.
//   2. The service worker source wires a modifier-bearing event descriptor into
//      the dispatchKeyEvent calls and uses the documented Slack/CDP bitmask
//      (Alt=1, Ctrl=2, Meta=4, Shift=8) plus common aliases.
//   3. The resolver function works: we extract resolveCdpModifiers from the
//      source and exercise it in a sandbox with representative inputs.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const { TOOLS } = require('../lib/tool-registry');

function fail(msg) {
  process.stderr.write(`cdp-key-modifiers-test FAIL: ${msg}\n`);
  process.exit(1);
}

function assert(cond, msg) {
  if (!cond) fail(msg);
}

// 1. Schema check.
const tool = TOOLS.find((t) => t.name === 'chrome_cdp_key');
assert(tool, 'chrome_cdp_key tool definition missing');
const props = tool.inputSchema && tool.inputSchema.properties;
assert(props, 'chrome_cdp_key inputSchema.properties missing');
assert(props.modifiers && props.modifiers.type === 'number', 'modifiers (number) param missing on chrome_cdp_key');
assert(
  props.modifierKeys && props.modifierKeys.type === 'array' && props.modifierKeys.items && props.modifierKeys.items.type === 'string',
  'modifierKeys (string array) param missing on chrome_cdp_key',
);
assert(/modifier/i.test(tool.description), 'chrome_cdp_key description does not mention modifiers');

// 2. Service worker source wiring check.
const bgPath = path.join(__dirname, '..', 'extension', 'runtime-worker.js');
const bgSrc = fs.readFileSync(bgPath, 'utf8');
assert(/CDP_MODIFIER_BITS\s*=\s*{[^}]*alt:\s*1[^}]*ctrl:\s*2[^}]*meta:\s*4[^}]*shift:\s*8/s.test(bgSrc), 'CDP_MODIFIER_BITS table missing or wrong bit values');
assert(/const event = \{ key, code, modifiers \}/.test(bgSrc), 'CDP key event descriptor does not include modifiers');
const dispatchCalls = bgSrc.match(/Input\.dispatchKeyEvent', \{ \.\.\.descriptor\.event/g) || [];
assert(dispatchCalls.length >= 2, `expected the modifier-bearing descriptor on rawKeyDown and keyUp, found ${dispatchCalls.length} calls`);

// 3. Functional resolver check via a tiny sandbox.
const resolverMatch = bgSrc.match(/const CDP_MODIFIER_BITS[\s\S]*?function resolveCdpModifiers\([\s\S]*?\n\}\n/);
assert(resolverMatch, 'could not extract resolveCdpModifiers from runtime-worker.js');
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(`${resolverMatch[0]}\nthis.resolveCdpModifiers = resolveCdpModifiers;`, sandbox);
const resolve = sandbox.resolveCdpModifiers;

assert(resolve({}) === 0, 'empty params should resolve to 0');
assert(resolve({ modifiers: 0 }) === 0, 'modifiers=0 should resolve to 0');
assert(resolve({ modifiers: 2 }) === 2, 'numeric modifiers=2 (Ctrl) should pass through');
assert(resolve({ modifierKeys: ['ctrl'] }) === 2, 'modifierKeys=["ctrl"] should be 2');
assert(resolve({ modifierKeys: ['Ctrl'] }) === 2, 'modifierKeys are case-insensitive');
assert(resolve({ modifierKeys: ['cmd'] }) === 4, 'cmd alias should be Meta=4');
assert(resolve({ modifierKeys: ['meta'] }) === 4, 'meta should be 4');
assert(resolve({ modifierKeys: ['shift'] }) === 8, 'shift should be 8');
assert(resolve({ modifierKeys: ['ctrl', 'shift'] }) === 10, 'ctrl+shift should be 2|8=10');
assert(resolve({ modifiers: 2, modifierKeys: ['shift'] }) === 10, 'modifiers and modifierKeys should OR-combine');
assert(resolve({ modifierKeys: ['alt', 'ctrl', 'meta', 'shift'] }) === 15, 'all four modifiers should be 15');

let threw = false;
try { resolve({ modifierKeys: ['fn'] }); } catch (_) { threw = true; }
assert(threw, 'unknown modifier should throw');

threw = false;
try { resolve({ modifiers: -1 }); } catch (_) { threw = true; }
assert(threw, 'negative modifiers should throw');

process.stdout.write('cdp-key-modifiers OK: schema + bg wiring + resolver bits validated\n');
