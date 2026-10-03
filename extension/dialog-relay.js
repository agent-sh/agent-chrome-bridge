'use strict';

// Isolated-world relay for page-hook.js. DOM events cross worlds
// synchronously, so the report leaves the renderer before a native dialog
// blocks the page.
(() => {
  if (globalThis.__agentChromeBridgeRelay) return;
  globalThis.__agentChromeBridgeRelay = true;

  document.addEventListener('__agent_chrome_bridge_dialog', (event) => {
    let entry;
    try {
      entry = JSON.parse(event.detail);
    } catch {
      return;
    }
    try {
      chrome.runtime.sendMessage({ type: 'agentChromeBridge.dialog', entry }).catch(() => {});
    } catch {
      // The extension may be reloading.
    }
  }, true);
})();
