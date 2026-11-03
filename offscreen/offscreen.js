// Offscreen document: runs folder sync, which needs a window context for the
// File System Access API. Offscreen documents only have chrome.runtime, so the
// settings arrive in the message and the final status goes back in the reply.
import { sync } from '../lib/sync.js';

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'offscreen-sync') return false;
  sync({ reason: msg.reason || 'alarm', settings: msg.settings, onStatus: async () => {} })
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, code: 'ERROR', message: err.message, status: { state: 'error', code: 'ERROR', message: err.message } }));
  return true;
});
