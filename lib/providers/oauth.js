// OAuth helpers shared by the cloud providers. Tokens are kept in
// chrome.storage.local under the "auth" key: { gdrive: {...}, dropbox: {...}, pcloud: {...} }
export function redirectUri() {
  return chrome.identity.getRedirectURL();
}

export async function launchAuth(url, interactive = true) {
  const result = await chrome.identity.launchWebAuthFlow({ url, interactive });
  if (!result) throw new Error('empty auth response');
  return result;
}

export function parseFragment(url) {
  const u = new URL(url);
  const params = new URLSearchParams(u.hash.replace(/^#/, ''));
  const out = {};
  for (const [k, v] of params) out[k] = v;
  for (const [k, v] of u.searchParams) out[k] ??= v;
  return out;
}

function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function pkcePair() {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(48)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

export const authStore = {
  async get(provider) {
    const { auth } = await chrome.storage.local.get('auth');
    return auth?.[provider] || null;
  },
  async set(provider, data) {
    const { auth } = await chrome.storage.local.get('auth');
    await chrome.storage.local.set({ auth: { ...(auth || {}), [provider]: data } });
  },
  async clear(provider) {
    const { auth } = await chrome.storage.local.get('auth');
    if (!auth) return;
    delete auth[provider];
    await chrome.storage.local.set({ auth });
  },
};

export function form(params) {
  return new URLSearchParams(params).toString();
}
