// Popup page. Structure and behaviour mirror Tab Session Manager's popup
// (PopupPage / Header / OptionsArea / SessionsArea / SessionDetailsArea / SaveArea).
import { applyI18n, t } from '../lib/i18n.js';
import { getSettings, saveSettings, applyTheme } from '../lib/settings.js';
import { formatDate } from '../lib/format.js';
import {
  listSessions, getSession, putSession, deleteSession, renameSession, addTag, removeTag,
  removeFromSession, exportSessions, replaceCurrentSession, addCurrentWindow, addCurrentTab,
  makeCopySession, currentTabTitle, isAutoSession, AUTO_TAGS,
} from '../lib/store.js';
import { sortedTabs } from '../lib/session.js';
import { tombstonesDB } from '../lib/db.js';
import { getSyncStatus, sync } from '../lib/sync.js';
import { folderPermissionState, requestFolderPermission } from '../lib/providers/folder.js';
import { icon } from './icons.js';

const $ = (sel, root = document) => root.querySelector(sel);
const RESERVED_TAGS = ['regular', 'winClose', 'browserExit', 'temp', '_startup', '_tracking'];

const state = {
  settings: null,
  sessions: [],
  selectedId: '',
  filterValue: '_displayAll',
  sortValue: 'newest',
  searchWords: [],
  isInTab: location.hash === '#inTab',
  undoStack: [],
  redoStack: [],
  collapsed: new Set(),
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function send(msg) {
  return chrome.runtime.sendMessage(msg).catch((err) => ({ ok: false, error: err.message }));
}

function applyIcons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]')) {
    if (el.querySelector('svg')) continue;
    el.prepend(icon(el.dataset.icon));
  }
}

function windowsInfoText(windowsNumber, tabsNumber) {
  const w = `${windowsNumber} ${windowsNumber == 1 ? t('windowLabel') : t('windowsLabel')}`;
  const tb = `${tabsNumber} ${tabsNumber == 1 ? t('tabLabel') : t('tabsLabel')}`;
  return `${w} - ${tb}`;
}

function tagLabel(tag) {
  switch (tag) {
    case 'regular': return t('regularSaveSessionNameShort');
    case 'winClose': return t('winCloseSessionNameShort');
    case 'browserExit': return t('browserExitSessionNameShort');
    case '_startup': return t('startupLabel');
    default: return tag;
  }
}

function tagIcon(tag) {
  if (AUTO_TAGS.includes(tag)) return icon('update', 'autoSaveIcon');
  if (tag === '_startup') return icon('star', 'startupIcon');
  return icon('tag', 'tagIcon');
}

function displayName(name) {
  return (name || '').trim() === '' ? '_' : name;
}

