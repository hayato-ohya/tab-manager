import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeSession, storage } from './helpers.js';
import { sessionsDB, tombstonesDB } from '../lib/db.js';
import { DEFAULT_SETTINGS } from '../lib/settings.js';
import { handleWindowRemoved, handleStartup, handleRegularSave } from '../lib/autosave.js';

const settings = () => JSON.parse(JSON.stringify(DEFAULT_SETTINGS));

function snapshot(time = 5000) {
  const session = makeSession('snap', { edited: time });
  session.windows[2] = { 20: { id: 20, index: 0, windowId: 2, url: 'https://b', title: 'B', pinned: false, active: true } };
  session.windowsInfo[2] = { state: 'maximized' };
  session.windowsNumber = 2;
  session.tabsNumber = 2;
  return { time, session };
}

beforeEach(async () => {
  for (const s of await sessionsDB.all()) await sessionsDB.remove(s.id);
  for (const t of await tombstonesDB.all()) await tombstonesDB.remove(t.id);
  for (const k of Object.keys(storage)) delete storage[k];
});

test('closing one window saves only that window as winClose', async () => {
  const r = await handleWindowRemoved({ windowId: 2, snapshot: snapshot(), remainingWindows: 1, settings: settings() });
  assert.equal(r, 'winClose');
  const all = await sessionsDB.all();
  assert.equal(all.length, 1);
  assert.deepEqual(all[0].tag, ['winClose']);
  assert.deepEqual(Object.keys(all[0].windows), ['2']);
  assert.equal(all[0].windowsInfo[2].state, 'maximized');
  assert.equal(all[0].tabsNumber, 1);
});

test('unknown window or disabled setting saves nothing', async () => {
  assert.equal(await handleWindowRemoved({ windowId: 99, snapshot: snapshot(), remainingWindows: 1, settings: settings() }), null);
  const s = settings();
  s.ifAutoSaveWhenClose = false;
  assert.equal(await handleWindowRemoved({ windowId: 2, snapshot: snapshot(), remainingWindows: 1, settings: s }), null);
  assert.equal((await sessionsDB.all()).length, 0);
});

test('closing the last window saves everything as browserExit and marks the snapshot handled', async () => {
  const now = 10_000;
  // A winClose produced moments earlier by the quit cascade.
  await handleWindowRemoved({ windowId: 1, snapshot: snapshot(), remainingWindows: 1, settings: settings(), now });
  const r = await handleWindowRemoved({ windowId: 2, snapshot: snapshot(), remainingWindows: 0, settings: settings(), now });
  assert.equal(r, 'browserExit');
  const all = await sessionsDB.all();
  assert.equal(all.length, 1, 'cascade winClose removed');
  assert.deepEqual(all[0].tag, ['browserExit']);
  assert.equal(all[0].windowsNumber, 2);
  assert.equal(storage.exitHandledFor, 5000);
});

test('startup converts an unhandled snapshot into browserExit, but not twice', async () => {
  assert.equal(await handleStartup({ snapshot: snapshot(), exitHandledFor: undefined, settings: settings() }), true);
  assert.equal(await handleStartup({ snapshot: snapshot(), exitHandledFor: 5000, settings: settings() }), false);
  const all = await sessionsDB.all();
  assert.equal(all.length, 1);
  assert.deepEqual(all[0].tag, ['browserExit']);
});

test('limits prune the oldest auto saves of the same kind only', async () => {
  const s = settings();
  s.autoSaveWhenCloseLimit = 2;
  for (let i = 0; i < 4; i++) {
    await handleWindowRemoved({ windowId: 2, snapshot: snapshot(), remainingWindows: 1, settings: s });
  }
  await handleRegularSave({ session: makeSession('r1', { edited: 1 }), settings: s });
  const all = await sessionsDB.all();
  assert.equal(all.filter((x) => x.tag.includes('winClose')).length, 2);
  assert.equal(all.filter((x) => x.tag.includes('regular')).length, 1);
});

test('regular save skips identical states when skipUnchanged is on', async () => {
  const s = settings();
  assert.equal(await handleRegularSave({ session: makeSession('a', { edited: 1, url: 'https://same' }), settings: s }), true);
  assert.equal(await handleRegularSave({ session: makeSession('b', { edited: 2, url: 'https://same' }), settings: s }), false);
  assert.equal(await handleRegularSave({ session: makeSession('c', { edited: 3, url: 'https://other' }), settings: s }), true);
  s.skipUnchanged = false;
  assert.equal(await handleRegularSave({ session: makeSession('d', { edited: 4, url: 'https://other' }), settings: s }), true);
  assert.equal((await sessionsDB.all()).length, 3);
});
