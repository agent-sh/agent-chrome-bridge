# Agent Chrome Bridge

Standalone Chrome control bridge for local agents.

The bridge has four pieces:

- `extension/`: a Manifest V3 Chrome extension loaded into your normal Chrome profile. DOM actions are injected through `extension/content-bridge.js`.
- `bin/native-host.js`: Chrome Native Messaging host used by the extension.
- `bin/broker.js`: local Unix-socket broker shared by the native host and agent clients.
- `bin/mcp-server.js`: MCP stdio server that local agent clients can use.

The extension talks to the native host. The native host and MCP server meet at a local Unix socket broker. This lets both agents act on the same already-open Chrome windows and tabs instead of launching a separate stripped browser.

## Install

1. Register the native messaging host:

```bash
npm run install:chrome-host
```

2. Open `chrome://extensions`, enable Developer mode, click "Load unpacked", and choose the `extension/` directory inside this repository (for example, the absolute path printed by `npm run install:chrome-host`).

3. Check the extension ID:

```bash
npm run extension:id
```

It should be:

```text
pfcpgdlnhaagndelcbdpopojfgalmbkf
```

4. Add `bin/mcp-server.js` as an MCP command in Codex and Claude.

5. Check the live bridge:

```bash
npm run doctor
```

The doctor output includes the broker socket path, action log path, extension connectivity, active tab locks, pending requests, and recent sanitized errors.

## Tools

- `chrome_health`
- `chrome_launch`
- `chrome_action_log`
- `chrome_lock_tab`
- `chrome_unlock_tab`
- `chrome_locks`
- `chrome_tabs`
- `chrome_active_tab`
- `chrome_select_tab`
- `chrome_new_tab`
- `chrome_close_tab`
- `chrome_reload`
- `chrome_back`
- `chrome_forward`
- `chrome_snapshot`
- `chrome_find`
- `chrome_extract_links`
- `chrome_extract_tables`
- `chrome_read_article`
- `chrome_get_network`
- `chrome_navigate`
- `chrome_click`
- `chrome_type`
- `chrome_scroll`
- `chrome_wait_for_selector`
- `chrome_wait_for_text`
- `chrome_wait_until_idle`
- `chrome_screenshot`
- `chrome_cdp_health`
- `chrome_get_dialog`
- `chrome_handle_dialog`
- `chrome_cdp_click`
- `chrome_cdp_key` (supports `modifiers` bitmask or `modifierKeys: ["ctrl"]` for Ctrl+K, Cmd+K, Shift+Tab, etc.)
- `chrome_cdp_type`
- `chrome_get_console`

`chrome_snapshot` and `chrome_find` return element ids such as `e1` or `f3`, one element per line:

```text
e4 button "Delete" disabled
e5 input[email] "Email" name=email value="a@b.co"
e6 link "Docs" -> /docs offscreen
```

Pass an id back to `chrome_click` or `chrome_type` as `elementId`. Snapshot (`e*`) and find (`f*`) ids coexist, and if the page re-rendered the element, the bridge falls back to its recorded selector. Results are compact by default; pass `verbose: true` for the full JSON objects. On a large GitHub page, a compact snapshot is about 16 KB, against 191 KB in the old format.

Read tools default to all frames and open shadow roots. Pass `includeFrames: false`, `includeShadow: false`, or a specific `frameId` to narrow the target.

`chrome_health` reports the loaded MCP, broker, native host, extension background, and content-script versions. Pass `tabId` if you want the content-script probe to check a specific tab; otherwise it uses the active injectable tab or the first injectable tab it can find.

`chrome_launch` starts a Chromium-based browser when the bridge extension is not connected, then polls until it reconnects. It auto-detects `google-chrome`, `google-chrome-stable`, `chromium`, `chromium-browser`, `brave-browser`, and `microsoft-edge` on Linux (and the standard application paths on macOS/Windows). By default it uses your normal user profile so existing logins and the bridge extension are present. If the extension is already connected, it returns `{ status: "already_connected" }` without relaunching unless you pass `force: true`. Example: `chrome_launch({ waitForExtensionMs: 20000 })`.

