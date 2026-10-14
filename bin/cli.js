#!/usr/bin/env node
'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { appDir, APP_FILES } = require('../lib/app-home');
const { chromeHostManifestPath } = require('../lib/native-host-config');
const { version } = require('../package.json');

const PACKAGE_ROOT = path.resolve(__dirname, '..');
const EXTENSION_ID = 'pfcpgdlnhaagndelcbdpopojfgalmbkf';

const HELP = `agent-chrome-bridge ${version} — let Claude Code and Codex drive your real Chrome

Usage: agent-chrome-bridge <command> [options]

Commands:
  setup        Install or upgrade: copy the runtime to a stable location, register
               the Chrome native host, and register the MCP server with Claude
               Code and Codex. Safe to re-run.
                 --claude / --codex   only register with that client
                 --no-mcp             skip MCP registration
                 --force-mcp          replace existing MCP entries
  doctor       Check the broker, extension connection and native host manifest.
  where        Print the install and extension directories.
  mcp          Run the MCP stdio server (what your agent launches).
  uninstall    Remove the native host manifest, MCP entries and installed runtime.
  help         Show this help.

Quick start:
  npx @agent-sh/chrome-bridge@latest setup
`;

function runNode(script, args = [], { quiet = false } = {}) {
  const result = childProcess.spawnSync(process.execPath, [script, ...args], { stdio: quiet ? 'ignore' : 'inherit' });
  return result.status ?? 1;
}

function copyRuntime(target) {
  const staging = `${target}.staging-${process.pid}`;
  fs.rmSync(staging, { recursive: true, force: true });
  for (const entry of APP_FILES) {
    const from = path.join(PACKAGE_ROOT, entry);
    if (!fs.existsSync(from)) continue;
    fs.cpSync(from, path.join(staging, entry), { recursive: true });
  }
  // The launcher is machine-specific; install-native-host regenerates it.
  fs.rmSync(path.join(staging, 'bin', 'native-host-launcher.sh'), { force: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.rmSync(target, { recursive: true, force: true });
  fs.renameSync(staging, target);
}

function setup(flags) {
  const target = appDir();
  const previous = readInstalledVersion(target);
  const fromInstalledCopy = fs.existsSync(target) && fs.realpathSync(PACKAGE_ROOT) === fs.realpathSync(target);

  if (!fromInstalledCopy) copyRuntime(target);
  console.log(`Runtime ${previous ? `${previous} -> ` : ''}${version} at ${target}\n`);

  if (runNode(path.join(target, 'scripts', 'install-native-host.js')) !== 0) process.exit(1);

  if (!flags.has('--no-mcp')) {
    const mcpArgs = ['--claude', '--codex'].filter((f) => flags.has(f));
    if (flags.has('--force-mcp')) mcpArgs.push('--force');
    console.log('');
    runNode(path.join(target, 'scripts', 'install-mcp.js'), mcpArgs);
  }

  const extensionDir = path.join(target, 'extension');
  console.log(`
Next steps:
  1. Open chrome://extensions and enable Developer mode.
  2. ${previous ? 'Click the reload icon on "Agent Chrome Bridge"' : `Click "Load unpacked" and choose:\n       ${extensionDir}`}
     (extension id ${EXTENSION_ID})
  3. Restart your agent (Claude Code: /mcp), then run: agent-chrome-bridge doctor`);
}

function readInstalledVersion(target) {
  try {
    return JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8')).version;
  } catch {
    return null;
  }
}

function doctor() {
  // Prefer the installed copy so the manifest path check compares against it.
  const installed = path.join(appDir(), 'scripts', 'doctor.js');
  const script = fs.existsSync(installed) ? installed : path.join(PACKAGE_ROOT, 'scripts', 'doctor.js');
  process.exit(runNode(script));
}

function where() {
  const target = appDir();
  console.log(`install:   ${target}${fs.existsSync(target) ? '' : '  (not installed — run setup)'}`);
  console.log(`extension: ${path.join(target, 'extension')}`);
  console.log(`mcp:       ${process.execPath} ${path.join(target, 'bin', 'mcp-server.js')}`);
}

function uninstall() {
  const target = appDir();
  const manifest = chromeHostManifestPath();
  fs.rmSync(manifest, { force: true });
  console.log(`Removed native host manifest ${manifest}`);
  for (const [cli, args] of [
    ['claude', ['mcp', 'remove', '-s', 'user', 'agent-chrome-bridge']],
    ['codex', ['mcp', 'remove', 'agent_chrome_bridge']],
  ]) {
    const result = childProcess.spawnSync(cli, args, { stdio: 'ignore' });
    if (result.error) continue;
    console.log(result.status === 0 ? `Removed ${cli} MCP entry` : `${cli}: no MCP entry to remove`);
  }
  fs.rmSync(target, { recursive: true, force: true });
  console.log(`Removed ${target}`);
  console.log('Finally, remove "Agent Chrome Bridge" from chrome://extensions.');
}

function main() {
  const [command = 'help', ...rest] = process.argv.slice(2);
  const flags = new Set(rest);
  switch (command) {
    case 'setup': return setup(flags);
    case 'doctor': return doctor();
    case 'where': return where();
    case 'mcp': return require('./mcp-server.js');
    case 'uninstall': return uninstall();
    case '--version': case '-v': return console.log(version);
    case 'help': case '--help': case '-h': return process.stdout.write(HELP);
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
      process.exit(2);
  }
}

main();
