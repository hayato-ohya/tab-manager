// High level session store: CRUD on IndexedDB plus tombstones for sync,
// change notifications, pruning of auto-saves and import/export.
import { sessionsDB, tombstonesDB } from './db.js';
import { captureCurrentSession, isAutoSession, recount, uuid, AUTO_TAGS, currentTabTitle, sortedTabs } from './session.js';
import { getSettings } from './settings.js';

export function notifyChanged(extra = {}) {
  chrome.runtime.sendMessage({ type: 'sessions-changed', ...extra }).catch(() => {});
}

export async function listSessions() {
  const all = await sessionsDB.all();
  return all.sort((a, b) => (b.date || 0) - (a.date || 0));
}

export const getSession = (id) => sessionsDB.get(id);

/** Store a session that was edited locally (bumps lastEditedTime). */
export async function putSession(session, { touch = true, notify = true } = {}) {
  if (touch) session.lastEditedTime = Date.now();
  recount(session);
  await sessionsDB.put(session);
  await tombstonesDB.remove(session.id).catch(() => {});
  if (notify) notifyChanged();
  return session;
}

export async function deleteSession(id, { notify = true } = {}) {
  const existing = await sessionsDB.get(id);
  await sessionsDB.remove(id);
  await tombstonesDB.put({ id, deletedAt: Date.now(), auto: existing ? isAutoSession(existing) : false });
  if (notify) notifyChanged();
}

export async function deleteSessions(ids) {
  for (const id of ids) await deleteSession(id, { notify: false });
  notifyChanged();
}

export async function renameSession(id, name) {
  const s = await sessionsDB.get(id);
  if (!s) return null;
  s.name = name;
  return putSession(s);
}

export async function setTags(id, tags) {
  const s = await sessionsDB.get(id);
  if (!s) return null;
  s.tag = [...new Set(tags.map((t) => t.trim()).filter(Boolean))];
  return putSession(s);
}

/** Remove a window or a tab from a saved session. */
export async function removeFromSession(id, windowId, tabId) {
  const s = await sessionsDB.get(id);
  if (!s || !s.windows[windowId]) return null;
  if (tabId === undefined) {
    delete s.windows[windowId];
    if (s.windowsInfo) delete s.windowsInfo[windowId];
  } else {
    delete s.windows[windowId][tabId];
    if (Object.keys(s.windows[windowId]).length === 0) {
      delete s.windows[windowId];
      if (s.windowsInfo) delete s.windowsInfo[windowId];
    }
  }
  if (Object.keys(s.windows).length === 0) {
    await deleteSession(id);
    return null;
  }
  return putSession(s);
}

export function defaultSessionName() {
  return '';
}

/**
 * Capture the current browser state and save it.
 * behavior: saveAllWindows | saveOnlyCurrentWindow
 */
export async function saveCurrentSession({ name = '', tag = [], behavior } = {}) {
  const settings = await getSettings();
  const onlyCurrentWindow = (behavior || settings.saveButtonBehavior) === 'saveOnlyCurrentWindow';
  const session = await captureCurrentSession({ name, tag, settings, onlyCurrentWindow });
  if (session.tabsNumber === 0) return null;
  return putSession(session, { touch: false });
}

/** Replace the windows of a saved session with the current browser state. */
export async function replaceCurrentSession(id, behavior = 'saveAllWindows') {
  const settings = await getSettings();
  const existing = await sessionsDB.get(id);
  if (!existing) return null;
  const fresh = await captureCurrentSession({ settings, onlyCurrentWindow: behavior === 'saveOnlyCurrentWindow' });
  if (fresh.tabsNumber === 0) return null;
  existing.windows = fresh.windows;
  existing.windowsInfo = fresh.windowsInfo;
  return putSession(existing);
}

/** Append the current window to a saved session. */
export async function addCurrentWindow(id) {
  const settings = await getSettings();
  const existing = await sessionsDB.get(id);
  if (!existing) return null;
  const fresh = await captureCurrentSession({ settings, onlyCurrentWindow: true });
  const [wid] = Object.keys(fresh.windows);
  if (!wid) return null;
  let newId = Number(wid);
  while (existing.windows[newId]) newId += 1;
  existing.windows[newId] = fresh.windows[wid];
  existing.windowsInfo ||= {};
  existing.windowsInfo[newId] = fresh.windowsInfo[wid];
  return putSession(existing);
}

