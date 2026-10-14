#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { HOST_SCRIPT, chromeHostDir, chromeHostManifestPath, launcherSource } = require('../lib/native-host-config');

const home = '/home/tester';

assert.equal(
  chromeHostDir({ platform: 'linux', home, env: {} }),
  path.join(home, '.config', 'google-chrome', 'NativeMessagingHosts'),
);
assert.equal(
  chromeHostDir({ platform: 'darwin', home, env: {} }),
  path.join(home, 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts'),
);
assert.equal(chromeHostDir({ platform: 'linux', home, env: { AGENT_CHROME_BRIDGE_HOST_DIR: '/custom' } }), '/custom');
assert.throws(() => chromeHostDir({ platform: 'win32', home, env: {} }), /Unsupported/);
assert.equal(
  chromeHostManifestPath({ platform: 'linux', home, env: {} }),
  path.join(home, '.config', 'google-chrome', 'NativeMessagingHosts', 'dev.agent_chrome_bridge.json'),
);

// Paths with spaces/quotes must survive the generated sh launcher.
const source = launcherSource("/opt/my node/it's/node");
assert.match(source, /^#!\/bin\/sh\n/);
assert.ok(source.includes(`exec '/opt/my node/it'\\''s/node' '${HOST_SCRIPT}' "$@"`), source);

process.stdout.write('Native host config OK\n');
