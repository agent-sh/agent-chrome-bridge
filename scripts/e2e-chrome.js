#!/usr/bin/env node
'use strict';

// End-to-end check against a real, isolated Chrome with the extension loaded.
// Needs a Chrome build that honors --load-extension (Chrome for Testing or
// Chromium): CHROME_BIN=/path/to/chrome npm run e2e
// Everything lives under .scratch/e2e in the repo and is removed afterwards.

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const WORK = path.join(ROOT, '.scratch', 'e2e');
const PROFILE = path.join(WORK, 'profile');
const SOCKET = path.join(WORK, 'bridge.sock');
const CHROME = process.env.CHROME_BIN;
const HEADLESS = process.env.E2E_HEADFUL ? [] : ['--headless=new'];

if (!CHROME) {
  process.stderr.write('Set CHROME_BIN to a Chrome for Testing or Chromium binary.\n');
  process.exit(2);
}

fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(path.join(PROFILE, 'NativeMessagingHosts'), { recursive: true });
process.env.AGENT_CHROME_BRIDGE_SOCKET = SOCKET;
process.env.AGENT_CHROME_BRIDGE_LOG_DIR = path.join(WORK, 'logs');
const { request } = require('../lib/broker-client');

fs.writeFileSync(path.join(PROFILE, 'NativeMessagingHosts', 'dev.agent_chrome_bridge.json'), JSON.stringify({
  name: 'dev.agent_chrome_bridge',
  description: 'e2e',
  path: path.join(ROOT, 'bin', 'native-host.js'),
  type: 'stdio',
  allowed_origins: ['chrome-extension://pfcpgdlnhaagndelcbdpopojfgalmbkf/'],
}));

const PAGE = `<!doctype html><title>Fixture</title>
<button id="alert" onclick="alert('Saved'); out.textContent='after-alert'">Alert</button>
<button id="confirm" onclick="out.textContent=String(confirm('Delete item?'))">Delete</button>
<button id="prompt" onclick="out.textContent=String(prompt('Name?','Avi'))">Rename</button>
<button id="popup" onclick="window.open('/page2','_blank')">Open popup</button>
<button id="modal" onclick="m.hidden=false">Open modal</button>
<button id="soon" onclick="setTimeout(()=>{out.textContent=String(confirm('Soon?'))}, 3000)">Soon confirm</button>
<button id="late" onclick="setTimeout(()=>{out.textContent=String(confirm('Late?'))}, 11000)">Late confirm</button>
<a href="/page2">Next page</a>
<input id="q" name="q" placeholder="Search">
<div id="out">-</div>
<div id="m" role="dialog" aria-label="Settings" hidden style="position:fixed;inset:20%;background:#eee;z-index:9">
  <p>Modal body</p><button onclick="m.hidden=true">Close modal</button>
</div>`;

const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html');
  if (req.url === '/page2') res.end('<!doctype html><title>Page two</title><p>second page</p>');
  else res.end(PAGE);
});

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let chrome = null;

async function call(method, params = {}, timeoutMs = 30000) {
  return request(method, params, { timeoutMs });
}

async function outText(tabId) {
  const result = await call('page.find', { tabId, selector: '#out', verbose: true });
  return result.result.elements[0]?.text;
}