function highlight(text, words) {
  const span = document.createElement('span');
  const active = words.filter(Boolean);
  if (active.length === 0) {
    span.textContent = text;
    return span;
  }
  const re = new RegExp(`(${active.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  for (const part of text.split(re)) {
    if (!part) continue;
    if (active.some((w) => w.toLowerCase() === part.toLowerCase())) {
      const mark = document.createElement('mark');
      mark.textContent = part;
      span.append(mark);
    } else span.append(part);
  }
  return span;
}

function faviconFor(tab) {
  if (tab.favIconUrl && /^(https?|data):/.test(tab.favIconUrl)) return tab.favIconUrl;
  try {
    const u = new URL(chrome.runtime.getURL('/_favicon/'));
    u.searchParams.set('pageUrl', tab.url || '');
    u.searchParams.set('size', '16');
    return u.toString();
  } catch {
    return '';
  }
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

// ---------------------------------------------------------------------------
// Notification / menu / modal
// ---------------------------------------------------------------------------
let notificationTimer = null;
function openNotification({ message, type = 'info', duration = 10000, buttonLabel = '', onClick = null }) {
  const el = $('#notification');
  el.dataset.type = type;
  $('.message', el).textContent = message;
  const btn = $('.actionButton', el);
  btn.hidden = !(buttonLabel && onClick);
  btn.textContent = buttonLabel;
  btn.onclick = () => {
    onClick?.();
    closeNotification();
  };
  el.classList.add('isOpen');
  clearTimeout(notificationTimer);
  notificationTimer = setTimeout(closeNotification, duration);
}
function closeNotification() {
  $('#notification').classList.remove('isOpen');
}
$('#notification .closeButton').onclick = closeNotification;

let lastFocused = null;
let menuJustOpened = false;
function openMenu(x, y, itemsEl) {
  const menu = $('#menu');
  lastFocused = document.activeElement;
  // The opening event is still bubbling; ignore the document-level close handlers for it.
  menuJustOpened = true;
  setTimeout(() => (menuJustOpened = false), 0);
  menu.innerHTML = '';
  menu.append(itemsEl);
  const close = document.createElement('button');
  close.className = 'closeMenuButton';
  close.title = t('closeMenuLabel');
  close.append(icon('plus'));
  menu.append(close);
  menu.hidden = false;
  const pw = document.body.offsetWidth;
  const ph = document.body.offsetHeight;
  let px = x;
  let py = y;
  if (px + menu.offsetWidth > pw) px = x - menu.offsetWidth;
  if (py + menu.offsetHeight > ph) py = y - menu.offsetHeight;
  menu.style.left = Math.max(0, px) + 'px';
  menu.style.top = Math.max(0, py) + 'px';
  menu.querySelector('button')?.focus();
}
function closeMenu() {
  const menu = $('#menu');
  if (menu.hidden) return;
  menu.hidden = true;
  lastFocused?.focus?.();
}
document.addEventListener('click', (e) => {
  if (menuJustOpened) return;
  if (!$('#menu').hidden && !e.target.closest('#menu button:not(.closeMenuButton)')) closeMenu();
});
document.addEventListener('contextmenu', () => {
  if (!menuJustOpened) closeMenu();
});
$('#menu').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeMenu();
  if (e.key !== 'Tab') return;
  const buttons = [...$('#menu').querySelectorAll('button')];
  const first = buttons[0];
  const last = buttons[buttons.length - 1];
  if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  } else if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  }
});

function menuItems(sections) {
  // sections: [{ title, iconName, items: [{ label, onClick }] }]
  const ul = document.createElement('ul');
  sections.forEach((section, i) => {
    if (i > 0) ul.append(document.createElement('hr'));
    if (section.title) {
      const li = document.createElement('li');
      li.className = 'section';
      if (section.iconName) li.append(icon(section.iconName));
      li.append(section.title);
      li.onclick = (e) => e.stopPropagation();
      ul.append(li);
    }
    for (const item of section.items) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.textContent = item.label;
      btn.onclick = () => {
        closeMenu();
        item.onClick();
      };
      li.append(btn);
      ul.append(li);
    }
  });
  return ul;
}

function openModal(title, contentEl) {
  lastFocused = document.activeElement;
  $('#modal .modalTitle').textContent = title;
  const content = $('#modal .modalContent');
  content.innerHTML = '';
  content.append(contentEl);
  const bg = $('#modalBackground');
  bg.classList.remove('isClose');
  bg.classList.add('isOpen');
  setTimeout(() => (content.querySelector('input, button, a') || $('#closeModalButton')).focus(), 100);
}
function closeModal() {
  const bg = $('#modalBackground');
  bg.classList.remove('isOpen');
  bg.classList.add('isClose');
  lastFocused?.focus?.();
}
$('#modalBackground').addEventListener('click', closeModal);
$('#modal').addEventListener('click', (e) => e.stopPropagation());
$('#closeModalButton').onclick = closeModal;
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('#modalBackground').classList.contains('isOpen')) closeModal();
});

function textInputModal({ defaultText = '', placeholder = '', onSave }) {
  const wrap = document.createElement('div');
  wrap.className = 'textInputModalContent';
  const form = document.createElement('form');
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = placeholder;
  input.value = defaultText;
  const buttons = document.createElement('div');
  buttons.className = 'buttons';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = t('cancelLabel');
  cancel.onclick = closeModal;
  const save = document.createElement('button');
  save.type = 'submit';
  save.className = 'saveButton';
  save.textContent = t('saveLabel');
  buttons.append(cancel, save);
  form.append(input, buttons);
  form.onsubmit = (e) => {
    e.preventDefault();
    onSave(input.value);
    closeModal();
  };
  wrap.append(form);
  setTimeout(() => input.select(), 120);
  return wrap;
}

function tagInputModal({ tagList, onSave }) {
  const wrap = textInputModal({ placeholder: t('inputTagLabel'), onSave });
  wrap.classList.add('tagInput');
  const input = wrap.querySelector('input');
  const list = document.createElement('ul');
  list.className = 'suggestions';
  const space = document.createElement('div');
  space.className = 'suggestionsSpace';
  input.after(list, space);
  let highlighted = -1;
  const render = () => {
    const value = input.value.trim().toLowerCase();
    const items = value ? tagList.filter((tag) => tag.toLowerCase().startsWith(value)) : tagList;
    list.innerHTML = '';
    for (const [i, tag] of items.entries()) {
      const li = document.createElement('li');
      li.textContent = tag;
      if (i === highlighted) li.classList.add('highlighted');
      li.onmousedown = (e) => {
        e.preventDefault();
        input.value = tag;
        render();
      };
      list.append(li);
    }
    const open = items.length > 0 && document.activeElement === input;
    list.classList.toggle('open', open);
    input.classList.toggle('open', open);
  };
  input.addEventListener('input', () => {
    highlighted = -1;
    render();
  });
  input.addEventListener('focus', render);
  input.addEventListener('blur', () => setTimeout(render, 100));
  input.addEventListener('keydown', (e) => {
    const items = list.querySelectorAll('li');
    if (e.key === 'ArrowDown') {
      highlighted = Math.min(items.length - 1, highlighted + 1);
      render();
      e.preventDefault();
    } else if (e.key === 'ArrowUp') {
      highlighted = Math.max(-1, highlighted - 1);
      render();
      e.preventDefault();
    } else if (e.key === 'Enter' && highlighted >= 0 && items[highlighted]) {
      input.value = items[highlighted].textContent;
      highlighted = -1;
      render();
      e.preventDefault();
    }
  });
  return wrap;
}

// ---------------------------------------------------------------------------
// Undo / redo
// ---------------------------------------------------------------------------
function pushHistory(entry) {
  state.undoStack.push(entry);
  state.redoStack = [];
  renderUndo();
}
async function undo() {
  const entry = state.undoStack.pop();
  if (!entry) return;
  await entry.undo();
  state.redoStack.push(entry);
  renderUndo();
  await load();
}
async function redo() {
  const entry = state.redoStack.pop();
  if (!entry) return;
  await entry.redo();
  state.undoStack.push(entry);
  renderUndo();
  await load();
}
function renderUndo() {
  const u = $('#undoButton');
  const r = $('#redoButton');
  u.classList.toggle('disable', state.undoStack.length === 0);
  r.classList.toggle('disable', state.redoStack.length === 0);
  $('.count', u).textContent = state.undoStack.length || '';
  $('.count', r).textContent = state.redoStack.length || '';
}
$('#undoButton').onclick = undo;
$('#redoButton').onclick = redo;

// ---------------------------------------------------------------------------
// Session operations
// ---------------------------------------------------------------------------
async function saveSession(name, behavior) {
  const res = await send({ type: 'save-session', name, behavior });
  if (res?.ok && res.id) {
    await load();
    selectSession(res.id);
    openNotification({ message: t('sessionSavedLabel'), type: 'success', duration: 2000 });
  } else {
    openNotification({ message: t('failedSaveSessionLabel'), type: 'error' });
  }
}

async function removeSession(id) {
  const session = await getSession(id);
  if (!session) return;
  await deleteSession(id);
  pushHistory({
    undo: () => putSession(structuredClone(session)),
    redo: () => deleteSession(id),
  });
  openNotification({ message: t('sessionDeletedLabel'), type: 'warn', buttonLabel: t('undoLabel'), onClick: undo });
  await load();
}

async function removeWindow(session, windowId) {
  const before = structuredClone(session);
  await removeFromSession(session.id, windowId);
  pushHistory({ undo: () => putSession(structuredClone(before)), redo: () => removeFromSession(session.id, windowId) });
  openNotification({ message: t('sessionWindowDeletedLabel'), type: 'warn', buttonLabel: t('undoLabel'), onClick: undo });
  await load();
}

async function removeTab(session, windowId, tabId) {
  const before = structuredClone(session);
  await removeFromSession(session.id, windowId, tabId);
  pushHistory({ undo: () => putSession(structuredClone(before)), redo: () => removeFromSession(session.id, windowId, tabId) });
  openNotification({ message: t('sessionTabDeletedLabel'), type: 'warn', buttonLabel: t('undoLabel'), onClick: undo });
  await load();
}

async function openSessionById(id, mode) {
  const res = await send({ type: 'open-session', id, mode: mode || state.settings.openButtonBehavior });
  if (res?.ok && !state.isInTab) window.close();
}

async function withUndo(label, mutate) {
  const before = state.selectedId ? structuredClone(await getSession(state.selectedId)) : null;
  const after = await mutate();
  if (before && after) {
    pushHistory({ undo: () => putSession(structuredClone(before)), redo: () => putSession(structuredClone(after)) });
  }
  if (label) openNotification({ message: label, type: 'success', duration: 2000 });
  await load();
}

// ---------------------------------------------------------------------------
// Menus
// ---------------------------------------------------------------------------
function openMenuItems(session) {
  return [{
    title: t('OpenSessionLabel'),
    iconName: 'newWindow',
    items: [
      { label: t('openInNewWindowLabel'), onClick: () => openSessionById(session.id, 'openInNewWindow') },
      { label: t('openInCurrentWindowLabel'), onClick: () => openSessionById(session.id, 'openInCurrentWindow') },
      { label: t('addToCurrentWindowLabel'), onClick: () => openSessionById(session.id, 'addToCurrentWindow') },
    ],
  }];
}

function sessionMenuItems(session) {
  const isStartup = (session.tag || []).includes('_startup');
  return [
    ...openMenuItems(session),
    {
      title: t('EditSessionLabel'),
      iconName: 'edit',
      items: [
        { label: t('replaceCurrentSessionLabel'), onClick: () => withUndo(t('sessionReplacedLabel'), () => replaceCurrentSession(session.id, 'saveAllWindows')) },
        { label: t('replaceCurrentWindowLabel'), onClick: () => withUndo(t('sessionReplacedLabel'), () => replaceCurrentSession(session.id, 'saveOnlyCurrentWindow')) },
        { label: t('addCurrentWindowLabel'), onClick: () => withUndo(t('windowAddedLabel'), () => addCurrentWindow(session.id)) },
        { label: t('makeCopySessionLabel'), onClick: async () => {
          const copy = await makeCopySession(session.id);
          if (copy) {
            pushHistory({ undo: () => deleteSession(copy.id), redo: () => putSession(structuredClone(copy)) });
            openNotification({ message: t('sessionCopiedLabel'), type: 'success', duration: 2000 });
            await load();
            selectSession(copy.id);
          }
        } },
      ],
    },
    {
      items: [
        { label: t(isStartup ? 'removeStartupLabel' : 'registerStartupLabel'), onClick: async () => {
          await (isStartup ? removeTag(session.id, '_startup') : addTag(session.id, '_startup'));
          await load();
        } },
        { label: t('exportButtonLabel'), onClick: async () => download(`${(session.name || 'session').replace(/[\\/:*?"<>|]/g, '_').slice(0, 80)}.json`, await exportSessions([session.id])) },
      ],
    },
  ];
}

function saveMenuItems(name) {
  return [{
    title: t('saveSessionLabel'),
    items: [
      { label: t('saveAllWindowsLabel'), onClick: () => saveSession(name, 'saveAllWindows') },
      { label: t('saveOnlyCurrentWindowLabel'), onClick: () => saveSession(name, 'saveOnlyCurrentWindow') },
    ],
  }];
}

function windowMenuItems(session, windowId) {
  return [{
    title: t('editWindowLabel'),
    iconName: 'edit',
    items: [
      { label: t('addCurrentTabLabel'), onClick: () => withUndo(t('tabAddedLabel'), () => addCurrentTab(session.id, windowId)) },
    ],
  }];
}

function eventPos(e) {
  if (e.pageX || e.pageY) return { x: e.pageX, y: e.pageY };
  const r = e.currentTarget.getBoundingClientRect();
  return { x: r.x, y: r.y + r.height };
}

// ---------------------------------------------------------------------------
// Filter / sort / search
// ---------------------------------------------------------------------------
function countAllTags(sessions) {
  const count = { all: 0, user: 0, auto: 0, regular: 0, winClose: 0, browserExit: 0, tags: {} };
  for (const s of sessions) {
    const tags = s.tag || [];
    count.all++;
    if (tags.includes('regular')) { count.auto++; count.regular++; }
    else if (tags.includes('winClose')) { count.auto++; count.winClose++; }
    else if (tags.includes('browserExit')) { count.auto++; count.browserExit++; }
    else count.user++;
    for (const tag of tags) {
      if (AUTO_TAGS.includes(tag) || tag === '') continue;
      count.tags[tag] = (count.tags[tag] || 0) + 1;
    }
  }
  return count;
}

function matchesFilter(tags, filterValue) {
  switch (filterValue) {
    case '_displayAll': return true;
    case '_user': return !tags.some((tg) => AUTO_TAGS.includes(tg));
    case '_auto': return tags.some((tg) => AUTO_TAGS.includes(tg));
    default: return tags.includes(filterValue);
  }
}

function matchesSearch(session) {
  const words = state.searchWords.filter(Boolean);
  if (words.length === 0) return true;
  const name = (session.name || '').toLowerCase();
  const titles = Object.values(session.windows || {})
    .flatMap((tabs) => Object.values(tabs).map((tab) => (tab.title || '').toLowerCase()))
    .join('\n');
  return words.every((w) => name.includes(w)) || words.every((w) => titles.includes(w));
}

function sortedSessions() {
  const list = state.sessions.filter((s) => matchesFilter(s.tag || [], state.filterValue) && matchesSearch(s));
  const newest = (a, b) => b.date - a.date;
  const alpha = (a, b) => (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase());
  const nameless = (a, b) => {
    if (a.name === '' && b.name !== '') return 1;
    if (a.name !== '' && b.name === '') return -1;
    if (a.name === b.name) return newest(a, b);
    return 0;
  };
  switch (state.sortValue) {
    case 'oldest': list.sort(newest).reverse(); break;
    case 'aToZ': list.sort(alpha); list.sort(nameless); break;
    case 'zToA': list.sort(alpha); list.reverse(); list.sort(nameless); break;
    case 'tabsAsc': list.sort((a, b) => a.tabsNumber - b.tabsNumber); break;
    case 'tabsDes': list.sort((a, b) => b.tabsNumber - a.tabsNumber); break;
    default: list.sort(newest);
  }
  return list;
}

function renderFilterOptions() {
  const select = $('#filterSelect');
  const c = countAllTags(state.sessions);
  const options = [['_displayAll', `${t('displayAllLabel')} [${c.all}]`]];
  const autoKinds = [c.winClose, c.browserExit, c.regular].filter((n) => n > 0).length;
  if (autoKinds >= 2) options.push(['_auto', `${t('displayAutoLabel')} [${c.auto}]`]);
  if (c.winClose > 0) options.push(['winClose', `${t('winCloseSessionName')} [${c.winClose}]`]);
  if (c.browserExit > 0) options.push(['browserExit', `${t('browserExitSessionName')} [${c.browserExit}]`]);
  if (c.regular > 0) options.push(['regular', `${t('regularSaveSessionName')} [${c.regular}]`]);
  if (c.user > 0) options.push(['_user', `${t('displayUserLabel')} [${c.user}]`]);
  for (const tag of Object.keys(c.tags).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))) {
    options.push([tag, `${tagLabel(tag)} [${c.tags[tag]}]`]);
  }
  select.innerHTML = '';
  for (const [value, label] of options) {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    select.append(o);
  }
  if (!options.some(([v]) => v === state.filterValue)) changeFilter('_displayAll');
  select.value = state.filterValue;
}

