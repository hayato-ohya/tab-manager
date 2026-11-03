// Headless smoke test for folder sync (page path and background → offscreen path).
// Usage: node scripts/smoke-folder.mjs "$(pwd)"   (BROWSER=/path/to/chromium to override)
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const EXT = process.argv[2];
const BRAVE = process.env.BROWSER || '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser';
const profile = mkdtempSync(join(process.env.SCRATCH || tmpdir(), 'tm-profile-'));
const port = 9334;
const proc = spawn(BRAVE, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, `--load-extension=${EXT}`, `--disable-extensions-except=${EXT}`, '--no-first-run', '--disable-brave-rewards', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const targets = async () => (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
class CDP { constructor(ws){this.ws=ws;this.id=0;this.pending=new Map();this.events=[];ws.onmessage=(e)=>{const m=JSON.parse(e.data);if(m.id){this.pending.get(m.id)?.(m);this.pending.delete(m.id);}else this.events.push(m);};}
  static async connect(url){const ws=new WebSocket(url);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});return new CDP(ws);}
  send(method,params={}){const id=++this.id;this.ws.send(JSON.stringify({id,method,params}));return new Promise((r)=>this.pending.set(id,r));}
  async eval(expression){const r=await this.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});return r.result?.result?.value ?? JSON.stringify(r.result);} }
const problems = [];
try {
  for (let i = 0; i < 40; i++) { try { await targets(); break; } catch { await sleep(250); } }
  await sleep(1000);
  const sw = (await targets()).find((t) => t.type === 'service_worker');
  const extId = new URL(sw.url).host;
  const t = await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(`chrome-extension://${extId}/options/options.html`)}`, { method: 'PUT' })).json();
  const c = await CDP.connect(t.webSocketDebuggerUrl);
  await c.send('Runtime.enable'); await c.send('Log.enable');
  await sleep(800);
  console.log('showDirectoryPicker available:', await c.eval('typeof window.showDirectoryPicker'));
  // Use an OPFS directory as a stand-in for a picked folder.
  console.log('setup:', await c.eval(`(async () => {
    const { kv } = await import('/lib/db.js');
    const { saveSettings } = await import('/lib/settings.js');
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle('sync', { create: true });
    await kv.set('syncFolderHandle', dir);
    await saveSettings({ sync: { provider: 'folder', autoSync: true, interval: 1 } });
    const { saveCurrentSession } = await import('/lib/store.js');
    const s = await saveCurrentSession({ name: 'folder-test' });
    return 'perm=' + (await dir.queryPermission({mode:'readwrite'})) + ' saved=' + s.id;
  })()`));
  // 1) sync from the page context
  console.log('page sync:', await c.eval(`(async () => { const { sync } = await import('/lib/sync.js'); return JSON.stringify(await sync({reason:'test'})); })()`));
  console.log('files:', await c.eval(`(async () => { const root = await navigator.storage.getDirectory(); const dir = await root.getDirectoryHandle('sync'); const out=[]; for await (const [n] of dir.entries()) out.push(n); return out.join(','); })()`));
  // 2) sync through the background → offscreen path with a remote-only file
  console.log('plant remote:', await c.eval(`(async () => { const root = await navigator.storage.getDirectory(); const dir = await root.getDirectoryHandle('sync'); const fh = await dir.getFileHandle('remote-1__999.json', {create:true}); const w = await fh.createWritable(); await w.write(JSON.stringify({id:'remote-1', name:'from other browser', date: 999, lastEditedTime: 999, tag: [], windows:{1:{1:{url:'https://example.org', title:'x', index:0}}}})); await w.close(); return 'ok'; })()`));
  console.log('bg sync:', await c.eval(`chrome.runtime.sendMessage({type:'sync'}).then(r => JSON.stringify(r))`));
  await sleep(500);
  console.log('local sessions:', await c.eval(`(async () => { const { listSessions } = await import('/lib/store.js'); return (await listSessions()).map(s => s.name).join(' | '); })()`));
  console.log('status:', await c.eval(`chrome.storage.local.get('syncStatus').then(s => JSON.stringify(s.syncStatus))`));
  // Reload the options page: the cloud sync category should now show the folder provider's children.
  await c.send('Page.enable'); await c.send('Page.reload'); await sleep(1200);
  console.log('cloud sync UI:', await c.eval(`document.querySelector('#sync\\.provider')?.value + ':' + document.querySelectorAll('.childElements .optionContainer').length + ':' + (document.querySelector('.formColumn .status')?.textContent || '')`));
  console.log('targets now:', (await targets()).map((x) => x.type + ':' + x.url.split('/').slice(-1)[0]).join(', '));
  for (const e of c.events) {
    if (e.method === 'Runtime.exceptionThrown') problems.push(JSON.stringify(e.params.exceptionDetails).slice(0, 400));
    if (e.method === 'Log.entryAdded' && e.params.entry.level === 'error') problems.push(e.params.entry.text);
    if (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') problems.push(e.params.args.map((a) => a.value || a.description).join(' '));
  }
} catch (err) { problems.push('harness: ' + err.stack); } finally { proc.kill('SIGKILL'); }
console.log('\nPROBLEMS:', problems.length ? '\n' + problems.join('\n') : 'none');
