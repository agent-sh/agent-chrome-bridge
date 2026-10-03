'use strict';

const TAB_GUARD = {
  expectedHost: { type: 'string', description: 'Refuse unless the tab host equals this.' },
  expectedUrlIncludes: { type: 'string', description: 'Refuse unless the tab URL contains this.' },
  lockId: { type: 'string', description: 'Lock id from chrome_lock_tab.' },
};

const OPTIONAL_TAB = {
  tabId: { type: 'number', description: 'Tab id. Defaults to the active tab.' },
};

const FRAME_OPTIONS = {
  frameId: { type: 'number', description: 'Frame id. Defaults to all frames for reads, main frame for selector actions.' },
  includeFrames: { type: 'boolean', description: 'Include all frames. Defaults to true.' },
  includeShadow: { type: 'boolean', description: 'Include open shadow roots. Defaults to true.' },
};

const VERBOSE = {
  verbose: { type: 'boolean', description: 'Full JSON instead of the compact default.' },
};

const DIALOG_OPTIONS = {
  onDialog: {
    type: 'string',
    enum: ['accept', 'dismiss'],
    description: 'Answer for a confirm/prompt this action opens. Default: alerts accepted, confirm/prompt dismissed; all reported in notices.',
  },
  promptText: { type: 'string', description: 'prompt() value when onDialog is accept.' },
};

const LOAD_OPTIONS = {
  wait: { type: 'boolean', description: 'Wait for load. Defaults to true.' },
  timeoutMs: { type: 'number', description: 'Load timeout ms. Defaults to 15000.' },
};

const TARGET = {
  selector: { type: 'string', description: 'CSS selector to target.' },
  elementId: { type: 'string', description: 'Element id from the latest chrome_snapshot or chrome_find result for that tab.' },
};

