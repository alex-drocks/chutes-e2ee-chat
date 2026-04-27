/**
 * Electron Preload Script
 *
 * Exposes a minimal, typed, security-audited API to the renderer process.
 * No Node.js or Electron internals leak to the renderer.
 */

const { contextBridge, ipcRenderer } = require('electron');

function on(channel, callback) {
  const wrapped = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

const chutesAPI = {
  /** Send a chat completion request. */
  chat: (requestId, params) => ipcRenderer.invoke('chutes:chat', { requestId, params }),

  /** Abort an in-flight streaming request. */
  abort: (requestId) => ipcRenderer.invoke('chutes:abort', { requestId }),

  /** Get available models. */
  models: () => ipcRenderer.invoke('chutes:models'),

  /** Register callback for stream chunks. Returns a disposer function. */
  onStreamChunk: (callback) => on('chutes:chunk', callback),

  /** Register callback for stream errors. Returns a disposer function. */
  onStreamError: (callback) => on('chutes:error', callback),

  /** Save API key securely in main process (encrypted at rest). */
  saveApiKey: (provider, apiKey) =>
    ipcRenderer.invoke('settings:saveApiKey', { provider, apiKey }),

  /** Get stored API key for a provider. */
  getApiKey: (provider) => ipcRenderer.invoke('settings:getApiKey', { provider }),
};

contextBridge.exposeInMainWorld('chutes', chutesAPI);
