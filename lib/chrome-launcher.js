'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Built-in candidate binaries per platform. Order matters: the first match
 * on PATH (linux) or on disk (darwin/win32) wins. Callers can override with
 * an explicit `binary` argument.
 */
const DEFAULT_CANDIDATES = {
  linux: [
    'google-chrome',
    'google-chrome-stable',
    'chromium',
    'chromium-browser',
    'brave-browser',
    'microsoft-edge',
  ],
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ],
  win32: [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe',
  ],
};

const DEFAULT_LAUNCH_ARGS = ['--restore-last-session'];
const LINUX_SESSION_ENV_KEYS = [
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XAUTHORITY',
  'XDG_RUNTIME_DIR',
  'XDG_SESSION_TYPE',
  'DBUS_SESSION_BUS_ADDRESS',
];

/**
 * Recover desktop-session variables that may be absent from an agent or
 * service process. systemd's user manager carries the environment used to
 * start desktop applications.
 *
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {string} [options.platform]
 * @param {typeof childProcess.execFileSync} [options.exec]
 * @param {() => number} [options.getuid]
 * @param {(p: string) => boolean} [options.exists]
 * @returns {NodeJS.ProcessEnv}
 */
function buildLaunchEnvironment(options = {}) {
  const baseEnv = options.env || process.env;
  const result = { ...baseEnv };
  const platform = options.platform || process.platform;
  if (platform !== 'linux') return result;

  const exec = options.exec || childProcess.execFileSync;
  const getuid = options.getuid || process.getuid;
  const exists = options.exists || fs.existsSync;

  let runtimeDir = result.XDG_RUNTIME_DIR;
  if (!runtimeDir && typeof getuid === 'function') {
    const candidate = `/run/user/${getuid()}`;
    if (exists(candidate)) runtimeDir = candidate;
  }

  const probeEnv = { ...baseEnv };
  if (runtimeDir) {
    probeEnv.XDG_RUNTIME_DIR = runtimeDir;
    const busPath = path.join(runtimeDir, 'bus');
    if (!probeEnv.DBUS_SESSION_BUS_ADDRESS && exists(busPath)) {
      probeEnv.DBUS_SESSION_BUS_ADDRESS = `unix:path=${busPath}`;
    }
  }

  try {
    const output = exec('systemctl', ['--user', 'show-environment'], {
      encoding: 'utf8',
      env: probeEnv,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    });
    const allowed = new Set(LINUX_SESSION_ENV_KEYS);
    for (const line of String(output).split(/\r?\n/)) {
      const separator = line.indexOf('=');
      if (separator <= 0) continue;
      const key = line.slice(0, separator);
      if (!allowed.has(key) || result[key]) continue;
      result[key] = line.slice(separator + 1);
    }
  } catch {
    // A headless host may not have a user manager or graphical session.
  }

  if (!result.XDG_RUNTIME_DIR && runtimeDir) result.XDG_RUNTIME_DIR = runtimeDir;
  if (!result.DBUS_SESSION_BUS_ADDRESS && probeEnv.DBUS_SESSION_BUS_ADDRESS) {
    result.DBUS_SESSION_BUS_ADDRESS = probeEnv.DBUS_SESSION_BUS_ADDRESS;
  }
  return result;
}

/**
 * Resolve a binary name against PATH using the OS `which` / `where` command.
 * Returns the absolute path or null if not found. Synchronous to keep the
 * detection logic simple and easy to unit-test.
 *
 * @param {string} name
 * @param {{ platform?: string, exec?: typeof childProcess.execFileSync }} [deps]
 * @returns {string|null}
 */
