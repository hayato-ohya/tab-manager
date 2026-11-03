// Session capture / restore. The on-disk format is compatible with
// Tab Session Manager exports so existing backups can be imported.
//
// session = {
//   id, name, date, lastEditedTime, tag: [],
//   windows: { [windowId]: { [tabId]: tab } },
//   windowsInfo: { [windowId]: { state, type, left, top, width, height, incognito, groups } },
//   windowsNumber, tabsNumber
// }

export const AUTO_TAGS = ['regular', 'winClose', 'browserExit'];

export function isAutoSession(session) {
  return (session.tag || []).some((t) => AUTO_TAGS.includes(t));
}

export function uuid() {
  return crypto.randomUUID();
}

function pickTab(tab) {
  return {
    id: tab.id,
    index: tab.index,
    windowId: tab.windowId,
    url: tab.url || tab.pendingUrl || '',
    title: tab.title || '',
    favIconUrl: tab.favIconUrl || '',
    pinned: !!tab.pinned,
    active: !!tab.active,
    groupId: typeof tab.groupId === 'number' ? tab.groupId : -1,
    discarded: !!tab.discarded,
  };
}

async function captureGroups(windowId) {
  if (!chrome.tabGroups) return {};
  try {
    const groups = await chrome.tabGroups.query({ windowId });
    const out = {};
    for (const g of groups) out[g.id] = { title: g.title || '', color: g.color, collapsed: !!g.collapsed };
    return out;
  } catch {
    return {};
  }
}