const TOOLS = [
  {
    name: 'chrome_health',
    description: 'Return bridge diagnostics: extension connectivity, component versions, active locks, and recent errors.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'number', description: 'Optional tab id for the content-script version probe. Defaults to the active injectable tab.' },
        verbose: { type: 'boolean', description: 'Include recent requests and the full broker state. Defaults to false.' },
      },
    },
  },
  {
    name: 'chrome_launch',
    description: 'Launch a Chromium-based browser when the bridge extension is not connected, then wait for it to reconnect. Uses the user default profile so existing logins and the bridge extension are present.',
    inputSchema: {
      type: 'object',
      properties: {
        binary: { type: 'string', description: 'Override path to the browser binary. Defaults to auto-detect (google-chrome, chromium, brave-browser, microsoft-edge).' },
        args: { type: 'array', items: { type: 'string' }, description: 'Extra CLI args. Defaults to ["--restore-last-session"]. Add "--silent-debugger-extension-api" to hide the debugging bar entirely (it hides it for every extension).' },
        userDataDir: { type: 'string', description: 'Override --user-data-dir. Defaults to the user profile (no flag passed).' },
        waitForExtensionMs: { type: 'number', description: 'How long to wait for the bridge extension to reconnect. Defaults to 15000, max 60000.' },
        force: { type: 'boolean', description: 'Launch even if the extension is already connected. Defaults to false.' },
      },
    },
  },
  {
    name: 'chrome_action_log',
    description: 'Return recent sanitized bridge requests and errors.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Maximum entries to return. Defaults to 20.' },
      },
    },
  },
  {
    name: 'chrome_lock_tab',
    description: 'Lock a tab for one agent/client to reduce accidental cross-agent edits. Mutating calls to that tab require the returned lockId until it expires or is released.',
    inputSchema: {
      type: 'object',
      required: ['tabId'],
      properties: {
        tabId: { type: 'number', description: 'Chrome tab id to lock.' },
        owner: { type: 'string', description: 'Human-readable lock owner, for example codex or claude.' },
        ttlMs: { type: 'number', description: 'Lock lifetime in milliseconds. Defaults to 120000.' },
        note: { type: 'string', description: 'Optional reason for the lock.' },
      },
    },
  },
  {
    name: 'chrome_unlock_tab',
    description: 'Release a tab lock by lock id.',
    inputSchema: {
      type: 'object',
      required: ['lockId'],
      properties: {
        lockId: { type: 'string' },
      },
    },
  },
  {
    name: 'chrome_locks',
    description: 'List active tab locks.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'chrome_tabs',
    description: 'List open Chrome tabs (id, windowId, title, url; active, openerTabId, loading, dialogOpen when set).',
    inputSchema: { type: 'object', properties: { ...VERBOSE } },
  },
  {
    name: 'chrome_active_tab',
    description: 'Return the active tab in the last focused Chrome window, plus any unseen dialog/popup notices for it.',
    inputSchema: { type: 'object', properties: { ...VERBOSE } },
  },
  {
    name: 'chrome_select_tab',
    description: 'Focus a Chrome tab and its window.',
    inputSchema: {
      type: 'object',
      required: ['tabId'],
      properties: {
        tabId: { type: 'number', description: 'Chrome tab id to activate.' },
        ...TAB_GUARD,
      },
    },
  },
  {
    name: 'chrome_new_tab',
    description: 'Create a new Chrome tab, optionally with a URL, and wait for it to load.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to open. Defaults to chrome://newtab.' },
        active: { type: 'boolean', description: 'Whether to make the tab active. Defaults to true.' },
        ...LOAD_OPTIONS,
      },
    },
  },
  {
    name: 'chrome_close_tab',
    description: 'Close a Chrome tab. Requires an explicit tab id to avoid accidental active-tab closes.',
    inputSchema: {
      type: 'object',
      required: ['tabId'],
      properties: {
        tabId: { type: 'number', description: 'Chrome tab id to close.' },
        ...TAB_GUARD,
      },
    },
  },
  {
    name: 'chrome_reload',
    description: 'Reload a Chrome tab and wait for it to load.',
    inputSchema: {
      type: 'object',
      properties: {
        ...OPTIONAL_TAB,
        bypassCache: { type: 'boolean', description: 'Bypass browser cache. Defaults to false.' },
        ...LOAD_OPTIONS,
        ...TAB_GUARD,
      },
    },
  },
  {
    name: 'chrome_back',
    description: 'Navigate the tab one history entry back and wait for it to load.',
    inputSchema: { type: 'object', properties: { ...OPTIONAL_TAB, ...LOAD_OPTIONS, ...TAB_GUARD } },
  },
  {
    name: 'chrome_forward',
    description: 'Navigate the tab one history entry forward and wait for it to load.',
    inputSchema: { type: 'object', properties: { ...OPTIONAL_TAB, ...LOAD_OPTIONS, ...TAB_GUARD } },
  },
  {
    name: 'chrome_snapshot',
    description: 'Read page text plus actionable elements, one per line: `<id> <role> "<label>" [flags]`. Pass the id as elementId to chrome_click/chrome_type. An open in-page modal is reported under modal and its elements come first (flag: modal). Covers all frames and open shadow roots.',
    inputSchema: {
      type: 'object',
      properties: {
        ...OPTIONAL_TAB,
        ...FRAME_OPTIONS,
        maxText: { type: 'number', description: 'Maximum body text characters per frame. Defaults to 6000 (12000 when verbose). Use 0 for elements only.' },
        maxElements: { type: 'number', description: 'Maximum actionable elements per frame. Defaults to 120.' },
        ...VERBOSE,
      },
    },
  },
  {
    name: 'chrome_find',
    description: 'Find visible actionable elements by selector, text, role, tag, placeholder, name, or href across frames and open shadow roots.',
    inputSchema: {
      type: 'object',
      properties: {
        ...OPTIONAL_TAB,
        ...FRAME_OPTIONS,
        selector: { type: 'string', description: 'Optional CSS selector to filter from.' },
        text: { type: 'string', description: 'Visible text, aria label, title, alt text, placeholder, name, or href text to match.' },
        exact: { type: 'boolean', description: 'Require exact case-insensitive text match. Defaults to false.' },
        role: { type: 'string', description: 'ARIA role to match.' },
        tag: { type: 'string', description: 'Tag name to match, for example button, a, input.' },
        placeholder: { type: 'string', description: 'Placeholder text to match.' },
        name: { type: 'string', description: 'Input name attribute to match.' },
        href: { type: 'string', description: 'Href substring to match.' },
        limit: { type: 'number', description: 'Maximum elements per frame to return. Defaults to 20.' },
        ...VERBOSE,
      },
    },
  },
  {
    name: 'chrome_extract_links',
    description: 'Extract links from a page across frames and open shadow roots.',
    inputSchema: {
      type: 'object',
      properties: {
        ...OPTIONAL_TAB,
        ...FRAME_OPTIONS,
        text: { type: 'string', description: 'Optional visible text filter.' },
        href: { type: 'string', description: 'Optional href substring filter.' },
        exact: { type: 'boolean', description: 'Require exact case-insensitive text match. Defaults to false.' },
        visible: { type: 'boolean', description: 'Only visible links. Defaults to true.' },
        limit: { type: 'number', description: 'Maximum links per frame. Defaults to 200.' },
        ...VERBOSE,
      },
    },
  },
  {
    name: 'chrome_extract_tables',
    description: 'Extract visible HTML tables into rows.',
    inputSchema: {
      type: 'object',
      properties: {
        ...OPTIONAL_TAB,
        ...FRAME_OPTIONS,
        visible: { type: 'boolean', description: 'Only visible tables. Defaults to true.' },
        limit: { type: 'number', description: 'Maximum tables per frame. Defaults to 20.' },
        maxRows: { type: 'number', description: 'Maximum rows per table. Defaults to 50.' },
        ...VERBOSE,
      },
    },
  },
  {
    name: 'chrome_read_article',
    description: 'Extract the most article-like main text from the page.',
    inputSchema: {
      type: 'object',
      properties: {
        ...OPTIONAL_TAB,
        ...FRAME_OPTIONS,
        maxText: { type: 'number', description: 'Maximum article text characters. Defaults to 30000.' },
        ...VERBOSE,
      },
    },
  },
  {
    name: 'chrome_get_network',
    description: 'Read Resource Timing entries from the page, including frame metadata when available.',
    inputSchema: {
      type: 'object',
      properties: {
        ...OPTIONAL_TAB,
        ...FRAME_OPTIONS,
        limit: { type: 'number', description: 'Maximum resource entries per frame. Defaults to 200.' },
        ...VERBOSE,
      },
    },
  },
  {
    name: 'chrome_navigate',
    description: 'Navigate a Chrome tab to a URL and wait for it to load.',
    inputSchema: {
      type: 'object',
      required: ['url'],
      properties: {
        ...OPTIONAL_TAB,
        url: { type: 'string' },
        ...LOAD_OPTIONS,
        ...TAB_GUARD,
      },
    },
  },
  {
    name: 'chrome_click',
    description: 'Click an element by snapshot element id, CSS selector, or visible text. Returns the resulting url/title, any in-page modal that opened, and notices for dialogs and popup tabs the click caused.',
    inputSchema: {
      type: 'object',
      properties: {
        ...OPTIONAL_TAB,
        ...FRAME_OPTIONS,
        ...TARGET,
        text: { type: 'string', description: 'Visible text/label to click when no selector or elementId is supplied.' },
        exact: { type: 'boolean', description: 'Require exact case-insensitive text match for text targeting. Defaults to false.' },
        role: { type: 'string', description: 'ARIA role to prefer for text targeting.' },
        index: { type: 'number', description: 'Zero-based match index for text targeting. Defaults to 0.' },
        trusted: { type: 'boolean', description: 'Click with a real CDP mouse event at the element center, for sites that ignore synthetic clicks. Main frame only. Defaults to false.' },
        ...DIALOG_OPTIONS,
        ...VERBOSE,
        ...TAB_GUARD,
      },
    },
  },
  {
    name: 'chrome_type',
    description: 'Type into an input, textarea, select, or contenteditable element by selector, element id, label, placeholder, or name.',
    inputSchema: {
      type: 'object',
      required: ['text'],
      properties: {
        ...OPTIONAL_TAB,
        ...FRAME_OPTIONS,
        ...TARGET,
        targetText: { type: 'string', description: 'Visible label/text near the typeable element.' },
        placeholder: { type: 'string', description: 'Placeholder text to target.' },
        name: { type: 'string', description: 'Input name attribute to target.' },
        text: { type: 'string', description: 'Text to type.' },
        replace: { type: 'boolean', description: 'Replace current value instead of appending. Defaults to true.' },
        submit: { type: 'boolean', description: 'Submit the nearest form after typing. Defaults to false.' },
        index: { type: 'number', description: 'Zero-based match index for text targeting. Defaults to 0.' },
        ...DIALOG_OPTIONS,
        ...VERBOSE,
        ...TAB_GUARD,
      },
    },
  },
  {
    name: 'chrome_scroll',
    description: 'Scroll a Chrome tab or frame by pixels.',
    inputSchema: {
      type: 'object',
      properties: {
        ...OPTIONAL_TAB,
        frameId: FRAME_OPTIONS.frameId,
        x: { type: 'number', description: 'Horizontal pixels. Defaults to 0.' },
        y: { type: 'number', description: 'Vertical pixels. Defaults to 700.' },
        ...TAB_GUARD,
      },
    },
  },
  {
    name: 'chrome_wait_for_selector',
    description: 'Wait until a selector exists, and optionally until it is visible.',
    inputSchema: {
      type: 'object',
      required: ['selector'],
      properties: {
        ...OPTIONAL_TAB,
        frameId: FRAME_OPTIONS.frameId,
        selector: { type: 'string' },
        visible: { type: 'boolean', description: 'Require the element to be visible. Defaults to true.' },
        timeoutMs: { type: 'number', description: 'Timeout in milliseconds. Defaults to 10000.' },
        ...TAB_GUARD,
      },
    },
  },
  {
    name: 'chrome_wait_for_text',
    description: 'Wait until page or frame text contains a string.',
    inputSchema: {
      type: 'object',
      required: ['text'],
      properties: {
        ...OPTIONAL_TAB,
        frameId: FRAME_OPTIONS.frameId,
        text: { type: 'string' },
        exact: { type: 'boolean', description: 'Require exact case-insensitive body text match. Defaults to false.' },
        timeoutMs: { type: 'number', description: 'Timeout in milliseconds. Defaults to 10000.' },
        ...TAB_GUARD,
      },
    },
  },
  {
    name: 'chrome_wait_until_idle',
    description: 'Wait for document readiness and a short period without DOM mutations.',
    inputSchema: {
      type: 'object',
      properties: {
        ...OPTIONAL_TAB,
        frameId: FRAME_OPTIONS.frameId,
        idleMs: { type: 'number', description: 'Milliseconds with no DOM mutations before resolving. Defaults to 500.' },
        timeoutMs: { type: 'number', description: 'Timeout in milliseconds. Defaults to 10000.' },
        ...TAB_GUARD,
      },
    },
  },
  {
    name: 'chrome_screenshot',
    description: 'Capture the visible part of the tab as an image. Defaults to JPEG scaled to 1280px wide to keep image tokens low. Prefer chrome_snapshot when text is enough.',
    inputSchema: {
      type: 'object',
      properties: {
        ...OPTIONAL_TAB,
        format: { type: 'string', enum: ['jpeg', 'png'], description: 'Image format. Defaults to jpeg.' },
        quality: { type: 'number', description: 'JPEG quality 10-100. Defaults to 70.' },
        maxWidth: { type: 'number', description: 'Scale down to at most this many pixels wide. Defaults to 1280.' },
      },
    },
  },
  {
    name: 'chrome_cdp_health',
    description: 'Check whether the CDP tools are available and which tabs the debugger is attached to right now.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'chrome_get_dialog',
    description: 'Return the JavaScript alert/confirm/prompt open in a tab (without closing it) and any unseen dialog/popup notices. Works without the debugger.',
    inputSchema: {
      type: 'object',
      properties: {
        ...OPTIONAL_TAB,
        timeoutMs: { type: 'number', description: 'How long to wait for a dialog to open. Defaults to 500, max 10000.' },
        ...TAB_GUARD,
      },
    },
  },
  {
    name: 'chrome_handle_dialog',
    description: 'Accept or dismiss the JavaScript dialog open in a tab. If none is open, arm the answer for the next dialog in that tab (see armMs). promptText supplies the value for a prompt.',
    inputSchema: {
      type: 'object',
      required: ['accept'],
      properties: {
        ...OPTIONAL_TAB,
        accept: { type: 'boolean', description: 'True to accept the dialog, false to dismiss it.' },
        promptText: { type: 'string', description: 'Text to submit when accepting a prompt dialog.' },
        timeoutMs: { type: 'number', description: 'How long to wait for a dialog to open before arming instead. Defaults to 100, max 10000.' },
        armMs: { type: 'number', description: 'When no dialog is open, how long the armed answer stays active. Defaults to 30000, max 120000.' },
        ...TAB_GUARD,
      },
    },
  },
  {
    name: 'chrome_cdp_click',
    description: 'Trusted mouse click at CSS-pixel viewport coordinates via CDP. Prefer chrome_click with trusted:true when you have an element id. Chrome shows its debugging bar while attached; the bridge detaches 15s after the last CDP call.',
    inputSchema: {
      type: 'object',
      required: ['x', 'y'],
      properties: {
        ...OPTIONAL_TAB,
        x: { type: 'number' },
        y: { type: 'number' },
        button: { type: 'string', description: 'Mouse button. Defaults to left.' },
        clickCount: { type: 'number', description: 'Click count. Defaults to 1.' },
        ...DIALOG_OPTIONS,
        ...TAB_GUARD,
      },
    },
  },
  {
    name: 'chrome_cdp_key',
    description: 'Use CDP to press a key in the target tab. Optional modifiers (Alt=1, Ctrl=2, Meta/Cmd=4, Shift=8 bitmask) or modifierKeys (friendly array like ["ctrl","shift"]) let you send Ctrl+K, Cmd+K, Shift+Tab, etc. Chrome shows its debugging bar while attached; the bridge detaches 15s after the last CDP call.',
    inputSchema: {
      type: 'object',
      required: ['key'],
      properties: {
        ...OPTIONAL_TAB,
        key: { type: 'string', description: 'Key value, for example Enter, Escape, Tab.' },
        code: { type: 'string', description: 'Optional physical key code.' },
        modifiers: {
          type: 'number',
          description: 'Optional CDP modifier bitmask (Alt=1, Ctrl=2, Meta/Cmd=4, Shift=8). OR-combined with modifierKeys when both supplied.',
        },
        modifierKeys: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional friendly modifier list, e.g. ["ctrl"], ["meta","shift"]. Accepts alt, ctrl/control, meta/cmd/command/super/win, shift. OR-combined with modifiers when both supplied.',
        },
        ...DIALOG_OPTIONS,
        ...TAB_GUARD,
      },
    },
  },
  {
    name: 'chrome_cdp_type',
    description: 'Insert text into the focused element via CDP Input.insertText (trusted input). Chrome shows its debugging bar while attached; the bridge detaches 15s after the last CDP call.',
    inputSchema: {
      type: 'object',
      required: ['text'],
      properties: {
        ...OPTIONAL_TAB,
        text: { type: 'string' },
        ...TAB_GUARD,
      },
    },
  },
  {
    name: 'chrome_get_console',
    description: 'Collect console/log/exception events emitted during a wait window via CDP. Captures new events only, not history. Chrome shows its debugging bar while attached; the bridge detaches 15s after the last CDP call.',
    inputSchema: {
      type: 'object',
      properties: {
        ...OPTIONAL_TAB,
        waitMs: { type: 'number', description: 'How long to listen for console events. Defaults to 1000, max 10000.' },
        ...TAB_GUARD,
      },
    },
  },
];

