#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const {
  ROOT,
  HOST_NAME,
  HOST_SCRIPT,
  HOST_LAUNCHER,
  chromeHostDir,
  chromeHostManifestPath,
  launcherSource,
} = require('../lib/native-host-config');

const CHROME_HOST_DIR = chromeHostDir();
const HOST_MANIFEST = chromeHostManifestPath();
const EXTENSION_ID = childProcess.execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'extension-id.js')], {
  encoding: 'utf8',
}).trim();

const manifest = {
  name: HOST_NAME,
  description: 'Agent Chrome Bridge native messaging host',
  path: HOST_LAUNCHER,
  type: 'stdio',
  allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
};

fs.mkdirSync(CHROME_HOST_DIR, { recursive: true });
fs.writeFileSync(HOST_LAUNCHER, launcherSource(process.execPath), { mode: 0o755 });
fs.chmodSync(HOST_LAUNCHER, 0o755);
fs.chmodSync(HOST_SCRIPT, 0o755);
fs.chmodSync(path.join(ROOT, 'bin', 'mcp-server.js'), 0o755);
fs.chmodSync(path.join(ROOT, 'bin', 'broker.js'), 0o755);
fs.writeFileSync(HOST_MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`Registered Chrome native messaging host: ${HOST_MANIFEST}`);
console.log(`Native host launcher: ${HOST_LAUNCHER}`);
console.log(`Node executable for Chrome: ${process.execPath}`);
console.log(`Extension ID: ${EXTENSION_ID}`);
console.log(`Load unpacked extension from: ${path.join(ROOT, 'extension')}`);
