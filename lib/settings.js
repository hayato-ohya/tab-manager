// Settings. Key names follow Tab Session Manager so its vocabulary (and its
// option labels) can be reused as-is.
export const DEFAULT_SETTINGS = {
  // Open
  ifLazyLoading: true,
  isRestoreWindowPosition: true,
  // Save
  saveTabGroups: true,
  ifSavePrivateWindow: false,
  ignoreUrlList: '',
  // Auto save
  ifAutoSave: true,
  autoSaveInterval: 15,
  autoSaveLimit: 10,
  ifAutoSaveWhenClose: true,
  autoSaveWhenCloseLimit: 10,
  autoSaveWhenCloseMinTabs: 1,
  ifAutoSaveWhenExitBrowser: true,
  autoSaveWhenExitBrowserLimit: 10,
  useTabTitleforAutoSave: true,
  skipUnchanged: true,
  // Startup
  startupBehavior: 'none', // none | previousSession | startupSession
  // Popup
  openButtonBehavior: 'openInNewWindow', // openInNewWindow | openInCurrentWindow | addToCurrentWindow
  saveButtonBehavior: 'saveAllWindows', // saveAllWindows | saveOnlyCurrentWindow
  isSessionListOpenInTab: false,
  // Style
  theme: 'system', // light | dark | system
  popupWidthV2: 700,
  popupHeight: 500,
  sidebarWidth: 300,
  dateFormat: 'YYYY.MM.DD HH:mm:ss',
  truncateTitle: true,
  isShowOpenButtons: true,
  // Popup state (remembered like TSM does)
  filterValue: '_displayAll',
  sortValue: 'newest',
  selectedSessionId: '',
  // Cloud sync
  sync: {
    provider: 'none', // none | folder | gdrive | dropbox | pcloud
    autoSync: true,
    interval: 5,
    syncAutoSaves: false,
    gdrive: { clientId: '', folder: 'TabManager' },
    dropbox: { appKey: '', folder: '/TabManager' },
    pcloud: { clientId: '', folder: '/TabManager' },
  },
};

function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch === undefined ? base : patch;
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(base?.[k] ?? {}, v) : v;
  }
  return out;
}

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return deepMerge(DEFAULT_SETTINGS, settings || {});
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = deepMerge(current, patch);
  await chrome.storage.local.set({ settings: next });
  return next;
}

export async function resetSettings() {
  await chrome.storage.local.set({ settings: {} });
}

/** Apply the theme class to <body> and keep it in sync with the settings. */
export async function applyTheme() {
  const settings = await getSettings();
  const set = (theme) => {
    document.body.classList.remove('light-theme', 'dark-theme', 'system-theme');
    document.body.classList.add(`${theme || 'system'}-theme`);
  };
  set(settings.theme);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) set(changes.settings.newValue?.theme);
  });
}
