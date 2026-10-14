'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Pick a directory that's stable across processes started under different
// TMPDIRs. macOS gives each launchd-rooted process a per-session
// /var/folders/.../T/ TMPDIR, which means a Chrome-launched native-host
// and a tmux-launched mcp-server end up at *different* os.tmpdir()s and
// can't see each other's broker. Anchor under ~/.local/state instead.
function runtimeDir() {
  if (process.env.XDG_RUNTIME_DIR) return process.env.XDG_RUNTIME_DIR;
  if (typeof process.getuid === 'function') {
    const candidate = `/run/user/${process.getuid()}`;
    if (fs.existsSync(candidate)) return candidate;
  }
  const home = os.homedir();
  if (home) {
    const stateDir = path.join(home, '.local', 'state', 'agent-chrome-bridge');
    try {
      fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      return stateDir;
    } catch {
      // fall through
    }
  }
  return os.tmpdir();
}

function socketPath() {
  return process.env.AGENT_CHROME_BRIDGE_SOCKET
    || path.join(runtimeDir(), 'agent-chrome-bridge.sock');
}

module.exports = { socketPath };
