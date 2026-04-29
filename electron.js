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
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';

import { ChutesE2EETransport } from './lib/chutes/ChutesE2EETransport.js';
import { DEFAULT_API_BASE, DEFAULT_MODELS_BASE } from './lib/chutes/constants.js';

const require = createRequire(import.meta.url);
const { app, BrowserWindow, clipboard, ipcMain, net, protocol, safeStorage, shell } = require('electron');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const execFile = promisify(execFileCallback);
const rendererUrl = process.env.ELECTRON_RENDERER_URL;
const rendererDistDir = path.join(__dirname, 'renderer', 'dist');
const API_KEY_PROVIDER = 'chutes';
const MAX_API_KEY_LENGTH = 512;
const CREDENTIALS_AAD = Buffer.from('chutes-e2ee-chat.credentials.v2');
const MODEL_STATS_CACHE_TTL_MS = 30 * 60 * 1000;
const MODEL_UTILIZATION_CACHE_TTL_MS = 2 * 60 * 1000;
const MODEL_STATS_LOOKBACK_DAYS = 3;
const CHAT_FALLBACK_MAX_ATTEMPTS = 3;
const CHAT_FALLBACK_MAX_UTILIZATION = 0.9;
const CHAT_FALLBACK_MAX_RATE_LIMIT_RATIO_5M = 0.25;
const WEB_CONTENT_CACHE_TTL_MS = 5 * 60 * 1000;
const WEB_CONTENT_MAX_CONCURRENT = 3;
const WEB_RESPONSE_MAX_BYTES = 5 * 1024 * 1024;   // 5 MB — cap raw HTML from search engine
const JINA_RESPONSE_MAX_BYTES = 1 * 1024 * 1024;    // 1 MB — cap extracted article text

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

function isExternalHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isWslEnvironment() {
  return Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP);
}

async function openExternalUrl(url) {
  if (!isExternalHttpUrl(url)) return;

  if (isWslEnvironment()) {
    try {
      await execFile(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', 'Start-Process -FilePath $args[0]', url],
        { timeout: 4000, windowsHide: true },
      );
      return;
    } catch {
      try {
        await execFile('explorer.exe', [url], { timeout: 4000, windowsHide: true });
      } catch {
        // Avoid Electron's Linux opener in WSL because it emits xdg-open errors.
      }
      return;
    }
  }

  try {
    await shell.openExternal(url);
  } catch {
    // External browser launch failures should not disrupt the chat window.
  }
}

function getErrorMessage(err) {
  return err instanceof Error ? err.message : String(err || 'Unexpected error');
}
// ---------------------------------------------------------------------------
// URL safety   (SSRF guards)
// ---------------------------------------------------------------------------

/** Blocked hostnames that resolve to internal/cloud-metadata endpoints. Always enforced. */
const _BLOCKED_HOSTNAMES = new Set([
  'metadata.google.internal',
  'metadata.goog',
]);
/** CIDR ranges that should never be reachable from web-search fetches. */
const _BLOCKED_CIDRS = [
  '127.0.0.0/8',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '169.254.0.0/16',    // Link-local (cloud metadata)
  '100.64.0.0/10',     // CGNAT / Tailscale / VPN
  '198.18.0.0/15',     // Benchmark/testing
];

let _blockSetCache = null;
function _getBlockedIpSet() {
  if (_blockSetCache) return _blockSetCache;
  const { createRequire } = require('node:module');
  const nodeRequire = createRequire(import.meta.url);
  try {
    const { isInSubnet } = nodeRequire('is-in-subnet');
    _blockSetCache = { isInSubnet };
  } catch {
    // Fallback: bitwise IPv4 CIDR match when the optional dep is absent.
    // Intentionally limited to IPv4; IPv6 literals are handled by regex below.
    _blockSetCache = {
      isInSubnet(addr, cidr) {
        const [net, bits] = cidr.split('/');
        const mask = parseInt(bits, 10);
        const a = addr.split('.').map(Number);
        const n = net.split('.').map(Number);
        if (a.length !== 4 || n.length !== 4 || Number.isNaN(mask)) return false;
        const shifts = 32 - mask;
        const addrInt = (a[0] << 24) | (a[1] << 16) | (a[2] << 8) | a[3];
        const netInt = (n[0] << 24) | (n[1] << 16) | (n[2] << 8) | n[3];
        return (addrInt >>> shifts) === (netInt >>> shifts);
      },
    };
  }
  return _blockSetCache;
}

