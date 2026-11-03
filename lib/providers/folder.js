// Sync through a local folder (File System Access API). Point it at a folder
// inside Google Drive for desktop, pCloud Drive, Dropbox, OneDrive, ... and the
// desktop client takes care of moving files between machines.
import { kv } from '../db.js';
import { BaseProvider, ProviderError } from './base.js';

export const FOLDER_HANDLE_KEY = 'syncFolderHandle';

export function folderSupported() {
  return typeof FileSystemDirectoryHandle !== 'undefined';
}

export async function getFolderHandle() {
  if (!folderSupported()) return null;
  try {
    return (await kv.get(FOLDER_HANDLE_KEY)) || null;
  } catch {
    return null;
  }
}

/** Must be called from a user gesture in an extension page. */
export async function pickFolder() {
  if (typeof window === 'undefined' || !window.showDirectoryPicker) throw new ProviderError('UNSUPPORTED');
  const handle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'tab-manager-sync' });
  await kv.set(FOLDER_HANDLE_KEY, handle);
  return handle;
}

export async function forgetFolder() {
  await kv.del(FOLDER_HANDLE_KEY);
}

/** Must be called from a user gesture. Returns true if access was granted. */
export async function requestFolderPermission() {
  const handle = await getFolderHandle();
  if (!handle) return false;
  const state = await handle.requestPermission({ mode: 'readwrite' });
  return state === 'granted';
}

export async function folderPermissionState() {
  const handle = await getFolderHandle();
  if (!handle) return 'none';
  try {
    return await handle.queryPermission({ mode: 'readwrite' });
  } catch {
    return 'prompt';
  }
}

export class FolderProvider extends BaseProvider {
  async init() {
    if (!folderSupported()) throw new ProviderError('UNSUPPORTED', 'File System Access API unavailable');
    this.handle = await getFolderHandle();
    if (!this.handle) throw new ProviderError('NOT_CONFIGURED');
    const state = await this.handle.queryPermission({ mode: 'readwrite' });
    if (state !== 'granted') throw new ProviderError('NEEDS_PERMISSION');
  }

  async list() {
    const out = [];
    for await (const [name, entry] of this.handle.entries()) {
      if (entry.kind === 'file') out.push({ name });
    }
    return out;
  }

  async read(name) {
    const fh = await this.handle.getFileHandle(name);
    const file = await fh.getFile();
    return file.text();
  }

  async write(name, text) {
    const fh = await this.handle.getFileHandle(name, { create: true });
    const writable = await fh.createWritable();
    await writable.write(text);
    await writable.close();
  }

  async delete(name) {
    try {
      await this.handle.removeEntry(name);
    } catch (err) {
      if (err?.name !== 'NotFoundError') throw err;
    }
  }
}
