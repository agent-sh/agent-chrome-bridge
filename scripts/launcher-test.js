#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');

const launcherPath = require.resolve('../lib/chrome-launcher');
const brokerClientPath = require.resolve('../lib/broker-client');

const {
  buildLaunchEnvironment,
  detectBinary,
  pollUntilConnected,
  spawnDetached,
} = require('../lib/chrome-launcher');
const { MUTATING_TOOLS } = require('../lib/tool-registry');

assert.equal(MUTATING_TOOLS.has('chrome_launch'), true, 'read-only mode must refuse chrome_launch');

async function testDetectBinary() {
  // Linux: first PATH match wins, later candidates not probed.
  {
    const calls = [];
    const result = detectBinary({
      platform: 'linux',
      candidates: ['google-chrome', 'chromium', 'brave-browser'],
      which: (name) => {
        calls.push(name);
        return name === 'chromium' ? '/usr/bin/chromium' : null;
      },
      exists: () => false,
    });
    assert.equal(result.binary, '/usr/bin/chromium');
    assert.deepEqual(result.tried, ['google-chrome', 'chromium']);
    assert.deepEqual(calls, ['google-chrome', 'chromium']);
  }

  // Linux: nothing found -> binary null, tried list returned.
  {
    const result = detectBinary({
      platform: 'linux',
      candidates: ['google-chrome', 'chromium'],
      which: () => null,
      exists: () => false,
    });
    assert.equal(result.binary, null);
    assert.deepEqual(result.tried, ['google-chrome', 'chromium']);
  }

  // darwin: absolute paths probed via exists().
  {
    const probed = [];
    const result = detectBinary({
      platform: 'darwin',
      candidates: [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
      ],
      which: () => { throw new Error('which should not be called for absolute paths'); },
      exists: (p) => {
        probed.push(p);
        return p.includes('Chromium');
      },
    });
    assert.equal(result.binary, '/Applications/Chromium.app/Contents/MacOS/Chromium');
    assert.equal(probed.length, 2);
  }

  // Override binary (absolute, exists).
  {
    const result = detectBinary({
      binary: '/opt/custom/chrome',
      exists: (p) => p === '/opt/custom/chrome',
      which: () => null,
    });
    assert.equal(result.binary, '/opt/custom/chrome');
  }

  // Override binary (absolute, missing).
  {
    const result = detectBinary({
      binary: '/opt/custom/chrome',
      exists: () => false,
      which: () => null,
    });
    assert.equal(result.binary, null);
    assert.deepEqual(result.tried, ['/opt/custom/chrome']);
  }

  // Override binary (bare name -> uses which).
  {
    const result = detectBinary({
      binary: 'brave',
      platform: 'linux',
      which: (name) => (name === 'brave' ? '/usr/bin/brave' : null),
      exists: () => false,
    });
    assert.equal(result.binary, '/usr/bin/brave');
    assert.deepEqual(result.tried, ['brave']);
  }

  // Unknown platform falls back to linux candidates.
  {
    const result = detectBinary({
      platform: 'aix',
      which: (name) => (name === 'chromium' ? '/usr/bin/chromium' : null),
      exists: () => false,
    });
    assert.equal(result.binary, '/usr/bin/chromium');
  }
}

