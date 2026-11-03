// pCloud provider. Uses the OAuth implicit flow (pCloud tokens do not expire).
import { BaseProvider, ProviderError, fetchOrThrow } from './base.js';
import { authStore, launchAuth, parseFragment, redirectUri } from './oauth.js';

function hostFor(locationId) {
  return Number(locationId) === 2 ? 'https://eapi.pcloud.com' : 'https://api.pcloud.com';
}

function normalizeFolder(folder) {
  let f = (folder || '/TabManager').trim();
  if (!f.startsWith('/')) f = '/' + f;
  return f.replace(/\/+$/, '');
}

export async function connectPcloud(clientId) {
  if (!clientId) throw new ProviderError('NOT_CONFIGURED');
  const p = new URLSearchParams({ client_id: clientId, response_type: 'token', redirect_uri: redirectUri() });
  const redirect = await launchAuth('https://my.pcloud.com/oauth2/authorize?' + p.toString(), true);
  const frag = parseFragment(redirect);
  if (!frag.access_token) throw new ProviderError('NEEDS_AUTH', frag.error || 'no token');
  const data = { accessToken: frag.access_token, locationId: Number(frag.locationid || 1) };
  try {
    const res = await fetch(`${hostFor(data.locationId)}/userinfo`, { headers: { Authorization: `Bearer ${data.accessToken}` } });
    const j = await res.json();
    if (j.result === 0) data.email = j.email || '';
  } catch {
    /* optional */
  }
  await authStore.set('pcloud', data);
  return data;
}

export async function disconnectPcloud() {
  await authStore.clear('pcloud');
}

const AUTH_ERRORS = new Set([1000, 2000, 2094, 2095]);

export class PcloudProvider extends BaseProvider {
  constructor(cfg = {}) {
    super();
    this.clientId = cfg.clientId || '';
    this.folder = normalizeFolder(cfg.folder);
  }

  async init() {
    if (!this.clientId) throw new ProviderError('NOT_CONFIGURED');
    this.auth = await authStore.get('pcloud');
    if (!this.auth?.accessToken) throw new ProviderError('NEEDS_AUTH');
    this.host = hostFor(this.auth.locationId);
    await this.api('createfolderifnotexists', { path: this.folder });
  }

  async api(method, params = {}, init = {}) {
    const qs = new URLSearchParams(params).toString();
    const res = await fetchOrThrow(`${this.host}/${method}${qs ? '?' + qs : ''}`, {
      ...init,
      headers: { Authorization: `Bearer ${this.auth.accessToken}`, ...(init.headers || {}) },
    });
    const json = await res.json();
    if (json.result !== 0) {
      if (AUTH_ERRORS.has(json.result)) {
        await authStore.clear('pcloud');
        throw new ProviderError('NEEDS_AUTH', json.error);
      }
      const err = new ProviderError('API', `${json.result} ${json.error || ''}`);
      err.result = json.result;
      throw err;
    }
    return json;
  }

  async list() {
    const json = await this.api('listfolder', { path: this.folder });
    return (json.metadata?.contents || []).filter((e) => !e.isfolder).map((e) => ({ name: e.name }));
  }

  async read(name) {
    const link = await this.api('getfilelink', { path: `${this.folder}/${name}` });
    const url = `https://${link.hosts[0]}${link.path}`;
    return (await fetchOrThrow(url)).text();
  }

  async write(name, text) {
    const body = new FormData();
    body.append('file', new Blob([text], { type: 'application/json' }), name);
    await this.api('uploadfile', { path: this.folder, filename: name, nopartial: 1 }, { method: 'POST', body });
  }

  async delete(name) {
    try {
      await this.api('deletefile', { path: `${this.folder}/${name}` });
    } catch (err) {
      if (err.result !== 2009 && err.result !== 2005) throw err; // not found
    }
  }
}
