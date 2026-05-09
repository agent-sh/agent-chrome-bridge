#!/usr/bin/env node
'use strict';

const readline = require('node:readline');
const { createRunner, MODEL_ALIAS } = require('../lib/claude-runner');

function parseArgs(argv) {
  const args = { model: 'sonnet', prompt: null, permissionMode: 'bypassPermissions', includePartial: false };
  for (let i = 2; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--model') args.model = argv[++i];
    else if (token === '--prompt') args.prompt = argv[++i];
    else if (token === '--ask') args.permissionMode = 'default';
    else if (token === '--partial') args.includePartial = true;
    else if (token === '-h' || token === '--help') args.help = true;
  }
  return args;
}

function usage() {
  process.stdout.write(`agent: Claude Code on Bedrock driving the agent-chrome-bridge MCP

Usage:
  node bin/agent.js [--model sonnet|opus|haiku|<full-id>] [--prompt "text"] [--ask] [--partial]

Flags:
  --model       model alias or full Bedrock inference profile id (default: sonnet)
  --prompt      one-shot message, then exit
  --ask         use permission-mode=default (Claude Code prompts for non-bridge tools)
                default is bypassPermissions so bridge tools run without prompts
  --partial     include partial message chunks in the event stream

Models:
  sonnet  -> ${MODEL_ALIAS.sonnet}
  opus    -> ${MODEL_ALIAS.opus}
  haiku   -> ${MODEL_ALIAS.haiku}
`);
}

function renderEvent(event) {
  switch (event.type) {
    case 'system': {
      if (event.subtype === 'init') {
        const mcp = (event.mcp_servers || []).map((server) => `${server.name}=${server.status}`).join(', ');
        process.stdout.write(`\n[system.init] model=${event.model} session=${event.session_id}\n            mcp: ${mcp || '(none)'}\n\n`);
      }
      return;
    }
    case 'assistant': {
      for (const block of event.message?.content || []) {
        if (block.type === 'text') process.stdout.write(block.text);
        else if (block.type === 'thinking') process.stdout.write(`\n[thinking] ${block.thinking}\n`);
        else if (block.type === 'tool_use') process.stdout.write(`\n[tool_use ${block.name}] ${JSON.stringify(block.input).slice(0, 200)}\n`);
      }
      process.stdout.write('\n');
      return;
    }
    case 'user': {
      for (const block of event.message?.content || []) {
        if (block.type === 'tool_result') {
          const summary = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
          process.stdout.write(`[tool_result${block.is_error ? ' error' : ''}] ${summary.slice(0, 200)}${summary.length > 200 ? '…' : ''}\n`);
        }
      }
      return;
    }
    case 'result': {
      const cost = event.total_cost_usd != null ? ` cost=$${event.total_cost_usd.toFixed(4)}` : '';
      process.stdout.write(`\n(${event.subtype} stop=${event.stop_reason} turns=${event.num_turns}${cost})\n`);
      return;
    }
    case 'parse_error': {
      process.stderr.write(`\n[parse_error] ${event.error}\n${event.raw}\n`);
      return;
    }
    default:
      return;
  }
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) { usage(); return; }

  const runner = createRunner({
    model: args.model,
    permissionMode: args.permissionMode,
    includePartialMessages: args.includePartial,
    onEvent: renderEvent,
  });

  process.stdout.write(`Model:  ${runner.model}\nRegion: ${runner.awsRegion}\n\n`);

  if (args.prompt) {
    runner.send(args.prompt);
    runner.end();
    const { code, signal, stderr } = await runner.exit;
    if (code !== 0) {
      process.stderr.write(`\nclaude exited code=${code} signal=${signal || ''}\n${stderr}\n`);
      process.exitCode = code || 1;
    }
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (question) => new Promise((resolve) => rl.question(question, resolve));

  rl.on('SIGINT', () => {
    runner.abort();
    rl.close();
  });

  for (;;) {
    const line = (await ask('\n> ')).trim();
    if (!line) continue;
    if (line === 'exit' || line === 'quit') break;
    runner.send(line);
    // Wait a brief moment so output interleaves nicely before the next prompt.
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  runner.end();
  rl.close();
  await runner.exit;
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
