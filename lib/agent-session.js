'use strict';

const { AnthropicBedrock } = require('@anthropic-ai/bedrock-sdk');
const { request: brokerRequest } = require('./broker-client');
const { TOOLS, METHOD_BY_TOOL, DESTRUCTIVE_TOOLS } = require('./tool-registry');

const MODEL_ALIAS = {
  sonnet: 'global.anthropic.claude-sonnet-4-6',
  opus: 'global.anthropic.claude-opus-4-7',
  haiku: 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
};

const DEFAULT_SYSTEM = `You are a browser agent with direct control of the user's Chrome browser through a local bridge. You can read tabs, find elements, click, type, navigate, scroll, take screenshots, and capture console output.

Rules:
- Prefer read-only tools (chrome_snapshot, chrome_find, chrome_read_article) to learn the page before acting.
- When you need an element, run chrome_find first, then use the returned elementId for chrome_click or chrome_type. Copying CSS selectors by hand is fragile.
- Before navigating off the current origin, explain what you are about to do.
- Keep tool calls minimal. One focused call beats five speculative ones.
- When the user asks a question that does not require browser actions, just answer.`;

function toolSchemasForBedrock() {
  return TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema || { type: 'object', properties: {} },
  }));
}

function isoNow() {
  return new Date().toISOString();
}

function createSession(options = {}) {
  const model = MODEL_ALIAS[options.model] || options.model || MODEL_ALIAS.sonnet;
  const maxTokens = options.maxTokens || 4096;
  const maxSteps = options.maxSteps || 20;
  const system = options.system || DEFAULT_SYSTEM;
  const emit = typeof options.onEvent === 'function' ? options.onEvent : () => {};
  const approver = typeof options.approve === 'function' ? options.approve : async () => ({ approved: true });
  const awsRegion = options.awsRegion || process.env.AWS_REGION || 'us-east-1';

  const client = new AnthropicBedrock({ awsRegion });
  const history = [];
  let aborted = false;

  function emitEvent(type, payload = {}) {
    emit({ type, ts: isoNow(), ...payload });
  }

  async function runTool(toolName, input, toolUseId) {
    const method = METHOD_BY_TOOL[toolName];
    if (!method) {
      return { error: `Unknown tool: ${toolName}` };
    }

    if (DESTRUCTIVE_TOOLS.has(toolName)) {
      const decision = await approver({ toolName, input, toolUseId });
      if (!decision || decision.approved === false) {
        return { error: decision?.reason || 'Denied by user' };
      }
    }

    const timeoutMs = toolName.startsWith('chrome_wait_')
      ? Math.max(1000, Number(input?.timeoutMs || 10000) + 5000)
      : toolName === 'chrome_get_console'
        ? Math.max(3000, Number(input?.waitMs || 1000) + 5000)
        : 30000;

    try {
      const result = await brokerRequest(method, input || {}, { timeoutMs });
      return { result };
    } catch (error) {
      return { error: error?.message || String(error) };
    }
  }

  function truncateForModel(value) {
    // Tool results can be huge (snapshots). Cap string payload size we send back.
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    const LIMIT = 20000;
    if (text.length <= LIMIT) return text;
    return `${text.slice(0, LIMIT)}\n\n[truncated ${text.length - LIMIT} chars]`;
  }

  async function streamAssistant() {
    const params = {
      model,
      max_tokens: maxTokens,
      system,
      tools: toolSchemasForBedrock(),
      messages: history,
    };

    const stream = await client.messages.stream(params);

    stream.on('text', (delta) => {
      if (aborted) return;
      emitEvent('assistant_delta', { text: delta });
    });

    const message = await stream.finalMessage();
    return message;
  }

  async function send(userText) {
    if (aborted) throw new Error('Session aborted');
    history.push({ role: 'user', content: userText });
    emitEvent('user_turn', { text: userText });

    let stepsLeft = maxSteps;
    while (stepsLeft-- > 0) {
      if (aborted) break;
      emitEvent('assistant_start', {});
      const message = await streamAssistant();
      history.push({ role: 'assistant', content: message.content });
      emitEvent('assistant_end', {
        stopReason: message.stop_reason,
        usage: message.usage || null,
      });

      const toolUses = message.content.filter((block) => block.type === 'tool_use');
      if (!toolUses.length || message.stop_reason !== 'tool_use') {
        emitEvent('session_turn_done', { stopReason: message.stop_reason });
        return message;
      }

      const toolResults = [];
      for (const toolUse of toolUses) {
        if (aborted) break;
        emitEvent('tool_start', { toolUseId: toolUse.id, name: toolUse.name, input: toolUse.input });
        const { result, error } = await runTool(toolUse.name, toolUse.input, toolUse.id);
        emitEvent('tool_end', {
          toolUseId: toolUse.id,
          name: toolUse.name,
          ok: !error,
          error: error || null,
        });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: truncateForModel(error ? { error } : result),
          is_error: Boolean(error),
        });
      }

      if (aborted) break;
      history.push({ role: 'user', content: toolResults });
    }

    emitEvent('session_turn_done', { stopReason: 'max_steps' });
    return { stop_reason: 'max_steps' };
  }

  function abort() {
    aborted = true;
    emitEvent('session_aborted', {});
  }

  function getHistory() {
    return history.slice();
  }

  return { send, abort, getHistory, model, awsRegion };
}

module.exports = { createSession, MODEL_ALIAS, DEFAULT_SYSTEM };
