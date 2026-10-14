#!/usr/bin/env node
'use strict';

// End-to-end `agent-chrome-bridge setup` into a throwaway HOME: the runtime is
// copied, the host manifest points at a launcher inside the copy, and a
// re-run (upgrade) is idempotent. MCP registration is skipped.

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const cli = path.join(__dirname, '..', 'bin', 'cli.js');
// realpath: macOS tmpdir is behind the /var -> /private/var symlink.
const tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agent-chrome-bridge-cli-')));
const env = {
  ...process.env,
  HOME: tempDir,
  AGENT_CHROME_BRIDGE_HOME: path.join(tempDir, 'data'),
  AGENT_CHROME_BRIDGE_HOST_DIR: path.join(tempDir, 'hosts'),
};

function run(...args) {
  const result = childProcess.spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, `cli ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

try {
  const appDir = path.join(tempDir, 'data', 'app');
  const first = run('setup', '--no-mcp');
  assert.match(first, /Load unpacked/);

  for (const rel of ['bin/mcp-server.js', 'bin/native-host.js', 'bin/broker.js', 'lib/tool-registry.js', 'extension/manifest.json', 'scripts/doctor.js', 'package.json']) {
    assert.ok(fs.existsSync(path.join(appDir, rel)), `missing ${rel} in installed runtime`);
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(tempDir, 'hosts', 'dev.agent_chrome_bridge.json'), 'utf8'));
  const launcher = path.join(appDir, 'bin', 'native-host-launcher.sh');
  assert.equal(manifest.path, launcher);
  assert.deepEqual(manifest.allowed_origins, ['chrome-extension://pfcpgdlnhaagndelcbdpopojfgalmbkf/']);
  const launcherSource = fs.readFileSync(launcher, 'utf8');
  assert.ok(launcherSource.includes(path.join(appDir, 'bin', 'native-host.js')), launcherSource);
  assert.ok(launcherSource.includes(process.execPath), launcherSource);
  assert.ok(fs.statSync(launcher).mode & 0o111, 'launcher must be executable');

  const second = run('setup', '--no-mcp');
  assert.match(second, /reload/, 'a re-run should be treated as an upgrade');
  assert.equal(JSON.parse(fs.readFileSync(path.join(tempDir, 'hosts', 'dev.agent_chrome_bridge.json'), 'utf8')).path, launcher);
  assert.equal(fs.readdirSync(path.join(tempDir, 'data')).length, 1, 'no staging directories left behind');

  assert.match(run('where'), new RegExp(`extension: ${path.join(appDir, 'extension').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(run('--help'), /Usage: agent-chrome-bridge/);

  process.stdout.write('CLI setup OK\n');
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