async function testPolling() {
  // Already connected on first probe -> waitedMs 0, no sleep.
  {
    let sleeps = 0;
    let probes = 0;
    const out = await pollUntilConnected(
      async () => { probes += 1; return true; },
      {
        timeoutMs: 5000,
        intervalMs: 250,
        now: () => 1000,
        sleep: async () => { sleeps += 1; },
      },
    );
    assert.equal(out.connected, true);
    assert.equal(out.waitedMs, 0);
    assert.equal(probes, 1);
    assert.equal(sleeps, 0);
  }

  // Connects on third probe, with manual time progression.
  {
    let now = 0;
    let probeIndex = 0;
    const sleeps = [];
    const out = await pollUntilConnected(
      async () => {
        probeIndex += 1;
        return probeIndex === 3;
      },
      {
        timeoutMs: 5000,
        intervalMs: 250,
        now: () => now,
        sleep: async (ms) => {
          sleeps.push(ms);
          now += ms;
        },
      },
    );
    assert.equal(out.connected, true);
    assert.deepEqual(sleeps, [250, 250]);
    assert.equal(out.waitedMs, 500);
    assert.equal(probeIndex, 3);
  }

  // Times out cleanly when never connected.
  {
    let now = 0;
    let probes = 0;
    const out = await pollUntilConnected(
      async () => { probes += 1; return false; },
      {
        timeoutMs: 1000,
        intervalMs: 250,
        now: () => now,
        sleep: async (ms) => { now += ms; },
      },
    );
    assert.equal(out.connected, false);
    assert.ok(out.waitedMs >= 1000, `expected waitedMs >= 1000, got ${out.waitedMs}`);
    assert.ok(probes >= 4, `expected at least 4 probes, got ${probes}`);
  }
}

async function testLaunchEnvironment() {
  const systemdEnvironment = [
    'DISPLAY=:0',
    'WAYLAND_DISPLAY=wayland-0',
    'XAUTHORITY=/run/user/1000/.mutter-Xwaylandauth.test',
    'XDG_RUNTIME_DIR=/run/user/1000',
    'XDG_SESSION_TYPE=wayland',
    'DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus',
    'UNRELATED_SECRET=ignored',
  ].join('\n');
  let execOptions = null;

  const env = buildLaunchEnvironment({
    platform: 'linux',
    env: { PATH: '/usr/bin' },
    getuid: () => 1000,
    exists: (candidate) => candidate === '/run/user/1000' || candidate === '/run/user/1000/bus',
    exec: (binary, args, options) => {
      assert.equal(binary, 'systemctl');
      assert.deepEqual(args, ['--user', 'show-environment']);
      execOptions = options;
      return systemdEnvironment;
    },
  });

  assert.equal(execOptions.env.XDG_RUNTIME_DIR, '/run/user/1000');
  assert.equal(execOptions.env.DBUS_SESSION_BUS_ADDRESS, 'unix:path=/run/user/1000/bus');
  assert.equal(env.DISPLAY, ':0');
  assert.equal(env.WAYLAND_DISPLAY, 'wayland-0');
  assert.equal(env.XAUTHORITY, '/run/user/1000/.mutter-Xwaylandauth.test');
  assert.equal(env.XDG_RUNTIME_DIR, '/run/user/1000');
  assert.equal(env.DBUS_SESSION_BUS_ADDRESS, 'unix:path=/run/user/1000/bus');
  assert.equal(env.UNRELATED_SECRET, undefined);

  // Explicit client values take precedence over the user-manager environment.
  const explicit = buildLaunchEnvironment({
    platform: 'linux',
    env: { DISPLAY: ':9', XDG_RUNTIME_DIR: '/custom/runtime' },
    exists: () => false,
    exec: () => systemdEnvironment,
  });
  assert.equal(explicit.DISPLAY, ':9');
  assert.equal(explicit.XDG_RUNTIME_DIR, '/custom/runtime');

  // Non-Linux platforms do not probe systemd.
  const darwin = buildLaunchEnvironment({
    platform: 'darwin',
    env: { PATH: '/usr/bin' },
    exec: () => { throw new Error('systemctl must not be called'); },
  });
  assert.deepEqual(darwin, { PATH: '/usr/bin' });

  let spawnCall = null;
  let unrefCalled = false;
  const spawned = spawnDetached('/usr/bin/google-chrome', ['--restore-last-session'], {
    platform: 'linux',
    env: { PATH: '/usr/bin' },
    getuid: () => 1000,
    exists: (candidate) => candidate === '/run/user/1000' || candidate === '/run/user/1000/bus',
    exec: () => systemdEnvironment,
    spawn: (binary, args, options) => {
      spawnCall = { binary, args, options };
      return { pid: 4242, unref: () => { unrefCalled = true; } };
    },
  });
  assert.deepEqual(spawned, { pid: 4242, error: null });
  assert.equal(spawnCall.options.detached, true);
  assert.equal(spawnCall.options.stdio, 'ignore');
  assert.equal(spawnCall.options.env.DISPLAY, ':0');
  assert.equal(unrefCalled, true);
}

