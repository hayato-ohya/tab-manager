export class ProviderError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code; // NOT_CONFIGURED | NEEDS_AUTH | NEEDS_PERMISSION | UNSUPPORTED | NETWORK | API
  }
}

/**
 * A storage provider exposes a flat directory of small text files:
 *   init()            prepare (check auth / permission, create folder)
 *   list()            → [{ name }]
 *   read(name)        → string
 *   write(name, text)
 *   delete(name)
 */
export class BaseProvider {
  async init() {}
  async list() { return []; }
  async read() { throw new ProviderError('UNSUPPORTED'); }
  async write() { throw new ProviderError('UNSUPPORTED'); }
  async delete() { throw new ProviderError('UNSUPPORTED'); }
}

export async function fetchOrThrow(url, init, { onUnauthorized } = {}) {
  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw new ProviderError('NETWORK', err.message);
  }
  if (res.status === 401 && onUnauthorized) await onUnauthorized();
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (res.status === 401) throw new ProviderError('NEEDS_AUTH', text.slice(0, 200));
    throw new ProviderError('API', `${res.status} ${text.slice(0, 200)}`);
  }
  return res;
}