Mutating tools support optional guards:

- `expectedHost`
- `expectedUrlIncludes`
- `lockId`

If a guard does not match the target tab, the action is refused. This is useful when multiple agents can control the same browser.

Use `chrome_lock_tab` before a longer edit flow. It returns a `lockId`; pass that `lockId` to mutating tools for that tab. Other agents will be refused until the lock expires or `chrome_unlock_tab` releases it.

## Dialogs, popups and modals

The bridge sees these without the Chrome debugger:

- **JavaScript dialogs.** `extension/page-hook.js` wraps `alert`, `confirm` and `prompt` in every frame. During an agent action, and for 10 s after it, the hook answers without blocking the page. Alerts are accepted. Confirm and prompt are dismissed unless the action passes `onDialog: "accept"` (and `promptText` for a prompt). Each answered dialog shows up under `notices` in the action result, with a hint when the default dismissed it. A dialog the page opens later is native: every tab result reports it as `dialogPending`, and `chrome_tabs` flags `dialogOpen`. Chrome lets CDP answer only dialogs that opened while the debugger was already attached, so the user has to answer these, or the agent reloads the tab. Calling `chrome_handle_dialog` with no dialog open arms the answer for the next dialog in that tab.
- **Popups.** Tabs or windows a page opens are reported as `notices: [{ kind: "popup", tabId, url }]`. Chrome blocks `window.open` without a user gesture, and a synthetic `element.click()` carries none. Those come back as `popupBlocked`; retry with `chrome_click({ trusted: true })`.
- **In-page modals.** Snapshots and click/type results report an open `[role=dialog]`, `[aria-modal]` or `<dialog open>` as `modal`, and a snapshot lists the modal's controls first.

## Chrome's debugging bar

Chrome shows "started debugging this browser" while any extension has a debugger attached. The bridge attaches only for the CDP tools (`chrome_cdp_*`, `chrome_click` with `trusted: true`, `chrome_get_console`). It detaches 15 s after the last CDP call, so the bar goes away. Snapshots, DOM clicks, typing, navigation and dialog handling never attach it. To hide the bar entirely, start Chrome with `--silent-debugger-extension-api`. That flag hides it for every extension, so it is opt-in: `chrome_launch({ args: ["--restore-last-session", "--silent-debugger-extension-api"] })`.

## Notes

Navigation tools (`chrome_navigate`, `chrome_new_tab`, `chrome_reload`, `chrome_back`, `chrome_forward`) wait for the page to load. Pass `wait: false` to return immediately. `chrome_screenshot` returns JPEG scaled to 1280 px wide by default (`format`, `quality`, `maxWidth` override). `cssSize` gives the coordinate space for `chrome_cdp_click`.

`chrome_cdp_key` accepts modifier keys via either a numeric `modifiers` bitmask (Alt=1, Ctrl=2, Meta/Cmd=4, Shift=8) or a friendly `modifierKeys` array. For example, to open Slack's quick switcher with Ctrl+K:

```json
{ "name": "chrome_cdp_key", "arguments": { "key": "k", "modifierKeys": ["ctrl"] } }
```

The same call with the raw bitmask is `{ "key": "k", "modifiers": 2 }`. When both are supplied they are OR-combined.

The extension requests Chrome's `debugger` permission for the optional CDP layer and `webNavigation` for popup tracking. After updating from an older version, reload the unpacked extension from `chrome://extensions` and restart the MCP server in your agent client.

Set `AGENT_CHROME_BRIDGE_READ_ONLY=1` on an MCP server process to expose the same read tools while refusing mutating actions.

`CHROME_BIN=/path/to/chrome-for-testing npm run e2e` runs the bridge end to end against an isolated headless Chrome. Stable Chrome ignores `--load-extension`, so use Chrome for Testing or Chromium. Set `E2E_MEASURE_URL` to print compact vs verbose output sizes for a real page. Scratch files go to `.scratch/e2e` and are removed afterwards.

Action logging is intentionally sanitized: fields such as `text`, `password`, `token`, `secret`, `cookie`, and `authorization` are redacted before they are written to the local JSONL log.
