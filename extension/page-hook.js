'use strict';

// Runs in the page (MAIN) world at document_start. It reports every
// alert/confirm/prompt to the bridge so the agent notices them without a
// debugger session, and answers them without blocking while an agent action is
// in flight. Outside an agent window the native dialog shows as usual.
(() => {
  if (window.__agentChromeBridgeDialogHook) return;
  Object.defineProperty(window, '__agentChromeBridgeDialogHook', { value: true });

  const REPORT_EVENT = '__agent_chrome_bridge_dialog';
  const CONTROL_EVENT = '__agent_chrome_bridge_control';
  const native = {
    alert: window.alert,
    confirm: window.confirm,
    prompt: window.prompt,
  };
  let agent = { until: 0, policy: null };

  document.addEventListener(CONTROL_EVENT, (event) => {
    try {
      const control = JSON.parse(event.detail);
      agent = {
        until: Date.now() + Math.max(0, Math.min(120000, Number(control.windowMs) || 0)),
        policy: control.policy || null,
      };
    } catch {
      // Ignore malformed control messages.
    }
  }, true);

  function report(entry) {
    try {
      document.dispatchEvent(new CustomEvent(REPORT_EVENT, { detail: JSON.stringify(entry) }));
    } catch {
      // Reporting must never break the page.
    }
  }

  function answer(type, policy, defaultPrompt) {
    if (type === 'alert') return { accepted: true, value: undefined };
    const accepted = policy ? policy.accept !== false : false;
    if (type === 'confirm') return { accepted, value: accepted };
    if (!accepted) return { accepted, value: null };
    const text = typeof policy.promptText === 'string' ? policy.promptText : defaultPrompt;
    return { accepted, value: text, userInput: text };
  }

  function wrap(type) {
    const original = native[type];
    if (typeof original !== 'function') return;
    const hooked = function (message, defaultPrompt) {
      const info = {
        type,
        message: String(message === undefined ? '' : message).slice(0, 2000),
        defaultPrompt: type === 'prompt' ? String(defaultPrompt === undefined ? '' : defaultPrompt) : undefined,
        url: location.href,
        at: Date.now(),
      };

      if (agent.until > Date.now()) {
        const policy = agent.policy;
        const result = answer(type, policy, info.defaultPrompt || '');
        if (policy?.once) agent.policy = null;
        report({
          ...info,
          phase: 'auto',
          accepted: result.accepted,
          userInput: result.userInput,
          policy: policy ? 'explicit' : 'default',
        });
        return result.value;
      }

      report({ ...info, phase: 'opening' });
      let value;
      try {
        value = original.apply(this, arguments);
      } finally {
        report({
          ...info,
          phase: 'closed',
          accepted: type === 'alert' ? true : type === 'confirm' ? value === true : value !== null,
          userInput: type === 'prompt' && typeof value === 'string' ? value : undefined,
        });
      }
      return value;
    };
    Object.defineProperty(hooked, 'name', { value: type });
    Object.defineProperty(hooked, 'toString', { value: () => `function ${type}() { [native code] }` });
    window[type] = hooked;
  }

  wrap('alert');
  wrap('confirm');
  wrap('prompt');

  // Chrome's popup blocker drops window.open without a user gesture (for
  // example after a synthetic element.click()) and only shows an omnibox icon.
  const nativeOpen = window.open;
  if (typeof nativeOpen === 'function') {
    const hookedOpen = function (url) {
      const opened = nativeOpen.apply(this, arguments);
      if (!opened) {
        let resolved = String(url === undefined ? '' : url);
        try {
          resolved = new URL(resolved, location.href).href;
        } catch {
          // Keep the raw value.
        }
        report({ type: 'popup', phase: 'blocked', url: resolved, at: Date.now() });
      }
      return opened;
    };
    Object.defineProperty(hookedOpen, 'name', { value: 'open' });
    Object.defineProperty(hookedOpen, 'toString', { value: () => 'function open() { [native code] }' });
    window.open = hookedOpen;
  }
})();
