#!/usr/bin/env node
'use strict';

const { openSessionClient } = require('../lib/broker-client');

function parseArgs(argv) {
  const args = { mode: 'per-session', autoAllow: true, prompt: null };
  const rest = [];
  for (let i = 2; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === '--mode') args.mode = argv[++i];
    else if (tok === '--deny') args.autoAllow = false;
    else rest.push(tok);
  }
  args.prompt = rest.join(' ') || 'List my open Chrome tabs by title only, numbered.';
  return args;
}

async function main() {
  const args = parseArgs(process.argv);

  let clientRef;
  const client = await openSessionClient({
    onEvent: (event) => {
      if (event.type === 'system' && event.subtype === 'init') {
        process.stdout.write(`[init] model=${event.model} session=${event.session_id}\n`);
      } else if (event.type === 'assistant') {
        for (const block of event.message?.content || []) {
          if (block.type === 'text') process.stdout.write(block.text + '\n');
          else if (block.type === 'tool_use') process.stdout.write(`[tool_use ${block.name}] ${JSON.stringify(block.input).slice(0, 140)}\n`);
        }
      } else if (event.type === 'user') {
        for (const block of event.message?.content || []) {
          if (block.type === 'tool_result') {
            const s = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
            process.stdout.write(`[tool_result${block.is_error ? ' error' : ''}] ${s.slice(0, 140)}\n`);
          }
        }
      } else if (event.type === 'approval_request') {
        process.stdout.write(`[approval_request ${event.approvalId}] ${event.toolName} ${JSON.stringify(event.input).slice(0, 200)}\n`);
        const decision = args.autoAllow ? 'allow' : 'deny';
        clientRef.approveRespond(event.approvalId, decision, { rememberForSession: args.mode === 'per-session' })
          .catch((error) => process.stderr.write(`approveRespond error: ${error.message}\n`));
      } else if (event.type === 'result') {
        process.stdout.write(`[result ${event.subtype}] stop=${event.stop_reason} turns=${event.num_turns}\n`);
        if (clientRef) clientRef.close();
      }
    },
    onExit: (event) => {
      process.stdout.write(`[exit] code=${event.code} signal=${event.signal || ''}\n`);
      process.exit(event.code || 0);
    },
  });
  clientRef = client;

  const opened = await client.open({ mode: args.mode });
  process.stdout.write(`[opened] ${opened.sessionId} model=${opened.model} mode=${opened.mode}\n`);
  await client.send(args.prompt);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exit(1);
});
