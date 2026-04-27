/**
 * Electron Main Process
 *
 * - Runs all Chutes API calls in Node.js main to bypass CORS.
 * - Encrypts credentials with OS safeStorage or an app-local file key fallback.
 * - Handles streaming via ReadableStream pump.
 */

import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { ChutesE2EETransport } from './lib/chutes/ChutesE2EETransport.js';
import { DEFAULT_API_BASE, DEFAULT_MODELS_BASE } from './lib/chutes/constants.js';

const require = createRequire(import.meta.url);
const { app, BrowserWindow, ipcMain, net, protocol, safeStorage } = require('electron');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rendererUrl = process.env.ELECTRON_RENDERER_URL;
const rendererDistDir = path.join(__dirname, 'renderer', 'dist');
const API_KEY_PROVIDER = 'chutes';
const MAX_API_KEY_LENGTH = 512;
const CREDENTIALS_AAD = Buffer.from('chutes-e2ee-chat.credentials.v2');
const MODEL_STATS_CACHE_TTL_MS = 30 * 60 * 1000;
const MODEL_UTILIZATION_CACHE_TTL_MS = 2 * 60 * 1000;
const MODEL_STATS_LOOKBACK_DAYS = 3;

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'chutes',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
    },
  },
]);

// ---------------------------------------------------------------------------
// Secure credential storage
// ---------------------------------------------------------------------------

const CREDENTIALS_FILE = path.join(app.getPath('userData'), 'credentials.enc');
const LOCAL_KEY_FILE = path.join(app.getPath('userData'), 'credentials.key');

function getStorageBackend() {
  if (typeof safeStorage.getSelectedStorageBackend !== 'function') {
    return undefined;
  }
  try {
    return safeStorage.getSelectedStorageBackend();
  } catch {
    return undefined;
  }
}

function canUseSafeStorage() {
  const backend = getStorageBackend();
  return safeStorage.isEncryptionAvailable() && backend !== 'basic_text';
}

function getCredentialStorageMode() {
  return canUseSafeStorage() ? 'safeStorage' : 'localFileKey';
}

function assertSupportedProvider(provider) {
  if (provider !== API_KEY_PROVIDER) {
    throw new Error('Unsupported provider. Use "chutes".');
  }
}

function isTrustedRendererUrl(value) {
  try {
    const url = new URL(value);
    if (rendererUrl) {
      return url.origin === new URL(rendererUrl).origin;
    }
    return url.protocol === 'chutes:' && url.hostname === 'renderer';
  } catch {
    return false;
  }
}

function assertTrustedSender(event) {
  const senderUrl = event.senderFrame?.url || event.sender.getURL();
  if (!isTrustedRendererUrl(senderUrl)) {
    throw new Error('Untrusted renderer origin.');
  }
}

function normalizeApiKey(apiKey) {
  if (typeof apiKey !== 'string') {
    throw new Error('API key must be a string.');
  }

  const trimmed = apiKey.trim();
  if (!trimmed) {
    throw new Error('API key is required.');
  }

  if (trimmed.length > MAX_API_KEY_LENGTH) {
    throw new Error('API key is too long.');
  }

  return trimmed;
}

async function loadCredentials() {
  try {
    const stored = await fs.promises.readFile(CREDENTIALS_FILE);
    return await decryptCredentials(stored);
  } catch {
    return {};
  }
}

async function saveCredentials(creds) {
  const payload = JSON.stringify(creds);
  const encrypted = await encryptCredentials(payload);
  await fs.promises.mkdir(path.dirname(CREDENTIALS_FILE), { recursive: true });
  await fs.promises.writeFile(CREDENTIALS_FILE, encrypted, { mode: 0o600 });
  await fs.promises.chmod(CREDENTIALS_FILE, 0o600).catch(() => {});
}

async function encryptCredentials(payload) {
  if (canUseSafeStorage()) {
    return Buffer.from(JSON.stringify({
      version: 2,
      mode: 'safeStorage',
      backend: getStorageBackend(),
      ciphertext: safeStorage.encryptString(payload).toString('base64'),
    }));
  }

  const key = await getLocalEncryptionKey({ create: true });
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(CREDENTIALS_AAD);
  const ciphertext = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.from(JSON.stringify({
    version: 2,
    mode: 'localFileKey',
    alg: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  }));
}

