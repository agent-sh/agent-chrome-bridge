#!/usr/bin/env node
'use strict';

// Registers bin/mcp-server.js with the Claude Code and Codex CLIs found on PATH.
// Usage: npm run install:mcp [-- --claude] [-- --codex] [-- --force] [-- --dry-run]
//   no client flag = every CLI found; --force replaces an existing entry.

const childProcess = require('node:child_process');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MCP_SERVER = path.join(ROOT, 'bin', 'mcp-server.js');

// Codex keys MCP config tables by name, so keep the TOML-friendly form there.
const CLIENTS = {
  claude: {
    name: 'agent-chrome-bridge',
    exists: (name) => ['mcp', 'get', name],
    remove: (name) => ['mcp', 'remove', '-s', 'user', name],
    add: (name, cmd) => ['mcp', 'add', '-s', 'user', name, '--', ...cmd],
  },
  codex: {
    name: 'agent_chrome_bridge',
    exists: (name) => ['mcp', 'get', name],
    remove: (name) => ['mcp', 'remove', name],
    add: (name, cmd) => ['mcp', 'add', name, '--', ...cmd],
  },
};

function parseArgs(argv) {
  const flags = new Set(argv);
  const picked = Object.keys(CLIENTS).filter((client) => flags.has(`--${client}`));
  return { picked, force: flags.has('--force'), dryRun: flags.has('--dry-run') };
}

function hasCli(bin) {
  const lookup = process.platform === 'win32' ? 'where' : 'which';
  return childProcess.spawnSync(lookup, [bin], { stdio: 'ignore' }).status === 0;
}

function run(bin, args, { dryRun, quiet = false } = {}) {
  if (dryRun) {
    console.log(`  would run: ${bin} ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`);
    return 0;
  }
  return childProcess.spawnSync(bin, args, { stdio: quiet ? 'ignore' : 'inherit' }).status;
}

function main() {
  const { picked, force, dryRun } = parseArgs(process.argv.slice(2));
  // Absolute node path: MCP clients may start servers with a PATH that lacks nvm/asdf shims.
  const command = [process.execPath, MCP_SERVER];
  const targets = picked.length ? picked : Object.keys(CLIENTS).filter(hasCli);

  if (!targets.length) {
    console.error('Neither `claude` nor `codex` found on PATH. Add this MCP stdio command manually:');
    console.error(`  ${command.join(' ')}`);
    process.exit(1);
  }

  let failed = false;
  for (const client of targets) {
    const spec = CLIENTS[client];
    if (!hasCli(client)) {
      console.error(`${client}: CLI not found on PATH, skipping`);
      failed = true;
      continue;
    }
    const present = run(client, spec.exists(spec.name), { quiet: true }) === 0;
    if (present && !force) {
      console.log(`${client}: '${spec.name}' already registered (use --force to replace)`);
      continue;
    }
    console.log(`${client}: registering '${spec.name}'`);
    if (present) run(client, spec.remove(spec.name), { dryRun, quiet: true });
    if (run(client, spec.add(spec.name, command), { dryRun }) !== 0) {
      console.error(`${client}: registration failed`);
      failed = true;
    }
  }

  console.log(`\nMCP command: ${command.join(' ')}`);
  console.log('Restart the agent (or run /mcp in Claude Code) to load the chrome_* tools.');
  process.exit(failed ? 1 : 0);
}

main();
