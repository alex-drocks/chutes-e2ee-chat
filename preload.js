/**
 * Electron Preload Script
 *
 * Exposes a minimal, typed API to the renderer process via contextBridge.
 * No Node.js or Electron APIs leak to the renderer.
 */

import { contextBridge, ipcRenderer } from 'electron';

const chutesAPI = {
  /**
   * Send a chat completion request. Returns immediately with { ok, stream?, body?, error? }.
   * For streaming, listen to `chutes:chunk` and `chutes:error` events via onStreamChunk/onStreamError.
   */
  chat: (requestId, params) => ipcRenderer.invoke('chutes:chat', { requestId, params }),

  /** Abort an in-flight streaming request. */
  abort: (requestId) => ipcRenderer.invoke('chutes:abort', { requestId }),

  /** Get available models. */
  models: () => ipcRenderer.invoke('chutes:models'),

  /** Register callback for stream chunks. */
  onStreamChunk: (callback) => ipcRenderer.on('chutes:chunk', (_event, payload) => callback(payload)),

  /** Register callback for stream errors. */
  onStreamError: (callback) => ipcRenderer.on('chutes:error', (_event, payload) => callback(payload)),
};

contextBridge.exposeInMainWorld('chutes', chutesAPI);
