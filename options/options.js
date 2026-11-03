// Options page: a sidebar with Settings / Sessions / Information pages, rendered
// from a declarative description like Tab Session Manager's defaultSettings.
import { applyI18n, t } from '../lib/i18n.js';
import { getSettings, saveSettings, resetSettings, applyTheme, DEFAULT_SETTINGS } from '../lib/settings.js';
import { listSessions, exportSessions, importSessions, deleteSessions, isAutoSession } from '../lib/store.js';
import { getSyncStatus, sync } from '../lib/sync.js';
import { formatDate } from '../lib/format.js';
import { redirectUri, authStore } from '../lib/providers/oauth.js';
import { folderSupported, getFolderHandle, pickFolder, forgetFolder, requestFolderPermission, folderPermissionState } from '../lib/providers/folder.js';
import { connectGoogleDrive, disconnectGoogleDrive } from '../lib/providers/gdrive.js';
import { connectDropbox, disconnectDropbox } from '../lib/providers/dropbox.js';
import { connectPcloud, disconnectPcloud } from '../lib/providers/pcloud.js';

const $ = (sel, root = document) => root.querySelector(sel);
let settings;

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}
function patchFor(path, value) {
  const keys = path.split('.');
  const patch = {};
  let cur = patch;
  keys.forEach((k, i) => {
    cur[k] = i === keys.length - 1 ? value : {};
    cur = cur[k];
  });
  return patch;
}
async function setSetting(path, value) {
  settings = await saveSettings(patchFor(path, value));
  chrome.runtime.sendMessage({ type: 'setup-alarms' }).catch(() => {});
  document.dispatchEvent(new CustomEvent('settings-changed', { detail: { path, value } }));
}

function download(filename, text) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on')) node[k] = v;
    else if (v !== undefined && v !== null) node.setAttribute(k, v);
  }
  for (const c of children) if (c) node.append(c);
  return node;
}

// ---------------------------------------------------------------------------
// OptionContainer
// ---------------------------------------------------------------------------
function optionContainer(opt) {
  if (opt.shouldShow === false) return null;
  const { id, type } = opt;
  const title = opt.title ? (opt.useRawTitle ? opt.title : t(opt.title)) : '';
  let formId = id || '';
  let form = null;
  const current = id ? getPath(settings, id) : undefined;

  const numberChange = (e) => {
    let value = e.target.value;
    const v = e.target.validity;
    if (v.rangeOverflow) value = opt.max;
    else if (v.rangeUnderflow) value = opt.min;
    else if (v.badInput || value === '' || !v.valid) value = opt.default ?? getPath(DEFAULT_SETTINGS, id);
    e.target.value = value;
    setSetting(id, Number(value));
  };

  switch (type) {
    case 'checkbox':
      form = el('label', {}, [
        el('input', { type: 'checkbox', id, onchange: (e) => (opt.onChange ? opt.onChange(e.target.checked) : setSetting(id, e.target.checked)) }),
        el('span', { class: 'checkbox' }),
      ]);
      form.querySelector('input').checked = !!current;
      break;
    case 'number':
      form = el('input', { type: 'number', id, min: opt.min, max: opt.max, step: opt.step, placeholder: opt.placeholder, onchange: numberChange });
      form.value = current ?? '';
      break;
    case 'text':
      form = el('input', { type: 'text', id, class: opt.wide ? 'wide' : '', placeholder: opt.placeholder, spellcheck: 'false', onchange: (e) => setSetting(id, e.target.value) });
      form.value = current ?? '';
      break;
    case 'textarea':
      form = el('textarea', { id, placeholder: opt.placeholder, spellcheck: 'false', onchange: (e) => setSetting(id, e.target.value) });
      form.value = current ?? '';
      break;
    case 'radio':
      formId = `${id}_${opt.value}`;
      form = el('label', {}, [
        el('input', { type: 'radio', id: formId, name: id, value: opt.value, onchange: (e) => setSetting(id, e.target.value) }),
        el('span', { class: 'radio' }),
      ]);
      form.querySelector('input').checked = opt.value === current;
      break;
    case 'select': {
      const select = el('select', { id, onchange: (e) => (opt.onChange ? opt.onChange(e.target.value) : setSetting(id, e.target.value)) },
        opt.options.map((o) => el('option', { value: o.value, text: o.raw ? o.name : t(o.name) })));
      select.value = current;
      form = el('div', { class: `selectWrap ${opt.wide ? 'wide' : ''}` }, [select]);
      break;
    }
    case 'button':
      formId = '';
      form = el('input', { type: 'button', value: t(opt.value), onclick: opt.onClick });
      break;
    case 'file':
      formId = '';
      form = el('label', { class: 'button includeSpan', for: id }, [
        el('span', { text: t(opt.value) }),
        el('input', { type: 'file', id, accept: opt.accept, onchange: opt.onChange }),
      ]);
      break;
    case 'extra':
      formId = '';
      form = opt.extraForm();
      break;
    default:
      formId = '';
      form = null;
  }

  const text = el('div', { class: 'optionText' }, [
    el('label', { class: 'noHover', for: formId || null }, [el('p', { text: title })]),
    ...(opt.captions || []).map((c) => (c ? el('p', { class: 'caption', text: opt.useRawCaptions ? c : t(c).replace(/<br>/g, '\n') }) : null)),
    opt.extraCaption || null,
    opt.link ? el('p', { class: 'caption' }, [el('a', { href: opt.link.href, target: '_blank', text: opt.link.text })]) : null,
  ]);
  const element = el('div', { class: `optionElement ${type === 'textarea' ? 'showColumn' : ''}` }, [text, el('div', { class: 'optionForm' }, [form])]);
  const li = el('li', { class: 'optionContainer' }, [element]);
  if (opt.childElements) {
    li.append(el('fieldset', {}, [
      el('legend', { class: 'noDisplayLegend', text: title }),
      el('ul', { class: 'childElements' }, opt.childElements.map(optionContainer)),
    ]));
  }
  if (!opt.noHr) li.append(el('hr'));
  return li;
}

