// Service worker: auto-save, window-close / browser-exit capture, sync scheduling
// and session restore on behalf of the popup (the popup closes as soon as a new
// window takes focus, so anything that opens windows must run here).
import { getSettings } from './lib/settings.js';
import { captureCurrentSession, openSession, openWindow, openTab, currentTabTitle } from './lib/session.js';
import { getSession, saveCurrentSession, listSessions } from './lib/store.js';
import { handleWindowRemoved, handleStartup, handleRegularSave } from './lib/autosave.js';
import { sync, setSyncStatus } from './lib/sync.js';

const ALARM_REGULAR = 'regular-save';
const ALARM_SYNC = 'sync';
const SNAPSHOT_KEY = 'lastSnapshot';

// ---------------------------------------------------------------------------
// Alarms
// ---------------------------------------------------------------------------
async function setupAlarms() {
  const settings = await getSettings();
  await chrome.alarms.clear(ALARM_REGULAR);
  await chrome.alarms.clear(ALARM_SYNC);
  if (settings.ifAutoSave) {
    const period = Math.max(0.5, Number(settings.autoSaveInterval) || 15);
    chrome.alarms.create(ALARM_REGULAR, { periodInMinutes: period, delayInMinutes: period });
  }
  if (settings.sync.provider !== 'none' && settings.sync.autoSync) {
    const period = Math.max(1, Number(settings.sync.interval) || 5);
    chrome.alarms.create(ALARM_SYNC, { periodInMinutes: period, delayInMinutes: 0.2 });
  }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_REGULAR) await regularSave();
  if (alarm.name === ALARM_SYNC) await runSync('alarm');
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) setupAlarms();
});

// ---------------------------------------------------------------------------
// Snapshot of the currently open windows (used for winClose / browserExit saves)
// ---------------------------------------------------------------------------
let snapshotTimer = null;

async function updateSnapshot() {
  try {
    const settings = await getSettings();
    const session = await captureCurrentSession({ settings });
    if (session.tabsNumber === 0) return;
    await chrome.storage.local.set({ [SNAPSHOT_KEY]: { time: Date.now(), session } });
  } catch (err) {
    console.warn('snapshot failed', err);
  }
}

function scheduleSnapshot() {
  clearTimeout(snapshotTimer);
  snapshotTimer = setTimeout(updateSnapshot, 700);
}

async function readSnapshot() {
  const data = await chrome.storage.local.get(SNAPSHOT_KEY);
  return data[SNAPSHOT_KEY] || null;
}

chrome.tabs.onCreated.addListener(scheduleSnapshot);
chrome.tabs.onMoved.addListener(scheduleSnapshot);
chrome.tabs.onAttached.addListener(scheduleSnapshot);
chrome.tabs.onDetached.addListener(scheduleSnapshot);
chrome.tabs.onActivated.addListener(scheduleSnapshot);
chrome.tabs.onUpdated.addListener((_id, info) => {
  if (info.url || info.title || info.pinned !== undefined || info.favIconUrl || info.groupId !== undefined || info.status === 'complete') {
    scheduleSnapshot();
  }
});
chrome.tabs.onRemoved.addListener((_id, info) => {
  if (!info.isWindowClosing) scheduleSnapshot();
});
chrome.windows.onCreated.addListener(scheduleSnapshot);
if (chrome.windows.onBoundsChanged) chrome.windows.onBoundsChanged.addListener(scheduleSnapshot);
if (chrome.tabGroups) {
  chrome.tabGroups.onUpdated.addListener(scheduleSnapshot);
  chrome.tabGroups.onRemoved.addListener(scheduleSnapshot);
}

chrome.windows.onRemoved.addListener(async (windowId) => {
  clearTimeout(snapshotTimer);
  const settings = await getSettings();
  const snapshot = await readSnapshot();
  const remaining = await chrome.windows.getAll({ windowTypes: ['normal'] });
  const saved = await handleWindowRemoved({ windowId, snapshot, remainingWindows: remaining.length, settings });
  if (saved === 'browserExit') return;
  if (saved === 'winClose') scheduleSyncSoon();
  scheduleSnapshot();
});

// ---------------------------------------------------------------------------
// Startup / install
// ---------------------------------------------------------------------------
chrome.runtime.onStartup.addListener(async () => {
  const settings = await getSettings();
  const snapshot = await readSnapshot();
  const { exitHandledFor } = await chrome.storage.local.get('exitHandledFor');
  await handleStartup({ snapshot, exitHandledFor, settings });
  await setupAlarms();
  await runStartupBehavior(settings);
  scheduleSnapshot();
  scheduleSyncSoon();
});