/** Append the active tab to a window of a saved session. */
export async function addCurrentTab(id, windowId) {
  const existing = await sessionsDB.get(id);
  if (!existing || !existing.windows[windowId]) return null;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return null;
  const tabs = existing.windows[windowId];
  let tabId = tab.id;
  while (tabs[tabId]) tabId += 1;
  const index = sortedTabs(tabs).length;
  tabs[tabId] = {
    id: tabId,
    index,
    windowId: Number(windowId),
    url: tab.url || tab.pendingUrl || '',
    title: tab.title || '',
    favIconUrl: tab.favIconUrl || '',
    pinned: false,
    active: false,
    groupId: -1,
  };
  return putSession(existing);
}

/** Duplicate a session. */
export async function makeCopySession(id) {
  const existing = await sessionsDB.get(id);
  if (!existing) return null;
  const copy = structuredClone(existing);
  copy.id = uuid();
  copy.date = Date.now();
  copy.name = existing.name ? `${existing.name} - Copy` : '';
  copy.tag = (existing.tag || []).filter((t) => !AUTO_TAGS.includes(t) && t !== '_startup');
  return putSession(copy);
}

export async function addTag(id, tag) {
  const s = await sessionsDB.get(id);
  if (!s) return null;
  if (!s.tag.includes(tag)) s.tag.push(tag);
  return putSession(s);
}

export async function removeTag(id, tag) {
  const s = await sessionsDB.get(id);
  if (!s) return null;
  s.tag = s.tag.filter((t) => t !== tag);
  return putSession(s);
}

export { currentTabTitle };

/** Keep only the newest `limit` sessions carrying `tag`. */
export async function pruneAutoSessions(tag, limit) {
  if (!Number.isFinite(limit) || limit < 0) return;
  const all = await listSessions();
  const tagged = all.filter((s) => (s.tag || []).includes(tag));
  const extra = tagged.slice(limit);
  for (const s of extra) await deleteSession(s.id, { notify: false });
  if (extra.length) notifyChanged();
}

// ---------------------------------------------------------------------------
// Import / export (compatible with Tab Session Manager JSON)
// ---------------------------------------------------------------------------

function toNumber(v, fallback) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Date.parse(v);
    if (!Number.isNaN(n)) return n;
    const f = Number(v);
    if (Number.isFinite(f)) return f;
  }
  return fallback;
}

export function normalizeSession(raw) {
  if (!raw || typeof raw !== 'object' || !raw.windows || typeof raw.windows !== 'object') return null;
  const now = Date.now();
  const session = {
    id: typeof raw.id === 'string' && raw.id ? raw.id : uuid(),
    name: typeof raw.name === 'string' ? raw.name : '',
    date: toNumber(raw.date, now),
    lastEditedTime: toNumber(raw.lastEditedTime, toNumber(raw.date, now)),
    tag: Array.isArray(raw.tag) ? raw.tag.filter((t) => typeof t === 'string') : [],
    windows: {},
    windowsInfo: typeof raw.windowsInfo === 'object' && raw.windowsInfo ? raw.windowsInfo : {},
    windowsNumber: 0,
    tabsNumber: 0,
  };
  for (const [wid, tabs] of Object.entries(raw.windows)) {
    if (!tabs || typeof tabs !== 'object') continue;
    const out = {};
    for (const [tid, tab] of Object.entries(tabs)) {
      if (!tab || typeof tab !== 'object') continue;
      out[tid] = {
        id: tab.id ?? Number(tid),
        index: tab.index ?? 0,
        windowId: tab.windowId ?? Number(wid),
        url: tab.url || '',
        title: tab.title || '',
        favIconUrl: tab.favIconUrl || '',
        pinned: !!tab.pinned,
        active: !!tab.active,
        groupId: typeof tab.groupId === 'number' ? tab.groupId : -1,
      };
    }
    if (Object.keys(out).length) session.windows[wid] = out;
  }
  if (!session.name) session.name = defaultSessionName(new Date(session.date));
  return recount(session);
}

/** Import sessions from parsed JSON (array or single session). Returns count. */
export async function importSessions(json) {
  const list = Array.isArray(json) ? json : [json];
  const sessions = list.map(normalizeSession).filter(Boolean);
  const existing = new Map((await sessionsDB.all()).map((s) => [s.id, s]));
  const toPut = [];
  for (const s of sessions) {
    const cur = existing.get(s.id);
    if (cur && cur.lastEditedTime >= s.lastEditedTime) continue;
    toPut.push(s);
  }
  await sessionsDB.putMany(toPut);
  for (const s of toPut) await tombstonesDB.remove(s.id).catch(() => {});
  if (toPut.length) notifyChanged();
  return toPut.length;
}

export async function exportSessions(ids = null) {
  const all = await listSessions();
  const selected = ids ? all.filter((s) => ids.includes(s.id)) : all;
  return JSON.stringify(selected, null, 2);
}

export { AUTO_TAGS, isAutoSession };