function _isPrivateIp(hostname) {
  const { isInSubnet } = _getBlockedIpSet();
  for (const cidr of _BLOCKED_CIDRS) {
    try {
      if (isInSubnet(hostname, cidr)) return true;
    } catch { /* malformed CIDR — skip */ }
  }
  return false;
}

/**
 * Return a reason string if a URL should be blocked; return `null` when safe.
 * Guards against SSRF (Server-Side Request Forgery) by rejecting private and
 * link-local addresses before any fetch leaves the main process.
 */
function isUrlUnsafe(urlString) {
  let url;
  try {
    url = new URL(urlString);
  } catch {
    return 'Invalid URL';
  }

  const host = (url.hostname || '').toLowerCase().trim();
  if (!host) return 'Missing hostname';

  // Always-block hostnames (cloud metadata endpoints)
  if (_BLOCKED_HOSTNAMES.has(host)) {
    return `Blocked hostname: ${host}`;
  }

  // Always-block literal IP addresses in private ranges
  if (_isPrivateIp(host)) {
    return `Blocked private IP: ${host}`;
  }

  // Catch-all for IPv6 loopback / link-local and mis-parsed IPv4 reserved ranges.
  if (/^\[?(::1|fc00:|fe80:|fd00:|169\.254\.|127\.|0\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)\]?/i.test(host)) {
    return `Blocked private/reserved address: ${host}`;
  }

  return null;
}



/** Regex that catches common secret prefixes in URLs (exfiltration prevention). */
const _SECRET_PREFIX_RE = /\b(sk-[a-zA-Z0-9_-]{10,}|[0-9a-f]{32,}|api[_-]?key\s*=\s*[a-zA-Z0-9_-]{8,}|token\s*=\s*[a-zA-Z0-9_-]{16,}|password\s*=\s*\S{8,}|secret\s*=\s*\S{8,})/i;

/**
 * Return `true` if a URL's query string or path appears to embed an API key,
 * token, or password — a common exfiltration vector.
 */
function containsExfiltratedSecret(urlString) {
  try {
    const decoded = decodeURIComponent(urlString);
    return _SECRET_PREFIX_RE.test(decoded);
  } catch {
    return false;
  }
}

/**
 * Read a Response body with a hard byte limit.
 * Throws if the body exceeds `maxBytes` so oversized payloads cannot OOM the
 * main process or renderer.
 */