function changeFilter(value) {
  state.filterValue = value;
  saveSettings({ filterValue: value });
  renderSessions();
  $('#sessionsArea').scrollTo(0, 0);
}
function changeSort(value) {
  state.sortValue = value;
  saveSettings({ sortValue: value });
  renderSessions();
  $('#sessionsArea').scrollTo(0, 0);
}

function toggleSearchBar(show = $('#searchBar').hidden) {
  $('#searchBar').hidden = !show;
  if (show) $('#searchInput').focus();
  else {
    $('#searchInput').value = '';
    changeSearchWord('');
    $('#sessionsArea').focus();
  }
}
function changeSearchWord(word, isEnter = false) {
  state.searchWords = word.trim().toLowerCase().split(' ').filter(Boolean);
  renderSessions();
  $('#sessionsArea').scrollTo(0, 0);
  if (isEnter) {
    const list = sortedSessions();
    if (list.length === 0) return;
    selectSession(list[0].id);
    $('#sessionsArea').focus();
    if (word === '') toggleSearchBar(false);
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function tagList() {
  return [...new Set(state.sessions.flatMap((s) => s.tag || []))]
    .filter((tag) => !RESERVED_TAGS.includes(tag))
    .sort((a, b) => a.localeCompare(b));
}

function renderSessions() {
  const area = $('#sessionsArea');
  for (const el of area.querySelectorAll('.sessionItem')) el.remove();
  const list = sortedSessions();
  const tpl = $('#sessionItemTpl');
  for (const session of list) {
    const node = tpl.content.firstElementChild.cloneNode(true);
    node.dataset.id = session.id;
    node.classList.toggle('isSelected', session.id === state.selectedId);
    const name = $('.name', node);
    name.classList.toggle('isTruncate', !!state.settings.truncateTitle);
    name.append(highlight(displayName(session.name), state.searchWords));
    const tags = $('.tagsContainer', node);
    for (const tag of session.tag || []) {
      const li = document.createElement('li');
      li.className = 'tag';
      li.append(tagIcon(tag));
      const span = document.createElement('span');
      span.textContent = tagLabel(tag);
      li.append(span);
      tags.append(li);
    }
    $('.windowsInfo', node).textContent = windowsInfoText(session.windowsNumber, session.tabsNumber);
    $('.date', node).textContent = formatDate(session.date, state.settings.dateFormat);
    const selectButton = $('.selectButton', node);
    selectButton.onclick = () => selectSession(session.id);
    selectButton.ondblclick = (e) => {
      e.stopPropagation();
      openSessionById(session.id);
    };
    selectButton.oncontextmenu = (e) => {
      e.preventDefault();
      selectSession(session.id);
      const { x, y } = eventPos(e);
      openMenu(x, y, menuItems(sessionMenuItems(session)));
    };
    $('.open', node).onclick = (e) => {
      e.stopPropagation();
      openSessionById(session.id);
    };
    $('.open', node).oncontextmenu = (e) => {
      e.preventDefault();
      const { x, y } = eventPos(e);
      openMenu(x, y, menuItems(openMenuItems(session)));
    };
    $('.remove', node).onclick = (e) => {
      e.stopPropagation();
      removeSession(session.id);
    };
    applyIcons(node);
    applyI18n(node);
    area.insertBefore(node, $('#noSession'));
  }
  const noWords = state.searchWords.length === 0;
  $('#noSession').hidden = !(list.length === 0 && state.filterValue === '_displayAll' && noWords);
  $('#noResult').hidden = !(list.length === 0 && !noWords);
}

async function selectSession(id) {
  if (id === state.selectedId) return renderDetails();
  state.selectedId = id;
  saveSettings({ selectedSessionId: id });
  for (const el of document.querySelectorAll('.sessionItem')) el.classList.toggle('isSelected', el.dataset.id === id);
  renderDetails();
  const item = document.querySelector(`.sessionItem[data-id="${id}"] .selectButton`);
  item?.focus();
}

async function renderDetails() {
  const area = $('#sessionDetailArea');
  area.innerHTML = '';
  const session = state.selectedId ? await getSession(state.selectedId) : null;
  if (!session) {
    const no = document.createElement('div');
    no.className = 'noSession';
    const p = document.createElement('p');
    p.textContent = t('noSessionSelectedLabel');
    no.append(p);
    area.append(no);
    return;
  }
  const frag = $('#detailsTpl').content.cloneNode(true);
  const nameContainer = $('.nameContainer', frag);
  nameContainer.classList.toggle('isTruncate', !!state.settings.truncateTitle);
  $('.sessionName', frag).textContent = displayName(session.name);
  $('.renameButton', frag).onclick = () => {
    openModal(t('renameSessionLabel'), textInputModal({
      defaultText: session.name,
      onSave: async (name) => {
        if (name.trim() === '' || name === session.name) return;
        await renameSession(session.id, name);
        pushHistory({ undo: () => renameSession(session.id, session.name), redo: () => renameSession(session.id, name) });
        await load();
      },
    }));
  };
  $('.menuButton', frag).onclick = (e) => {
    const { x, y } = eventPos(e);
    openMenu(x, y, menuItems(sessionMenuItems(session)));
  };
  const tags = $('.tagsContainer', frag);
  const addTagButton = $('.addTagButton', frag);
  for (const tag of session.tag || []) {
    const div = document.createElement('div');
    div.className = 'tag';
    div.append(tagIcon(tag));
    const span = document.createElement('span');
    span.textContent = tagLabel(tag);
    div.append(span);
    const rm = document.createElement('button');
    rm.className = 'removeTagButton';
    rm.title = t('removeTagLabel');
    rm.append(icon('plus'));
    rm.onclick = async () => {
      await removeTag(session.id, tag);
      pushHistory({ undo: () => addTag(session.id, tag), redo: () => removeTag(session.id, tag) });
      await load();
    };
    div.append(rm);
    tags.insertBefore(div, addTagButton);
  }
  addTagButton.prepend(icon('tag'));
  addTagButton.onclick = () => {
    openModal(t('addTagLabel'), tagInputModal({
      tagList: tagList(),
      onSave: async (tag) => {
        tag = tag.trim();
        if (!tag) return;
        await addTag(session.id, tag);
        pushHistory({ undo: () => removeTag(session.id, tag), redo: () => addTag(session.id, tag) });
        await load();
      },
    }));
  };
  $('.sessionHeader .date', frag).textContent = formatDate(session.date, state.settings.dateFormat);
  $('.sessionHeader .windowsInfo', frag).textContent = windowsInfoText(session.windowsNumber, session.tabsNumber);
  const openBtn = $('.sessionHeader .open', frag);
  openBtn.title = t(`${state.settings.openButtonBehavior}Label`);
  openBtn.onclick = () => openSessionById(session.id);
  openBtn.oncontextmenu = (e) => {
    e.preventDefault();
    const { x, y } = eventPos(e);
    openMenu(x, y, menuItems(openMenuItems(session)));
  };
  $('.sessionHeader .remove', frag).onclick = () => removeSession(session.id);

  const details = $('.detailsContainer', frag);
  const searchWords = matchesSearch(session) && state.searchWords.length ? state.searchWords : [];
  for (const windowId of Object.keys(session.windows)) {
    const tabs = sortedTabs(session.windows[windowId]);
    const win = $('#windowTpl').content.firstElementChild.cloneNode(true);
    const key = `${session.id}/${windowId}`;
    win.classList.toggle('isCollapsed', state.collapsed.has(key));
    $('.collapseButton', win).onclick = () => {
      if (state.collapsed.has(key)) state.collapsed.delete(key);
      else state.collapsed.add(key);
      win.classList.toggle('isCollapsed', state.collapsed.has(key));
    };
    const incognito = !!session.windowsInfo?.[windowId]?.incognito;
    $('.windowIcon', win).append(icon(incognito ? 'windowIncognito' : 'window'));
    const title = $('.windowTitle', win);
    title.textContent = session.windowsInfo?.[windowId]?.title || tabs.find((tab) => tab.active)?.title || t('windowLabel');
    title.onclick = () => send({ type: 'open-window', id: session.id, windowId, mode: 'openInNewWindow' }).then((r) => r?.ok && !state.isInTab && window.close());
    $('.tabsNumber', win).textContent = `${tabs.length} ${tabs.length > 1 ? t('tabsLabel') : t('tabLabel')}`;
    const editClick = (e) => {
      e.preventDefault();
      const { x, y } = eventPos(e);
      openMenu(x, y, menuItems(windowMenuItems(session, windowId)));
    };
    $('.editButton', win).onclick = editClick;
    $('.windowInfo', win).oncontextmenu = editClick;
    const rmWin = $('.windowInfo .removeButton', win);
    if (session.windowsNumber > 1) rmWin.onclick = () => removeWindow(session, windowId);
    else rmWin.remove();
    const tabsEl = $('.tabs', win);
    for (const tab of tabs) {
      const node = $('#tabTpl').content.firstElementChild.cloneNode(true);
      const btn = $('.tabButton', node);
      btn.title = `${tab.title}\n${tab.url}`;
      const img = $('.favIcon', node);
      img.src = faviconFor(tab);
      img.onerror = () => { img.style.visibility = 'hidden'; };
      $('.tabTitle', node).append(highlight(tab.title || '', searchWords));
      btn.onmouseup = (e) => {
        if (e.button === 0) send({ type: 'open-tab', tab, active: true }).then((r) => r?.ok && !state.isInTab && window.close());
        else if (e.button === 1) send({ type: 'open-tab', tab, active: false });
      };
      const rmTab = $('.removeButton', node);
      if (session.tabsNumber > 1) rmTab.onclick = () => removeTab(session, windowId, String(tab.id));
      else rmTab.remove();
      tabsEl.append(node);
    }
    details.append(win);
  }
  applyIcons(frag);
  applyI18n(frag);
  area.append(frag);
}

// ---------------------------------------------------------------------------
// Sync status (header)
// ---------------------------------------------------------------------------
async function renderSyncStatus() {
  const { settings } = state;
  const btn = $('#cloudSyncButton');
  const statusEl = $('#syncStatus');
  const badge = $('.syncBadge', btn);
  const enabled = settings.sync.provider !== 'none';
  btn.hidden = !enabled;
  if (!enabled) return;
  const status = await getSyncStatus();
  let cls = 'none';
  let text = '';
  let error = false;
  if (status.state === 'syncing') { cls = 'pending'; text = `${t('syncingLabel')}...`; }
  else if (status.state === 'ok') { cls = 'complete'; text = t('syncCompletedLabel'); }
  else if (status.state === 'error') {
    error = true;
    if (status.code === 'NEEDS_AUTH') { cls = 'signInRequired'; text = t('signInRequiredLabel'); }
    else if (status.code === 'NEEDS_PERMISSION') { cls = 'error'; text = t('needsPermissionLabel'); }
    else if (status.code === 'NOT_CONFIGURED') { cls = 'error'; text = t('folderNotConfiguredLabel'); }
    else { cls = 'error'; text = t('syncErrorLabel', [status.message || status.code || '']); }
  }
  statusEl.className = `syncStatus ${cls}`;
  $('span', statusEl).textContent = text;
  const needsSync = await calcNeedsSync(status);
  badge.hidden = !(needsSync || error);
  badge.classList.toggle('syncError', error);
}

async function calcNeedsSync(status) {
  const last = status.state === 'ok' ? status.time || 0 : status.updatedAt || 0;
  const include = !!state.settings.sync.syncAutoSaves;
  const dirty = state.sessions
    .filter((s) => include || !isAutoSession(s))
    .some((s) => (s.lastEditedTime || 0) > last);
  if (dirty) return true;
  const tombs = await tombstonesDB.all().catch(() => []);
  return tombs.some((tb) => (include || !tb.auto) && tb.deletedAt > last);
}

async function runSync() {
  if (state.settings.sync.provider === 'folder') {
    if ((await folderPermissionState()) !== 'granted') {
      const ok = await requestFolderPermission();
      if (!ok) return;
    }
    await sync({ reason: 'manual' });
  } else {
    await send({ type: 'sync' });
  }
  await load();
}
$('#cloudSyncButton').onclick = runSync;

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
$('#filterSelect').onchange = (e) => changeFilter(e.target.value);
$('#sortSelect').onchange = (e) => changeSort(e.target.value);
$('#searchButton').onclick = () => toggleSearchBar();
$('#clearSearchButton').onclick = () => toggleSearchBar(false);
$('#searchInput').oninput = (e) => changeSearchWord(e.target.value);
$('#searchInput').onkeydown = (e) => {
  if (e.key === 'Enter') changeSearchWord(e.target.value, true);
  if (e.key === 'Escape') toggleSearchBar(false);
};
$('#saveButton').onclick = () => saveSession($('#saveInput').value, state.settings.saveButtonBehavior);
$('#saveButton').oncontextmenu = (e) => {
  e.preventDefault();
  const { x, y } = eventPos(e);
  openMenu(x, y, menuItems(saveMenuItems($('#saveInput').value)));
};
$('#saveOptionButton').onclick = $('#saveButton').oncontextmenu;
$('#saveInput').onkeydown = (e) => {
  if (e.key === 'Enter') saveSession(e.target.value, state.settings.saveButtonBehavior);
  if (e.key === 'Tab' && e.shiftKey) {
    e.preventDefault();
    $('#sessionsArea').focus();
  }
};
$('#sessionsArea').onkeydown = (e) => {
  if (e.target.closest('input')) return;
  const list = sortedSessions();
  const index = list.findIndex((s) => s.id === state.selectedId);
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    if (list[Math.max(0, index - 1)]) selectSession(list[Math.max(0, index - 1)].id);
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    if (list[Math.min(list.length - 1, index + 1)]) selectSession(list[Math.min(list.length - 1, index + 1)].id);
  } else if (e.key === 'Tab' && e.shiftKey) {
    e.preventDefault();
    $('#searchButton').focus();
  } else if (e.key === 'Tab') {
    e.preventDefault();
    $('#saveInput').focus();
  } else if (e.key === 'Enter' && e.shiftKey) {
    if (state.selectedId) openSessionById(state.selectedId);
  } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
    toggleSearchBar(true);
  }
};
$('#settingsButton').onclick = () => chrome.runtime.openOptionsPage();
$('#openInTabButton').onclick = () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('popup/popup.html#inTab') });
  window.close();
};

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'sessions-changed') load();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.syncStatus) renderSyncStatus();
});

