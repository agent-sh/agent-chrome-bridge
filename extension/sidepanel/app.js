'use strict';

const els = {
  chat: document.getElementById('chat'),
  composer: document.getElementById('composer'),
  input: document.getElementById('input'),
  send: document.getElementById('send'),
  model: document.getElementById('model'),
  mode: document.getElementById('mode'),
  abort: document.getElementById('abort'),
  status: document.getElementById('status'),
};

const state = {
  port: null,
  sessionId: null,
  pendingById: new Map(),
  rpcCounter: 0,
  running: false,
  toolCardsById: new Map(),
};

function setStatus(text, cls) {
  els.status.textContent = text;
  els.status.className = `status ${cls || ''}`;
}

function appendNode(node) {
  els.chat.appendChild(node);
  els.chat.scrollTop = els.chat.scrollHeight;
}

function addMessage(role, text) {
  const div = document.createElement('div');
  div.className = `msg ${role}`;
  div.textContent = text;

  if (role === 'assistant') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'speak-btn';
    btn.textContent = 'speak';
    btn.addEventListener('click', () => {
      if (chrome.tts.isSpeaking && chrome.tts.isSpeaking()) {
        chrome.tts.stop();
        btn.textContent = 'speak';
        btn.classList.remove('active');
        return;
      }
      btn.textContent = 'stop';
      btn.classList.add('active');
      chrome.tts.speak(div.textContent, {
        onEvent: (event) => {
          if (event.type === 'end' || event.type === 'interrupted' || event.type === 'cancelled' || event.type === 'error') {
            btn.textContent = 'speak';
            btn.classList.remove('active');
          }
        },
      });
    });
    div.appendChild(btn);
  }

  appendNode(div);
  return div;
}

function addToolCard(toolUseId, name, input) {
  const div = document.createElement('div');
  div.className = 'tool-card';
  const header = document.createElement('div');
  header.innerHTML = `<span class="tool-name">${name.replace(/^mcp__[^_]+__/, '')}</span> <span class="status">running…</span>`;
  div.appendChild(header);

  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = 'arguments';
  details.appendChild(summary);
  const pre = document.createElement('pre');
  pre.textContent = JSON.stringify(input, null, 2);
  details.appendChild(pre);
  div.appendChild(details);

  appendNode(div);
  state.toolCardsById.set(toolUseId, { card: div, status: header.querySelector('.status') });
  return div;
}

function addToolResult(toolUseId, content, isError) {
  const entry = state.toolCardsById.get(toolUseId);
  if (!entry) return;
  entry.status.textContent = isError ? 'error' : 'ok';
  if (isError) entry.card.classList.add('error');
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = isError ? 'error detail' : 'result';
  details.appendChild(summary);
  const pre = document.createElement('pre');
  pre.textContent = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
  details.appendChild(pre);
  entry.card.appendChild(details);
  els.chat.scrollTop = els.chat.scrollHeight;
}

function addApproval(event) {
  const div = document.createElement('div');
  div.className = 'approval';

  const heading = document.createElement('div');
  const shortName = event.toolName.replace(/^mcp__[^_]+__/, '');
  heading.innerHTML = `Claude wants to run <b>${shortName}</b>.`;
  div.appendChild(heading);

  const target = document.createElement('div');
  target.className = 'target';
  target.textContent = JSON.stringify(event.input);
  div.appendChild(target);

  const actions = document.createElement('div');
  actions.className = 'actions';

  const deny = document.createElement('button');
  deny.type = 'button';
  deny.className = 'ghost';
  deny.textContent = 'Deny';
  deny.addEventListener('click', () => decide('deny'));

  const allow = document.createElement('button');
  allow.type = 'button';
  allow.textContent = 'Allow';
  allow.addEventListener('click', () => decide('allow'));

  const allowSession = document.createElement('button');
  allowSession.type = 'button';
  allowSession.textContent = 'Allow (session)';
  allowSession.addEventListener('click', () => decide('allow', { rememberForSession: true }));

  actions.append(deny, allow, allowSession);
  div.appendChild(actions);
  appendNode(div);

  function decide(decision, opts = {}) {
    div.remove();
    sendRpc('session.approve_respond', {
      sessionId: state.sessionId,
      approvalId: event.approvalId,
      decision,
      rememberForSession: opts.rememberForSession === true,
    });
  }
}

