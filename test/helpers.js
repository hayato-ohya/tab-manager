// Minimal browser globals so the extension modules can run under Node.
import 'fake-indexeddb/auto';

const localStore = {};
globalThis.chrome = {
  storage: {
    local: {
      async get(key) {
        if (typeof key === 'string') return { [key]: localStore[key] };
        const out = {};
        for (const k of key) out[k] = localStore[k];
        return out;
      },
      async set(obj) {
        Object.assign(localStore, obj);
      },
      async remove(key) {
        delete localStore[key];
      },
    },
    onChanged: { addListener() {} },
  },
  runtime: {
    id: 'test',
    sendMessage: async () => {},
    getURL: (p) => 'chrome-extension://test/' + p,
    onMessage: { addListener() {} },
  },
  i18n: { getMessage: (k) => k },
};
if (!globalThis.navigator) globalThis.navigator = {};
Object.defineProperty(globalThis.navigator, 'locks', {
  value: { request: (_name, fn) => fn() },
  configurable: true,
});

export const storage = localStore;

/** In-memory provider that records calls. */
export class MemoryProvider {
  constructor(files = {}) {
    this.files = { ...files };
    this.log = [];
  }
  async init() {}
  async list() {
    return Object.keys(this.files).map((name) => ({ name }));
  }
  async read(name) {
    if (!(name in this.files)) throw new Error('not found ' + name);
    return this.files[name];
  }
  async write(name, text) {
    this.log.push(['write', name]);
    this.files[name] = text;
  }
  async delete(name) {
    this.log.push(['delete', name]);
    delete this.files[name];
  }
}

export function makeSession(id, { name = 'S ' + id, edited = 1000, tag = [], url = 'https://example.com/' + id } = {}) {
  return {
    id,
    name,
    date: edited,
    lastEditedTime: edited,
    tag,
    windows: { 1: { 10: { id: 10, index: 0, windowId: 1, url, title: 'T', favIconUrl: '', pinned: false, active: true } } },
    windowsInfo: { 1: { state: 'normal' } },
    windowsNumber: 1,
    tabsNumber: 1,
  };
}
