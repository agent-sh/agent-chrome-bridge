'use strict';

const os = require('node:os');
const path = require('node:path');

// `setup` copies the runtime here so Chrome's unpacked-extension path, the
// native host launcher and MCP registrations survive npx cache eviction,
// global reinstalls and node version switches.
function appHome({ env = process.env, home = os.homedir() } = {}) {
  if (env.AGENT_CHROME_BRIDGE_HOME) return env.AGENT_CHROME_BRIDGE_HOME;
  const dataHome = env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  return path.join(dataHome, 'agent-chrome-bridge');
}

function appDir(options) {
  return path.join(appHome(options), 'app');
}

// Everything the installed runtime needs; mirrors package.json "files".
const APP_FILES = [
  'bin',
  'lib',
  'extension',
  'scripts/install-native-host.js',
  'scripts/install-mcp.js',
  'scripts/extension-id.js',
  'scripts/doctor.js',
  'package.json',
  'LICENSE',
  'README.md',
];

module.exports = { appHome, appDir, APP_FILES };
