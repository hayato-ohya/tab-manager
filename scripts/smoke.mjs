// Usage: node scripts/smoke.mjs "$(pwd)"   (BROWSER=/path/to/chromium to override)
// Headless smoke test: load the unpacked extension, open popup & options pages,
// collect console errors / exceptions through the DevTools protocol.
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EXT = process.argv[2];
const BRAVE = process.env.BROWSER || '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const profile = mkdtempSync(join(process.env.SCRATCH || tmpdir(), 'tm-profile-'));
const port = 9333;
const proc = spawn(BRAVE, [
  '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
  `--load-extension=${EXT}`, `--disable-extensions-except=${EXT}`, '--window-size=900,700', '--no-first-run', '--no-default-browser-check',
  '--disable-brave-rewards', '--disable-brave-update', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function targets() {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  return res.json();
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.events = [];
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id) { this.pending.get(m.id)?.(m); this.pending.delete(m.id); } else this.events.push(m); }; }
  static async connect(url) { const ws = new WebSocket(url); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; }); return new CDP(ws); }
  send(method, params = {}) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params })); return new Promise((r) => this.pending.set(id, r)); }
}

const problems = [];
try {
  for (let i = 0; i < 40; i++) { try { await targets(); break; } catch { await sleep(250); } }
  await sleep(1500);
  let list = await targets();
  const sw = list.find((t) => t.type === 'service_worker' && t.url.includes('background.js'));
  console.log('targets:', list.map((t) => `${t.type}:${t.url}`).join('\n  '));
  if (!sw) problems.push('service worker not found');
  const extId = sw ? new URL(sw.url).host : null;

  if (sw) {
    const c = await CDP.connect(sw.webSocketDebuggerUrl);
    await c.send('Runtime.enable');
    await c.send('Log.enable');
    await sleep(500);
    const r = await c.send('Runtime.evaluate', { expression: `(async () => {
      const r1 = await new Promise(res => chrome.runtime.onMessage.dispatch ? res('n/a') : res('ok'));
      const s = await chrome.storage.local.get(null);
      return JSON.stringify({ keys: Object.keys(s), alarms: (await chrome.alarms.getAll()).map(a=>a.name) });
    })()`, awaitPromise: true });
    console.log('sw eval:', r.result?.result?.value || JSON.stringify(r.result));
    for (const e of c.events) if (e.method === 'Runtime.exceptionThrown' || (e.method === 'Log.entryAdded' && e.params.entry.level === 'error')) problems.push('SW: ' + JSON.stringify(e.params).slice(0, 300));
    for (const e of c.events) if (e.method === 'Runtime.consoleAPICalled' && ['error','warning'].includes(e.params.type)) problems.push('SW console: ' + e.params.args.map(a=>a.value||a.description).join(' '));
  }

  // Open popup & options pages as tabs and watch for errors.
  for (const page of ['popup/popup.html', 'options/options.html', 'lazy/lazy.html#url=https%3A%2F%2Fexample.com&title=Example']) {
    const url = `chrome-extension://${extId}/${page}`;
    const res = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
    const t = await res.json();
    const c = await CDP.connect(t.webSocketDebuggerUrl);
    await c.send('Runtime.enable');
    await c.send('Log.enable');
    await sleep(1500);
    const r = await c.send('Runtime.evaluate', { expression: `JSON.stringify({ title: document.title, text: document.body.innerText.slice(0, 200) })`, returnByValue: true });
    console.log(page, '→', r.result?.result?.value);
    if (page.startsWith('options')) {
      const shot = await c.send('Page.captureScreenshot', { format: 'png' });
      (await import('node:fs')).writeFileSync(process.env.SHOT_DIR + '/options.png', Buffer.from(shot.result.data, 'base64'));
    }
    for (const e of c.events) {
      if (e.method === 'Runtime.exceptionThrown') problems.push(page + ': ' + JSON.stringify(e.params.exceptionDetails).slice(0, 400));
      if (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') problems.push(page + ' log: ' + e.params.entry.text + ' ' + (e.params.entry.url || ''));
      if (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') problems.push(page + ' console: ' + e.params.args.map((a) => a.value || a.description).join(' '));
    }
    if (page.startsWith('popup')) {
      // Save a session through the popup form and check that it shows up.
      await c.send('Runtime.evaluate', { expression: `document.querySelector('#saveInput').value='smoke'; document.querySelector('#saveButton').click();` });
      await sleep(1500);
      const r2 = await c.send('Runtime.evaluate', { expression: `document.querySelectorAll('.sessionItem').length + ':' + (document.querySelector('.sessionItem .name')?.textContent||'') + ':' + document.querySelector('#filterSelect').options.length + ':' + document.querySelector('#notification').className`, returnByValue: true });
      console.log('after save →', r2.result?.result?.value);
      if (!String(r2.result?.result?.value).startsWith('1:smoke')) problems.push('popup save did not list the session');
      const r3 = await c.send('Runtime.evaluate', { expression: `document.querySelectorAll('#sessionDetailArea .tabContainer').length + ':' + document.querySelector('#sessionDetailArea .sessionName').textContent + ':' + document.querySelector('#sessionDetailArea .windowsInfo').textContent`, returnByValue: true });
      console.log('details →', r3.result?.result?.value);
      if (!String(r3.result?.result?.value).startsWith('2:smoke')) problems.push('details area not rendered');
      // Context menu + modal rename + tag flow
      await c.send('Runtime.evaluate', { expression: `document.querySelector('.sessionItem .selectButton').dispatchEvent(new MouseEvent('contextmenu', {bubbles:true, cancelable:true, clientX: 50, clientY: 100}))` });
      const r3b = await c.send('Runtime.evaluate', { expression: `document.querySelector('#menu').hidden + ':' + document.querySelectorAll('#menu li button').length`, returnByValue: true });
      console.log('menu →', r3b.result?.result?.value);
      if (!String(r3b.result?.result?.value).startsWith('false:')) problems.push('context menu did not open');
      await c.send('Runtime.evaluate', { expression: `document.querySelector('#menu .closeMenuButton').click(); document.querySelector('#sessionDetailArea .addTagButton').click();` });
      await sleep(300);
      await c.send('Runtime.evaluate', { expression: `const i = document.querySelector('#modal input'); i.value = 'work'; i.form.requestSubmit();` });
      await sleep(500);
      const r3c = await c.send('Runtime.evaluate', { expression: `[...document.querySelectorAll('#sessionDetailArea .tag span')].map(s => s.textContent).join(',') + '|' + document.querySelector('#modalBackground').className + '|' + document.querySelector('#filterSelect').options.length`, returnByValue: true });
      console.log('tags →', r3c.result?.result?.value);
      if (!String(r3c.result?.result?.value).startsWith('work|isClose|')) problems.push('tag add via modal failed');
      const shot = await c.send('Page.captureScreenshot', { format: 'png' });
      (await import('node:fs')).writeFileSync(process.env.SHOT_DIR + '/popup.png', Buffer.from(shot.result.data, 'base64'));
      await c.send('Runtime.evaluate', { expression: `chrome.runtime.sendMessage({type:'open-session', mode:'openInNewWindow', id: document.querySelector('.sessionItem').dataset.id})`, awaitPromise: true });
      await sleep(1500);
      const r4 = await c.send('Runtime.evaluate', { expression: `chrome.windows.getAll({populate:true}).then(w => JSON.stringify(w.map(x => x.tabs.map(t=>t.url))))`, awaitPromise: true, returnByValue: true });
      console.log('windows after open →', r4.result?.result?.value);
      for (const e of c.events) if (e.method === 'Runtime.exceptionThrown') problems.push('popup(after): ' + JSON.stringify(e.params.exceptionDetails).slice(0, 400));
    }
  }
} catch (err) {
  problems.push('harness: ' + err.stack);
} finally {
  proc.kill('SIGKILL');
}
console.log('\nPROBLEMS:', problems.length ? '\n' + problems.join('\n') : 'none');
process.exit(problems.length ? 1 : 0);