function ignoreMatcher(list) {
  const patterns = String(list || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((p) => new RegExp('^' + p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$'));
  return (url) => patterns.some((re) => re.test(url || ''));
}

/** Build a session object from chrome.windows.Window[] (populated with tabs). */
export async function buildSession(windows, { name = '', tag = [], settings = {} } = {}) {
  const ignored = ignoreMatcher(settings.ignoreUrlList);
  const now = Date.now();
  const session = {
    id: uuid(),
    name,
    date: now,
    lastEditedTime: now,
    tag: [...tag],
    windows: {},
    windowsInfo: {},
    windowsNumber: 0,
    tabsNumber: 0,
  };
  for (const win of windows) {
    if (!win.tabs || win.tabs.length === 0) continue;
    if (win.incognito && settings.ifSavePrivateWindow === false) continue;
    const kept = win.tabs.filter((tab) => !ignored(tab.url || tab.pendingUrl || ''));
    if (kept.length === 0) continue;
    const tabs = {};
    for (const tab of kept) tabs[tab.id] = pickTab(tab);
    session.windows[win.id] = tabs;
    session.windowsInfo[win.id] = {
      state: win.state,
      type: win.type,
      left: win.left,
      top: win.top,
      width: win.width,
      height: win.height,
      incognito: !!win.incognito,
      focused: !!win.focused,
      groups: settings.saveTabGroups === false ? {} : await captureGroups(win.id),
    };
    session.windowsNumber += 1;
    session.tabsNumber += kept.length;
  }
  return session;
}

export async function captureCurrentSession(opts = {}) {
  let windows;
  if (opts.onlyCurrentWindow) {
    const current = await chrome.windows.getLastFocused({ populate: true, windowTypes: ['normal'] });
    windows = current ? [current] : [];
  } else {
    windows = await chrome.windows.getAll({ populate: true, windowTypes: ['normal'] });
  }
  return buildSession(windows, opts);
}

/** Title of the active tab in the focused window (used as default session name). */
export async function currentTabTitle(settings = {}) {
  let tabs = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => []);
  if (tabs[0]?.incognito && settings.ifSavePrivateWindow === false) {
    tabs = (await chrome.tabs.query({ active: true })).filter((t) => !t.incognito);
  }
  return tabs[0]?.title || '';
}

/** Recalculate counters after editing a session. */
export function recount(session) {
  session.windowsNumber = Object.keys(session.windows).length;
  session.tabsNumber = Object.values(session.windows).reduce((n, tabs) => n + Object.keys(tabs).length, 0);
  return session;
}

/** Tabs of a window sorted by index. */
export function sortedTabs(tabsMap) {
  return Object.values(tabsMap || {}).sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
}

/** Stable signature of the open tabs, used to skip identical auto-saves. */
export function sessionSignature(session) {
  const wins = Object.values(session.windows)
    .map((tabs) => sortedTabs(tabs).map((t) => t.url).join('\n'))
    .sort();
  return wins.join('\n\n');
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

const UNOPENABLE = /^(javascript|data|blob|view-source):/i;
const RESTRICTED = /^(chrome|brave|edge|vivaldi|opera|about|file|chrome-extension|moz-extension):/i;

export function lazyUrl(tab) {
  const params = new URLSearchParams({ url: tab.url, title: tab.title || '', icon: tab.favIconUrl || '' });
  return chrome.runtime.getURL('lazy/lazy.html') + '#' + params.toString();
}

function urlFor(tab, lazy) {
  const url = tab.url || 'about:blank';
  if (UNOPENABLE.test(url)) return lazyUrl(tab);
  if (lazy && !RESTRICTED.test(url)) return lazyUrl(tab);
  return url;
}

async function createTab(props, tab) {
  try {
    return await chrome.tabs.create(props);
  } catch (err) {
    // Restricted URL (chrome://, file:// without permission, ...) → show a placeholder instead.
    if (props.url !== lazyUrl(tab)) return chrome.tabs.create({ ...props, url: lazyUrl(tab) });
    throw err;
  }
}

async function applyGroups(windowId, groupsInfo, tabIdByGroup) {
  if (!chrome.tabGroups || !chrome.tabs.group) return;
  for (const [oldGroupId, tabIds] of Object.entries(tabIdByGroup)) {
    if (tabIds.length === 0) continue;
    try {
      const gid = await chrome.tabs.group({ tabIds, createProperties: { windowId } });
      const info = groupsInfo?.[oldGroupId];
      if (info) {
        const update = { title: info.title || '', color: info.color };
        await chrome.tabGroups.update(gid, update);
        if (info.collapsed) await chrome.tabGroups.update(gid, { collapsed: true }).catch(() => {});
      }
    } catch (err) {
      console.warn('tab group restore failed', err);
    }
  }
}

/**
 * Create the tabs of a saved window inside an existing window.
 * Returns the ids of the created tabs.
 */
async function populateWindow(windowId, session, savedWindowId, { lazyLoad, skipFirst = null, startIndex } = {}) {
  const tabs = sortedTabs(session.windows[savedWindowId]);
  const groups = session.windowsInfo?.[savedWindowId]?.groups || {};
  const created = [];
  const tabIdByGroup = {};
  let activeId = null;
  for (let i = 0; i < tabs.length; i++) {
    const tab = tabs[i];
    let newTab;
    if (i === 0 && skipFirst) {
      newTab = skipFirst;
    } else {
      const props = {
        windowId,
        url: urlFor(tab, lazyLoad && !tab.active),
        pinned: !!tab.pinned,
        active: false,
      };
      if (typeof startIndex === 'number') props.index = startIndex + i;
      newTab = await createTab(props, tab);
    }
    created.push(newTab.id);
    if (tab.active) activeId = newTab.id;
    if (tab.groupId !== undefined && tab.groupId !== -1 && !tab.pinned) {
      (tabIdByGroup[tab.groupId] ||= []).push(newTab.id);
    }
  }
  if (activeId !== null) await chrome.tabs.update(activeId, { active: true }).catch(() => {});
  await applyGroups(windowId, groups, tabIdByGroup);
  return created;
}

function windowCreateData(info, settings) {
  const data = {};
  if (info?.incognito) data.incognito = true;
  if (!settings.isRestoreWindowPosition || !info) return data;
  if (info.state && info.state !== 'normal') {
    data.state = info.state;
  } else if ([info.left, info.top, info.width, info.height].every((n) => typeof n === 'number')) {
    Object.assign(data, { left: info.left, top: info.top, width: info.width, height: info.height });
  }
  return data;
}

/** Open one saved window in a brand-new browser window. */
export async function openWindowInNew(session, savedWindowId, settings) {
  const tabs = sortedTabs(session.windows[savedWindowId]);
  if (tabs.length === 0) return null;
  const info = session.windowsInfo?.[savedWindowId];
  const first = tabs[0];
  const base = windowCreateData(info, settings);
  let win;
  try {
    win = await chrome.windows.create({ ...base, url: urlFor(first, false), focused: true });
  } catch {
    win = await chrome.windows.create({ ...base, url: lazyUrl(first), focused: true });
  }
  const firstTab = win.tabs?.[0] || (await chrome.tabs.query({ windowId: win.id }))[0];
  if (first.pinned) await chrome.tabs.update(firstTab.id, { pinned: true }).catch(() => {});
  await populateWindow(win.id, session, savedWindowId, { lazyLoad: settings.ifLazyLoading, skipFirst: firstTab });
  return win;
}

/** Open the whole session. mode: openInNewWindow | openInCurrentWindow | addToCurrentWindow */
export async function openSession(session, mode, settings) {
  const savedWindowIds = Object.keys(session.windows);
  if (savedWindowIds.length === 0) return;

  // Like TSM: adding a multi-window session to the current window opens new windows instead.
  if (mode === 'addToCurrentWindow' && savedWindowIds.length > 1) mode = 'openInNewWindow';

  if (mode === 'addToCurrentWindow') {
    const current = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    for (const wid of savedWindowIds) {
      await populateWindow(current.id, session, wid, { lazyLoad: settings.ifLazyLoading });
    }
    return;
  }

  let rest = savedWindowIds;
  if (mode === 'openInCurrentWindow') {
    const current = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
    const oldTabs = (await chrome.tabs.query({ windowId: current.id })).map((t) => t.id);
    await populateWindow(current.id, session, savedWindowIds[0], { lazyLoad: settings.ifLazyLoading });
    await chrome.tabs.remove(oldTabs).catch(() => {});
    rest = savedWindowIds.slice(1);
  }
  for (const wid of rest) await openWindowInNew(session, wid, settings);
}

/** Open a single saved window. */
export async function openWindow(session, savedWindowId, mode, settings) {
  if (mode === 'openInNewWindow') return openWindowInNew(session, savedWindowId, settings);
  const current = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
  if (mode === 'openInCurrentWindow') {
    const oldTabs = (await chrome.tabs.query({ windowId: current.id })).map((t) => t.id);
    await populateWindow(current.id, session, savedWindowId, { lazyLoad: settings.ifLazyLoading });
    await chrome.tabs.remove(oldTabs).catch(() => {});
  } else {
    await populateWindow(current.id, session, savedWindowId, { lazyLoad: settings.ifLazyLoading });
  }
}

/** Open a single saved tab in the current window. */
export async function openTab(tab, { active = true } = {}) {
  return createTab({ url: urlFor(tab, false), active }, tab);
}
