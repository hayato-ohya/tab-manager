// Two-way sync between the local IndexedDB and a storage provider.
//
// Remote layout (flat folder):
//   <sessionId>__<lastEditedTime>.json   a session
//   <sessionId>__<deletedAt>.tomb        a deletion marker
// The timestamp is part of the file name so that a single directory listing
// is enough to decide what to push and pull. Newest event (edit or delete) wins.
import { sessionsDB, tombstonesDB } from './db.js';
import { getSettings } from './settings.js';
import { createProvider } from './providers/index.js';
import { isAutoSession } from './session.js';
import { normalizeSession, notifyChanged } from './store.js';
import { ProviderError } from './providers/base.js';

const NAME_RE = /^([0-9a-zA-Z_-]+)__(\d+)\.(json|tomb)$/;

export async function setSyncStatus(status) {
  await chrome.storage.local.set({ syncStatus: { ...status, updatedAt: Date.now() } });
}

export async function getSyncStatus() {
  const { syncStatus } = await chrome.storage.local.get('syncStatus');
  return syncStatus || { state: 'idle' };
}

function parseRemote(entries) {
  const map = new Map(); // id → { json: [{name,time}], tomb: [{name,time}] }
  for (const { name } of entries) {
    const m = NAME_RE.exec(name);
    if (!m) continue;
    const [, id, time, kind] = m;
    const rec = map.get(id) || { json: [], tomb: [] };
    rec[kind].push({ name, time: Number(time) });
    map.set(id, rec);
  }
  return map;
}

function newest(list) {
  return list.reduce((best, cur) => (!best || cur.time > best.time ? cur : best), null);
}

/**
 * Run one sync pass. Safe to call from any extension context; a Web Lock
 * prevents two contexts from syncing at once.
 */
/**
 * Options:
 *   reason    free-form label stored with the status
 *   provider  injected provider (tests)
 *   settings  pre-loaded settings (contexts without chrome.storage, e.g. offscreen documents)
 *   onStatus  status sink; defaults to chrome.storage.local
 */
export async function sync({ reason = 'manual', provider: injected = null, settings: preset = null, onStatus = null } = {}) {
  const settings = preset || (await getSettings());
  const provider = injected || createProvider(settings);
  if (!provider) return { skipped: true };
  const report = onStatus || setSyncStatus;

  return navigator.locks.request('tab-manager-sync', async () => {
    await report({ state: 'syncing', reason });
    const stats = { pushed: 0, pulled: 0, deletedLocal: 0, deletedRemote: 0 };
    try {
      await provider.init();
      const remote = parseRemote(await provider.list());
      const includeAuto = !!settings.sync.syncAutoSaves;

      const locals = new Map((await sessionsDB.all()).map((s) => [s.id, s]));
      const tombs = new Map((await tombstonesDB.all()).map((t) => [t.id, t]));
      const ids = new Set([...locals.keys(), ...tombs.keys(), ...remote.keys()]);
      let changedLocal = false;

      for (const id of ids) {
        const local = locals.get(id);
        const tomb = tombs.get(id);
        const rem = remote.get(id) || { json: [], tomb: [] };
        const remJson = newest(rem.json);
        const remTomb = newest(rem.tomb);

        if (!includeAuto) {
          if (local && isAutoSession(local)) continue;
          if (!local && tomb?.auto) continue;
        }

        const events = [];
        if (local) events.push({ kind: 'edit', side: 'local', time: local.lastEditedTime || local.date || 0 });
        if (tomb) events.push({ kind: 'tomb', side: 'local', time: tomb.deletedAt || 0 });
        if (remJson) events.push({ kind: 'edit', side: 'remote', time: remJson.time });
        if (remTomb) events.push({ kind: 'tomb', side: 'remote', time: remTomb.time });
        if (events.length === 0) continue;
        const win = events.reduce((a, b) => (b.time > a.time ? b : a));

        if (win.kind === 'tomb') {
          if (local) {
            await sessionsDB.remove(id);
            stats.deletedLocal++;
            changedLocal = true;
          }
          if (!tomb || tomb.deletedAt < win.time) await tombstonesDB.put({ id, deletedAt: win.time, auto: tomb?.auto || false });
          for (const f of rem.json) {
            await provider.delete(f.name);
            stats.deletedRemote++;
          }
          if (!remTomb || remTomb.time < win.time) {
            await provider.write(`${id}__${win.time}.tomb`, '{}');
            for (const f of rem.tomb) await provider.delete(f.name);
          } else {
            for (const f of rem.tomb) if (f.name !== remTomb.name) await provider.delete(f.name);
          }
          continue;
        }

        // Edit wins.
        if (win.side === 'local') {
          if (!remJson || remJson.time < win.time) {
            await provider.write(`${id}__${win.time}.json`, JSON.stringify(local));
            stats.pushed++;
            for (const f of rem.json) await provider.delete(f.name);
          } else {
            for (const f of rem.json) if (f.name !== remJson.name) await provider.delete(f.name);
          }
          for (const f of rem.tomb) await provider.delete(f.name);
          if (tomb) await tombstonesDB.remove(id);
        } else {
          let parsed = null;
          try {
            parsed = normalizeSession(JSON.parse(await provider.read(remJson.name)));
          } catch (err) {
            console.warn('skip unreadable remote session', remJson.name, err);
          }
          if (parsed) {
            parsed.id = id;
            if (!includeAuto && isAutoSession(parsed)) continue;
            parsed.lastEditedTime = Math.max(parsed.lastEditedTime || 0, remJson.time);
            await sessionsDB.put(parsed);
            stats.pulled++;
            changedLocal = true;
            if (tomb) await tombstonesDB.remove(id);
            for (const f of rem.json) if (f.name !== remJson.name) await provider.delete(f.name);
            for (const f of rem.tomb) await provider.delete(f.name);
          }
        }
      }

      if (changedLocal) notifyChanged({ fromSync: true });
      const status = { state: 'ok', time: Date.now(), stats, reason };
      await report(status);
      return { ok: true, stats, status };
    } catch (err) {
      console.error('sync failed', err);
      const code = err instanceof ProviderError ? err.code : 'ERROR';
      const status = { state: 'error', code, message: err.message || String(err), reason };
      await report(status);
      return { ok: false, code, message: err.message, status };
    }
  });
}