async function readWithLengthLimit(response, maxBytes, label) {
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    if (text.length > maxBytes) {
      throw new Error(`${label} response exceeds ${maxBytes} byte limit.`);
    }
    return text;
  }
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value?.byteLength || 0;
      if (total > maxBytes) {
        throw new Error(`${label} response exceeds ${maxBytes} byte limit.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const decoder = new TextDecoder();
  return chunks.map((c) => decoder.decode(c, { stream: true })).join('') + decoder.decode();
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

    try {
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
    } catch {
      return new Response('Not found', { status: 404 });
    }
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

  win.once('ready-to-show', () => {
    win.maximize();
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isExternalHttpUrl(url)) {
      openExternalUrl(url);
    }
    return { action: 'deny' };
  });

  win.webContents.on('will-navigate', (event, url) => {
    if (isTrustedRendererUrl(url)) return;
    event.preventDefault();
    if (isExternalHttpUrl(url)) {
      openExternalUrl(url);
    }
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
          const data = trimmed.slice(6);
          if (data !== '[DONE]') chunkCount += 1;
          sendToRenderer(requestId, { requestId, data, done: false });
        }
      }
    }

    // Flush remaining buffer
    if (buffer.trim().startsWith('data: ')) {
      const data = buffer.trim().slice(6);
      if (data !== '[DONE]') chunkCount += 1;
      sendToRenderer(requestId, { requestId, data, done: false });
    }

    // Detect completely empty stream (no meaningful chunks)
    if (chunkCount === 0) {
      sendToRenderer(requestId, { requestId, error: 'The model returned an empty response. It may be warming up or at capacity.', done: true });
    } else {
      sendToRenderer(requestId, { requestId, done: true });
    }
  } catch (err) {
    if (err?.name !== 'AbortError') {
      sendToRenderer(requestId, { requestId, error: getErrorMessage(err), done: true });
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

function chatParamsNeedImageInput(params) {
  for (const message of params?.messages || []) {
    const content = message?.content;
    if (!Array.isArray(content)) continue;
    if (content.some((part) => part?.type === 'image_url')) return true;
  }
  return false;
}

function isTransientE2EEError(err) {
  const status = Number(err?.status);
  if ([429, 500, 502, 503, 504].includes(status)) return true;

  const message = getErrorMessage(err);
  return /\b(429|500|502|503|504)\b/.test(message) ||
    /Bad Gateway|rate limited|temporarily unavailable|capacity|warming up/i.test(message);
}

function modelFallbackScore(stats) {
  const activeInstances = finiteNumber(stats?.activeInstanceCount ?? stats?.totalInstanceCount);
  const utilization = finiteNumber(stats?.utilizationCurrent);
  const utilization5m = finiteNumber(stats?.utilization5m);
  const rateLimitRatio5m = finiteNumber(stats?.rateLimitRatio5m);
  const singleInstancePenalty = activeInstances < 2 ? 0.3 : 0;
  const activeInstanceBonus = Math.min(activeInstances, 20) * 0.01;

  return utilization +
    utilization5m * 0.5 +
    rateLimitRatio5m * 2 +
    singleInstancePenalty -
    activeInstanceBonus;
}

async function getFallbackChatModels(transportInstance, params, failedModels) {
  const [metadata, statsResult] = await Promise.all([
    transportInstance.getModelMetadata(),
    fetchModelStats().catch(() => ({})),
  ]);
  const needsImageInput = chatParamsNeedImageInput(params);

  return metadata
    .filter((entry) => {
      if (!entry?.id || failedModels.has(entry.id)) return false;
      if (!entry.confidentialCompute || !entry.id.includes('-TEE')) return false;
      if (!entry.inputModalities?.includes('text') || !entry.outputModalities?.includes('text')) return false;
      if (needsImageInput && !entry.inputModalities?.includes('image')) return false;

      const stats = statsResult[entry.id];
      if (!stats) return true;
      if (finiteNumber(stats.activeInstanceCount ?? stats.totalInstanceCount) <= 0) return false;
      if (finiteNumber(stats.utilizationCurrent) >= CHAT_FALLBACK_MAX_UTILIZATION) return false;
      if (finiteNumber(stats.utilization5m) >= CHAT_FALLBACK_MAX_UTILIZATION) return false;
      if (finiteNumber(stats.rateLimitRatio5m) >= CHAT_FALLBACK_MAX_RATE_LIMIT_RATIO_5M) return false;
      return true;
    })
    .sort((a, b) => {
      const aStats = statsResult[a.id];
      const bStats = statsResult[b.id];
      const scoreDelta = modelFallbackScore(aStats) - modelFallbackScore(bStats);
      if (scoreDelta !== 0) return scoreDelta;
      return a.id.localeCompare(b.id);
    })
    .map((entry) => entry.id);
}

async function clearFailedModelNonceCache(transportInstance, model) {
  try {
    const chuteId = await transportInstance._discovery.resolveChuteId(model);
    transportInstance._discovery.clearNonceCache(chuteId);
  } catch {
    transportInstance._discovery.clearNonceCache();
  }
}

async function chatWithModelFallback(transportInstance, params) {
  const originalModel = params.model;
  const failedModels = new Set();
  const attemptedModels = [];
  let lastError = null;

  for (let attempt = 0; attempt < CHAT_FALLBACK_MAX_ATTEMPTS; attempt += 1) {
    let model = attempt === 0 ? originalModel : null;
    if (!model) {
      model = (await getFallbackChatModels(transportInstance, params, failedModels))[0] || null;
    }
    if (!model || failedModels.has(model)) break;

    attemptedModels.push(model);
    try {
      const result = await transportInstance.chat({ ...params, model });
      if (model !== originalModel) {
        console.warn(`  [fallback] ${originalModel} failed; using ${model}`);
      }
      return { ...result, modelUsed: model, attemptedModels };
    } catch (err) {
      lastError = err;
      failedModels.add(model);
      await clearFailedModelNonceCache(transportInstance, model);
      if (!isTransientE2EEError(err)) throw err;
    }
  }

  if (lastError) {
    const attempted = attemptedModels.length ? ` Tried: ${attemptedModels.join(', ')}.` : '';
    lastError.message = `${getErrorMessage(lastError)}${attempted}`;
    throw lastError;
  }

  throw new Error('No usable TEE model is currently available for E2EE chat.');
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeDuckDuckGoUrl(value) {
  try {
    const decoded = decodeHtmlEntities(value);
    const url = new URL(decoded, 'https://duckduckgo.com');
    const uddg = url.searchParams.get('uddg');
    return uddg ? decodeURIComponent(uddg) : decoded;
  } catch {
    return decodeHtmlEntities(value);
  }
}

function parseDuckDuckGoLiteResults(html) {
  const results = [];
  const seenUrls = new Set();
  let m;

  // Pattern 1: href before class (observed structure on lite.duckduckgo.com)
  const hrefFirst =
    /<a[^>]*?\bhref\s*=\s*["']([^"']+)["'][^>]*?\bclass\s*=\s*["'](?:[^"']*\s)?result-link(?:\s[^"']*)?["'][^>]*>([\s\S]*?)<\/a>/gi;
  while ((m = hrefFirst.exec(html)) !== null) {
    const url = m[1].trim();
    if (!seenUrls.has(url)) {
      seenUrls.add(url);
      results.push({ title: m[2], url, snippet: '' });
    }
  }

  // Pattern 2: class before href (future-proofing)
  const classFirst =
    /<a[^>]*?\bclass\s*=\s*["'](?:[^"']*\s)?result-link(?:\s[^"']*)?["'][^>]*?\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  while ((m = classFirst.exec(html)) !== null) {
    const url = m[1].trim();
    if (!seenUrls.has(url)) {
      seenUrls.add(url);
      results.push({ title: m[2], url, snippet: '' });
    }
  }

  // Collect snippets in document order
  const snippets = [];
  const snippetRe =
    /<td[^>]*?\bclass\s*=\s*["'](?:[^"']*\s)?result-snippet(?:\s[^"']*)?["'][^>]*>([\s\S]*?)<\/td>/gi;
  while ((m = snippetRe.exec(html)) !== null) {
    snippets.push(m[1]);
  }

  // Pair snippets by index
  for (let i = 0; i < results.length && i < snippets.length; i++) {
    results[i].snippet = snippets[i];
  }

  return results
    .map((r) => ({
      title: decodeHtmlEntities(r.title),
      url: normalizeDuckDuckGoUrl(r.url),
      snippet: decodeHtmlEntities(r.snippet),
    }))
    .filter((r) => r.title && r.url);
}

/** In-memory cache for extracted page content (r.jina.ai results). */
let webContentCache = new Map();

async function fetchJinaContent(url, timeoutMs = 8000) {
  // Guard: block URLs targeting private/internal networks (SSRF protection)
  const unsafeReason = isUrlUnsafe(url);
  if (unsafeReason) {
    throw new Error(`Unsafe URL: ${unsafeReason}`);
  }

  // Guard: URLs must not appear to embed secrets (exfiltration prevention)
  if (containsExfiltratedSecret(url)) {
    throw new Error('Blocked: URL appears to contain an embedded secret/token.');
  }

  const now = Date.now();
  const cached = webContentCache.get(url);
  if (cached && now - cached.loadedAt < WEB_CONTENT_CACHE_TTL_MS) {
    return cached.content;
  }
  const jinaUrl = `https://r.jina.ai/http://${encodeURIComponent(url)}`;
  const res = await fetch(jinaUrl, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: 'text/markdown, text/plain, */*' },
  });
  if (!res.ok) {
    return null;
  }
  const text = await readWithLengthLimit(res, JINA_RESPONSE_MAX_BYTES, 'jina.ai');
  if (!text || text.length < 20) {
    return null;
  }
  webContentCache.set(url, { content: text, loadedAt: now });
  return text;
}

