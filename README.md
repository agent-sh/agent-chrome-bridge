# Agent Chrome Bridge

[![npm](https://img.shields.io/npm/v/@agent-sh/chrome-bridge)](https://www.npmjs.com/package/@agent-sh/chrome-bridge)
[![CI](https://github.com/avifenesh/agent-chrome-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/avifenesh/agent-chrome-bridge/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Let Claude Code and Codex drive the Chrome you already have open** — your tabs, your logins, your profile — through one shared MCP server.

No separate headless browser, no re-login, no cookie export. Agents read pages as compact element lists, click and type by element id, and share the browser safely with tab locks and URL guards.

- **Linux** (primary) and **macOS**
- **Claude Code** and **Codex** (any MCP stdio client works)
- Node.js ≥ 18, Google Chrome or another Chromium browser
- No runtime dependencies

---

## Contents

- [How it works](#how-it-works)
- [Quick start](#quick-start)
- [Using it](#using-it)
- [Tools](#tools)
- [Dialogs, popups and modals](#dialogs-popups-and-modals)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)
- [Updating](#updating)
- [Development](#development)

## How it works

```text
  Claude Code ── mcp-server.js ──┐
                                 ├──► broker.js ◄──► native-host.js ◄──► extension ──► your Chrome tabs
  Codex ──────── mcp-server.js ──┘    Unix socket    Native Messaging     (your profile, your logins)
```

| Piece | Role |
|---|---|
| `extension/` | Manifest V3 extension in your normal Chrome profile. Injects `content-bridge.js` to read and act on pages. |
| `bin/native-host.js` | Chrome Native Messaging host the extension talks to. |
| `bin/broker.js` | Local Unix-socket broker. One per user; every agent and the native host meet here. |
| `bin/mcp-server.js` | The MCP stdio server your agent runs. Starts the broker on demand. |

Because every agent goes through the same broker, Claude and Codex act on the **same** windows and tabs at the same time.

## Quick start

About two minutes.

**1. Install**

```bash
npx @agent-sh/chrome-bridge@latest setup
```

`setup` does three things, and is safe to re-run:

- Copies the bridge to `~/.local/share/agent-chrome-bridge/app`, a stable location that does not move with the npx cache or your Node version.
- Registers the Chrome native messaging host. Chrome starts native hosts with an almost empty `PATH`, so the host goes through a small launcher that pins your current `node` binary.
- Registers the MCP server with every agent CLI it finds on your `PATH`:

| Client | Registered as |
|---|---|
| Claude Code | `agent-chrome-bridge` (user scope) |
| Codex | `agent_chrome_bridge` |

Options: `--claude` or `--codex` to register with one client only, `--no-mcp` to skip registration, `--force-mcp` to replace existing entries. Existing entries are left alone by default, so per-tool approval settings you already configured survive.

Prefer a global install? `npm i -g @agent-sh/chrome-bridge && agent-chrome-bridge setup` does the same thing.

**2. Load the extension**

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose the folder `setup` printed: `~/.local/share/agent-chrome-bridge/app/extension` (`agent-chrome-bridge where` prints it again).
3. The ID should be `pfcpgdlnhaagndelcbdpopojfgalmbkf`. It is fixed by the key in `manifest.json`, so it is the same on every machine.

**3. Check it**

```bash
npx @agent-sh/chrome-bridge doctor
```

Look for `"extensionConnected": true` and matching versions for every component. Then restart your agent (in Claude Code, `/mcp` reconnects) and ask it to call `chrome_health`.

| Platform | Native host manifest |
|---|---|
| Linux | `~/.config/google-chrome/NativeMessagingHosts/dev.agent_chrome_bridge.json` |
| macOS | `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/dev.agent_chrome_bridge.json` |

<details>
<summary>Other MCP clients, or editing config files by hand</summary>

`agent-chrome-bridge where` prints the exact command. Use absolute paths, because MCP clients may start servers without your shell's `PATH`.

Claude Code (`~/.claude.json`, or a project `.mcp.json`):

```json
{
  "mcpServers": {
    "agent-chrome-bridge": {
      "command": "/absolute/path/to/node",
      "args": ["/home/you/.local/share/agent-chrome-bridge/app/bin/mcp-server.js"]
    }
  }
}
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.agent_chrome_bridge]
command = "/absolute/path/to/node"
args = ["/home/you/.local/share/agent-chrome-bridge/app/bin/mcp-server.js"]
```

</details>

### CLI reference

| Command | What it does |
|---|---|
| `agent-chrome-bridge setup` | Install or upgrade (see above). |
| `agent-chrome-bridge doctor` | Broker, extension and native host diagnostics. |
| `agent-chrome-bridge where` | Print the install folder, extension folder and MCP command. |
| `agent-chrome-bridge mcp` | Run the MCP stdio server directly. |
| `agent-chrome-bridge uninstall` | Remove the native host manifest, MCP entries and installed copy. |

## Using it

### Read, then act by id

`chrome_snapshot` and `chrome_find` return one actionable element per line:

```text
e4 button "Delete" disabled
e5 input[email] "Email" name=email value="a@b.co"
e6 link "Docs" -> /docs offscreen
```

Pass an id back to `chrome_click` or `chrome_type` as `elementId`. Snapshot (`e*`) and find (`f*`) ids coexist, and if the page re-rendered the element, the bridge falls back to its recorded selector.

- `chrome_find` is cheaper than a full snapshot when you know what you are looking for; `maxText: 0` skips page text.
- Results are compact by default (a large GitHub page is ~16 KB instead of ~191 KB). Pass `verbose: true` for full JSON.
- Read tools cover all frames and open shadow roots. Narrow with `includeFrames: false`, `includeShadow: false`, or a `frameId`.
- Navigation tools wait for the page to load; pass `wait: false` to return immediately.
- Action results carry the new URL and title, any open in-page modal, and notices for dialogs and popups the action caused.

### Sharing the browser between agents

Every mutating tool accepts optional guards. If one does not match the target tab, the action is refused:

| Guard | Refuses unless |
|---|---|
| `expectedHost` | the tab's host matches |
| `expectedUrlIncludes` | the tab's URL contains the string |
| `lockId` | the caller holds the tab's lock |

For a longer flow, call `chrome_lock_tab` first and pass the returned `lockId` to each action. Other agents are refused until the lock expires or `chrome_unlock_tab` releases it.

### Read-only mode

Set `AGENT_CHROME_BRIDGE_READ_ONLY=1` on an MCP server process to expose the read tools and refuse every mutating action — handy for a reviewer agent.

## Tools

**Diagnostics and coordination**

| Tool | What it does |
|---|---|
| `chrome_health` | Connectivity, component versions, locks, recent errors. Pass `tabId` to probe a specific tab. |
| `chrome_launch` | Start Chrome (or Chromium, Brave, Edge) with your normal profile when the extension is not connected, then wait for it. No-op if already connected unless `force: true`. |
| `chrome_action_log` | Recent sanitized requests and errors. |
| `chrome_lock_tab` / `chrome_unlock_tab` / `chrome_locks` | Tab locks for multi-agent work. |
| `chrome_cdp_health` | Whether the CDP tools are available and where the debugger is attached. |

**Tabs and navigation**

| Tool | What it does |
|---|---|
| `chrome_tabs` / `chrome_active_tab` | List tabs; get the active tab plus unseen dialog/popup notices. |
| `chrome_select_tab` / `chrome_new_tab` / `chrome_close_tab` | Focus, open, close. |
| `chrome_navigate` / `chrome_reload` / `chrome_back` / `chrome_forward` | Navigate and wait for load. |

**Reading pages**

| Tool | What it does |
|---|---|
| `chrome_snapshot` | Page text plus actionable elements, one per line. |
| `chrome_find` | Find elements by selector, text, role, tag, placeholder, name or href. |
| `chrome_extract_links` / `chrome_extract_tables` / `chrome_read_article` | Links, tables as rows, main article text. |
| `chrome_get_network` | Resource Timing entries, with frame metadata. |
| `chrome_screenshot` | JPEG of the visible tab, 1280 px wide by default (`format`, `quality`, `maxWidth`). Reports `cssSize` for `chrome_cdp_click`. |

**Acting on pages**

| Tool | What it does |
|---|---|
| `chrome_click` | Click by element id, selector or visible text. `trusted: true` uses a real CDP mouse event. |
| `chrome_type` | Type into inputs, textareas, selects and contenteditables. |
| `chrome_scroll` | Scroll a tab or frame. |
| `chrome_wait_for_selector` / `chrome_wait_for_text` / `chrome_wait_until_idle` | Wait for an element, text, or a quiet DOM. |
| `chrome_get_dialog` / `chrome_handle_dialog` | Inspect or answer a JavaScript dialog. |

**Trusted input and console (CDP)**

| Tool | What it does |
|---|---|
| `chrome_cdp_click` | Trusted click at CSS-pixel viewport coordinates. |
| `chrome_cdp_key` | Trusted key press, with modifiers (see below). |
| `chrome_cdp_type` | Trusted text insertion into the focused element. |
| `chrome_get_console` | Console, log and exception events during a wait window. |

`chrome_cdp_key` takes modifiers as a `modifierKeys` array or a numeric `modifiers` bitmask (Alt=1, Ctrl=2, Meta/Cmd=4, Shift=8); both are OR-combined. Ctrl+K to open Slack's quick switcher:

```json
{ "name": "chrome_cdp_key", "arguments": { "key": "k", "modifierKeys": ["ctrl"] } }
```

## Dialogs, popups and modals

The bridge handles these without the Chrome debugger:

- **JavaScript dialogs.** `extension/page-hook.js` wraps `alert`, `confirm` and `prompt` in every frame. During an agent action, and for 10 s after it, the hook answers without blocking the page: alerts are accepted, confirm and prompt are dismissed unless the action passes `onDialog: "accept"` (plus `promptText` for a prompt). Each answered dialog appears under `notices` in the result. A dialog the page opens later is native: results report it as `dialogPending` and `chrome_tabs` flags `dialogOpen`. Chrome only lets CDP answer dialogs opened while the debugger was attached, so the user answers these or the agent reloads the tab. Calling `chrome_handle_dialog` with no dialog open arms the answer for the next one.
- **Popups.** Tabs or windows a page opens come back as `notices: [{ kind: "popup", tabId, url }]`. Chrome blocks `window.open` without a user gesture, and a synthetic `element.click()` carries none; those return `popupBlocked`, so retry with `chrome_click({ trusted: true })`.
- **In-page modals.** An open `[role=dialog]`, `[aria-modal]` or `<dialog open>` is reported as `modal`, and snapshots list its controls first.

### The "started debugging this browser" bar

Chrome shows this bar while any extension has the debugger attached. The bridge attaches only for the CDP tools (`chrome_cdp_*`, `chrome_click` with `trusted: true`, `chrome_get_console`) and detaches 15 s after the last CDP call. Snapshots, DOM clicks, typing, navigation and dialog handling never attach it.

To hide the bar entirely, start Chrome with `--silent-debugger-extension-api`. It hides the bar for every extension, so it is opt-in:

```js
chrome_launch({ args: ["--restore-last-session", "--silent-debugger-extension-api"] })
```

## Configuration

All optional.

| Variable | Default | Purpose |
|---|---|---|
| `AGENT_CHROME_BRIDGE_READ_ONLY` | unset | `1` refuses mutating tools on that MCP server. |
| `AGENT_CHROME_BRIDGE_SOCKET` | see below | Broker socket path. |
| `AGENT_CHROME_BRIDGE_LOG_DIR` | `~/.local/state/agent-chrome-bridge` | Broker and action logs. |
| `AGENT_CHROME_BRIDGE_HOST_DIR` | per-platform (above) | Where `setup` writes the native host manifest, e.g. for Chromium or Brave. |
| `AGENT_CHROME_BRIDGE_HOME` | `$XDG_DATA_HOME/agent-chrome-bridge`, else `~/.local/share/agent-chrome-bridge` | Where `setup` installs the runtime. |

The broker socket lives in `$XDG_RUNTIME_DIR`, else `/run/user/<uid>` (the usual Linux case), else `~/.local/state/agent-chrome-bridge` (the usual macOS case). Every process resolves the same directory, which matters on macOS where Chrome-launched and terminal-launched processes get different `TMPDIR`s.

The action log is sanitized: fields such as `text`, `password`, `token`, `secret`, `cookie` and `authorization` are redacted before anything is written.

## Troubleshooting

Start with `agent-chrome-bridge doctor`; its `nativeMessaging` section shows whether the host manifest exists and points at the installed copy.

| Symptom | Fix |
|---|---|
| `extensionConnected: false` | Reload the extension in `chrome://extensions`. If it persists, rerun `setup` and check that the manifest `path` matches. |
| Extension ID differs from `pfcpgdlnhaagndelcbdpopojfgalmbkf` | You loaded a different folder; load the one `agent-chrome-bridge where` prints. |
| Worked, then broke after removing a Node version | The launcher and MCP entries pin the node binary used at setup. Rerun `setup --force-mcp`. |
| Agent does not list `chrome_*` tools | Restart the agent after `setup` (in Claude Code, `/mcp`). Check `claude mcp list` / `codex mcp list`. |
| Versions differ between components in `chrome_health` | Old code still loaded somewhere: reload the extension and restart the agent. |
| Using Chromium, Brave or Edge | Point setup at that browser's `NativeMessagingHosts` folder: `AGENT_CHROME_BRIDGE_HOST_DIR=... agent-chrome-bridge setup`. |

## Updating

```bash
npx @agent-sh/chrome-bridge@latest setup
```

Then click reload on the extension in `chrome://extensions` and restart your agents. The extension needs Chrome's `debugger` permission (for the optional CDP tools) and `webNavigation` (for popup tracking); Chrome may ask you to approve them after an update.

## Development

Work from a checkout; the npm scripts install from the checkout instead of the copied runtime, and Chrome loads `extension/` from the repo:

```bash
git clone https://github.com/avifenesh/agent-chrome-bridge.git && cd agent-chrome-bridge
npm run install:chrome-host   # native host -> this checkout
npm run install:mcp           # MCP entries -> this checkout (--force to replace)
npm test                      # syntax checks plus unit tests, no browser needed
CHROME_BIN=/path/to/chrome-for-testing npm run e2e
```

`npm run e2e` runs the bridge end to end against an isolated headless Chrome. Stable Chrome ignores `--load-extension`, so use Chrome for Testing or Chromium. Set `E2E_MEASURE_URL` to print compact vs verbose output sizes for a real page. Scratch files go to `.scratch/e2e` and are removed afterwards.

**Releasing:** bump `version` in `package.json`, `extension/manifest.json` and `BRIDGE_VERSION` in `extension/content-bridge.js` (tests fail if they drift), merge, then `git tag vX.Y.Z && git push origin vX.Y.Z`. The release workflow checks the versions, runs the tests, publishes to npm with provenance and creates the GitHub release.

## License

[MIT](LICENSE)
