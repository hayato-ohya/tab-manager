// Auto-save policies (regular / window close / browser exit). Kept free of
// event wiring so they can be unit-tested; background.js supplies the inputs.
import { putSession, pruneAutoSessions, listSessions, deleteSessions } from './store.js';
import { sessionSignature } from './session.js';

/** Build and store a session from a subset of the snapshot's windows. */
function autoName(session, windowIds, settings) {
  if (!settings.useTabTitleforAutoSave) return '';
  for (const wid of windowIds) {
    const info = session.windowsInfo?.[wid];
    const tabs = Object.values(session.windows[wid] || {});
    const active = tabs.find((t) => t.active) || tabs[0];
    if (active?.title && (info?.focused || windowIds.length === 1)) return active.title;
  }
  for (const wid of windowIds) {
    const tabs = Object.values(session.windows[wid] || {});
    const active = tabs.find((t) => t.active) || tabs[0];
    if (active?.title) return active.title;
  }
  return '';
}

export async function saveFromSnapshot(snapshot, windowIds, tag, settings = {}) {
  const session = snapshot.session;
  const now = Date.now();
  const picked = {
    ...session,
    id: crypto.randomUUID(),
    name: autoName(session, windowIds, settings),
    date: now,
    lastEditedTime: now,
    tag: [tag],
    windows: {},
    windowsInfo: {},
  };
  for (const wid of windowIds) {
    if (!session.windows[wid]) continue;
    picked.windows[wid] = session.windows[wid];
    picked.windowsInfo[wid] = session.windowsInfo?.[wid] || {};
  }
  if (Object.keys(picked.windows).length === 0) return null;
  return putSession(picked, { touch: false });
}

/** Delete winClose saves produced by a quit cascade (one per window). */
export async function deleteRecentWinCloseSaves(since) {
  const all = await listSessions();
  const ids = all.filter((s) => (s.tag || []).includes('winClose') && s.date >= since).map((s) => s.id);
  if (ids.length) await deleteSessions(ids);
  return ids.length;
}

/**
 * A window was removed.
 * Returns 'browserExit' | 'winClose' | null depending on what was saved.
 */
export async function handleWindowRemoved({ windowId, snapshot, remainingWindows, settings, now = Date.now() }) {
  if (!snapshot || !snapshot.session.windows[windowId]) return null;
  if (remainingWindows === 0) {
    if (!settings.ifAutoSaveWhenExitBrowser) return null;
    await deleteRecentWinCloseSaves(now - 15_000);
    await saveFromSnapshot(snapshot, Object.keys(snapshot.session.windows), 'browserExit', settings);
    await pruneAutoSessions('browserExit', settings.autoSaveWhenExitBrowserLimit);
    await chrome.storage.local.set({ exitHandledFor: snapshot.time });
    return 'browserExit';
  }
  if (!settings.ifAutoSaveWhenClose) return null;
  const tabCount = Object.keys(snapshot.session.windows[windowId] || {}).length;
  if (tabCount < (Number(settings.autoSaveWhenCloseMinTabs) || 1)) return null;
  await saveFromSnapshot(snapshot, [String(windowId)], 'winClose', settings);
  await pruneAutoSessions('winClose', settings.autoSaveWhenCloseLimit);
  return 'winClose';
}

/**
 * Browser started. If the previous run ended without the exit handler running
 * (the usual case: the process quits before the service worker gets a chance),
 * convert the last snapshot into a browserExit session.
 */
export async function handleStartup({ snapshot, exitHandledFor, settings }) {
  if (!snapshot || !settings.ifAutoSaveWhenExitBrowser || exitHandledFor === snapshot.time) {
    await chrome.storage.local.remove('exitHandledFor');
    return false;
  }
  await deleteRecentWinCloseSaves(snapshot.time - 2_000);
  await saveFromSnapshot(snapshot, Object.keys(snapshot.session.windows), 'browserExit', settings);
  await pruneAutoSessions('browserExit', settings.autoSaveWhenExitBrowserLimit);
  await chrome.storage.local.remove('exitHandledFor');
  return true;
}

/** Periodic save. Returns true when a session was stored. */
export async function handleRegularSave({ session, settings }) {
  if (!settings.ifAutoSave || !session || session.tabsNumber === 0) return false;
  if (settings.skipUnchanged) {
    const sig = sessionSignature(session);
    const { lastRegularSig } = await chrome.storage.local.get('lastRegularSig');
    if (sig === lastRegularSig) return false;
    await chrome.storage.local.set({ lastRegularSig: sig });
  }
  session.tag = ['regular'];
  await putSession(session, { touch: false });
  await pruneAutoSessions('regular', settings.autoSaveLimit);
  return true;
}
