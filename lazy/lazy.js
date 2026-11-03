// Placeholder tab that loads its real URL only when it becomes visible.
const params = new URLSearchParams(location.hash.slice(1));
const url = params.get('url') || '';
const title = params.get('title') || url;
const icon = params.get('icon') || '';

document.title = title;
document.getElementById('title').textContent = title;
document.getElementById('url').textContent = url;
if (icon) document.getElementById('icon').href = icon;

let navigating = false;
async function navigate() {
  if (navigating || !url) return;
  navigating = true;
  try {
    const tab = await chrome.tabs.getCurrent();
    await chrome.tabs.update(tab.id, { url });
  } catch (err) {
    navigating = false;
    document.getElementById('hint').textContent = chrome.i18n.getMessage('lazyCannotOpen') || 'This URL cannot be opened automatically. Copy it into the address bar.';
    const btn = document.getElementById('go');
    btn.hidden = false;
    btn.onclick = () => navigator.clipboard.writeText(url).catch(() => {});
    btn.textContent = chrome.i18n.getMessage('copyUrl') || 'Copy URL';
  }
}

if (document.visibilityState === 'visible') navigate();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') navigate();
});