async function decryptCredentials(stored) {
  const text = stored.toString('utf8');
  let envelope;

  try {
    envelope = JSON.parse(text);
  } catch {
    if (!canUseSafeStorage()) return {};
    return JSON.parse(safeStorage.decryptString(stored));
  }

  if (envelope?.version === 2 && envelope.mode === 'safeStorage') {
    if (!canUseSafeStorage()) return {};
    return JSON.parse(safeStorage.decryptString(Buffer.from(envelope.ciphertext, 'base64')));
  }

  if (envelope?.version === 2 && envelope.mode === 'localFileKey') {
    return JSON.parse(await decryptWithLocalKey(envelope));
  }

  if (envelope?.chutesApiKey) {
    await saveCredentials(envelope);
    return envelope;
  }

  return {};
}

async function getLocalEncryptionKey({ create }) {
  try {
    const encoded = (await fs.promises.readFile(LOCAL_KEY_FILE, 'utf8')).trim();
    const key = Buffer.from(encoded, 'base64');
    if (key.length === 32) return key;
  } catch {
    // Create a new local key below only when saving.
  }

  if (!create) {
    throw new Error('Local credential key is missing or invalid.');
  }

  const key = randomBytes(32);
  await fs.promises.mkdir(path.dirname(LOCAL_KEY_FILE), { recursive: true });
  await fs.promises.writeFile(LOCAL_KEY_FILE, key.toString('base64'), { mode: 0o600 });
  await fs.promises.chmod(LOCAL_KEY_FILE, 0o600).catch(() => {});
  return key;
}

async function decryptWithLocalKey(envelope) {
  const key = await getLocalEncryptionKey({ create: false });
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(envelope.iv, 'base64'),
  );
  decipher.setAAD(CREDENTIALS_AAD);
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

async function deleteCredentialsFileIfEmpty(creds) {
  if (Object.keys(creds).length === 0) {
    await fs.promises.rm(CREDENTIALS_FILE, { force: true });
    await fs.promises.rm(LOCAL_KEY_FILE, { force: true });
    return true;
  }
  return false;
}

async function getApiKeyStatus() {
  const creds = await loadCredentials();
  const hasStoredKey = Boolean(creds.chutesApiKey);

  return {
    hasApiKey: hasStoredKey,
    hasStoredKey,
    source: hasStoredKey ? 'stored' : 'none',
    canPersist: true,
    storageMode: getCredentialStorageMode(),
    storageBackend: getStorageBackend(),
    isOsBackedStorage: canUseSafeStorage(),
  };
}

// ---------------------------------------------------------------------------
// Transport lifecycle
// ---------------------------------------------------------------------------

let transport = null;

async function getTransport() {
  if (transport) return transport;

  const creds = await loadCredentials();
  const apiKey = creds.chutesApiKey || '';
  transport = new ChutesE2EETransport({ apiKey, modelsBase: DEFAULT_MODELS_BASE });
  return transport;
}

function setApiKey(apiKey) {
  if (transport) {
    transport.setApiKey(apiKey);
  } else {
    transport = new ChutesE2EETransport({ apiKey, modelsBase: DEFAULT_MODELS_BASE });
  }
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function resolveRendererFile(requestUrl) {
  const url = new URL(requestUrl);
  const pathname = decodeURIComponent(url.pathname || '/index.html');
  const relativePath = path.normalize(pathname).replace(/^[/\\]+/, '') || 'index.html';
  const filePath = path.join(rendererDistDir, relativePath);
  const relativeToDist = path.relative(rendererDistDir, filePath);

  if (relativeToDist.startsWith('..') || path.isAbsolute(relativeToDist)) {
    return null;
  }

  return filePath;
}

function registerStaticRendererProtocol() {
  const contentSecurityPolicy = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' https://api.chutes.ai https://llm.chutes.ai",
  ].join('; ');

  protocol.handle('chutes', async (request) => {
    const filePath = resolveRendererFile(request.url);
    if (!filePath) {
      return new Response('Not found', { status: 404 });
    }

    if (path.extname(filePath) === '.html') {
      const html = await fs.promises.readFile(filePath);
      return new Response(html, {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy': contentSecurityPolicy,
        },
      });
    }

    return net.fetch(pathToFileURL(filePath).toString());
  });
}

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

  if (rendererUrl) {
    win.loadURL(rendererUrl);
    win.webContents.openDevTools();
  } else {
    win.loadURL('chutes://renderer/index.html');
  }

  return win;
}