async function main() {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  chrome = childProcess.spawn(CHROME, [
    ...HEADLESS,
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${PROFILE}`,
    `--disable-extensions-except=${path.join(ROOT, 'extension')}`,
    `--load-extension=${path.join(ROOT, 'extension')}`,
    'about:blank',
  ], { stdio: 'ignore', env: process.env });

  const deadline = Date.now() + 20000;
  for (;;) {
    const health = await call('bridge.health').catch(() => null);
    if (health?.extensionConnected) break;
    if (Date.now() > deadline) throw new Error('extension did not connect');
    await delay(250);
  }

  const created = await call('tabs.create', { url: `${base}/` });
  const tabId = created.tab.id;
  assert.equal(created.loaded, true);
  assert.equal(created.tab.title, 'Fixture');

  const snap = await call('page.snapshot', { tabId });
  assert.match(snap.elements, /e\d+ button "Delete"/);
  assert.match(snap.elements, /textbox|input\[text\]|input "Search"/);
  assert.equal(typeof snap.elements, 'string');

  const alert = await call('page.click', { tabId, selector: '#alert' });
  assert.equal(alert.notices[0].type, 'alert');
  assert.equal(alert.notices[0].handled, 'accepted');
  assert.equal(await outText(tabId), 'after-alert');

  const dismissed = await call('page.click', { tabId, selector: '#confirm' });
  assert.equal(dismissed.notices[0].handled, 'dismissed');
  assert.match(dismissed.notices[0].hint, /onDialog/);
  assert.equal(await outText(tabId), 'false');

  const deleteId = snap.elements.match(/(e\d+) button "Delete"/)[1];
  const accepted = await call('page.click', { tabId, elementId: deleteId, onDialog: 'accept' });
  assert.equal(accepted.notices[0].handled, 'accepted');
  assert.equal(await outText(tabId), 'true');

  await call('page.click', { tabId, selector: '#prompt', onDialog: 'accept', promptText: 'Zed' });
  assert.equal(await outText(tabId), 'Zed');

  let cdp = await call('cdp.health');
  assert.deepEqual(cdp.attachedTabs, [], 'debugger attached during DOM-only work');

  const blocked = await call('page.click', { tabId, selector: '#popup' });
  assert.equal(blocked.notices?.[0]?.kind, 'popupBlocked', `blocked popup not reported: ${JSON.stringify(blocked)}`);
  const popup = await call('page.click', { tabId, selector: '#popup', trusted: true });
  await delay(300);
  if (!popup.notices) Object.assign(popup, await call('cdp.getDialog', { tabId, timeoutMs: 0 }));
  const popupNotice = popup.notices?.find((notice) => notice.kind === 'popup');
  assert(popupNotice, `popup not reported: ${JSON.stringify(popup)}`);
  await call('tabs.close', { tabId: popupNotice.tabId });

  const modal = await call('page.click', { tabId, selector: '#modal' });
  assert.equal(modal.modal?.label, 'Settings');
  const modalSnap = await call('page.snapshot', { tabId, maxText: 0 });
  assert.match(modalSnap.elements.split('\n')[0], /"Close modal".* modal/);
  await call('page.click', { tabId, text: 'Close modal' });


  // A dialog the page opens on its own, outside any agent action, is native
  // and blocks the tab. The hook must still report it.
  // A dialog shortly after an action is still answered by the hook.
  await call('page.click', { tabId, selector: '#soon' });
  await delay(3500);
  const soon = await call('cdp.getDialog', { tabId, timeoutMs: 0 });
  assert.equal(soon.dialog, null);
  assert.equal(soon.notices?.[0]?.message, 'Soon?');
  assert.equal(soon.notices[0].handled, 'dismissed');

  await call('page.click', { tabId, selector: '#late' });
  await delay(11500);
  const pending = await call('cdp.getDialog', { tabId, timeoutMs: 2000 });
  assert.equal(pending.dialog?.message, 'Late?', `late dialog not seen: ${JSON.stringify(pending)}`);
  const lateResult = await call('cdp.handleDialog', { tabId, accept: true }).then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error: error.message }),
  );
  assert.equal(lateResult.ok, false);
  assert.match(lateResult.error, /only the user can answer it/);
  // Reloading clears it, and the bridge stops reporting it.
  await call('tabs.reload', { tabId });
  const cleared = await call('cdp.getDialog', { tabId, timeoutMs: 0 });
  assert.equal(cleared.dialog, null);

  const armed = await call('cdp.handleDialog', { tabId, accept: true, timeoutMs: 0 });
  assert.equal(armed.armed, true);

  const nav = await call('page.navigate', { tabId, url: `${base}/page2` });
  assert.equal(nav.loaded, true);
  assert.equal(nav.tab.title, 'Page two');
  const back = await call('tabs.back', { tabId });
  assert.equal(back.tab.title, 'Fixture');

  await call('tabs.select', { tabId });
  const shot = await call('page.screenshot', { tabId }).catch((error) => ({ error: error.message }));
  if (shot.error) {
    process.stdout.write(`screenshot skipped: ${shot.error}\n`);
  } else {
    assert.equal(shot.mimeType, 'image/jpeg');
    assert(shot.size.width <= 1280);
  }

  await call('cdp.key', { tabId, key: 'Tab' });
  cdp = await call('cdp.health');
  assert.deepEqual([...cdp.attachedTabs], [tabId]);
  await delay(16000);
  cdp = await call('cdp.health');
  assert.deepEqual(cdp.attachedTabs, [], 'debugger did not detach after idle');

  // Optional: compare compact vs verbose output size on a real page.
  if (process.env.E2E_MEASURE_URL) {
    await call('page.navigate', { tabId, url: process.env.E2E_MEASURE_URL, timeoutMs: 30000 }, 40000);
    for (const method of ['page.snapshot', 'page.extractLinks']) {
      const compact = JSON.stringify(await call(method, { tabId }));
      const verbose = JSON.stringify(await call(method, { tabId, verbose: true }), null, 2);
      process.stdout.write(`${method}: compact ${compact.length} chars, verbose/pretty ${verbose.length} chars\n`);
    }
  }

  process.stdout.write('E2E OK\n');
}

async function cleanup() {
  server.close();
  if (chrome && chrome.exitCode === null) {
    chrome.kill('SIGTERM');
    await Promise.race([new Promise((resolve) => chrome.once('exit', resolve)), delay(3000)]);
  }
  try {
    const health = await call('bridge.health', {}, 2000);
    if (health?.pid) process.kill(health.pid, 'SIGTERM');
  } catch {
    // Broker already gone.
  }
  await delay(300);
  fs.rmSync(WORK, { recursive: true, force: true });
}

main().then(cleanup, async (error) => {
  process.stderr.write(`E2E failed: ${error.stack || error.message}\n`);
  await cleanup();
  process.exit(1);
});