const METHOD_BY_TOOL = {
  chrome_health: 'bridge.health',
  chrome_action_log: 'bridge.log',
  chrome_lock_tab: 'locks.acquire',
  chrome_unlock_tab: 'locks.release',
  chrome_locks: 'locks.list',
  chrome_tabs: 'tabs.list',
  chrome_active_tab: 'tabs.active',
  chrome_select_tab: 'tabs.select',
  chrome_new_tab: 'tabs.create',
  chrome_close_tab: 'tabs.close',
  chrome_reload: 'tabs.reload',
  chrome_back: 'tabs.back',
  chrome_forward: 'tabs.forward',
  chrome_snapshot: 'page.snapshot',
  chrome_find: 'page.find',
  chrome_extract_links: 'page.extractLinks',
  chrome_extract_tables: 'page.extractTables',
  chrome_read_article: 'page.readArticle',
  chrome_get_network: 'page.network',
  chrome_navigate: 'page.navigate',
  chrome_click: 'page.click',
  chrome_type: 'page.type',
  chrome_scroll: 'page.scroll',
  chrome_wait_for_selector: 'page.waitForSelector',
  chrome_wait_for_text: 'page.waitForText',
  chrome_wait_until_idle: 'page.waitUntilIdle',
  chrome_screenshot: 'page.screenshot',
  chrome_cdp_health: 'cdp.health',
  chrome_get_dialog: 'cdp.getDialog',
  chrome_handle_dialog: 'cdp.handleDialog',
  chrome_cdp_click: 'cdp.click',
  chrome_cdp_key: 'cdp.key',
  chrome_cdp_type: 'cdp.type',
  chrome_get_console: 'cdp.console',
};

const MUTATING_TOOLS = new Set([
  'chrome_launch',
  'chrome_lock_tab',
  'chrome_unlock_tab',
  'chrome_select_tab',
  'chrome_new_tab',
  'chrome_close_tab',
  'chrome_reload',
  'chrome_back',
  'chrome_forward',
  'chrome_navigate',
  'chrome_click',
  'chrome_type',
  'chrome_scroll',
  'chrome_handle_dialog',
  'chrome_cdp_click',
  'chrome_cdp_key',
  'chrome_cdp_type',
]);

const DESTRUCTIVE_TOOLS = new Set([
  'chrome_close_tab',
  'chrome_navigate',
  'chrome_click',
  'chrome_type',
  'chrome_handle_dialog',
  'chrome_cdp_click',
  'chrome_cdp_key',
  'chrome_cdp_type',
]);

module.exports = { TOOLS, METHOD_BY_TOOL, MUTATING_TOOLS, DESTRUCTIVE_TOOLS };