app.whenReady().then(() => {
  registerStaticRendererProtocol();
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
async function pumpSSE(requestId, readableStream, sendToRenderer, cleanupRequestFn) {
  const reader = readableStream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let chunkCount = 0;

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
          chunkCount += 1;
          sendToRenderer(requestId, { requestId, data: trimmed.slice(6), done: false });
        }
      }
    }

    // Flush remaining buffer
    if (buffer.trim().startsWith('data: ')) {
      chunkCount += 1;
      sendToRenderer(requestId, { requestId, data: buffer.trim().slice(6), done: false });
    }

    // Detect completely empty stream (no meaningful chunks)
    if (chunkCount === 0) {
      sendToRenderer(requestId, { requestId, error: 'The model returned an empty response. It may be warming up or at capacity.', done: true });
    } else {
      sendToRenderer(requestId, { requestId, done: true });
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      sendToRenderer(requestId, { requestId, error: err.message, done: true });
    } else {
      sendToRenderer(requestId, { requestId, done: true });
    }
  } finally {
    reader.releaseLock();
    cleanupRequestFn(requestId);
  }
}

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------

const activeControllers = new Map(); // requestId -> abort()
const streamingWindows = new Map();  // requestId -> BrowserWindow
let historicalModelStatsCache = { loadedAt: 0, value: null, promise: null };
let modelUtilizationCache = { loadedAt: 0, value: null, promise: null };

function toIsoDateDaysAgo(daysAgo) {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - daysAgo);
  return date.toISOString().slice(0, 10);
}

function finiteNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function latestStatsByModel(rows) {
  const stats = {};

  for (const row of rows) {
    if (!row || typeof row.name !== 'string' || row.name === '[private]') continue;

    const current = stats[row.name];
    if (current && String(current.date) >= String(row.date)) continue;

    stats[row.name] = {
      chuteId: row.chute_id,
      name: row.name,
      date: row.date,
      totalRequests: finiteNumber(row.total_requests),
      totalInputTokens: finiteNumber(row.total_input_tokens),
      totalOutputTokens: finiteNumber(row.total_output_tokens),
      averageTps: finiteNumber(row.average_tps),
      averageTtft: finiteNumber(row.average_ttft),
    };
  }

  return stats;
}

function latestUtilizationByModel(rows) {
  const utilization = {};

  for (const row of rows) {
    if (!row || typeof row.name !== 'string' || row.name.startsWith('[private')) continue;

    const current = utilization[row.name];
    if (current && String(current.timestamp) >= String(row.timestamp)) continue;

    utilization[row.name] = {
      chuteId: row.chute_id,
      name: row.name,
      timestamp: row.timestamp,
      activeInstanceCount: finiteNumber(row.active_instance_count ?? row.instance_count),
      totalInstanceCount: finiteNumber(row.total_instance_count ?? row.instance_count),
      utilizationCurrent: finiteNumber(row.utilization_current),
      utilization5m: finiteNumber(row.utilization_5m),
      utilization15m: finiteNumber(row.utilization_15m),
      utilization1h: finiteNumber(row.utilization_1h),
      rateLimitRatio5m: finiteNumber(row.rate_limit_ratio_5m),
      rateLimitRatio15m: finiteNumber(row.rate_limit_ratio_15m),
      rateLimitRatio1h: finiteNumber(row.rate_limit_ratio_1h),
      scalable: Boolean(row.scalable),
      scaleAllowance: finiteNumber(row.scale_allowance),
    };
  }

  return utilization;
}

function mergeModelData(stats, utilization) {
  const merged = { ...stats };

  for (const [name, util] of Object.entries(utilization)) {
    merged[name] = {
      ...(merged[name] || {
        chuteId: util.chuteId,
        name,
        date: '',
        totalRequests: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        averageTps: 0,
        averageTtft: 0,
      }),
      ...util,
    };
  }

  return merged;
}