/** Clean up stale entries from the web content cache occasionally. */
function pruneWebContentCache() {
  const now = Date.now();
  for (const [key, entry] of webContentCache.entries()) {
    if (now - entry.loadedAt > WEB_CONTENT_CACHE_TTL_MS) {
      webContentCache.delete(key);
    }
  }
}

/** Send a chunk/error to the renderer for a given request. */
function sendToRenderer(requestId, payload) {
  const win = streamingWindows.get(requestId);
  if (!win || win.isDestroyed()) return false;

  try {
    if (payload.error) {
      win.webContents.send('chutes:error', payload);
    } else {
      win.webContents.send('chutes:chunk', payload);
    }
  } catch {
    // Window destroyed between the isDestroyed() check and the send
    return false;
  }
  return true;
}

/** Cleanup a request's state. */
function cleanupRequest(requestId) {
  activeControllers.delete(requestId);
  streamingWindows.delete(requestId);
}

async function readWindowsClipboardImageFromWSL() {
  if (!process.env.WSL_DISTRO_NAME && !process.env.WSL_INTEROP) return null;

  const script = `
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $image = [System.Windows.Forms.Clipboard]::GetImage()
    if ($null -eq $image) { exit 2 }
    $stream = New-Object System.IO.MemoryStream
    try {
      $image.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
      [Convert]::ToBase64String($stream.ToArray())
    } finally {
      $stream.Dispose()
      $image.Dispose()
    }
  `;

  try {
    const { stdout } = await execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-STA', '-Command', script],
      { timeout: 4000, maxBuffer: 64 * 1024 * 1024, windowsHide: true },
    );
    const base64 = String(stdout || '').replace(/\s/g, '');
    if (!base64) return null;
    const buffer = Buffer.from(base64, 'base64');
    if (buffer.length === 0) return null;
    return {
      dataUrl: `data:image/png;base64,${base64}`,
      mimeType: 'image/png',
      size: buffer.byteLength,
      source: 'windows-clipboard',
    };
  } catch {
    return null;
  }
}