function sendRpc(method, params) {
  const id = `panel-${Date.now()}-${++state.rpcCounter}`;
  return new Promise((resolve, reject) => {
    state.pendingById.set(id, { resolve, reject, method });
    state.port.postMessage({ type: 'session.request', id, method, params });
  });
}

function connect() {
  state.port = chrome.runtime.connect({ name: 'agent-session' });
  setStatus('connecting…');

  state.port.onMessage.addListener((message) => {
    if (message.type === 'session.response' && message.id) {
      const pending = state.pendingById.get(message.id);
      if (!pending) return;
      state.pendingById.delete(message.id);
      if (message.error) pending.reject(new Error(message.error));
      else pending.resolve(message.result);
      return;
    }
    if (message.type === 'session.event') {
      handleSessionEvent(message.event);
    }
  });

  state.port.onDisconnect.addListener(() => {
    state.port = null;
    state.sessionId = null;
    state.running = false;
    setStatus('disconnected', 'error');
    els.abort.disabled = true;
  });

  openSession();
}

async function openSession() {
  try {
    const result = await sendRpc('session.open', {
      model: els.model.value,
      mode: els.mode.value,
    });
    state.sessionId = result.sessionId;
    setStatus(`connected · ${result.model}`, 'ok');
    addMeta(`Session ${result.sessionId.slice(0, 14)}… · ${result.model}`);
  } catch (error) {
    setStatus(`error: ${error.message}`, 'error');
  }
}

function addMeta(text) {
  const div = document.createElement('div');
  div.className = 'meta';
  div.textContent = text;
  appendNode(div);
}

function handleSessionEvent(event) {
  switch (event.type) {
    case 'system':
      // system.init; already indicated in status.
      return;
    case 'assistant':
      for (const block of event.message?.content || []) {
        if (block.type === 'text') addMessage('assistant', block.text);
        else if (block.type === 'thinking') {
          const div = document.createElement('div');
          div.className = 'thinking';
          div.textContent = block.thinking;
          appendNode(div);
        } else if (block.type === 'tool_use') {
          addToolCard(block.id, block.name, block.input);
        }
      }
      return;
    case 'user':
      for (const block of event.message?.content || []) {
        if (block.type === 'tool_result') addToolResult(block.tool_use_id, block.content, block.is_error === true);
      }
      return;
    case 'approval_request':
      addApproval(event);
      return;
    case 'result':
      state.running = false;
      els.send.disabled = false;
      els.abort.disabled = true;
      addMeta(`stop=${event.stop_reason} turns=${event.num_turns}${event.total_cost_usd != null ? ` cost=$${event.total_cost_usd.toFixed(4)}` : ''}`);
      return;
    case 'session.exit':
      state.running = false;
      els.send.disabled = false;
      els.abort.disabled = true;
      setStatus(`exited${event.signal ? ' · ' + event.signal : ''}`, 'error');
      return;
    default:
      return;
  }
}

els.composer.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const text = els.input.value.trim();
  if (!text || !state.sessionId) return;
  addMessage('user', text);
  els.input.value = '';
  els.send.disabled = true;
  els.abort.disabled = false;
  state.running = true;
  try {
    await sendRpc('session.send', { sessionId: state.sessionId, text });
  } catch (error) {
    addMessage('assistant', `[error] ${error.message}`);
    els.send.disabled = false;
    els.abort.disabled = true;
    state.running = false;
  }
});

els.abort.addEventListener('click', async () => {
  if (!state.sessionId) return;
  try { await sendRpc('session.abort', { sessionId: state.sessionId }); } catch { /* ignore */ }
});

els.mode.addEventListener('change', async () => {
  if (!state.sessionId) return;
  try { await sendRpc('session.set_mode', { sessionId: state.sessionId, mode: els.mode.value }); } catch (error) {
    addMeta(`mode change failed: ${error.message}`);
  }
});

els.input.addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
    els.composer.requestSubmit();
  }
});

connect();
