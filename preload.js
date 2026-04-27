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

  /** Get cached public LLM model stats. */
  modelStats: () => ipcRenderer.invoke('chutes:modelStats'),

  /** Run a lightweight web search from the main process. */
  webSearch: (query) => ipcRenderer.invoke('chutes:webSearch', { query }),

  /** Register callback for stream chunks. Returns a disposer function. */
  onStreamChunk: (callback) => on('chutes:chunk', callback),

  /** Register callback for stream errors. Returns a disposer function. */
  onStreamError: (callback) => on('chutes:error', callback),

  /** Save API key securely in main process (encrypted at rest). */
  saveApiKey: (provider, apiKey) =>
    ipcRenderer.invoke('settings:saveApiKey', { provider, apiKey }),

  /** Get API key presence and storage status. Does not return the key. */
  getApiKeyStatus: (provider) =>
    ipcRenderer.invoke('settings:getApiKeyStatus', { provider }),

  /** Delete the persisted API key for a provider. */
  deleteApiKey: (provider) =>
    ipcRenderer.invoke('settings:deleteApiKey', { provider }),
};

contextBridge.exposeInMainWorld('chutes', chutesAPI);
