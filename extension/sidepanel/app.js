'use strict';

const els = {
  chat: document.getElementById('chat'),
  composer: document.getElementById('composer'),
  input: document.getElementById('input'),
  send: document.getElementById('send'),
  model: document.getElementById('model'),
  mode: document.getElementById('mode'),
  abort: document.getElementById('abort'),
  newChat: document.getElementById('newChat'),
  quick: document.getElementById('quick'),
  autoSpeak: document.getElementById('autoSpeak'),
  status: document.getElementById('status'),
  statusDot: document.getElementById('statusDot'),
};

const MODEL_LABEL = {
  'global.anthropic.claude-sonnet-4-6': 'Sonnet 4.6',
  'global.anthropic.claude-opus-4-7': 'Opus 4.7',
  'global.anthropic.claude-haiku-4-5-20251001-v1:0': 'Haiku 4.5',
};

const SAMPLE_PROMPTS = [
  'List my open tabs by title',
  'Summarize the article in my current tab',
  'Read this page aloud',
];

const state = {
  port: null,
  sessionId: null,
  pendingById: new Map(),
  rpcCounter: 0,
  running: false,
  toolCardsById: new Map(),
  autoSpeak: false,
};

function setStatus(text, cls) {
  els.status.textContent = text;
  els.status.className = `status ${cls || ''}`;
  if (els.statusDot) els.statusDot.className = `dot ${cls || ''}`;
}

function shortModel(model) {
  return MODEL_LABEL[model] || (model || '').replace(/^global\.anthropic\.claude-/, '').replace(/-\d+$/, '');
}

function renderWelcome() {
  if (els.chat.querySelector('.welcome')) return;
  const box = document.createElement('div');
  box.className = 'welcome';

  const h = document.createElement('div');
  h.className = 'welcome-title';
  h.textContent = 'Try one of these:';
  box.appendChild(h);

  const chips = document.createElement('div');
  chips.className = 'chips';
  for (const prompt of SAMPLE_PROMPTS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = prompt;
    b.addEventListener('click', () => {
      els.input.value = prompt;
      els.input.focus();
      els.input.dispatchEvent(new Event('input'));
    });
    chips.appendChild(b);
  }
  box.appendChild(chips);

  appendNode(box);
}

function clearWelcome() {
  const w = els.chat.querySelector('.welcome');
  if (w) w.remove();
}

function appendNode(node) {
  els.chat.appendChild(node);
  els.chat.scrollTop = els.chat.scrollHeight;
}

function addMessage(role, text) {
  const md = globalThis.__agentChromeBridgeMarkdown;
  const wrapper = document.createElement('div');
  wrapper.className = `msg ${role}`;

  if (role === 'assistant' && md) {
    wrapper.appendChild(md.renderMarkdown(text));
  } else {
    const body = document.createElement('div');
    body.className = 'md';
    const p = document.createElement('p');
    p.textContent = text;
    body.appendChild(p);
    wrapper.appendChild(body);
  }

  if (role === 'assistant') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'speak-btn';
    btn.title = 'Read aloud';
    btn.setAttribute('aria-label', 'Read aloud');
    btn.textContent = '🔊';

    const plainText = md ? md.stripMarkdown(text) : text;
    const speak = () => {
      btn.textContent = '■';
      btn.classList.add('active');
      chrome.tts.speak(plainText, {
        onEvent: (event) => {
          if (['end', 'interrupted', 'cancelled', 'error'].includes(event.type)) {
            btn.textContent = '🔊';
            btn.classList.remove('active');
          }
        },
      });
    };

    btn.addEventListener('click', () => {
      chrome.tts.isSpeaking((speaking) => {
        if (speaking) {
          chrome.tts.stop();
          btn.textContent = '🔊';
          btn.classList.remove('active');
          return;
        }
        speak();
      });
    });
    wrapper.appendChild(btn);

    if (state.autoSpeak) {
      chrome.tts.stop();
      setTimeout(speak, 50);
    }
  }

  appendNode(wrapper);
  return wrapper;
}