function categoryContainer({ category, elements }) {
  return el('li', { class: 'categoryContainer' }, [
    el('fieldset', {}, [
      el('legend', {}, [el('p', { class: 'categoryTitle', text: category ? t(category) : '' })]),
      el('ul', { class: 'categoryElements' }, elements.map(optionContainer)),
    ]),
  ]);
}

// ---------------------------------------------------------------------------
// Cloud sync forms
// ---------------------------------------------------------------------------
function folderForm() {
  const status = el('span', { class: 'status' });
  const refresh = async () => {
    const handle = await getFolderHandle();
    if (!folderSupported() || typeof window.showDirectoryPicker !== 'function') {
      status.textContent = t('folderUnsupportedLabel');
      return;
    }
    if (!handle) {
      status.textContent = t('folderNotConfiguredLabel');
      return;
    }
    const state = await folderPermissionState();
    status.textContent = `${t('folderSelectedLabel', [handle.name])} (${state === 'granted' ? t('permissionGrantedLabel') : t('needsPermissionLabel')})`;
  };
  const pick = el('input', { type: 'button', value: t('pickFolderButtonLabel'), onclick: async () => {
    try {
      await pickFolder();
    } catch (err) {
      if (err?.name !== 'AbortError') alert(err.message);
    }
    refresh();
  } });
  const grant = el('input', { type: 'button', value: t('grantLabel'), onclick: async () => {
    await requestFolderPermission();
    refresh();
  } });
  const forget = el('input', { type: 'button', value: t('forgetLabel'), onclick: async () => {
    await forgetFolder();
    refresh();
  } });
  refresh();
  return el('div', { class: 'formColumn' }, [el('div', { class: 'optionForm' }, [pick, grant, forget]), status]);
}

function accountForm(provider, connect, disconnect, getKey) {
  const status = el('span', { class: 'status' });
  const refresh = async () => {
    const auth = await authStore.get(provider);
    const ok = provider === 'dropbox' ? !!auth?.refreshToken : !!auth?.accessToken;
    status.textContent = ok ? t('connectedAsLabel', [auth.email || auth.name || '✓']) : t('notConnectedLabel');
  };
  const signIn = el('input', { type: 'button', value: t('signInLabel'), onclick: async () => {
    try {
      await connect(getKey());
    } catch (err) {
      alert(t('authFailedLabel', [err.message || String(err)]));
    }
    refresh();
  } });
  const signOut = el('input', { type: 'button', value: t('signOutLabel'), onclick: async () => {
    await disconnect();
    refresh();
  } });
  refresh();
  return el('div', { class: 'formColumn' }, [el('div', { class: 'optionForm' }, [signIn, signOut]), status]);
}