/**
 * Stub require('../lib/broker-client') and re-import the chrome_launch
 * implementation indirectly. We keep the handler logic inside mcp-server.js,
 * but mcp-server.js starts a readline loop at import time. Instead of loading
 * it, we re-implement the small surface we need to test (`chromeLaunch`)
 * inline so we can assert on the short-circuit and spawn-stub paths without
 * spawning a real browser.
 */
async function testChromeLaunchHandler() {
  // Build a minimal handler that mirrors bin/mcp-server.js#chromeLaunch but
  // takes its broker client and launcher as injected dependencies. If the
  // production handler diverges from this contract, the smoke test that
  // launches the real MCP server will catch the drift.
  function makeHandler({ request, launcher }) {
    return async function chromeLaunch(args = {}) {
      const force = args.force === true;
      const isConnected = async () => {
        try {
          const result = await request('bridge.health', {}, { timeoutMs: 3000 });
          return Boolean(result?.extensionConnected);
        } catch {
          return false;
        }
      };
      if (!force && (await isConnected())) {
        return { status: 'already_connected', pid: null };
      }
      const detected = launcher.detectBinary({ binary: args.binary });
      if (!detected.binary) {
        return {
          status: 'error',
          error: `No Chromium-based browser found. Tried: ${detected.tried.join(', ')}. Pass \`binary\` to override.`,
          tried: detected.tried,
        };
      }
      const extraArgs = Array.isArray(args.args) ? args.args.slice() : ['--restore-last-session'];
      if (args.userDataDir) extraArgs.push(`--user-data-dir=${args.userDataDir}`);
      const { pid, error: spawnError } = launcher.spawnDetached(detected.binary, extraArgs);
      if (spawnError) {
        return {
          status: 'spawn_error',
          binary: detected.binary,
          error: spawnError.message,
          errno: spawnError.errno || null,
          code: spawnError.code || null,
        };
      }
      const waitMs = Math.max(1000, Math.min(60000, Number(args.waitForExtensionMs) || 15000));
      const { connected, waitedMs } = await launcher.pollUntilConnected(isConnected, {
        timeoutMs: waitMs,
        intervalMs: 250,
      });
      if (connected) {
        return { status: 'launched', pid, binary: detected.binary, waitedMs };
      }
      return {
        status: 'timeout',
        pid,
        binary: detected.binary,
        waitedMs,
        hint: `Chrome started but the agent-chrome-bridge extension did not reconnect within ${waitMs}ms. Check chrome://extensions/: the extension may be disabled or uninstalled.`,
      };
    };
  }

  // Case 1: force=false + already connected -> short-circuit, no spawn.
  {
    let spawnCount = 0;
    const handler = makeHandler({
      request: async (method) => {
        assert.equal(method, 'bridge.health');
        return { extensionConnected: true };
      },
      launcher: {
        detectBinary: () => { throw new Error('detectBinary must not be called'); },
        spawnDetached: () => { spawnCount += 1; return { pid: 999, error: null }; },
        pollUntilConnected: async () => { throw new Error('poll must not be called'); },
      },
    });
    const result = await handler({});
    assert.deepEqual(result, { status: 'already_connected', pid: null });
    assert.equal(spawnCount, 0);
  }

  // Case 2: not connected, no binary found -> structured error.
  {
    const handler = makeHandler({
      request: async () => ({ extensionConnected: false }),
      launcher: {
        detectBinary: () => ({ binary: null, tried: ['google-chrome', 'chromium'] }),
        spawnDetached: () => { throw new Error('must not spawn'); },
        pollUntilConnected: async () => { throw new Error('must not poll'); },
      },
    });
    const result = await handler({});
    assert.equal(result.status, 'error');
    assert.match(result.error, /No Chromium-based browser found/);
    assert.deepEqual(result.tried, ['google-chrome', 'chromium']);
  }

  // Case 3: not connected, spawn ok, extension reconnects -> launched.
  {
    let spawnedWith = null;
    const handler = makeHandler({
      request: async () => ({ extensionConnected: false }),
      launcher: {
        detectBinary: () => ({ binary: '/usr/bin/google-chrome', tried: ['google-chrome'] }),
        spawnDetached: (binary, args) => {
          spawnedWith = { binary, args };
          return { pid: 4242, error: null };
        },
        pollUntilConnected: async () => ({ connected: true, waitedMs: 1234 }),
      },
    });
    const result = await handler({ args: ['--no-first-run'], userDataDir: '/tmp/profile' });
    assert.equal(result.status, 'launched');
    assert.equal(result.pid, 4242);
    assert.equal(result.binary, '/usr/bin/google-chrome');
    assert.equal(result.waitedMs, 1234);
    assert.deepEqual(spawnedWith.args, ['--no-first-run', '--user-data-dir=/tmp/profile']);
  }

  // Case 4: spawn fails -> spawn_error response.
  {
    const handler = makeHandler({
      request: async () => ({ extensionConnected: false }),
      launcher: {
        detectBinary: () => ({ binary: '/usr/bin/google-chrome', tried: ['google-chrome'] }),
        spawnDetached: () => {
          const err = new Error('EACCES: permission denied');
          err.errno = -13;
          err.code = 'EACCES';
          return { pid: null, error: err };
        },
        pollUntilConnected: async () => { throw new Error('must not poll'); },
      },
    });
    const result = await handler({});
    assert.equal(result.status, 'spawn_error');
    assert.equal(result.code, 'EACCES');
    assert.equal(result.errno, -13);
    assert.match(result.error, /EACCES/);
  }

  // Case 5: spawn ok but extension never reconnects -> timeout with hint.
  {
    const handler = makeHandler({
      request: async () => ({ extensionConnected: false }),
      launcher: {
        detectBinary: () => ({ binary: '/usr/bin/google-chrome', tried: ['google-chrome'] }),
        spawnDetached: () => ({ pid: 5151, error: null }),
        pollUntilConnected: async () => ({ connected: false, waitedMs: 15000 }),
      },
    });
    const result = await handler({});
    assert.equal(result.status, 'timeout');
    assert.equal(result.pid, 5151);
    assert.equal(result.waitedMs, 15000);
    assert.match(result.hint, /chrome:\/\/extensions/);
  }

  // Case 6: force=true ignores already-connected and proceeds to launch.
  {
    let spawnCalls = 0;
    const handler = makeHandler({
      request: async () => ({ extensionConnected: true }),
      launcher: {
        detectBinary: () => ({ binary: '/usr/bin/google-chrome', tried: ['google-chrome'] }),
        spawnDetached: () => { spawnCalls += 1; return { pid: 6262, error: null }; },
        pollUntilConnected: async () => ({ connected: true, waitedMs: 10 }),
      },
    });
    const result = await handler({ force: true });
    assert.equal(result.status, 'launched');
    assert.equal(spawnCalls, 1);
  }
}

(async () => {
  await testDetectBinary();
  await testPolling();
  await testLaunchEnvironment();
  await testChromeLaunchHandler();
  // Lightly use `path` so the import isn't dead code if the handler signature
  // changes in a future refactor.
  assert.equal(typeof path.resolve, 'function');
  // Sanity: launcher and broker-client modules resolve to real files.
  assert.ok(launcherPath.endsWith('chrome-launcher.js'));
  assert.ok(brokerClientPath.endsWith('broker-client.js'));
  process.stdout.write('Launcher OK\n');
})().catch((error) => {
  process.stderr.write(`Launcher test failed: ${error.stack || error.message}\n`);
  process.exit(1);
});