function addToolCard(toolUseId, name, input) {
  const div = document.createElement('div');
  div.className = 'tool-card';

  const header = document.createElement('div');
  const nameEl = document.createElement('span');
  nameEl.className = 'tool-name';
  nameEl.textContent = name.replace(/^mcp__[^_]+__/, '');
  const statusEl = document.createElement('span');
  statusEl.className = 'status';
  statusEl.textContent = 'running';
  statusEl.dataset.state = 'running';
  header.append(nameEl, statusEl);
  div.appendChild(header);

  if (input && Object.keys(input).length) {
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = 'arguments';
    details.appendChild(summary);
    const pre = document.createElement('pre');
    pre.textContent = JSON.stringify(input, null, 2);
    details.appendChild(pre);
    div.appendChild(details);
  }

  appendNode(div);
  state.toolCardsById.set(toolUseId, { card: div, status: statusEl });
  return div;
}

function addToolResult(toolUseId, content, isError) {
  const entry = state.toolCardsById.get(toolUseId);
  if (!entry) return;
  entry.status.textContent = isError ? 'error' : 'ok';
  entry.status.dataset.state = isError ? 'error' : 'ok';
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
  heading.className = 'heading';
  const shortName = event.toolName.replace(/^mcp__[^_]+__/, '');
  heading.append(document.createTextNode('Claude wants to run '));
  const b = document.createElement('b');
  b.textContent = shortName;
  heading.append(b, document.createTextNode('.'));
  div.appendChild(heading);

  const target = document.createElement('div');
  target.className = 'target';
  target.textContent = JSON.stringify(event.input, null, 2);
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
      // Ignore events from superseded sessions after 'New chat'.
      if (message.sessionId && state.sessionId && message.sessionId !== state.sessionId) return;
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
    setStatus(shortModel(result.model), 'ok');
    renderWelcome();
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
      if (event.total_cost_usd != null && event.num_turns > 1) {
        addMeta(`${event.num_turns} turns · $${event.total_cost_usd.toFixed(4)}`);
      }
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
  clearWelcome();
  addMessage('user', text);
  els.input.value = '';
  els.input.style.height = 'auto';
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
  if (ev.key === 'Enter' && !ev.shiftKey) {
    ev.preventDefault();
    els.composer.requestSubmit();
  }
});

els.input.addEventListener('input', () => {
  els.input.style.height = 'auto';
  els.input.style.height = Math.min(els.input.scrollHeight, 160) + 'px';
});

els.newChat.addEventListener('click', async () => {
  chrome.tts.stop();
  // Close the current session (if any) and reopen with current model/mode.
  if (state.sessionId) {
    try { await sendRpc('session.close', { sessionId: state.sessionId }); } catch { /* ignore */ }
    state.sessionId = null;
  }
  state.toolCardsById.clear();
  els.chat.innerHTML = '';
  state.running = false;
  els.send.disabled = false;
  els.abort.disabled = true;
  setStatus('reconnecting…');
  // The prior session.close triggered session.exit which leaves the runner gone.
  // Open a fresh session on the same panel port.
  await openSession();
});

els.quick.addEventListener('click', async () => {
  els.input.focus();
  if (!els.input.value.trim()) {
    els.input.placeholder = 'Quick task (Haiku + trust)…';
    return;
  }
  // Temporarily swap model to haiku + mode to trust for this turn.
  const prevModel = els.model.value;
  const prevMode = els.mode.value;
  els.model.value = 'haiku';
  els.mode.value = 'trust';
  if (state.sessionId) {
    try { await sendRpc('session.set_mode', { sessionId: state.sessionId, mode: 'trust' }); } catch { /* ignore */ }
  }
  els.composer.requestSubmit();
  // Restore UI (the session stays with whatever mode the user picked next).
  setTimeout(() => {
    els.model.value = prevModel;
    els.mode.value = prevMode;
  }, 100);
});

els.autoSpeak.addEventListener('change', () => {
  state.autoSpeak = els.autoSpeak.checked;
  chrome.storage?.local?.set({ autoSpeak: state.autoSpeak });
  if (!state.autoSpeak) chrome.tts.stop();
});

chrome.storage?.local?.get({ autoSpeak: false }, (prefs) => {
  state.autoSpeak = !!prefs.autoSpeak;
  els.autoSpeak.checked = state.autoSpeak;
});

connect();
