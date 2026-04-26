/**
 * Electron Main Process
 *
 * Bootstraps the Next.js renderer and handles all Chutes E2EE transport
 * via IPC, keeping crypto and auth in the secure main process.
 */

import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

import { ChutesE2EETransport } from './lib/chutes/ChutesE2EETransport.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const isDev = !app.isPackaged;
const API_KEY = process.env.CHUTES_API_KEY || '';

const chutes = new ChutesE2EETransport({ apiKey: API_KEY });

/** Create the main browser window. */
function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    titleBarStyle: 'hiddenInset',
  });

  if (isDev) {
    win.loadURL('http://localhost:3000');
    win.webContents.openDevTools();
  } else {
    win.loadFile(path.join(__dirname, 'renderer', 'out', 'index.html'));
  }
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ---------------------------------------------------------------------------
// IPC handlers — secure bridge between renderer and main process
// ---------------------------------------------------------------------------

const activeControllers = new Map(); // requestId -> AbortController

ipcMain.handle('chutes:chat', async (_event, { requestId, params }) => {
  try {
    const { response, abort } = await chutes.chat(params);
    activeControllers.set(requestId, abort);

    if (params.stream) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      const pump = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              if (line.trim().startsWith('data: ')) {
                const data = line.trim().slice(6);
                if (data === '[DONE]') {
                  BrowserWindow.getAllWindows()[0]?.webContents.send('chutes:chunk', { requestId, done: true });
                } else {
                  BrowserWindow.getAllWindows()[0]?.webContents.send('chutes:chunk', { requestId, data });
                }
              }
            }
          }

          if (buffer.trim()) {
            const line = buffer.trim();
            if (line.startsWith('data: ')) {
              BrowserWindow.getAllWindows()[0]?.webContents.send('chutes:chunk', {
                requestId,
                data: line.slice(6),
              });
            }
          }

          BrowserWindow.getAllWindows()[0]?.webContents.send('chutes:chunk', { requestId, done: true });
        } catch (err) {
          BrowserWindow.getAllWindows()[0]?.webContents.send('chutes:error', {
            requestId,
            error: err.message,
          });
        }
      };

      pump();
      return { ok: true, stream: true };
    }

    const body = await response.json();
    activeControllers.delete(requestId);
    return { ok: true, stream: false, body };
  } catch (err) {
    activeControllers.delete(requestId);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('chutes:abort', (_event, { requestId }) => {
  const abort = activeControllers.get(requestId);
  if (abort) {
    abort();
    activeControllers.delete(requestId);
  }
});

ipcMain.handle('chutes:models', async () => {
  try {
    const models = await chutes.getModels();
    return { ok: true, models };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
