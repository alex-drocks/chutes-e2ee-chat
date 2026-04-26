import { app, BrowserWindow, ipcMain, safeStorage } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ChutesE2EETransport } from './lib/chutes/ChutesE2EETransport.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;

// ---------------------------------------------------------------------------
// Secure credential storage
// ---------------------------------------------------------------------------

const CREDENTIALS_FILE = path.join(app.getPath('userData'), 'credentials.enc');

async function loadCredentials() {
  const fs = await import('node:fs');
  try {
    const encrypted = await fs.promises.readFile(CREDENTIALS_FILE);
    if (safeStorage.isEncryptionAvailable()) {
      return JSON.parse(safeStorage.decryptString(encrypted));
    }
    return JSON.parse(encrypted.toString('utf-8'));
  } catch {
    return {};
  }
}

async function saveCredentials(creds) {
  const fs = await import('node:fs');
  const data = Buffer.from(JSON.stringify(creds));
  const encrypted = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(JSON.stringify(creds))
    : data;
  await fs.promises.writeFile(CREDENTIALS_FILE, encrypted);
}

// ---------------------------------------------------------------------------
// Transport initialization
// ---------------------------------------------------------------------------

let chutes = null;

async function getTransport() {
  if (chutes) return chutes;
  const creds = await loadCredentials();
  const apiKey = process.env.CHUTES_API_KEY || creds.chutesApiKey || '';
  chutes = new ChutesE2EETransport({ apiKey });
  return chutes;
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

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
    win.loadFile(path.join(__dirname, 'renderer', 'dist', 'index.html'));
  }

  return win;
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
// IPC handlers
// ---------------------------------------------------------------------------

const activeControllers = new Map();
const streamingWindows = new Map(); // requestId -> BrowserWindow

ipcMain.handle('chutes:chat', async (event, { requestId, params }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  streamingWindows.set(requestId, win);

  try {
    const transport = await getTransport();
    const { response, abort } = await transport.chat(params);
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
                const target = streamingWindows.get(requestId);
                if (target && !target.isDestroyed()) {
                  target.webContents.send('chutes:chunk', { requestId, data, done: data === '[DONE]' });
                }
              }
            }
          }

          if (buffer.trim() && buffer.trim().startsWith('data: ')) {
            const target = streamingWindows.get(requestId);
            if (target && !target.isDestroyed()) {
              target.webContents.send('chutes:chunk', { requestId, data: buffer.trim().slice(6) });
            }
          }

          const target = streamingWindows.get(requestId);
          if (target && !target.isDestroyed()) {
            target.webContents.send('chutes:chunk', { requestId, done: true });
          }
        } catch (err) {
          const target = streamingWindows.get(requestId);
          if (target && !target.isDestroyed()) {
            target.webContents.send('chutes:error', { requestId, error: err.message });
          }
        } finally {
          activeControllers.delete(requestId);
          streamingWindows.delete(requestId);
        }
      };

      pump();
      return { ok: true, stream: true };
    }

    const body = await response.json();
    activeControllers.delete(requestId);
    streamingWindows.delete(requestId);
    return { ok: true, stream: false, body };
  } catch (err) {
    activeControllers.delete(requestId);
    streamingWindows.delete(requestId);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('chutes:abort', (_event, { requestId }) => {
  const abort = activeControllers.get(requestId);
  if (abort) {
    abort();
    activeControllers.delete(requestId);
    streamingWindows.delete(requestId);
  }
});

ipcMain.handle('chutes:models', async () => {
  try {
    const transport = await getTransport();
    const models = await transport.getModels();
    return { ok: true, models };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('settings:saveApiKey', async (_event, { provider, apiKey }) => {
  try {
    const creds = await loadCredentials();
    creds[`${provider}ApiKey`] = apiKey;
    await saveCredentials(creds);
    // Re-initialize transport with new key
    if (provider === 'chutes') {
      chutes = new ChutesE2EETransport({ apiKey });
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('settings:getApiKey', async (_event, { provider }) => {
  try {
    const creds = await loadCredentials();
    return { ok: true, apiKey: creds[`${provider}ApiKey`] || '' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