ipcMain.handle('chutes:chat', async (event, payload = {}) => {
  const { requestId, params } = payload || {};
  try {
    assertTrustedSender(event);
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) throw new Error('Unable to resolve renderer window.');
    if (typeof requestId !== 'string' || !requestId) throw new Error('Invalid request id.');
    if (!params || typeof params !== 'object') throw new Error('Invalid chat params.');
    streamingWindows.set(requestId, win);

    const t = await getTransport();
    const { response, abort, modelUsed } = await chatWithModelFallback(t, params);
    activeControllers.set(requestId, abort);

    if (params.stream) {
      if (!response.body) throw new Error('Streaming response body is missing.');
      pumpSSE(requestId, response.body, sendToRenderer, cleanupRequest);
      return { ok: true, stream: true, modelUsed };
    }

    const body = await response.json();
    cleanupRequest(requestId);
    return { ok: true, stream: false, body, modelUsed };
  } catch (err) {
    cleanupRequest(requestId);
    return { ok: false, error: getErrorMessage(err) };
  }
});

ipcMain.handle('chutes:abort', (event, payload = {}) => {
  try {
    assertTrustedSender(event);
    const { requestId } = payload || {};
    if (typeof requestId !== 'string' || !requestId) throw new Error('Invalid request id.');
    activeControllers.get(requestId)?.();
    cleanupRequest(requestId);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: getErrorMessage(err) };
  }
});

ipcMain.handle('chutes:models', async (event) => {
  try {
    assertTrustedSender(event);
    const t = await getTransport();
    const metadata = await t.getModelMetadata();
    return { ok: true, models: metadata.map((entry) => entry.id), metadata };
  } catch (err) {
    return { ok: false, error: getErrorMessage(err) };
  }
});