function whichSync(name, deps = {}) {
  const platform = deps.platform || process.platform;
  const exec = deps.exec || childProcess.execFileSync;
  const cmd = platform === 'win32' ? 'where' : 'which';
  try {
    const out = exec(cmd, [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const first = String(out).split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0];
    return first || null;
  } catch {
    return null;
  }
}

/**
 * Resolve a Chromium-family browser binary.
 *
 * @param {object} [options]
 * @param {string} [options.binary] explicit override; returned as-is if it exists.
 * @param {string[]} [options.candidates] override candidate list (mostly for tests).
 * @param {string} [options.platform] override `process.platform` (mostly for tests).
 * @param {(p: string) => boolean} [options.exists] file-exists probe (mostly for tests).
 * @param {(name: string) => string|null} [options.which] PATH lookup (mostly for tests).
 * @returns {{ binary: string|null, tried: string[] }}
 */
function detectBinary(options = {}) {
  const platform = options.platform || process.platform;
  const exists = options.exists || ((p) => {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
  const which = options.which || ((name) => whichSync(name, { platform }));
  const candidates = options.candidates
    || DEFAULT_CANDIDATES[platform]
    || DEFAULT_CANDIDATES.linux;

  if (options.binary) {
    if (path.isAbsolute(options.binary) || options.binary.includes('/') || options.binary.includes('\\')) {
      return exists(options.binary)
        ? { binary: options.binary, tried: [options.binary] }
        : { binary: null, tried: [options.binary] };
    }
    const resolved = which(options.binary);
    return { binary: resolved, tried: [options.binary] };
  }

  const tried = [];
  for (const candidate of candidates) {
    tried.push(candidate);
    if (path.isAbsolute(candidate) || candidate.includes('/') || candidate.includes('\\')) {
      if (exists(candidate)) return { binary: candidate, tried };
    } else {
      const resolved = which(candidate);
      if (resolved) return { binary: resolved, tried };
    }
  }
  return { binary: null, tried };
}

/**
 * Spawn the resolved browser binary detached so it outlives the MCP server.
 *
 * @param {string} binary
 * @param {string[]} args
 * @param {{
 *   spawn?: typeof childProcess.spawn,
 *   env?: NodeJS.ProcessEnv,
 *   platform?: string,
 *   exec?: typeof childProcess.execFileSync,
 *   getuid?: () => number,
 *   exists?: (p: string) => boolean
 * }} [deps]
 * @returns {{ pid: number|null, error: Error|null }}
 */
function spawnDetached(binary, args, deps = {}) {
  const spawn = deps.spawn || childProcess.spawn;
  try {
    const env = buildLaunchEnvironment(deps);
    const child = spawn(binary, args, { detached: true, stdio: 'ignore', env });
    if (child && typeof child.unref === 'function') child.unref();
    return { pid: child?.pid || null, error: null };
  } catch (error) {
    return { pid: null, error };
  }
}

/**
 * Poll `isConnected` every `intervalMs` until it returns truthy or the
 * timeout elapses.
 *
 * @param {() => Promise<boolean>|boolean} isConnected
 * @param {{ timeoutMs?: number, intervalMs?: number, now?: () => number, sleep?: (ms: number) => Promise<void> }} [options]
 * @returns {Promise<{ connected: boolean, waitedMs: number }>}
 */
async function pollUntilConnected(isConnected, options = {}) {
  const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : 15000;
  const intervalMs = Number.isFinite(options.intervalMs) ? options.intervalMs : 250;
  const now = options.now || (() => Number(process.hrtime.bigint() / 1000000n));
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  const start = now();
  // Try once before the first sleep so a fast connect returns immediately.
  if (await isConnected()) return { connected: true, waitedMs: 0 };
  for (;;) {
    const elapsed = now() - start;
    if (elapsed >= timeoutMs) return { connected: false, waitedMs: elapsed };
    const remaining = timeoutMs - elapsed;
    await sleep(Math.min(intervalMs, remaining));
    if (await isConnected()) return { connected: true, waitedMs: now() - start };
  }
}

module.exports = {
  DEFAULT_CANDIDATES,
  DEFAULT_LAUNCH_ARGS,
  LINUX_SESSION_ENV_KEYS,
  buildLaunchEnvironment,
  detectBinary,
  pollUntilConnected,
  spawnDetached,
  whichSync,
};
