/**
 * Electron Main Process
 *
 * - Runs all Chutes API calls in Node.js main to bypass CORS.
 * - Encrypts credentials with safeStorage.
 * - Handles streaming via ReadableStream pump.
 */

import { app, BrowserWindow, ipcMain, safeStorage } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

import { ChutesE2EETransport } from './lib/chutes/ChutesE2EETransport.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;

// ---------------------------------------------------------------------------
// Secure credential storage
// ---------------------------------------------------------------------------

const CREDENTIALS_FILE = path.join(app.getPath('userData'), 'credentials.enc');

async function loadCredentials() {
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
  const data = Buffer.from(JSON.stringify(creds));
  const encrypted = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(JSON.stringify(creds))
    : data;
  await fs.promises.writeFile(CREDENTIALS_FILE, encrypted);
}

// ---------------------------------------------------------------------------
// Transport lifecycle
// ---------------------------------------------------------------------------

let transport = null;

async function getTransport() {
  if (transport) return transport;

  const creds = await loadCredentials();
  const apiKey = process.env.CHUTES_API_KEY || creds.chutesApiKey || '';
  transport = new ChutesE2EETransport({ apiKey });
  return transport;
}

function resetTransport(apiKey) {
  transport = new ChutesE2EETransport({ apiKey });
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
// Streaming helpers
// ---------------------------------------------------------------------------

/**
 * Pump an SSE readable stream into renderer IPC events.
 * Guards against window destruction (race on abort/close).
 */
async function pumpSSE(requestId, readableStream, send, done) {
  const reader = readableStream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done: readerDone, value } = await reader.read();
      if (readerDone) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('data: ')) {
          send({ requestId, data: trimmed.slice(6), done: false });
        }
      }
    }

    // Flush remaining buffer
    if (buffer.trim().startsWith('data: ')) {
      send({ requestId, data: buffer.trim().slice(6), done: false });
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      send({ requestId, error: err.message, done: true });
    }
  } finally {
    reader.releaseLock();
    done(requestId);
  }
}

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------

const activeControllers = new Map(); // requestId -> abort()
const streamingWindows = new Map();  // requestId -> BrowserWindow

/** Send a chunk/error to the renderer for a given request. */
function sendToRenderer(requestId, payload) {
  const win = streamingWindows.get(requestId);
  if (!win || win.isDestroyed()) return false;

  if (payload.error) {
    win.webContents.send('chutes:error', payload);
  } else {
    win.webContents.send('chutes:chunk', payload);
  }
  return true;
}

/** Cleanup a request's state. */
function cleanupRequest(requestId) {
  activeControllers.delete(requestId);
  streamingWindows.delete(requestId);
}

ipcMain.handle('chutes:chat', async (event, { requestId, params }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  streamingWindows.set(requestId, win);

  try {
    const t = await getTransport();
    const { response, abort } = await t.chat(params);
    activeControllers.set(requestId, abort);

    if (params.stream) {
      const send = (p) => sendToRenderer(requestId, p);
      const done = () => {
        sendToRenderer(requestId, { requestId, done: true });
        cleanupRequest(requestId);
      };
      pumpSSE(requestId, response.body, send, () => cleanupRequest(requestId));
      return { ok: true, stream: true };
    }

    const body = await response.json();
    cleanupRequest(requestId);
    return { ok: true, stream: false, body };
  } catch (err) {
    cleanupRequest(requestId);
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('chutes:abort', (_event, { requestId }) => {
  const abort = activeControllers.get(requestId);
  if (abort) {
    abort();
    cleanupRequest(requestId);
  }
});

ipcMain.handle('chutes:models', async () => {
  try {
    const t = await getTransport();
    const models = await t.getModels();
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

    if (provider === 'chutes') {
      resetTransport(apiKey);
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
