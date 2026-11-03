// Google Drive provider. Uses the OAuth implicit flow through
// chrome.identity.launchWebAuthFlow with a "Web application" client ID, which
// works in every Chromium browser (chrome.identity.getAuthToken is Chrome-only).
import { BaseProvider, ProviderError, fetchOrThrow } from './base.js';
import { authStore, launchAuth, parseFragment, redirectUri } from './oauth.js';

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

function authUrl(clientId, { interactive, loginHint }) {
  const p = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri(),
    response_type: 'token',
    scope: SCOPE,
    include_granted_scopes: 'true',
    prompt: interactive ? 'select_account' : 'none',
  });
  if (loginHint) p.set('login_hint', loginHint);
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + p.toString();
}

async function storeTokenFromRedirect(redirect, previous = {}) {
  const frag = parseFragment(redirect);
  if (frag.error) throw new ProviderError('NEEDS_AUTH', frag.error);
  if (!frag.access_token) throw new ProviderError('NEEDS_AUTH', 'no access token');
  const data = {
    ...previous,
    accessToken: frag.access_token,
    expiresAt: Date.now() + (Number(frag.expires_in) || 3600) * 1000 - 60_000,
  };
  await authStore.set('gdrive', data);
  return data;
}

/** Interactive sign-in (call from the options page). */
export async function connectGoogleDrive(clientId) {
  if (!clientId) throw new ProviderError('NOT_CONFIGURED');
  const redirect = await launchAuth(authUrl(clientId, { interactive: true }), true);
  let data = await storeTokenFromRedirect(redirect);
  try {
    const res = await fetch(`${API}/about?fields=user`, { headers: { Authorization: `Bearer ${data.accessToken}` } });
    if (res.ok) {
      const about = await res.json();
      data = { ...data, email: about.user?.emailAddress || '', name: about.user?.displayName || '' };
      await authStore.set('gdrive', data);
    }
  } catch {
    /* optional */
  }
  return data;
}

export async function disconnectGoogleDrive() {
  await authStore.clear('gdrive');
}

export class GoogleDriveProvider extends BaseProvider {
  constructor(cfg = {}) {
    super();
    this.clientId = cfg.clientId || '';
    this.folderName = cfg.folder || 'TabManager';
    this.ids = new Map(); // name → fileId
  }

  async init() {
    if (!this.clientId) throw new ProviderError('NOT_CONFIGURED');
    this.auth = await authStore.get('gdrive');
    if (!this.auth?.accessToken) throw new ProviderError('NEEDS_AUTH');
    await this.ensureToken();
    this.folderId = await this.ensureFolder();
  }

  async ensureToken() {
    if (this.auth.expiresAt > Date.now()) return;
    try {
      const redirect = await launchAuth(authUrl(this.clientId, { interactive: false, loginHint: this.auth.email }), false);
      this.auth = await storeTokenFromRedirect(redirect, this.auth);
    } catch (err) {
      throw new ProviderError('NEEDS_AUTH', err.message);
    }
  }

  headers(extra = {}) {
    return { Authorization: `Bearer ${this.auth.accessToken}`, ...extra };
  }

  async api(path, init = {}) {
    const res = await fetchOrThrow(path.startsWith('http') ? path : API + path, { ...init, headers: this.headers(init.headers) }, {
      onUnauthorized: () => authStore.set('gdrive', { ...this.auth, expiresAt: 0 }),
    });
    return res;
  }

  async ensureFolder() {
    const q = `name='${this.folderName.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false and 'root' in parents`;
    const res = await this.api(`/files?q=${encodeURIComponent(q)}&fields=files(id,name)&spaces=drive`);
    const { files } = await res.json();
    if (files?.length) return files[0].id;
    const created = await this.api('/files?fields=id', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: this.folderName, mimeType: 'application/vnd.google-apps.folder' }),
    });
    return (await created.json()).id;
  }

  async list() {
    this.ids.clear();
    const out = [];
    let pageToken = '';
    do {
      const q = `'${this.folderId}' in parents and trashed=false`;
      const url = `/files?q=${encodeURIComponent(q)}&fields=nextPageToken,files(id,name)&pageSize=1000&spaces=drive${pageToken ? `&pageToken=${pageToken}` : ''}`;
      const data = await (await this.api(url)).json();
      for (const f of data.files || []) {
        if (!this.ids.has(f.name)) {
          this.ids.set(f.name, f.id);
          out.push({ name: f.name });
        }
      }
      pageToken = data.nextPageToken || '';
    } while (pageToken);
    return out;
  }

  async read(name) {
    const id = this.ids.get(name);
    if (!id) throw new ProviderError('API', `not found: ${name}`);
    return (await this.api(`/files/${id}?alt=media`)).text();
  }

  async write(name, text) {
    const id = this.ids.get(name);
    if (id) {
      await this.api(`${UPLOAD}/files/${id}?uploadType=media`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: text,
      });
      return;
    }
    const boundary = 'tabmanager' + Math.random().toString(36).slice(2);
    const meta = JSON.stringify({ name, parents: [this.folderId], mimeType: 'application/json' });
    const body =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
      `--${boundary}\r\nContent-Type: application/json\r\n\r\n${text}\r\n--${boundary}--`;
    const res = await this.api(`${UPLOAD}/files?uploadType=multipart&fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    });
    const created = await res.json();
    this.ids.set(name, created.id);
  }

  async delete(name) {
    const id = this.ids.get(name);
    if (!id) return;
    try {
      await this.api(`/files/${id}`, { method: 'DELETE' });
    } catch (err) {
      if (!/^404/.test(err.message)) throw err;
    }
    this.ids.delete(name);
  }
}
