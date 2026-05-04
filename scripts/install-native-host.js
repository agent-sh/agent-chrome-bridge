#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const HOST_NAME = 'dev.agent_chrome_bridge';
const HOST_SCRIPT = path.join(ROOT, 'bin', 'native-host.js');
const CHROME_HOST_DIR = path.join(os.homedir(), '.config', 'google-chrome', 'NativeMessagingHosts');
const HOST_MANIFEST = path.join(CHROME_HOST_DIR, `${HOST_NAME}.json`);
const EXTENSION_ID = childProcess.execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'extension-id.js')], {
  encoding: 'utf8',
}).trim();

const manifest = {
  name: HOST_NAME,
  description: 'Agent Chrome Bridge native messaging host',
  path: HOST_SCRIPT,
  type: 'stdio',
  allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
};

fs.mkdirSync(CHROME_HOST_DIR, { recursive: true });
fs.chmodSync(HOST_SCRIPT, 0o755);
fs.chmodSync(path.join(ROOT, 'bin', 'mcp-server.js'), 0o755);
fs.chmodSync(path.join(ROOT, 'bin', 'broker.js'), 0o755);
fs.writeFileSync(HOST_MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`Registered Chrome native messaging host: ${HOST_MANIFEST}`);
console.log(`Extension ID: ${EXTENSION_ID}`);
console.log(`Load unpacked extension from: ${path.join(ROOT, 'extension')}`);