function syncNowForm() {
  const status = el('span', { class: 'status' });
  const refresh = async () => {
    const s = await getSyncStatus();
    if (s.state === 'syncing') status.textContent = `${t('syncingLabel')}...`;
    else if (s.state === 'ok') status.textContent = t('syncOkLabel', [formatDate(s.time, settings.dateFormat)]) + (s.stats ? ` (↑${s.stats.pushed} ↓${s.stats.pulled})` : '');
    else if (s.state === 'error') status.textContent = t('syncErrorLabel', [s.code === 'NEEDS_AUTH' ? t('signInRequiredLabel') : s.code === 'NEEDS_PERMISSION' ? t('needsPermissionLabel') : s.message || s.code]);
    else status.textContent = t('syncNeverLabel');
  };
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.syncStatus) refresh();
  });
  refresh();
  const btn = el('input', { type: 'button', value: t('syncNowLabel'), onclick: async () => {
    if (settings.sync.provider === 'folder') await requestFolderPermission().catch(() => {});
    await sync({ reason: 'manual' });
    refresh();
  } });
  return el('div', { class: 'formColumn' }, [el('div', { class: 'optionForm' }, [btn]), status]);
}

const redirectCaption = () => el('p', { class: 'caption' }, [document.createTextNode(`${t('redirectUriLabel')}: `), el('code', { text: redirectUri() })]);

function providerElements(provider) {
  switch (provider) {
    case 'folder':
      return [{ title: 'syncFolderLabel', captions: ['syncFolderCaptionLabel'], type: 'extra', extraForm: folderForm }];
    case 'gdrive':
      return [
        { title: 'providerGdrive', captions: ['gdriveCaptionLabel', 'redirectUriCaptionLabel'], type: 'none', extraCaption: redirectCaption(), link: { href: 'https://console.cloud.google.com/apis/credentials', text: 'Google Cloud Console' } },
        { id: 'sync.gdrive.clientId', title: 'clientIdLabel', captions: [], type: 'text', wide: true },
        { id: 'sync.gdrive.folder', title: 'folderNameLabel', captions: [], type: 'text', placeholder: 'TabManager' },
        { title: 'accountLabel', captions: [], type: 'extra', extraForm: () => accountForm('gdrive', connectGoogleDrive, disconnectGoogleDrive, () => settings.sync.gdrive.clientId) },
      ];
    case 'dropbox':
      return [
        { title: 'providerDropbox', captions: ['dropboxCaptionLabel', 'redirectUriCaptionLabel'], type: 'none', extraCaption: redirectCaption(), link: { href: 'https://www.dropbox.com/developers/apps', text: 'Dropbox App Console' } },
        { id: 'sync.dropbox.appKey', title: 'appKeyLabel', captions: [], type: 'text', wide: true },
        { id: 'sync.dropbox.folder', title: 'folderPathLabel', captions: [], type: 'text', placeholder: '/TabManager' },
        { title: 'accountLabel', captions: [], type: 'extra', extraForm: () => accountForm('dropbox', connectDropbox, disconnectDropbox, () => settings.sync.dropbox.appKey) },
      ];
    case 'pcloud':
      return [
        { title: 'providerPcloud', captions: ['pcloudCaptionLabel', 'redirectUriCaptionLabel'], type: 'none', extraCaption: redirectCaption(), link: { href: 'https://docs.pcloud.com/my_apps/', text: 'pCloud My Applications' } },
        { id: 'sync.pcloud.clientId', title: 'clientIdLabel', captions: [], type: 'text', wide: true },
        { id: 'sync.pcloud.folder', title: 'folderPathLabel', captions: [], type: 'text', placeholder: '/TabManager' },
        { title: 'accountLabel', captions: [], type: 'extra', extraForm: () => accountForm('pcloud', connectPcloud, disconnectPcloud, () => settings.sync.pcloud.clientId) },
      ];
    default:
      return [];
  }
}

