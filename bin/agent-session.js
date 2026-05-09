#!/usr/bin/env node
'use strict';

const readline = require('node:readline');
const { createSession, MODEL_ALIAS } = require('../lib/agent-session');

function parseArgs(argv) {
  const args = { model: 'sonnet', mode: 'per-session', prompt: null };
  for (let i = 2; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--model') args.model = argv[++i];
    else if (token === '--mode') args.mode = argv[++i];
    else if (token === '--prompt') args.prompt = argv[++i];
    else if (token === '-h' || token === '--help') args.help = true;
  }
  return args;
}

function usage() {
  process.stdout.write(`agent-session: Bedrock Claude + Chrome bridge REPL

Usage:
  node bin/agent-session.js [--model sonnet|opus|haiku] [--mode per-action|per-session|trust] [--prompt "text"]

Modes:
  per-action   prompt before each destructive tool call (chrome_click/type/navigate/close/cdp_*)
  per-session  prompt once on the first destructive action, then trust for this session
  trust        never prompt

Models (Bedrock inference profile):
  sonnet  -> ${MODEL_ALIAS.sonnet}
  opus    -> ${MODEL_ALIAS.opus}
  haiku   -> ${MODEL_ALIAS.haiku}
`);
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    usage();
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (question) => new Promise((resolve) => rl.question(question, resolve));

  let sessionApproved = false;
  async function approve({ toolName, input }) {
    if (args.mode === 'trust') return { approved: true };
    if (args.mode === 'per-session' && sessionApproved) return { approved: true };
    const summary = JSON.stringify(input).slice(0, 160);
    const answer = (await ask(`\n[approve] ${toolName} ${summary}\n  allow? [y/N/trust-session] `)).trim().toLowerCase();
    if (answer === 'trust-session' || answer === 't') {
      sessionApproved = true;
      return { approved: true };
    }
    if (answer === 'y' || answer === 'yes') return { approved: true };
    return { approved: false, reason: 'User denied' };
  }

  function onEvent(event) {
    switch (event.type) {
      case 'user_turn':
        break;
      case 'assistant_delta':
        process.stdout.write(event.text);
        break;
      case 'assistant_end':
        process.stdout.write('\n');
        break;
      case 'tool_start':
        process.stdout.write(`\n  [tool ${event.name}] ${JSON.stringify(event.input).slice(0, 200)}\n`);
        break;
      case 'tool_end':
        process.stdout.write(`  [tool ${event.name}] ${event.ok ? 'ok' : `error: ${event.error}`}\n`);
        break;
      case 'session_turn_done':
        process.stdout.write(`\n(stop: ${event.stopReason})\n`);
        break;
      default:
        break;
    }
  }

  const session = createSession({ model: args.model, approve, onEvent });
  process.stdout.write(`Model: ${session.model}\nMode:  ${args.mode}\nRegion: ${session.awsRegion}\nType 'exit' or Ctrl+C to quit.\n\n`);

  const oneShot = args.prompt;
  if (oneShot) {
    try {
      await session.send(oneShot);
    } catch (error) {
      process.stderr.write(`\nError: ${error.message}\n`);
      process.exitCode = 1;
    }
    rl.close();
    return;
  }

  for (;;) {
    const line = (await ask('\n> ')).trim();
    if (!line) continue;
    if (line === 'exit' || line === 'quit') break;
    try {
      await session.send(line);
    } catch (error) {
      process.stderr.write(`\nError: ${error.message}\n`);
    }
  }
  rl.close();
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
