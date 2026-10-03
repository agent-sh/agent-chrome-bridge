'use strict';

const HOST = 'dev.agent_chrome_bridge';
const CONTENT_SCRIPT_FILE = 'content-bridge.js';
const PAGE_HOOK_FILE = 'page-hook.js';
const DIALOG_RELAY_FILE = 'dialog-relay.js';
const CONTROL_EVENT = '__agent_chrome_bridge_control';
const BRIDGE_VERSION = chrome.runtime.getManifest().version;
const DEBUGGER_PROTOCOL_VERSION = '1.3';
const DIALOG_ACTION_GRACE_MS = 150;
// While an agent action runs (and this long after it), page dialogs are
// answered by the page hook instead of blocking the tab.
const AGENT_WINDOW_MS = 10000;
// The debugger is attached only for CDP tools and released after this much
// idle time, so Chrome's "started debugging this browser" bar goes away.
const DEBUGGER_IDLE_MS = 15000;
const MAX_NOTICES = 20;
let port = null;
let reconnectTimer = null;
let snapshotCounter = 0;
const snapshotCache = new Map();
const debuggerSessions = new Map();
const tabStates = new Map();

function connectNative() {
  if (port) return;

  try {
    port = chrome.runtime.connectNative(HOST);
  } catch {
    scheduleReconnect();
    return;
  }

  port.onMessage.addListener((message) => {
    if (message.type === 'response') return;
    dispatch(message).then(
      (result) => port?.postMessage({ id: message.id, result }),
      (error) => port?.postMessage({ id: message.id, error: error.message || String(error) }),
    );
  });

  port.onDisconnect.addListener(() => {
    // Reading runtime.lastError is required: Chrome records an "Unchecked
    // runtime.lastError: Native host has exited" extension error if a native
    // messaging port disconnects and the callback never inspects the error.
    // Reloading/upgrading the connector intentionally tears down the old native
    // host, so consume the diagnostic and reconnect instead of surfacing it as
    // an extension failure.
    const lastError = chrome.runtime.lastError;
    if (lastError && lastError.message) {
      console.warn(`native host disconnected: ${lastError.message}`);
    }
    port = null;
    scheduleReconnect();
  });
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectNative();
  }, 1000);
}


async function dispatch(message) {
  const params = message.params || {};
  switch (message.method) {
    case 'bridge.info':
      return bridgeInfo(params);
    case 'tabs.list':
      return tabsList(params);
    case 'tabs.active':
      return activeTab(params);
    case 'tabs.select':
      return tabSelect(params);
    case 'tabs.create':
      return tabCreate(params);
    case 'tabs.close':
      return tabClose(params);
    case 'tabs.reload':
      return tabReload(params);
    case 'tabs.back':
      return tabHistory(params, 'back');
    case 'tabs.forward':
      return tabHistory(params, 'forward');
    case 'page.snapshot':
      return pageSnapshot(params);
    case 'page.find':
      return pageFind(params);
    case 'page.extractLinks':
      return pageExtractLinks(params);
    case 'page.extractTables':
      return pageExtractTables(params);
    case 'page.readArticle':
      return pageReadArticle(params);
    case 'page.network':
      return pageNetwork(params);
    case 'page.navigate':
      return pageNavigate(params);
    case 'page.click':
      return pageClick(params);
    case 'page.type':
      return pageType(params);
    case 'page.scroll':
      return pageScroll(params);
    case 'page.waitForSelector':
      return pageWaitForSelector(params);
    case 'page.waitForText':
      return pageWaitForText(params);
    case 'page.waitUntilIdle':
      return pageWaitUntilIdle(params);
    case 'page.screenshot':
      return pageScreenshot(params);
    case 'cdp.health':
      return cdpHealth();
    case 'cdp.getDialog':
      return cdpGetDialog(params);
    case 'cdp.handleDialog':
      return cdpHandleDialog(params);
    case 'cdp.click':
      return cdpClick(params);
    case 'cdp.key':
      return cdpKey(params);
    case 'cdp.type':
      return cdpType(params);
    case 'cdp.console':
      return cdpConsole(params);
    default:
      throw new Error(`Unknown bridge method: ${message.method}`);
  }
}

async function bridgeInfo(params = {}) {
  const manifest = chrome.runtime.getManifest();
  const info = {
    extension: {
      id: chrome.runtime.id,
      name: manifest.name,
      version: manifest.version,
      backgroundVersion: BRIDGE_VERSION,
      manifestVersion: manifest.manifest_version,
      features: {
        cdpKeyCharEvent: true,
        modalDialogs: true,
        dialogHook: true,
        lazyDebugger: true,
        popupNotices: true,
        compactResults: true,
        nativeDisconnectLastErrorHandled: true,
      },
    },
    contentScript: {
      ok: false,
      error: 'No injectable tab found.',
    },
  };

  const probe = await resolveContentProbeTab(params);
  if (!probe?.tab) return info;

  try {
    const content = await Promise.race([
      executeContent(probe.tab.id, 'bridgeInfo'),
      delay(1000).then(() => {
        throw new Error('Content probe timed out; the tab may be blocked by a modal dialog.');
      }),
    ]);
    info.contentScript = {
      ok: true,
      tab: tabBrief(probe.tab),
      selection: probe.selection,
      ...content,
    };
  } catch (error) {
    info.contentScript = {
      ok: false,
      tab: tabBrief(probe.tab),
      selection: probe.selection,
      error: error.message || String(error),
    };
  }

  return info;
}

async function tabsList(params = {}) {
  const tabs = await chrome.tabs.query({});
  if (params.verbose === true) return tabs.map(tabSummary);
  return tabs.map((tab) => {
    const entry = { id: tab.id, windowId: tab.windowId, title: tab.title, url: tab.url };
    if (tab.active) entry.active = true;
    if (tab.openerTabId !== undefined) entry.openerTabId = tab.openerTabId;
    if (tab.status === 'loading') entry.loading = true;
    if (tabStates.get(tab.id)?.openDialog) entry.dialogOpen = true;
    return entry;
  });
}

async function activeTab(params = {}) {
  const tab = await resolveTab({});
  return params.verbose === true ? tabSummary(tab) : withNotices(tab.id, { tab: tabBrief(tab) });
}

