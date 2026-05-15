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
 * @param {{ spawn?: typeof childProcess.spawn }} [deps]
 * @returns {{ pid: number|null, error: Error|null }}
 */
function spawnDetached(binary, args, deps = {}) {
  const spawn = deps.spawn || childProcess.spawn;
  try {
    const child = spawn(binary, args, { detached: true, stdio: 'ignore' });
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
  const now = options.now || (() => Date.now());
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
  detectBinary,
  pollUntilConnected,
  spawnDetached,
  whichSync,
};