ipcMain.handle('chutes:webSearch', async (event, payload = {}) => {
  const nowIso = new Date().toISOString();
  try {
    assertTrustedSender(event);
    const { query, deepSearch = false } = payload || {};
    const normalizedQuery = typeof query === 'string' ? query.trim() : '';
    if (!normalizedQuery) {
      return {
        ok: false, error: 'Search query is required.', results: [],
        fetchedAt: nowIso, provider: 'DuckDuckGo', deepSearch: false,
        extractedCount: 0, totalResults: 0, errors: 0,
      };
    }

    const searchUrl = 'https://lite.duckduckgo.com/lite/';
    const body = new URLSearchParams();
    body.append('q', normalizedQuery);

    const response = await fetch(searchUrl, {
      method: 'POST',
      signal: AbortSignal.timeout(12_000),
      headers: {
        accept: 'text/html',
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': 'ChutesE2EEChat/1.0',
      },
      body: body.toString(),
    });

    if (!response.ok) {
      return {
        ok: false, error: `Search failed: HTTP ${response.status}`, results: [],
        fetchedAt: nowIso, provider: 'DuckDuckGo', deepSearch: Boolean(deepSearch),
        extractedCount: 0, totalResults: 0, errors: 0,
      };
    }

    const html = await readWithLengthLimit(response, WEB_RESPONSE_MAX_BYTES, 'DuckDuckGo');
    const results = parseDuckDuckGoLiteResults(html).slice(0, 5);

    if (results.length === 0) {
      return {
        ok: true, results: [], fetchedAt: nowIso, provider: 'DuckDuckGo',
        deepSearch: false, extractedCount: 0, totalResults: 0, errors: 0,
      };
    }

    // Base response fields — every success path carries the same shape
    const baseResponse = {
      ok: true,
      results,
      fetchedAt: nowIso,
      provider: 'DuckDuckGo',
      deepSearch: Boolean(deepSearch),
      totalResults: results.length,
    };

    if (!deepSearch) {
      return { ...baseResponse, extractedCount: 0, errors: 0 };
    }

    pruneWebContentCache();
    const limit = Math.min(results.length, WEB_CONTENT_MAX_CONCURRENT);
    let extractedCount = 0;
    let errorCount = 0;
    for (let i = 0; i < limit; i++) {
      try {
        // fetchJinaContent already enforces SSRF and secret-exfil guards
        const article = await fetchJinaContent(results[i].url, 8000);
        if (article) {
          results[i].article = article;
          extractedCount += 1;
        }
      } catch (err) {
        errorCount += 1;
        // Leave article absent; snippet is always present from DDG
      }
    }
    return {
      ...baseResponse,
      extractedCount,
      errors: errorCount,
    };
  } catch (err) {
    return {
      ok: false, error: getErrorMessage(err), results: [],
      fetchedAt: nowIso, provider: 'DuckDuckGo',
      deepSearch: false, extractedCount: 0, totalResults: 0, errors: 0,
    };
  }
});

ipcMain.handle('chutes:modelStats', async (event) => {
  try {
    assertTrustedSender(event);
    const stats = await fetchModelStats();
    return { ok: true, stats };
  } catch (err) {
    return { ok: false, error: getErrorMessage(err) };
  }
});

ipcMain.handle('chutes:clipboardImage', async (event) => {
  try {
    assertTrustedSender(event);
    const image = clipboard.readImage();
    if (!image.isEmpty()) {
      const png = image.toPNG();
      return {
        ok: true,
        hasImage: true,
        dataUrl: image.toDataURL(),
        mimeType: 'image/png',
        size: png.byteLength,
        source: 'electron-clipboard',
      };
    }

    const windowsImage = await readWindowsClipboardImageFromWSL();
    if (!windowsImage) {
      return { ok: true, hasImage: false };
    }

    return {
      ok: true,
      hasImage: true,
      ...windowsImage,
    };
  } catch (err) {
    return { ok: false, error: getErrorMessage(err) };
  }
});

ipcMain.handle('settings:saveApiKey', async (event, payload = {}) => {
  try {
    assertTrustedSender(event);
    const { provider, apiKey } = payload || {};
    assertSupportedProvider(provider);
    const normalizedApiKey = normalizeApiKey(apiKey);
    const creds = await loadCredentials();
    creds.chutesApiKey = normalizedApiKey;
    await saveCredentials(creds);
    setApiKey(normalizedApiKey);
    return { ok: true, ...(await getApiKeyStatus()) };
  } catch (err) {
    return { ok: false, error: getErrorMessage(err) };
  }
});

ipcMain.handle('settings:getApiKeyStatus', async (event, payload = {}) => {
  try {
    assertTrustedSender(event);
    const { provider } = payload || {};
    assertSupportedProvider(provider);
    return { ok: true, ...(await getApiKeyStatus()) };
  } catch (err) {
    return { ok: false, error: getErrorMessage(err) };
  }
});

ipcMain.handle('settings:deleteApiKey', async (event, payload = {}) => {
  try {
    assertTrustedSender(event);
    const { provider } = payload || {};
    assertSupportedProvider(provider);
    const creds = await loadCredentials();
    delete creds.chutesApiKey;

    if (!(await deleteCredentialsFileIfEmpty(creds))) {
      await saveCredentials(creds);
    }

    setApiKey('');
    return { ok: true, ...(await getApiKeyStatus()) };
  } catch (err) {
    return { ok: false, error: getErrorMessage(err) };
  }
});