async function tabSelect(params) {
  if (params.tabId === undefined || params.tabId === null) throw new Error('tabId is required');
  const tab = await chrome.tabs.update(Number(params.tabId), { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
  return withNotices(tab.id, { tab: tabBrief(tab) });
}

async function tabCreate(params) {
  const options = { active: params.active !== false };
  if (params.url) options.url = params.url;
  const created = await chrome.tabs.create(options);
  if (!params.url || params.wait === false) return { tab: tabBrief(created) };
  const load = await waitForTabLoad(created.id, loadTimeout(params), { sawLoading: true });
  return { tab: tabBrief(load.tab || created), loaded: load.loaded, waitedMs: load.waitedMs };
}

async function tabClose(params) {
  if (params.tabId === undefined || params.tabId === null) throw new Error('tabId is required');
  const tab = await chrome.tabs.get(Number(params.tabId));
  await chrome.tabs.remove(tab.id);
  forgetTab(tab.id);
  return { closed: true, tab: tabBrief(tab) };
}

async function tabReload(params) {
  const tab = await resolveTab(params);
  assertTabGuard(tab, params);
  const load = await navigateAndWait(tab.id, params, () => chrome.tabs.reload(tab.id, { bypassCache: params.bypassCache === true }));
  return withNotices(tab.id, { reloaded: true, ...load });
}

async function tabHistory(params, direction) {
  const tab = await resolveTab(params);
  assertTabGuard(tab, params);
  // history.back() in the page, not chrome.tabs.goBack(): the tabs API skips
  // entries Chrome marks as added without a user gesture, which includes
  // every agent navigation.
  const load = await navigateAndWait(tab.id, params, () => executeContent(
    tab.id,
    direction === 'back' ? 'historyBack' : 'historyForward',
    [],
    0,
  ));
  return withNotices(tab.id, { navigated: direction, ...load });
}

function loadTimeout(params) {
  return clampedNumberParam(params, 'timeoutMs', 15000, 0, 60000);
}

// Run a navigation and wait until the tab finishes loading, so the agent does
// not need a separate wait call after every navigate/reload/back.
async function navigateAndWait(tabId, params, action) {
  if (params.wait === false) {
    await action();
    return { tab: tabBrief(await chrome.tabs.get(tabId)) };
  }
  const waiter = waitForTabLoad(tabId, loadTimeout(params));
  try {
    await action();
  } catch (error) {
    waiter.cancel();
    throw error;
  }
  const load = await waiter;
  return { tab: tabBrief(load.tab || await chrome.tabs.get(tabId)), loaded: load.loaded, waitedMs: load.waitedMs };
}

function waitForTabLoad(tabId, timeoutMs, options = {}) {
  let cancel = () => {};
  const startedAt = Date.now();
  const promise = new Promise((resolve) => {
    let sawLoading = options.sawLoading === true;
    let finished = false;
    const finish = async (loaded) => {
      if (finished) return;
      finished = true;
      clearInterval(poll);
      chrome.tabs.onUpdated.removeListener(listener);
      const tab = await chrome.tabs.get(tabId).catch(() => null);
      resolve({ loaded, waitedMs: Date.now() - startedAt, tab });
    };
    const listener = (id, changeInfo) => {
      if (id !== tabId) return;
      if (changeInfo.status === 'loading') sawLoading = true;
      if (changeInfo.status === 'complete' && sawLoading) finish(true);
    };
    const poll = setInterval(async () => {
      if (Date.now() - startedAt >= timeoutMs) {
        finish(false);
        return;
      }
      // Same-document navigations (hash changes, history.pushState) never
      // report a loading status; settle on the tab's current state.
      if (!sawLoading && Date.now() - startedAt >= 600) {
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        if (!tab || tab.status === 'complete') finish(Boolean(tab));
      }
    }, 100);
    chrome.tabs.onUpdated.addListener(listener);
    cancel = () => finish(false);
  });
  promise.cancel = () => cancel();
  return promise;
}

async function resolveTab(params) {
  if (params.tabId !== undefined && params.tabId !== null) {
    return chrome.tabs.get(Number(params.tabId));
  }

  const focused = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (focused[0]) return focused[0];

  const current = await chrome.tabs.query({ active: true, currentWindow: true });
  if (current[0]) return current[0];

  throw new Error('No active Chrome tab found.');
}

function tabSummary(tab) {
  return {
    id: tab.id,
    windowId: tab.windowId,
    active: tab.active,
    highlighted: tab.highlighted,
    pinned: tab.pinned,
    audible: tab.audible,
    status: tab.status,
    title: tab.title,
    url: tab.url,
    openerTabId: tab.openerTabId,
  };
}

function tabBrief(tab) {
  const brief = { id: tab.id, title: tab.title, url: tab.url };
  if (tab.status === 'loading') brief.loading = true;
  return brief;
}

function assertTabGuard(tab, params) {
  if (!params.expectedHost && !params.expectedUrlIncludes) return;

  if (params.expectedUrlIncludes && !String(tab.url || '').includes(params.expectedUrlIncludes)) {
    throw new Error(`Tab guard failed: URL does not include ${params.expectedUrlIncludes}`);
  }

  if (params.expectedHost) {
    let host = '';
    try {
      host = new URL(tab.url || '').host;
    } catch {
      host = '';
    }
    if (host !== params.expectedHost) {
      throw new Error(`Tab guard failed: expected host ${params.expectedHost}, got ${host || '(none)'}`);
    }
  }
}

async function resolveContentProbeTab(params = {}) {
  if (params.tabId !== undefined && params.tabId !== null) {
    return { tab: await chrome.tabs.get(Number(params.tabId)), selection: 'requested' };
  }

  const active = await resolveTab({});
  if (isInjectableUrl(active.url)) return { tab: active, selection: 'active' };

  const tabs = await chrome.tabs.query({});
  const fallback = tabs.find((tab) => isInjectableUrl(tab.url));
  if (fallback) return { tab: fallback, selection: 'firstInjectable' };

  return { tab: active, selection: 'activeNonInjectable' };
}

function isInjectableUrl(url) {
  return /^(https?:|file:)/i.test(String(url || ''));
}

function numberParam(params, name, fallback) {
  const value = params[name];
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clampedNumberParam(params, name, fallback, min, max) {
  return Math.max(min, Math.min(max, numberParam(params, name, fallback)));
}

// ---- Per-tab state: page dialogs and popups reported to the agent ----

function tabState(tabId) {
  let state = tabStates.get(tabId);
  if (!state) {
    state = { openDialog: null, notices: [], dialogWaiters: new Set(), policy: null };
    tabStates.set(tabId, state);
  }
  return state;
}

function forgetTab(tabId) {
  snapshotCache.delete(tabId);
  tabStates.delete(tabId);
  const session = debuggerSessions.get(tabId);
  if (session?.idleTimer) clearTimeout(session.idleTimer);
  debuggerSessions.delete(tabId);
}

function pushNotice(tabId, notice) {
  const state = tabState(tabId);
  state.notices.push(notice);
  while (state.notices.length > MAX_NOTICES) state.notices.shift();
}

function takeNotices(tabId) {
  const state = tabStates.get(tabId);
  if (!state?.notices.length) return [];
  const notices = state.notices;
  state.notices = [];
  return notices;
}

// Attach unseen dialog/popup events, plus any dialog still blocking the tab, to
// a tab-scoped result. This is how the agent notices popups without polling.
function withNotices(tabId, result) {
  const notices = takeNotices(tabId);
  if (notices.length) result.notices = notices;
  const open = tabStates.get(tabId)?.openDialog;
  if (open) {
    result.dialogPending = true;
    result.dialog = dialogBrief(open);
  }
  return result;
}

function dialogBrief(entry) {
  if (!entry) return null;
  const brief = { type: entry.type, message: entry.message };
  if (entry.defaultPrompt) brief.defaultPrompt = entry.defaultPrompt;
  if (entry.frameUrl && entry.frameUrl !== entry.url) brief.frameUrl = entry.frameUrl;
  return brief;
}

function onHookMessage(message, sender) {
  if (message?.type !== 'agentChromeBridge.dialog') return;
  const tabId = sender.tab?.id;
  if (tabId === undefined) return;
  const entry = { ...message.entry, frameId: sender.frameId || 0 };
  const state = tabState(tabId);

  if (entry.phase === 'blocked') {
    pushNotice(tabId, {
      kind: 'popupBlocked',
      url: entry.url,
      hint: 'Chrome blocked a popup that had no user gesture. Retry the click with trusted:true, or open the url with chrome_new_tab.',
    });
    return;
  }

  if (entry.phase === 'opening') {
    state.openDialog = entry;
    resolveWaiters(state.dialogWaiters, entry);
    return;
  }

  if (entry.phase === 'closed') {
    if (state.openDialog?.at === entry.at) state.openDialog = null;
    // chrome_handle_dialog already reported this one.
    if (state.agentHandled === entry.at) {
      state.agentHandled = null;
      return;
    }
    pushNotice(tabId, {
      kind: 'dialog',
      ...dialogBrief(entry),
      handled: entry.accepted ? 'accepted' : 'dismissed',
      by: 'user',
      userInput: entry.userInput,
    });
    return;
  }

  if (entry.phase === 'auto') {
    if (entry.policy === 'explicit') state.policy = null;
    const notice = {
      kind: 'dialog',
      ...dialogBrief(entry),
      handled: entry.accepted ? 'accepted' : 'dismissed',
      by: entry.policy === 'explicit' ? 'onDialog' : 'default',
      userInput: entry.userInput,
    };
    if (entry.policy !== 'explicit' && entry.type !== 'alert') {
      notice.hint = 'Dismissed by default. Re-run the action with onDialog:"accept" (and promptText for prompts) to accept it.';
    }
    pushNotice(tabId, notice);
  }
}

function notePopup(openerTabId, tabId, windowId, url) {
  const state = tabState(openerTabId);
  state.popupsSeen = state.popupsSeen || new Set();
  if (state.popupsSeen.has(tabId)) return;
  state.popupsSeen.add(tabId);
  pushNotice(openerTabId, { kind: 'popup', tabId, windowId, url: url || undefined });
}

function onTabCreated(tab) {
  if (tab.openerTabId === undefined || tab.openerTabId === null) return;
  notePopup(tab.openerTabId, tab.id, tab.windowId, tab.pendingUrl || tab.url);
}

// Also covers noopener popups, which carry no openerTabId.
function onCreatedNavigationTarget(details) {
  chrome.tabs.get(details.tabId).then(
    (tab) => notePopup(details.sourceTabId, details.tabId, tab.windowId, details.url),
    () => notePopup(details.sourceTabId, details.tabId, undefined, details.url),
  );
}

// ---- Content script execution ----

function dialogPolicy(params) {
  const raw = params.onDialog;
  if (raw === undefined || raw === null || raw === 'default') return null;
  if (raw === 'accept' || raw === true) {
    return typeof params.promptText === 'string' ? { accept: true, promptText: params.promptText } : { accept: true };
  }
  if (raw === 'dismiss' || raw === false) return { accept: false };
  throw new Error('onDialog must be "accept", "dismiss", or "default"');
}

function controlFor(tabId, params = {}) {
  const explicit = dialogPolicy(params);
  const state = tabStates.get(tabId);
  let policy = explicit;
  if (!policy && state?.policy && state.policy.until > Date.now()) policy = state.policy.value;
  return JSON.stringify({ windowMs: AGENT_WINDOW_MS, policy });
}

function throwIfDialogPending(tabId) {
  const open = tabStates.get(tabId)?.openDialog;
  if (!open) return;
  throw new Error(`A ${open.type} dialog is open in tab ${tabId}: ${JSON.stringify(open.message)}. Call chrome_handle_dialog first.`);
}

async function injectBridge(target) {
  await Promise.all([
    chrome.scripting.executeScript({ target, files: [CONTENT_SCRIPT_FILE] }),
    // Tabs opened before the extension loaded have no static hook yet.
    chrome.scripting.executeScript({ target, files: [PAGE_HOOK_FILE], world: 'MAIN' }).catch(() => {}),
    chrome.scripting.executeScript({ target, files: [DIALOG_RELAY_FILE] }).catch(() => {}),
  ]);
}

function contentCall(target, method, args, control) {
  return chrome.scripting.executeScript({
    target,
    func: (methodName, methodArgs, version, controlEvent, controlDetail) => {
      const bridge = globalThis.__agentChromeBridge;
      if (!bridge || bridge.version !== version) return { __agentChromeBridgeMissing: true };
      if (controlDetail) document.dispatchEvent(new CustomEvent(controlEvent, { detail: controlDetail }));
      return bridge[methodName](...(methodArgs || []));
    },
    args: [method, args, BRIDGE_VERSION, CONTROL_EVENT, control || null],
  });
}

const isMissing = (entry) => entry?.result?.__agentChromeBridgeMissing === true;

async function executeContent(tabId, method, args = [], frameId = undefined, control = undefined) {
  throwIfDialogPending(tabId);
  const target = frameId === undefined || frameId === null
    ? { tabId }
    : { tabId, frameIds: [Number(frameId)] };
  let results = await contentCall(target, method, args, control);
  if (isMissing(results?.[0])) {
    await injectBridge(target);
    results = await contentCall(target, method, args, control);
  }
  return results?.[0]?.result;
}

async function executeContentAllFrames(tabId, method, args = []) {
  throwIfDialogPending(tabId);
  const target = { tabId, allFrames: true };
  let results = await contentCall(target, method, args);
  if (results.some(isMissing)) {
    await injectBridge(target);
    results = await contentCall(target, method, args);
  }
  return results
    .filter((entry) => entry?.result && !isMissing(entry))
    .map((entry) => ({ frameId: entry.frameId || 0, result: entry.result }));
}

async function runContent(tabId, method, args, params) {
  if (params.frameId !== undefined && params.frameId !== null) {
    return [{ frameId: Number(params.frameId), result: await executeContent(tabId, method, args, params.frameId) }];
  }
  if (params.includeFrames === false) {
    return [{ frameId: 0, result: await executeContent(tabId, method, args, 0) }];
  }
  return executeContentAllFrames(tabId, method, args);
}

function combineFrameResults(frames, options = {}) {
  const main = frames.find((frame) => frame.frameId === 0)?.result || frames[0]?.result || {};
  const elements = frames.flatMap((frame) => (frame.result.elements || []).map((element) => ({
    ...element,
    frameId: frame.frameId,
    frameUrl: frame.result.url,
    frameTitle: frame.result.title,
  })));
  const text = frames
    .map((frame) => frame.result.text)
    .filter(Boolean)
    .join('\n\n');
  const modalFrame = frames.find((frame) => frame.result.modal);

  return {
    ...main,
    text: text || main.text || '',
    textLength: frames.reduce((sum, frame) => sum + (frame.result.textLength || 0), 0) || undefined,
    modal: modalFrame ? { ...modalFrame.result.modal, frameId: modalFrame.frameId } : null,
    elements,
    frames: frames.map((frame) => ({
      frameId: frame.frameId,
      title: frame.result.title,
      url: frame.result.url,
      readyState: frame.result.readyState,
      elementCount: frame.result.elements?.length || 0,
    })),
    frameCount: frames.length,
    includeFrames: options.includeFrames !== false,
  };
}

function combineListFrames(frames, key) {
  const main = frames.find((frame) => frame.frameId === 0)?.result || frames[0]?.result || {};
  const items = frames.flatMap((frame) => (frame.result[key] || []).map((item) => ({
    ...item,
    frameId: frame.frameId,
    frameUrl: frame.result.url,
    frameTitle: frame.result.title,
  })));
  return {
    title: main.title,
    url: main.url,
    [key]: items,
    frames: frames.map((frame) => ({ frameId: frame.frameId, title: frame.result.title, url: frame.result.url })),
    frameCount: frames.length,
  };
}

// Snapshot and find ids live side by side (e* and f*), so a find does not
// invalidate the ids from the last snapshot.
function cacheElements(tabId, snapshot, prefix) {
  const snapshotId = `snapshot-${Date.now()}-${++snapshotCounter}`;
  const previous = snapshotCache.get(tabId);
  const elements = new Map();
  if (previous) {
    for (const [id, element] of previous.elements) {
      if (!id.startsWith(prefix)) elements.set(id, element);
    }
  }
  const enriched = (snapshot.elements || []).map((element, index) => {
    const id = `${prefix}${index + 1}`;
    const next = { id, ...element };
    elements.set(id, next);
    return next;
  });

  const cached = {
    snapshotId,
    cachedAt: new Date().toISOString(),
    elements,
  };
  snapshotCache.set(tabId, cached);

  return {
    ...snapshot,
    snapshotId,
    cachedAt: cached.cachedAt,
    elements: enriched,
  };
}

function targetFromCache(tabId, elementId) {
  const cache = snapshotCache.get(tabId);
  const element = cache?.elements?.get(elementId);
  if (!element) {
    throw new Error(`Unknown elementId ${elementId}. Run chrome_snapshot or chrome_find for this tab first.`);
  }
  return {
    selector: element.selector,
    elementId,
    frameId: element.frameId,
    ref: element.ref,
  };
}

async function resolveClickTarget(tabId, params) {
  if (params.selector) return { selector: params.selector, frameId: params.frameId };
  if (params.elementId) return targetFromCache(tabId, params.elementId);
  if (params.text) {
    const frames = await runContent(tabId, 'findElements', [{
      text: params.text,
      exact: params.exact === true,
      role: params.role,
      limit: Number(params.index || 0) + 1,
      includeShadow: params.includeShadow !== false,
    }], params);
    const combined = combineFrameResults(frames, params);
    const match = combined.elements[Number(params.index || 0)];
    if (!match) throw new Error(`No clickable element found for text: ${params.text}`);
    return { ref: match.ref, selector: match.selector, frameId: match.frameId };
  }
  throw new Error('selector, elementId, or text is required');
}

async function resolveTypeTarget(tabId, params) {
  if (params.selector) return { selector: params.selector, frameId: params.frameId };
  if (params.elementId) return targetFromCache(tabId, params.elementId);
  if (params.targetText || params.placeholder || params.name) {
    const frames = await runContent(tabId, 'findTypeableElements', [{
      text: params.targetText,
      exact: params.exact === true,
      placeholder: params.placeholder,
      name: params.name,
      limit: Number(params.index || 0) + 1,
      includeShadow: params.includeShadow !== false,
    }], params);
    const combined = combineFrameResults(frames, params);
    const match = combined.elements[Number(params.index || 0)];
    if (!match) throw new Error('No typeable element found for target');
    return { ref: match.ref, selector: match.selector, frameId: match.frameId };
  }
  throw new Error('selector, elementId, targetText, placeholder, or name is required');
}

// ---- Compact rendering: one line per element instead of a JSON object ----

function quote(text, max) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return JSON.stringify(value.length > max ? `${value.slice(0, max - 1)}…` : value);
}

function shortHref(href, pageUrl) {
  if (!href) return '';
  try {
    const url = new URL(href);
    const page = new URL(pageUrl);
    if (url.origin === page.origin) return `${url.pathname}${url.search}${url.hash}` || '/';
    return href.length > 100 ? `${href.slice(0, 99)}…` : href;
  } catch {
    return href.length > 100 ? `${href.slice(0, 99)}…` : href;
  }
}

function elementLine(element, pageUrl) {
  const kind = element.role || element.tag;
  const type = element.type && element.tag === 'input' ? `[${element.type}]` : '';
  const parts = [`${element.id} ${kind}${type}`];
  parts.push(quote(element.text, 80));
  if (element.name && (element.tag === 'input' || element.tag === 'textarea' || element.tag === 'select')) {
    parts.push(`name=${element.name}`);
  }
  if (element.value !== undefined) parts.push(`value=${quote(element.value, 40)}`);
  if (element.href && element.tag === 'a') parts.push(`-> ${shortHref(element.href, pageUrl)}`);
  if (element.checked !== undefined) parts.push(element.checked ? 'checked' : 'unchecked');
  if (element.expanded !== undefined) parts.push(element.expanded ? 'expanded' : 'collapsed');
  if (element.disabled) parts.push('disabled');
  if (element.offscreen) parts.push('offscreen');
  if (element.inModal) parts.push('modal');
  if (element.frameId) parts.push(`frame=${element.frameId}`);
  return parts.join(' ');
}

function elementBrief(element, pageUrl) {
  if (!element) return undefined;
  return elementLine({ ...element, id: element.id || '' }, pageUrl).trim();
}

function compactPage(tab, combined, options = {}) {
  const result = {
    tab: tabBrief(tab),
  };
  if (combined.modal) result.modal = combined.modal;
  if (options.includeText !== false) {
    result.text = combined.text;
    if (combined.textLength && combined.textLength > combined.text.length) {
      result.textTruncated = `${combined.text.length}/${combined.textLength} chars; raise maxText or use chrome_read_article`;
    }
  }
  if (combined.scroll && combined.scroll.maxY > 0) {
    result.scroll = `${combined.scroll.y}/${combined.scroll.maxY}`;
  }
  result.elements = combined.elements.map((element) => elementLine(element, tab.url)).join('\n');
  const otherFrames = (combined.frames || []).filter((frame) => frame.frameId !== 0 && frame.elementCount);
  if (otherFrames.length) {
    result.frames = otherFrames.map((frame) => `frame=${frame.frameId} ${frame.url}`).join('\n');
  }
  return result;
}

async function pageSnapshot(params) {
  const tab = await resolveTab(params);
  const verbose = params.verbose === true;
  const frames = await runContent(tab.id, 'snapshotPage', [{
    maxText: clampedNumberParam(params, 'maxText', verbose ? 12000 : 6000, 0, 50000),
    maxElements: clampedNumberParam(params, 'maxElements', 120, 0, 500),
    includeShadow: params.includeShadow !== false,
  }], params);
  const snapshot = cacheElements(tab.id, combineFrameResults(frames, params), 'e');
  if (verbose) return withNotices(tab.id, { tab: tabSummary(tab), snapshot });
  return withNotices(tab.id, compactPage(tab, snapshot));
}

async function pageFind(params) {
  const tab = await resolveTab(params);
  const frames = await runContent(tab.id, 'findElements', [{
    selector: params.selector,
    text: params.text,
    exact: params.exact === true,
    role: params.role,
    tag: params.tag,
    placeholder: params.placeholder,
    name: params.name,
    href: params.href,
    limit: Number(params.limit || 20),
    includeShadow: params.includeShadow !== false,
  }], params);
  const result = cacheElements(tab.id, combineFrameResults(frames, params), 'f');
  if (params.verbose === true) return withNotices(tab.id, { tab: tabSummary(tab), result });
  const compact = compactPage(tab, result, { includeText: false });
  delete compact.scroll;
  if (!result.elements.length) compact.elements = '(no matches)';
  return withNotices(tab.id, compact);
}

async function pageExtractLinks(params) {
  const tab = await resolveTab(params);
  const frames = await runContent(tab.id, 'extractLinks', [{
    text: params.text,
    exact: params.exact === true,
    href: params.href,
    limit: Number(params.limit || 200),
    visible: params.visible !== false,
    includeShadow: params.includeShadow !== false,
  }], params);
  const result = combineListFrames(frames, 'links');
  if (params.verbose === true) return { tab: tabSummary(tab), result };
  const seen = new Set();
  const lines = [];
  for (const link of result.links) {
    const key = `${link.text}|${link.href}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(`${quote(link.text, 80)} -> ${shortHref(link.href, tab.url)}${link.frameId ? ` frame=${link.frameId}` : ''}`);
  }
  return withNotices(tab.id, { tab: tabBrief(tab), count: lines.length, links: lines.join('\n') });
}

async function pageExtractTables(params) {
  const tab = await resolveTab(params);
  const frames = await runContent(tab.id, 'extractTables', [{
    limit: Number(params.limit || 20),
    maxRows: Number(params.maxRows || 50),
    visible: params.visible !== false,
    includeShadow: params.includeShadow !== false,
  }], params);
  const result = combineListFrames(frames, 'tables');
  if (params.verbose === true) return { tab: tabSummary(tab), result };
  const tables = result.tables.map((table) => {
    const compact = { rows: table.rows };
    if (table.caption) compact.caption = table.caption;
    if (table.headers.length && JSON.stringify(table.headers) !== JSON.stringify(table.rows[0])) compact.headers = table.headers;
    if (table.frameId) compact.frameId = table.frameId;
    return compact;
  });
  return withNotices(tab.id, { tab: tabBrief(tab), tables });
}

async function pageReadArticle(params) {
  const tab = await resolveTab(params);
  const frames = await runContent(tab.id, 'readArticle', [{
    maxText: clampedNumberParam(params, 'maxText', 30000, 0, 100000),
    includeShadow: params.includeShadow !== false,
  }], { ...params, includeFrames: params.includeFrames === true });
  const articles = frames.map((frame) => ({ frameId: frame.frameId, ...frame.result }));
  const best = articles.slice().sort((left, right) => (right.textLength || 0) - (left.textLength || 0))[0] || null;
  if (params.verbose === true) {
    return { tab: tabSummary(tab), article: best, frames: articles.map((article) => ({ frameId: article.frameId, title: article.title, url: article.url, textLength: article.textLength })) };
  }
  const result = { tab: tabBrief(tab), text: best?.text || '' };
  if (best && best.textLength > result.text.length) result.textTruncated = `${result.text.length}/${best.textLength} chars`;
  if (best?.selection) result.selection = best.selection;
  return withNotices(tab.id, result);
}

async function pageNetwork(params) {
  const tab = await resolveTab(params);
  const frames = await runContent(tab.id, 'getNetworkEntries', [{
    limit: Number(params.limit || 200),
  }], params);
  const result = combineListFrames(frames, 'entries');
  if (params.verbose === true) return { tab: tabSummary(tab), result };
  const lines = result.entries.map((entry) => [
    entry.responseStatus || '-',
    `${entry.duration}ms`,
    entry.transferSize ? `${Math.round(entry.transferSize / 1024)}KB` : '0KB',
    entry.initiatorType,
    entry.name.length > 160 ? `${entry.name.slice(0, 159)}…` : entry.name,
  ].join(' '));
  return { tab: tabBrief(tab), entries: lines.join('\n') };
}

async function pageNavigate(params) {
  if (!params.url) throw new Error('url is required');
  const tab = await resolveTab(params);
  assertTabGuard(tab, params);
  const load = await navigateAndWait(tab.id, params, () => chrome.tabs.update(tab.id, { url: params.url }));
  return withNotices(tab.id, load);
}

async function pageClick(params) {
  const tab = await resolveTab(params);
  assertTabGuard(tab, params);
  const target = await resolveClickTarget(tab.id, params);
  if (params.trusted === true) return trustedClick(tab, target, params);
  const outcome = await runDialogAwareAction(
    tab.id,
    () => executeContent(tab.id, 'clickTarget', [target], target.frameId, controlFor(tab.id, params)),
  );
  return actionResult(tab, { clicked: true }, outcome, params);
}

async function pageType(params) {
  if (typeof params.text !== 'string') throw new Error('text is required');
  const tab = await resolveTab(params);
  assertTabGuard(tab, params);
  const target = await resolveTypeTarget(tab.id, params);
  const outcome = await runDialogAwareAction(
    tab.id,
    () => executeContent(tab.id, 'typeIntoTarget', [
      target,
      params.text,
      params.replace !== false,
      params.submit === true,
    ], target.frameId, controlFor(tab.id, params)),
  );
  return actionResult(tab, { typed: true }, outcome, params);
}

// Click through CDP at the element's center. Some sites ignore synthetic
// element.click() and need a real (trusted) mouse event.
async function trustedClick(tab, target, params) {
  if (target.frameId) throw new Error('trusted clicks support main-frame elements only');
  const center = await executeContent(tab.id, 'elementCenter', [target], 0, controlFor(tab.id, params));
  const result = await cdpClick({ ...params, tabId: tab.id, x: center.x, y: center.y });
  result.target = elementBrief(center.target, tab.url);
  result.trusted = true;
  return result;
}

async function pageScroll(params) {
  const tab = await resolveTab(params);
  assertTabGuard(tab, params);
  const result = await executeContent(tab.id, 'scrollPage', [
    Number(params.x || 0),
    Number(params.y === undefined ? 700 : params.y),
  ], params.frameId);
  return withNotices(tab.id, { tab: tabBrief(tab), ...result });
}

async function pageWaitForSelector(params) {
  if (!params.selector) throw new Error('selector is required');
  const tab = await resolveTab(params);
  assertTabGuard(tab, params);
  const result = await executeContent(tab.id, 'waitForSelectorInPage', [
    params.selector,
    params.visible !== false,
    Number(params.timeoutMs || 10000),
  ], params.frameId);
  if (params.verbose !== true && result?.target) result.target = elementBrief(result.target, tab.url);
  return withNotices(tab.id, { tab: tabBrief(tab), ...result });
}

async function pageWaitForText(params) {
  if (!params.text) throw new Error('text is required');
  const tab = await resolveTab(params);
  assertTabGuard(tab, params);
  const result = await executeContent(tab.id, 'waitForTextInPage', [
    params.text,
    params.exact === true,
    Number(params.timeoutMs || 10000),
  ], params.frameId);
  return withNotices(tab.id, { tab: tabBrief(tab), ...result });
}

async function pageWaitUntilIdle(params) {
  const tab = await resolveTab(params);
  assertTabGuard(tab, params);
  const result = await executeContent(tab.id, 'waitUntilIdleInPage', [
    Number(params.idleMs || 500),
    Number(params.timeoutMs || 10000),
  ], params.frameId);
  return withNotices(tab.id, { tab: tabBrief(tab), ...result });
}

async function pageScreenshot(params) {
  const tab = await resolveTab(params);
  const format = params.format === 'png' ? 'png' : 'jpeg';
  const quality = clampedNumberParam(params, 'quality', 70, 10, 100);
  const maxWidth = clampedNumberParam(params, 'maxWidth', 1280, 200, 4000);
  if (!tab.active) {
    throw new Error(`Tab ${tab.id} is not the visible tab in its window; call chrome_select_tab first.`);
  }
  let dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, format === 'png' ? { format } : { format, quality });
  let size = null;
  try {
    const scaled = await downscaleDataUrl(dataUrl, format, quality, maxWidth);
    dataUrl = scaled.dataUrl;
    size = scaled.size;
  } catch (error) {
    console.warn(`screenshot downscale failed: ${error.message || error}`);
  }
  const mimeType = format === 'png' ? 'image/png' : 'image/jpeg';
  // cssSize is the coordinate space for chrome_cdp_click.
  const cssSize = tab.width && tab.height ? { width: tab.width, height: tab.height } : undefined;
  return withNotices(tab.id, { tab: tabBrief(tab), mimeType, size, cssSize, dataUrl });
}

// Device-pixel screenshots are often 2x the CSS viewport. Scale them down so
// the image costs fewer model tokens; CSS coordinates stay derivable from
// size.cssWidth.
async function downscaleDataUrl(dataUrl, format, quality, maxWidth) {
  if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap === 'undefined') {
    return { dataUrl, size: null };
  }
  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, maxWidth / bitmap.width);
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);
  if (scale === 1) {
    bitmap.close?.();
    return { dataUrl, size: { width, height } };
  }
  const canvas = new OffscreenCanvas(width, height);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  const out = await canvas.convertToBlob(format === 'png' ? { type: 'image/png' } : { type: 'image/jpeg', quality: quality / 100 });
  const bytes = new Uint8Array(await out.arrayBuffer());
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return { dataUrl: `data:${out.type};base64,${btoa(binary)}`, size: { width, height } };
}

function actionResult(tab, base, outcome, params = {}) {
  const value = outcome.value || {};
  const result = { ...base, tab: tabBrief(tab) };
  if (value.page) {
    result.tab.url = value.page.url;
    result.tab.title = value.page.title;
    if (value.page.modal) result.modal = value.page.modal;
  }
  if (value.target) result.target = params.verbose === true ? value.target : elementBrief(value.target, tab.url);
  if (value.submitted) result.submitted = true;
  if (outcome.actionPending) result.completed = false;
  return withNotices(tab.id, result);
}

// Race the action against a native dialog opening. Inside the agent window
// the page hook answers dialogs without blocking, but a dialog from another
// frame (or one the hook missed) can still block the tab; report it instead
// of hanging until the broker times out.
async function runDialogAwareAction(tabId, action) {
  const state = tabState(tabId);
  if (state.openDialog) return { dialog: state.openDialog, actionPending: false };

  const signal = eventSignal(state.dialogWaiters);
  let settled = false;
  const tracked = Promise.resolve().then(action).then(
    (value) => {
      settled = true;
      return { kind: 'result', value };
    },
    (error) => {
      settled = true;
      return { kind: 'error', error };
    },
  );

  try {
    const first = await Promise.race([
      tracked,
      signal.promise.then((dialog) => ({ kind: 'dialog', dialog })),
    ]);
    if (first.kind === 'dialog') return { dialog: first.dialog, actionPending: !settled };
    if (first.kind === 'error') throw first.error;
    return { dialog: null, actionPending: false, value: first.value };
  } finally {
    signal.cancel();
  }
}

function resolveWaiters(waiters, value) {
  for (const waiter of waiters) waiter(value);
  waiters.clear();
}

function eventSignal(waiters) {
  let active = true;
  let resolvePromise;
  const waiter = (value) => {
    if (!active) return;
    active = false;
    waiters.delete(waiter);
    resolvePromise(value);
  };
  const promise = new Promise((resolve) => {
    resolvePromise = resolve;
    waiters.add(waiter);
  });
  return {
    promise,
    cancel() {
      if (!active) return;
      active = false;
      waiters.delete(waiter);
    },
  };
}

async function waitForHookDialog(state, timeoutMs) {
  if (state.openDialog) return state.openDialog;
  if (timeoutMs <= 0) return null;
  const signal = eventSignal(state.dialogWaiters);
  try {
    return await Promise.race([signal.promise, delay(timeoutMs).then(() => null)]);
  } finally {
    signal.cancel();
  }
}

// Put the page hook into agent mode without running a content method, for
// CDP input and for pre-arming chrome_handle_dialog.
async function armTab(tabId, control) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: (controlEvent, controlDetail) => {
        document.dispatchEvent(new CustomEvent(controlEvent, { detail: controlDetail }));
      },
      args: [CONTROL_EVENT, control],
      world: 'MAIN',
    });
  } catch {
    // Non-injectable pages have no hook to arm.
  }
}

// ---- Dialog tools: hook-based, no debugger needed to observe ----

async function cdpGetDialog(params) {
  const tab = await resolveTab(params);
  assertTabGuard(tab, params);
  const timeoutMs = clampedNumberParam(params, 'timeoutMs', 500, 0, 10000);
  const state = tabState(tab.id);
  const open = await waitForHookDialog(state, timeoutMs);
  const result = { tab: tabBrief(tab), dialog: dialogBrief(open) };
  const notices = takeNotices(tab.id);
  if (notices.length) result.notices = notices;
  return result;
}

async function cdpHandleDialog(params) {
  const tab = await resolveTab(params);
  assertTabGuard(tab, params);
  if (typeof params.accept !== 'boolean') throw new Error('accept must be true or false');
  if (params.promptText !== undefined && typeof params.promptText !== 'string') {
    throw new Error('promptText must be a string');
  }

  const timeoutMs = clampedNumberParam(params, 'timeoutMs', 100, 0, 10000);
  const state = tabState(tab.id);
  const open = await waitForHookDialog(state, timeoutMs);

  if (!open) {
    // Nothing is showing: arm the answer for the next dialog in this tab.
    const armMs = clampedNumberParam(params, 'armMs', 30000, 1000, 120000);
    const policy = { accept: params.accept, once: true };
    if (params.promptText !== undefined) policy.promptText = params.promptText;
    state.policy = { value: policy, until: Date.now() + armMs };
    await armTab(tab.id, JSON.stringify({ windowMs: armMs, policy }));
    return {
      tab: tabBrief(tab),
      handled: false,
      armed: true,
      note: `No dialog is open. The next dialog in this tab within ${Math.round(armMs / 1000)}s will be ${params.accept ? 'accepted' : 'dismissed'}.`,
    };
  }

  // A native dialog is blocking the page. Only CDP can close it.
  const command = { accept: params.accept };
  if (params.promptText !== undefined) command.promptText = params.promptText;
  state.agentHandled = open.at;
  try {
    const session = await attachDebuggerSession(tab.id);
    await withTimeout(startPageMonitoring(session), 1500, 'Page.enable timed out');
    await cdpSend(session.target, 'Page.handleJavaScriptDialog', command);
    touchDebugger(session);
  } catch (error) {
    state.agentHandled = null;
    // Chrome lets CDP answer only dialogs that opened while the debugger was
    // already attached, and the bridge no longer keeps it attached.
    throw new Error(`A ${open.type} dialog opened outside an agent action (${JSON.stringify(open.message)}) and only the user can answer it: ask them to click OK/Cancel in Chrome, or reload the tab. (${error.message || error})`);
  }
  state.openDialog = null;
  return {
    tab: tabBrief(tab),
    dialog: dialogBrief(open),
    handled: true,
    accepted: params.accept,
    userInput: params.accept && open.type === 'prompt' ? (params.promptText ?? open.defaultPrompt) : undefined,
  };
}

function withTimeout(promise, ms, message) {
  return Promise.race([promise, delay(ms).then(() => { throw new Error(message); })]);
}

// ---- CDP: attached on demand, released after DEBUGGER_IDLE_MS ----

function cdpHealth() {
  return {
    debuggerApiAvailable: Boolean(chrome.debugger),
    attachedTabs: [...debuggerSessions.values()].filter((session) => session.attached).map((session) => session.tabId),
    idleDetachMs: DEBUGGER_IDLE_MS,
    note: chrome.debugger
      ? 'Dialogs and popups are observed without the debugger. CDP tools attach on demand and detach after idle, so Chrome shows its debugging bar only while they run.'
      : 'Chrome debugger API is unavailable. Reload the extension after granting the debugger permission.',
  };
}

function createDebuggerSession(tabId) {
  return {
    tabId,
    target: { tabId },
    attached: false,
    attachPromise: null,
    pageEnabled: false,
    pageEnablePromise: null,
    idleTimer: null,
  };
}

async function attachDebuggerSession(tabId) {
  if (!chrome.debugger) throw new Error('Chrome debugger API is unavailable. Reload the extension after granting debugger permission.');

  let session = debuggerSessions.get(tabId);
  if (session?.attached) return session;
  if (session?.attachPromise) return session.attachPromise;

  session = createDebuggerSession(tabId);
  debuggerSessions.set(tabId, session);
  session.attachPromise = (async () => {
    await chrome.debugger.attach(session.target, DEBUGGER_PROTOCOL_VERSION);
    session.attached = true;
    return session;
  })();

  try {
    return await session.attachPromise;
  } catch (error) {
    debuggerSessions.delete(tabId);
    throw error;
  }
}

function touchDebugger(session) {
  if (session.idleTimer) clearTimeout(session.idleTimer);
  session.idleTimer = setTimeout(() => detachDebugger(session.tabId), DEBUGGER_IDLE_MS);
}

async function detachDebugger(tabId) {
  const session = debuggerSessions.get(tabId);
  if (!session) return;
  if (session.idleTimer) clearTimeout(session.idleTimer);
  debuggerSessions.delete(tabId);
  if (session.attached) await chrome.debugger.detach(session.target).catch(() => {});
}

async function withDebugger(tabId, run) {
  const session = await attachDebuggerSession(tabId);
  if (session.idleTimer) clearTimeout(session.idleTimer);
  try {
    return await run(session.target);
  } finally {
    touchDebugger(session);
  }
}

async function cdpSend(target, method, params = {}) {
  return chrome.debugger.sendCommand(target, method, params);
}

function startPageMonitoring(session) {
  if (session.pageEnabled) return Promise.resolve(true);
  if (session.pageEnablePromise) return session.pageEnablePromise;

  session.pageEnablePromise = cdpSend(session.target, 'Page.enable').then(
    () => {
      session.pageEnabled = true;
      return true;
    },
    (error) => {
      session.pageEnablePromise = null;
      throw error;
    },
  );
  session.pageEnablePromise.catch(() => {});
  return session.pageEnablePromise;
}

function onDebuggerDetach(source) {
  if (source.tabId === undefined || source.tabId === null) return;
  const session = debuggerSessions.get(source.tabId);
  if (session?.idleTimer) clearTimeout(session.idleTimer);
  debuggerSessions.delete(source.tabId);
}

async function cdpAction(params, base, run) {
  const tab = await resolveTab(params);
  assertTabGuard(tab, params);
  await armTab(tab.id, controlFor(tab.id, params));
  const outcome = await runDialogAwareAction(tab.id, () => withDebugger(tab.id, run));
  if (!outcome.dialog) await delay(DIALOG_ACTION_GRACE_MS);
  const fresh = await chrome.tabs.get(tab.id).catch(() => tab);
  return actionResult(fresh, base, outcome, params);
}

async function cdpClick(params) {
  if (params.x === undefined || params.y === undefined) throw new Error('x and y are required');
  const x = Number(params.x);
  const y = Number(params.y);
  const button = params.button || 'left';
  const clickCount = Number(params.clickCount || 1);
  return cdpAction(params, { clicked: true, x, y }, async (target) => {
    await cdpSend(target, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
    await cdpSend(target, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount });
    await cdpSend(target, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount });
  });
}

// CDP Input.dispatchKeyEvent modifier bitmask: Alt=1, Ctrl=2, Meta/Cmd=4, Shift=8
const CDP_MODIFIER_BITS = {
  alt: 1,
  ctrl: 2,
  control: 2,
  meta: 4,
  cmd: 4,
  command: 4,
  super: 4,
  win: 4,
  shift: 8,
};

function resolveCdpModifiers(params) {
  let bits = 0;
  if (params.modifiers !== undefined && params.modifiers !== null) {
    const n = Number(params.modifiers);
    if (!Number.isFinite(n) || n < 0) throw new Error('modifiers must be a non-negative number');
    bits |= n & 0xf;
  }
  if (Array.isArray(params.modifierKeys)) {
    for (const raw of params.modifierKeys) {
      if (raw == null) continue;
      const key = String(raw).toLowerCase().trim();
      if (!key) continue;
      const bit = CDP_MODIFIER_BITS[key];
      if (bit === undefined) throw new Error(`unknown modifier key: ${raw}`);
      bits |= bit;
    }
  }
  return bits;
}

function cdpKeyDescriptor(params, modifiers) {
  const rawKey = String(params.key);
  const alias = rawKey.toLowerCase().trim();
  let key = rawKey;
  let code = params.code || rawKey;
  let text = '';
  let windowsVirtualKeyCode = 0;

  if (rawKey === ' ' || alias === 'space' || alias === 'spacebar') {
    key = ' ';
    code = params.code || 'Space';
    text = ' ';
    windowsVirtualKeyCode = 32;
  } else if ([...rawKey].length === 1 && rawKey >= ' ' && rawKey !== '\u007f') {
    text = rawKey;
    const upper = rawKey.toUpperCase();
    if (/^[A-Z]$/.test(upper)) {
      code = params.code || `Key${upper}`;
      windowsVirtualKeyCode = upper.charCodeAt(0);
    } else if (/^[0-9]$/.test(rawKey)) {
      code = params.code || `Digit${rawKey}`;
      windowsVirtualKeyCode = rawKey.charCodeAt(0);
    }
  } else {
    const named = {
      enter: ['Enter', 'Enter', 13],
      return: ['Enter', 'Enter', 13],
      tab: ['Tab', 'Tab', 9],
      escape: ['Escape', 'Escape', 27],
      esc: ['Escape', 'Escape', 27],
      backspace: ['Backspace', 'Backspace', 8],
      delete: ['Delete', 'Delete', 46],
      arrowleft: ['ArrowLeft', 'ArrowLeft', 37],
      left: ['ArrowLeft', 'ArrowLeft', 37],
      arrowup: ['ArrowUp', 'ArrowUp', 38],
      up: ['ArrowUp', 'ArrowUp', 38],
      arrowright: ['ArrowRight', 'ArrowRight', 39],
      right: ['ArrowRight', 'ArrowRight', 39],
      arrowdown: ['ArrowDown', 'ArrowDown', 40],
      down: ['ArrowDown', 'ArrowDown', 40],
    }[alias];
    if (named) {
      [key, code, windowsVirtualKeyCode] = named;
      code = params.code || code;
    }
  }

  // Printable characters should produce a CDP `char` event in addition to the
  // keydown/up pair. Without this, focused text editors receive a Space keydown
  // but do not insert an actual space, which made browser notepad-style pages
  // collapse "a b" into "ab".
  if (modifiers & (CDP_MODIFIER_BITS.ctrl | CDP_MODIFIER_BITS.meta | CDP_MODIFIER_BITS.alt)) {
    text = '';
  }

  const event = { key, code, modifiers };
  if (windowsVirtualKeyCode) {
    event.windowsVirtualKeyCode = windowsVirtualKeyCode;
    event.nativeVirtualKeyCode = windowsVirtualKeyCode;
  }
  return { event, text, key, code };
}

async function cdpKey(params) {
  if (!params.key) throw new Error('key is required');
  const modifiers = resolveCdpModifiers(params);
  const descriptor = cdpKeyDescriptor(params, modifiers);
  return cdpAction(params, { pressed: descriptor.key, modifiers: modifiers || undefined }, async (target) => {
    await cdpSend(target, 'Input.dispatchKeyEvent', { ...descriptor.event, type: 'rawKeyDown' });
    if (descriptor.text) {
      await cdpSend(target, 'Input.dispatchKeyEvent', {
        ...descriptor.event,
        type: 'char',
        text: descriptor.text,
        unmodifiedText: descriptor.text,
      });
    }
    await cdpSend(target, 'Input.dispatchKeyEvent', { ...descriptor.event, type: 'keyUp' });
  });
}

async function cdpType(params) {
  if (typeof params.text !== 'string') throw new Error('text is required');
  return cdpAction(params, { typed: true, length: params.text.length }, async (target) => {
    await cdpSend(target, 'Input.insertText', { text: params.text });
  });
}

async function cdpConsole(params) {
  const tab = await resolveTab(params);
  assertTabGuard(tab, params);
  const waitMs = clampedNumberParam(params, 'waitMs', 1000, 0, 10000);
  const entries = [];

  const listener = (source, method, eventParams) => {
    if (source.tabId !== tab.id) return;
    if (method === 'Runtime.consoleAPICalled') {
      entries.push({
        type: eventParams.type,
        timestamp: eventParams.timestamp,
        args: (eventParams.args || []).map(remoteObjectSummary),
      });
    } else if (method === 'Runtime.exceptionThrown') {
      entries.push({
        type: 'exception',
        timestamp: eventParams.timestamp,
        text: eventParams.exceptionDetails?.text,
        url: eventParams.exceptionDetails?.url,
        lineNumber: eventParams.exceptionDetails?.lineNumber,
        columnNumber: eventParams.exceptionDetails?.columnNumber,
      });
    } else if (method === 'Log.entryAdded') {
      entries.push({
        type: eventParams.entry?.level || 'log',
        source: eventParams.entry?.source,
        text: eventParams.entry?.text,
        url: eventParams.entry?.url,
        lineNumber: eventParams.entry?.lineNumber,
      });
    }
  };

  chrome.debugger.onEvent.addListener(listener);
  try {
    await withDebugger(tab.id, async (target) => {
      await cdpSend(target, 'Runtime.enable');
      await cdpSend(target, 'Log.enable');
      await cdpSend(target, 'Runtime.evaluate', { expression: 'undefined' });
      await delay(waitMs);
    });
  } finally {
    chrome.debugger.onEvent.removeListener(listener);
  }

  return { tab: tabBrief(tab), waitMs, entries };
}

function remoteObjectSummary(value) {
  if ('value' in value) return value.value;
  if (value.unserializableValue) return value.unserializableValue;
  if (value.description) return value.description;
  return value.type;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Tabs that were open before the extension (re)loaded have no static hook.
async function hookExistingTabs() {
  const tabs = await chrome.tabs.query({});
  await Promise.allSettled(tabs.filter((tab) => isInjectableUrl(tab.url) && !tab.discarded).map(async (tab) => {
    const target = { tabId: tab.id, allFrames: true };
    await chrome.scripting.executeScript({ target, files: [PAGE_HOOK_FILE], world: 'MAIN' });
    await chrome.scripting.executeScript({ target, files: [DIALOG_RELAY_FILE] });
  }));
}

function startBridge() {
  connectNative();
}

chrome.debugger?.onDetach?.addListener(onDebuggerDetach);
chrome.runtime.onMessage?.addListener(onHookMessage);
chrome.tabs.onCreated?.addListener(onTabCreated);
chrome.webNavigation?.onCreatedNavigationTarget?.addListener(onCreatedNavigationTarget);
chrome.tabs.onRemoved?.addListener((tabId) => forgetTab(tabId));
chrome.tabs.onUpdated?.addListener((tabId, changeInfo) => {
  // A navigation tears down any dialog the old document had open.
  if (changeInfo.status === 'loading') {
    const state = tabStates.get(tabId);
    if (state) state.openDialog = null;
  }
});
chrome.runtime.onStartup.addListener(startBridge);
chrome.runtime.onInstalled.addListener(() => {
  startBridge();
  hookExistingTabs().catch((error) => console.warn(`could not hook open tabs: ${error.message || error}`));
});
startBridge();