async function runStartupBehavior(settings) {
  try {
    let toOpen = [];
    if (settings.startupBehavior === 'previousSession') {
      const last = (await listSessions()).find((s) => (s.tag || []).includes('browserExit'));
      if (last) toOpen = [last];
    } else if (settings.startupBehavior === 'startupSession') {
      toOpen = (await listSessions()).filter((s) => (s.tag || []).includes('_startup'));
    }
    for (let i = 0; i < toOpen.length; i++) {
      await openSession(toOpen[i], i === 0 ? 'openInCurrentWindow' : 'openInNewWindow', settings);
    }
  } catch (err) {
    console.warn('startup behavior failed', err);
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  await setupAlarms();
  scheduleSnapshot();
});

// ---------------------------------------------------------------------------
// Regular auto-save
// ---------------------------------------------------------------------------
async function regularSave() {
  const settings = await getSettings();
  if (!settings.ifAutoSave) return;
  const name = settings.useTabTitleforAutoSave ? await currentTabTitle(settings) : '';
  const session = await captureCurrentSession({ name, tag: ['regular'], settings });
  if (await handleRegularSave({ session, settings })) scheduleSyncSoon();
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------
let syncSoonTimer = null;
function scheduleSyncSoon() {
  clearTimeout(syncSoonTimer);
  syncSoonTimer = setTimeout(() => runSync('change'), 3_000);
}

async function ensureOffscreen() {
  if (!chrome.offscreen) return false;
  const has = chrome.offscreen.hasDocument ? await chrome.offscreen.hasDocument() : false;
  if (!has) {
    await chrome.offscreen.createDocument({
      url: 'offscreen/offscreen.html',
      reasons: ['WORKERS'],
      justification: 'Read and write session files in the configured sync folder',
    }).catch((err) => {
      if (!/single offscreen/i.test(err.message)) throw err;
    });
  }
  return true;
}

export async function runSync(reason = 'manual') {
  const settings = await getSettings();
  if (settings.sync.provider === 'none') return { skipped: true };
  if (!settings.sync.autoSync && reason !== 'manual') return { skipped: true };
  if (settings.sync.provider === 'folder') {
    // The File System Access API is not usable from a service worker; delegate to an offscreen document.
    if (!(await ensureOffscreen())) return { ok: false, code: 'UNSUPPORTED' };
    await setSyncStatus({ state: 'syncing', reason });
    try {
      const result = await chrome.runtime.sendMessage({ type: 'offscreen-sync', reason, settings });
      await setSyncStatus(result?.status || { state: 'error', code: 'ERROR', message: 'no response', reason });
      return result;
    } catch (err) {
      await setSyncStatus({ state: 'error', code: 'ERROR', message: err.message, reason });
      return { ok: false, code: 'ERROR', message: err.message };
    }
  }
  return sync({ reason });
}

// ---------------------------------------------------------------------------
// Commands & messages
// ---------------------------------------------------------------------------
chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'save-session') {
    const settings = await getSettings();
    await saveCurrentSession({ name: await currentTabTitle(settings), tag: [] });
    scheduleSyncSoon();
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return false;
  if (msg.type === 'offscreen-sync') return false; // handled by the offscreen document
  (async () => {
    const settings = await getSettings();
    switch (msg.type) {
      case 'open-session': {
        const session = await getSession(msg.id);
        if (session) await openSession(session, msg.mode || settings.openButtonBehavior, settings);
        return { ok: true };
      }
      case 'open-window': {
        const session = await getSession(msg.id);
        if (session) await openWindow(session, msg.windowId, msg.mode || settings.openButtonBehavior, settings);
        return { ok: true };
      }
      case 'open-tab': {
        await openTab(msg.tab, { active: msg.active !== false });
        return { ok: true };
      }
      case 'save-session': {
        const s = await saveCurrentSession({ name: msg.name || '', tag: msg.tag || [], behavior: msg.behavior });
        scheduleSyncSoon();
        return { ok: true, id: s?.id, session: s };
      }
      case 'sync':
        return runSync('manual');
      case 'sessions-changed':
        if (sender.id === chrome.runtime.id && msg.fromSync !== true) scheduleSyncSoon();
        return { ok: true };
      case 'setup-alarms':
        await setupAlarms();
        return { ok: true };
      default:
        return { ok: false, error: 'unknown message' };
    }
  })()
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
  return true;
});
