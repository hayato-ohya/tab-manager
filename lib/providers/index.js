import { FolderProvider } from './folder.js';
import { GoogleDriveProvider } from './gdrive.js';
import { DropboxProvider } from './dropbox.js';
import { PcloudProvider } from './pcloud.js';

export function createProvider(settings) {
  const cfg = settings.sync || {};
  switch (cfg.provider) {
    case 'folder':
      return new FolderProvider();
    case 'gdrive':
      return new GoogleDriveProvider(cfg.gdrive);
    case 'dropbox':
      return new DropboxProvider(cfg.dropbox);
    case 'pcloud':
      return new PcloudProvider(cfg.pcloud);
    default:
      return null;
  }
}
