// Dropbox provider using OAuth 2 with PKCE and refresh tokens (no app secret needed).
import { BaseProvider, ProviderError, fetchOrThrow } from './base.js';
import { authStore, form, launchAuth, pkcePair, redirectUri } from './oauth.js';

const API = 'https://api.dropboxapi.com';
const CONTENT = 'https://content.dropboxapi.com';

function asciiJson(obj) {
  return JSON.stringify(obj).replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

function normalizeFolder(folder) {
  let f = (folder || '/TabManager').trim();
  if (!f.startsWith('/')) f = '/' + f;
  return f.replace(/\/+$/, '');
}

export async function connectDropbox(appKey) {
  if (!appKey) throw new ProviderError('NOT_CONFIGURED');
  const { verifier, challenge } = await pkcePair();
  const p = new URLSearchParams({
    client_id: appKey,
    response_type: 'code',
    redirect_uri: redirectUri(),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    token_access_type: 'offline',
  });
  const redirect = await launchAuth('https://www.dropbox.com/oauth2/authorize?' + p.toString(), true);
  const code = new URL(redirect).searchParams.get('code');
  if (!code) throw new ProviderError('NEEDS_AUTH', 'no code');
  const res = await fetchOrThrow(`${API}/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ code, grant_type: 'authorization_code', code_verifier: verifier, client_id: appKey, redirect_uri: redirectUri() }),
  });
  const tok = await res.json();
  const data = {
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token,
    expiresAt: Date.now() + (tok.expires_in || 14400) * 1000 - 60_000,
    accountId: tok.account_id || '',
  };
  try {
    const acc = await fetch(`${API}/2/users/get_current_account`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${data.accessToken}` },
    });
    if (acc.ok) {
      const j = await acc.json();
      data.email = j.email || '';
      data.name = j.name?.display_name || '';
    }
  } catch {
    /* optional */
  }
  await authStore.set('dropbox', data);
  return data;
}

export async function disconnectDropbox() {
  await authStore.clear('dropbox');
}

export class DropboxProvider extends BaseProvider {
  constructor(cfg = {}) {
    super();
    this.appKey = cfg.appKey || '';
    this.folder = normalizeFolder(cfg.folder);
  }

  async init() {
    if (!this.appKey) throw new ProviderError('NOT_CONFIGURED');
    this.auth = await authStore.get('dropbox');
    if (!this.auth?.refreshToken) throw new ProviderError('NEEDS_AUTH');
    await this.ensureToken();
    try {
      await this.rpc('/2/files/create_folder_v2', { path: this.folder, autorename: false });
    } catch (err) {
      if (!/conflict/.test(err.message)) throw err;
    }
  }

  async ensureToken() {
    if (this.auth.expiresAt > Date.now()) return;
    const res = await fetchOrThrow(`${API}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form({ grant_type: 'refresh_token', refresh_token: this.auth.refreshToken, client_id: this.appKey }),
    }).catch((err) => {
      throw new ProviderError('NEEDS_AUTH', err.message);
    });
    const tok = await res.json();
    this.auth = { ...this.auth, accessToken: tok.access_token, expiresAt: Date.now() + (tok.expires_in || 14400) * 1000 - 60_000 };
    await authStore.set('dropbox', this.auth);
  }

  async rpc(path, body) {
    const res = await fetchOrThrow(API + path, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.auth.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.json();
  }

  async list() {
    const out = [];
    let data = await this.rpc('/2/files/list_folder', { path: this.folder, recursive: false, limit: 2000 });
    for (;;) {
      for (const e of data.entries || []) if (e['.tag'] === 'file') out.push({ name: e.name });
      if (!data.has_more) break;
      data = await this.rpc('/2/files/list_folder/continue', { cursor: data.cursor });
    }
    return out;
  }

  async read(name) {
    const res = await fetchOrThrow(`${CONTENT}/2/files/download`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.auth.accessToken}`, 'Dropbox-API-Arg': asciiJson({ path: `${this.folder}/${name}` }) },
    });
    return res.text();
  }

  async write(name, text) {
    await fetchOrThrow(`${CONTENT}/2/files/upload`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.auth.accessToken}`,
        'Content-Type': 'application/octet-stream',
        'Dropbox-API-Arg': asciiJson({ path: `${this.folder}/${name}`, mode: 'overwrite', mute: true }),
      },
      body: text,
    });
  }

  async delete(name) {
    try {
      await this.rpc('/2/files/delete_v2', { path: `${this.folder}/${name}` });
    } catch (err) {
      if (!/not_found/.test(err.message)) throw err;
    }
  }
}