function cloudSyncCategory() {
  const common = [
    { id: 'sync.autoSync', title: 'enabledAutoSyncLabel', captions: ['enabledAutoSyncCaptionLabel'], type: 'checkbox' },
    { id: 'sync.interval', title: 'syncIntervalLabel', captions: [], type: 'number', min: 1, placeholder: 5 },
    { id: 'sync.syncAutoSaves', title: 'includesAutoSaveToSyncLabel', captions: ['includesAutoSaveToSyncCaptionLabel'], type: 'checkbox' },
  ];
  return {
    category: 'cloudSyncLabel',
    elements: [
      {
        id: 'sync.provider',
        title: 'syncProviderLabel',
        captions: ['syncProviderCaptionLabel'],
        type: 'select',
        wide: true,
        options: [
          { name: 'providerNone', value: 'none' },
          { name: 'providerFolder', value: 'folder' },
          { name: 'providerGdrive', value: 'gdrive' },
          { name: 'providerDropbox', value: 'dropbox' },
          { name: 'providerPcloud', value: 'pcloud' },
        ],
        onChange: async (value) => {
          await setSetting('sync.provider', value);
          renderSettings();
        },
        childElements: settings.sync.provider === 'none' ? [] : [...providerElements(settings.sync.provider), ...common, { title: 'syncNowLabel', captions: ['syncNowCaptionLabel'], type: 'extra', extraForm: syncNowForm, noHr: true }],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Settings page definition
// ---------------------------------------------------------------------------
function settingsDefinition() {
  return [
    {
      category: 'openCategoryLabel',
      elements: [
        { id: 'ifLazyLoading', title: 'ifLazyLoadingLabel', captions: ['ifLazyLoadingCaptionLabel'], type: 'checkbox' },
        { id: 'isRestoreWindowPosition', title: 'isRestoreWindowPositionLabel', captions: ['isRestoreWindowPositionCaptionLabel'], type: 'checkbox' },
      ],
    },
    {
      category: 'saveCategoryLabel',
      elements: [
        { id: 'saveTabGroups', title: 'saveTabGroupsLabel', captions: ['saveTabGroupsCaptionLabel'], type: 'checkbox', shouldShow: !!chrome.tabGroups },
        { id: 'ifSavePrivateWindow', title: 'ifSavePrivateWindowLabel', captions: ['ifSavePrivateWindowCaptionLabel'], type: 'checkbox' },
        { id: 'ignoreUrlList', title: 'ignoreUrlListLabel', captions: ['ignoreUrlListCaptionLabel'], type: 'textarea', placeholder: 'https://example.com/*\nhttps://example.net/*' },
      ],
    },
    {
      category: 'autoSaveLabel',
      elements: [
        { id: 'ifAutoSave', title: 'ifAutoSaveLabel', captions: ['ifAutoSaveCaptionLabel'], type: 'checkbox', childElements: [
          { id: 'autoSaveInterval', title: 'autoSaveIntervalLabel', captions: ['autoSaveIntervalCaptionLabel'], type: 'number', min: 0.5, step: 0.1, placeholder: 15 },
          { id: 'autoSaveLimit', title: 'autoSaveLimitLabel', captions: ['autoSaveLimitCaptionLabel'], type: 'number', min: 1, placeholder: 10 },
        ] },
        { id: 'ifAutoSaveWhenClose', title: 'ifAutoSaveWhenCloseLabel', captions: ['ifAutoSaveWhenCloseCaptionLabel'], type: 'checkbox', childElements: [
          { id: 'autoSaveWhenCloseLimit', title: 'autoSaveWhenCloseLimitLabel', captions: ['autoSaveWhenCloseCaptionLabel'], type: 'number', min: 1, placeholder: 10 },
          { id: 'autoSaveWhenCloseMinTabs', title: 'autoSaveWhenCloseMinTabsLabel', captions: ['autoSaveWhenCloseMinTabsCaptionLabel'], type: 'number', min: 1, placeholder: 1 },
        ] },
        { id: 'ifAutoSaveWhenExitBrowser', title: 'ifAutoSaveWhenExitBrowserLabel', captions: ['ifAutoSaveWhenExitBrowserCaptionLabel'], type: 'checkbox', childElements: [
          { id: 'autoSaveWhenExitBrowserLimit', title: 'autoSaveWhenExitBrowserLimitLabel', captions: ['autoSaveWhenExitBrowserCaptionLabel'], type: 'number', min: 1, placeholder: 10 },
        ] },
        { id: 'useTabTitleforAutoSave', title: 'useTabTitleforAutoSaveLabel', captions: ['useTabTitleforAutoSaveCaptionLabel'], type: 'checkbox' },
      ],
    },
    {
      category: 'startupLabel',
      elements: [
        { id: 'startupBehavior', title: 'startupBehaviorLabel', captions: [], type: 'none', childElements: [
          { id: 'startupBehavior', title: 'openPreviousSessionLabel', captions: ['openPreviousSessionCaptionLabel'], type: 'radio', value: 'previousSession' },
          { id: 'startupBehavior', title: 'openStartupSessionLabel', captions: ['openStartupSessionCaptionLabel'], type: 'radio', value: 'startupSession' },
          { id: 'startupBehavior', title: 'DoNothingLabel', captions: [''], type: 'radio', value: 'none' },
        ] },
      ],
    },
    cloudSyncCategory(),
    {
      category: 'popupLabel',
      elements: [
        { id: 'openButtonBehavior', title: 'openButtonBehaviorLabel', captions: ['openButtonBehaviorCaptionLabel'], type: 'none', childElements: [
          { id: 'openButtonBehavior', title: 'openInNewWindowLabel', captions: ['openInNewWindowCaptionLabel'], type: 'radio', value: 'openInNewWindow' },
          { id: 'openButtonBehavior', title: 'openInCurrentWindowLabel', captions: ['openInCurrentWindowCaptionLabel'], type: 'radio', value: 'openInCurrentWindow' },
          { id: 'openButtonBehavior', title: 'addToCurrentWindowLabel', captions: ['addToCurrentWindowCaptionLabel'], type: 'radio', value: 'addToCurrentWindow' },
        ] },
        { id: 'saveButtonBehavior', title: 'saveButtonBehaviorLabel', captions: ['saveButtonBehaviorCaptionLabel'], type: 'none', childElements: [
          { id: 'saveButtonBehavior', title: 'saveAllWindowsLabel', captions: [''], type: 'radio', value: 'saveAllWindows' },
          { id: 'saveButtonBehavior', title: 'saveOnlyCurrentWindowLabel', captions: [''], type: 'radio', value: 'saveOnlyCurrentWindow' },
        ] },
        { id: 'isSessionListOpenInTab', title: 'isSessionListOpenInTabLabel', captions: ['isSessionListOpenInTabCaptionLabel'], type: 'checkbox' },
      ],
    },
    {
      category: 'styleLabel',
      elements: [
        { id: 'theme', title: 'themeLabel', captions: ['themeCaptionLabel'], type: 'select', options: [
          { name: 'lightLabel', value: 'light' }, { name: 'darkLabel', value: 'dark' }, { name: 'systemLabel', value: 'system' },
        ] },
        { title: 'sizeLabel', captions: ['popupSizeCaptionLabel'], type: 'none', childElements: [
          { id: 'popupWidthV2', title: 'widthLabel', captions: [''], type: 'number', min: 300, max: 800, placeholder: 700 },
          { id: 'popupHeight', title: 'heightLabel', captions: [''], type: 'number', min: 200, max: 600, placeholder: 500 },
          { id: 'sidebarWidth', title: 'sidebarWidthLabel', captions: [''], type: 'number', min: 100, max: 800, placeholder: 300 },
        ] },
        { id: 'dateFormat', title: 'dateFormatLabel', captions: ['dateFormatCaptionLabel'], type: 'text', placeholder: 'YYYY.MM.DD HH:mm:ss' },
        { id: 'truncateTitle', title: 'truncateTitleLabel', captions: ['truncateTitleCaptionLabel'], type: 'checkbox' },
        { id: 'isShowOpenButtons', title: 'isShowOpenButtonsLabel', captions: ['isShowOpenButtonsCaptionLabel'], type: 'checkbox' },
      ],
    },
    {
      category: '',
      elements: [
        { id: 'importSettings', title: 'importSettingsLabel', captions: ['importSettingsCaptionLabel'], type: 'file', accept: '.json', value: 'importSaveButtonLabel', onChange: async (e) => {
          const file = e.target.files[0];
          if (!file) return;
          try {
            const json = JSON.parse(await file.text());
            await saveSettings(json);
            location.reload();
          } catch (err) {
            alert(err.message);
          }
        } },
        { title: 'exportSettingsLabel', captions: ['exportSettingsCaptionLabel'], type: 'button', value: 'exportButtonLabel', onClick: async () => {
          download('tab-manager-settings.json', JSON.stringify(await getSettings(), null, 2));
        } },
        { title: 'resetSettingsLabel', captions: ['resetSettingsCaptionLabel'], type: 'button', value: 'resetSettingsButtonLabel', onClick: async () => {
          await resetSettings();
          location.reload();
        } },
      ],
    },
  ];
}

function sessionsDefinition() {
  return [
    { id: 'importSessions', title: 'importLabel', captions: ['importCaptionLabel', 'importCaption2Label'], type: 'file', accept: '.json,application/json', value: 'importSaveButtonLabel', onChange: async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const count = await importSessions(JSON.parse(await file.text()));
        alert(`${t('importMessage')} (${count})`);
      } catch (err) {
        alert(err.message);
      }
      e.target.value = '';
    } },
    { title: 'exportLabel', captions: ['exportCaptionLabel'], type: 'button', value: 'exportButtonLabel', onClick: async () => {
      download(`tab-manager-sessions-${new Date().toISOString().slice(0, 10)}.json`, await exportSessions());
    } },
    { title: 'removeAutoSessionsLabel', captions: ['removeAutoSessionsCaptionLabel'], type: 'button', value: 'removeSessionsButtonLabel', onClick: async () => {
      if (!confirm(t('warningRemoveAutoMessage'))) return;
      const ids = (await listSessions()).filter(isAutoSession).map((s) => s.id);
      await deleteSessions(ids);
    } },
    { title: 'removeSessionsLabel', captions: ['removeSessionsCaptionLabel'], type: 'button', value: 'removeSessionsButtonLabel', onClick: async () => {
      if (!confirm(t('warningRemoveAllMessage'))) return;
      const ids = (await listSessions()).map((s) => s.id);
      await deleteSessions(ids);
    } },
  ];
}

function informationDefinition() {
  const manifest = chrome.runtime.getManifest();
  return [
    { title: 'versionLabel', captions: [manifest.version], useRawCaptions: true, type: 'none' },
    { title: 'repositoryLabel', captions: [], type: 'none', link: { href: 'https://github.com/hayato-ohya/tab-manager', text: 'github.com/hayato-ohya/tab-manager' } },
    { title: 'creditLabel', captions: ['creditCaptionLabel'], type: 'none', link: { href: 'https://github.com/sienori/Tab-Session-Manager', text: 'github.com/sienori/Tab-Session-Manager' } },
  ];
}

// ---------------------------------------------------------------------------
// Rendering / routing
// ---------------------------------------------------------------------------
function renderSettings() {
  const list = $('#settingsList');
  list.innerHTML = '';
  for (const cat of settingsDefinition()) list.append(categoryContainer(cat));
}

function renderPage() {
  const page = ['sessions', 'information'].includes(location.hash.slice(1)) ? location.hash.slice(1) : 'settings';
  for (const el of document.querySelectorAll('.page')) el.hidden = el.dataset.page !== page;
  for (const li of document.querySelectorAll('.sideBarItem')) li.classList.toggle('selected', li.dataset.page === page);
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', renderPage);

(async () => {
  applyI18n();
  await applyTheme();
  settings = await getSettings();
  renderSettings();
  const sessionsList = $('#sessionsList');
  for (const opt of sessionsDefinition()) sessionsList.append(optionContainer(opt));
  const infoList = $('#informationList');
  for (const opt of informationDefinition()) infoList.append(optionContainer(opt));
  renderPage();
})();
