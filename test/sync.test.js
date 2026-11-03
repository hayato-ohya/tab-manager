import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryProvider, makeSession, storage } from './helpers.js';
import { sessionsDB, tombstonesDB } from '../lib/db.js';
import { putSession, deleteSession, importSessions } from '../lib/store.js';
import { sync } from '../lib/sync.js';

let provider;
beforeEach(async () => {
  provider = new MemoryProvider();
  storage.settings = { sync: { provider: 'memory', syncAutoSaves: false } };
  for (const s of await sessionsDB.all()) await sessionsDB.remove(s.id);
  for (const t of await tombstonesDB.all()) await tombstonesDB.remove(t.id);
});

test('pushes local sessions and pulls remote ones', async () => {
  await putSession(makeSession('a', { edited: 100 }), { touch: false, notify: false });
  provider.files['b__200.json'] = JSON.stringify(makeSession('b', { edited: 200 }));

  const result = await runSync();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(Object.keys(provider.files).sort(), ['a__100.json', 'b__200.json']);
  const local = (await sessionsDB.all()).map((s) => s.id).sort();
  assert.deepEqual(local, ['a', 'b']);
});

test('newer local edit replaces older remote file', async () => {
  provider.files['a__100.json'] = JSON.stringify(makeSession('a', { edited: 100, name: 'old' }));
  await putSession(makeSession('a', { edited: 300, name: 'new' }), { touch: false, notify: false });
  await runSync();
  assert.deepEqual(Object.keys(provider.files), ['a__300.json']);
  assert.equal(JSON.parse(provider.files['a__300.json']).name, 'new');
});

test('newer remote edit overwrites local copy', async () => {
  await putSession(makeSession('a', { edited: 100, name: 'old' }), { touch: false, notify: false });
  provider.files['a__500.json'] = JSON.stringify(makeSession('a', { edited: 500, name: 'remote' }));
  await runSync();
  const local = await sessionsDB.get('a');
  assert.equal(local.name, 'remote');
  assert.equal(local.lastEditedTime, 500);
});

test('local deletion propagates as a tombstone and removes the remote file', async () => {
  await putSession(makeSession('a', { edited: 100 }), { touch: false, notify: false });
  await runSync();
  assert.ok(provider.files['a__100.json']);
  await deleteSession('a', { notify: false });
  await runSync();
  assert.equal(provider.files['a__100.json'], undefined);
  const tombs = Object.keys(provider.files).filter((n) => n.endsWith('.tomb'));
  assert.equal(tombs.length, 1);
  assert.ok(tombs[0].startsWith('a__'));
});

test('remote tombstone deletes the local session, but a later edit resurrects it', async () => {
  await putSession(makeSession('a', { edited: 100 }), { touch: false, notify: false });
  provider.files['a__200.tomb'] = '{}';
  await runSync();
  assert.equal(await sessionsDB.get('a'), undefined);
  assert.ok(await tombstonesDB.get('a'));

  // Another browser edited it after the deletion.
  provider.files['a__300.json'] = JSON.stringify(makeSession('a', { edited: 300, name: 'back' }));
  await runSync();
  assert.equal((await sessionsDB.get('a')).name, 'back');
  assert.equal(await tombstonesDB.get('a'), undefined);
  assert.equal(provider.files['a__200.tomb'], undefined);
});

test('auto-saved sessions are not synced unless enabled', async () => {
  await putSession(makeSession('auto', { edited: 100, tag: ['regular'] }), { touch: false, notify: false });
  provider.files['rauto__100.json'] = JSON.stringify(makeSession('rauto', { edited: 100, tag: ['winClose'] }));
  await runSync();
  assert.equal(provider.files['auto__100.json'], undefined);
  assert.equal(await sessionsDB.get('rauto'), undefined);

  storage.settings.sync.syncAutoSaves = true;
  await runSync();
  assert.ok(provider.files['auto__100.json']);
  assert.ok(await sessionsDB.get('rauto'));
});

test('duplicate remote versions are reduced to the newest', async () => {
  provider.files['a__100.json'] = JSON.stringify(makeSession('a', { edited: 100, name: 'v1' }));
  provider.files['a__150.json'] = JSON.stringify(makeSession('a', { edited: 150, name: 'v2' }));
  await runSync();
  assert.deepEqual(Object.keys(provider.files), ['a__150.json']);
  assert.equal((await sessionsDB.get('a')).name, 'v2');
});

test('import keeps the newer copy and is TSM-format tolerant', async () => {
  const count = await importSessions([
    { id: 'x', name: 'tsm', date: '2024-01-02T03:04:05Z', windows: { 5: { 7: { url: 'https://a', title: 'A' } } } },
    { name: 'no-id', windows: { 1: { 1: { url: 'https://b' } } } },
    { name: 'broken' },
  ]);
  assert.equal(count, 2);
  const x = await sessionsDB.get('x');
  assert.equal(x.tabsNumber, 1);
  assert.equal(x.date, Date.parse('2024-01-02T03:04:05Z'));
});

async function runSync() {
  return sync({ reason: 'test', provider });
}