async function fetchHistoricalModelStats() {
  const now = Date.now();
  if (historicalModelStatsCache.value && now - historicalModelStatsCache.loadedAt < MODEL_STATS_CACHE_TTL_MS) {
    return historicalModelStatsCache.value;
  }

  if (historicalModelStatsCache.promise) {
    return historicalModelStatsCache.promise;
  }

  const startDate = toIsoDateDaysAgo(MODEL_STATS_LOOKBACK_DAYS);
  const endDate = toIsoDateDaysAgo(0);
  const url = new URL('/invocations/stats/llm', DEFAULT_API_BASE);
  url.searchParams.set('start_date', startDate);
  url.searchParams.set('end_date', endDate);

  historicalModelStatsCache.promise = fetch(url, {
    signal: AbortSignal.timeout(12_000),
    headers: { accept: 'application/json' },
  })
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`Stats request failed: HTTP ${response.status}`);
      }
      const body = await response.json();
      const rows = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : [];
      const value = latestStatsByModel(rows);
      historicalModelStatsCache = { loadedAt: Date.now(), value, promise: null };
      return value;
    })
    .catch((err) => {
      historicalModelStatsCache.promise = null;
      throw err;
    });

  return historicalModelStatsCache.promise;
}

async function fetchModelUtilization() {
  const now = Date.now();
  if (modelUtilizationCache.value && now - modelUtilizationCache.loadedAt < MODEL_UTILIZATION_CACHE_TTL_MS) {
    return modelUtilizationCache.value;
  }

  if (modelUtilizationCache.promise) {
    return modelUtilizationCache.promise;
  }

  const url = new URL('/chutes/utilization', DEFAULT_API_BASE);

  modelUtilizationCache.promise = fetch(url, {
    signal: AbortSignal.timeout(12_000),
    headers: { accept: 'application/json' },
  })
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`Utilization request failed: HTTP ${response.status}`);
      }
      const body = await response.json();
      const rows = Array.isArray(body) ? body : Array.isArray(body?.data) ? body.data : [];
      const value = latestUtilizationByModel(rows);
      modelUtilizationCache = { loadedAt: Date.now(), value, promise: null };
      return value;
    })
    .catch((err) => {
      modelUtilizationCache.promise = null;
      throw err;
    });

  return modelUtilizationCache.promise;
}

async function fetchModelStats() {
  const [statsResult, utilizationResult] = await Promise.allSettled([
    fetchHistoricalModelStats(),
    fetchModelUtilization(),
  ]);

  if (statsResult.status === 'rejected' && utilizationResult.status === 'rejected') {
    throw statsResult.reason || utilizationResult.reason;
  }

  const stats = statsResult.status === 'fulfilled' ? statsResult.value : {};
  const utilization = utilizationResult.status === 'fulfilled' ? utilizationResult.value : {};
  return mergeModelData(stats, utilization);
}

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
  try {
    assertTrustedSender(event);
    const win = BrowserWindow.fromWebContents(event.sender);
    streamingWindows.set(requestId, win);

    const t = await getTransport();
    const { response, abort } = await t.chat(params);
    activeControllers.set(requestId, abort);

    if (params.stream) {
      pumpSSE(requestId, response.body, sendToRenderer, cleanupRequest);
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

ipcMain.handle('chutes:abort', (event, { requestId }) => {
  try {
    assertTrustedSender(event);
    activeControllers.get(requestId)?.();
    cleanupRequest(requestId);
  } catch {
    return;
  }
});

ipcMain.handle('chutes:models', async (event) => {
  try {
    assertTrustedSender(event);
    const t = await getTransport();
    const models = await t.getModels();
    return { ok: true, models };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('chutes:modelStats', async (event) => {
  try {
    assertTrustedSender(event);
    const stats = await fetchModelStats();
    return { ok: true, stats };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('settings:saveApiKey', async (event, { provider, apiKey }) => {
  try {
    assertTrustedSender(event);
    assertSupportedProvider(provider);
    const normalizedApiKey = normalizeApiKey(apiKey);
    const creds = await loadCredentials();
    creds.chutesApiKey = normalizedApiKey;
    await saveCredentials(creds);
    setApiKey(normalizedApiKey);
    return { ok: true, ...(await getApiKeyStatus()) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('settings:getApiKeyStatus', async (event, { provider }) => {
  try {
    assertTrustedSender(event);
    assertSupportedProvider(provider);
    return { ok: true, ...(await getApiKeyStatus()) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('settings:deleteApiKey', async (event, { provider }) => {
  try {
    assertTrustedSender(event);
    assertSupportedProvider(provider);
    const creds = await loadCredentials();
    delete creds.chutesApiKey;

    if (!(await deleteCredentialsFileIfEmpty(creds))) {
      await saveCredentials(creds);
    }

    setApiKey('');
    return { ok: true, ...(await getApiKeyStatus()) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