async function load() {
  state.settings = await getSettings();
  state.sessions = await listSessions();
  $('#popupPage').classList.toggle('hideOpenButtons', !state.settings.isShowOpenButtons);
  renderFilterOptions();
  renderSessions();
  await renderDetails();
  await renderSyncStatus();
}

async function init() {
  applyI18n();
  applyIcons();
  await applyTheme();
  state.settings = await getSettings();
  const { settings } = state;
  if (!state.isInTab) {
    if (settings.isSessionListOpenInTab) {
      chrome.tabs.create({ url: chrome.runtime.getURL('popup/popup.html#inTab') });
      window.close();
      return;
    }
    document.body.style.width = `${settings.popupWidthV2}px`;
    document.body.style.height = `${settings.popupHeight}px`;
  } else {
    document.documentElement.style.height = '100%';
    document.body.style.height = '100%';
    $('#popupPage').classList.add('isInTab');
  }
  $('#sidebar').style.width = `${settings.sidebarWidth}px`;
  state.filterValue = settings.filterValue || '_displayAll';
  state.sortValue = settings.sortValue || 'newest';
  state.selectedId = settings.selectedSessionId || '';
  $('#sortSelect').value = state.sortValue;
  await load();
  if (state.selectedId && !state.sessions.some((s) => s.id === state.selectedId)) {
    state.selectedId = '';
    await renderDetails();
  }
  const item = document.querySelector(`.sessionItem[data-id="${state.selectedId}"]`);
  if (item) $('#sessionsArea').scrollTo(0, item.offsetTop);
  $('#saveInput').value = await currentTabTitle(settings);
  renderUndo();

  if (settings.sync.provider !== 'none' && settings.sync.autoSync) {
    if (settings.sync.provider === 'folder') {
      if ((await folderPermissionState()) === 'granted') sync({ reason: 'popup' }).then(load);
    } else {
      send({ type: 'sync' }).then(load);
    }
  }
}

init();
