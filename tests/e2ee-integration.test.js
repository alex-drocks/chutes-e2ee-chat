/**
 * Standalone E2EE integration test.
 *
 * Tests the Node.js E2EE transport directly — no Electron needed.
 *
 * Usage:
 *   RUN_LIVE_TESTS=1 CHUTES_API_KEY=*** node tests/e2ee-integration.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'dotenv/config';

import { ChutesE2EETransport } from '../lib/chutes/ChutesE2EETransport.js';

const API_KEY = process.env.CHUTES_API_KEY || '';
const ENABLED = process.env.RUN_LIVE_TESTS === '1';
const NON_REASONING_MODEL = 'Qwen/Qwen3-32B-TEE';
const REASONING_MODEL = 'moonshotai/Kimi-K2.5-TEE';

const SKIP_MSG = 'Skipped — set CHUTES_API_KEY and RUN_LIVE_TESTS=1 to run integration tests.';

test('(live) should discover available TEE models', async () => {
  if (!ENABLED) {
    console.log(SKIP_MSG);
    return;
  }
  const transport = new ChutesE2EETransport({ apiKey: API_KEY });
  const models = await transport.getModels();
  assert.ok(models.length > 0, 'expected at least one model');
  assert.ok(models.some((m) => m.includes('TEE')), 'expected at least one TEE model');
  console.log('  Found models:', models.slice(0, 5));
});

test('(live) should complete a non-streaming chat completion', async () => {
  if (!ENABLED) return;
  const transport = new ChutesE2EETransport({ apiKey: API_KEY });
  const { response } = await transport.chat({
    model: NON_REASONING_MODEL,
    messages: [{ role: 'user', content: 'Say exactly "encryption confirmed"' }],
    stream: false,
    max_tokens: 20,
  });

  assert.strictEqual(response.status, 200);
  const body = await response.json();
  const text = body.choices?.[0]?.message?.content || '';
  assert.ok(text.toLowerCase().includes('confirmed'), `unexpected response: ${text}`);
  console.log('  Non-streaming response:', text.slice(0, 60));
});

test('(live) should stream a chat completion with valid SSE chunks', async () => {
  if (!ENABLED) return;
  const transport = new ChutesE2EETransport({ apiKey: API_KEY });
  const { response } = await transport.chat({
    model: NON_REASONING_MODEL,
    messages: [{ role: 'user', content: 'Count: one two three' }],
    stream: true,
    max_tokens: 15,
  });

  assert.strictEqual(response.status, 200);
  const ct = response.headers.get('content-type');
  assert.ok(ct?.includes('text/event-stream'), `expected SSE, got ${ct}`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let dataLines = 0;

  for (let i = 0; i < 20; i++) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (line.trim().startsWith('data:')) dataLines++;
    }
  }
  reader.releaseLock();
  assert.ok(dataLines > 0, 'expected at least one SSE data line');
  console.log('  Streaming chunks received:', dataLines);
});

test('(live) should handle a reasoning model (Kimi)', async () => {
  if (!ENABLED) return;
  const transport = new ChutesE2EETransport({ apiKey: API_KEY });
  const { response } = await transport.chat({
    model: REASONING_MODEL,
    messages: [{ role: 'user', content: 'Confirm E2EE works, one word.' }],
    stream: false,
    max_tokens: 30,
  });

  assert.strictEqual(response.status, 200);
  const body = await response.json();
  const msg = body.choices?.[0]?.message;
  const text = msg?.content || msg?.reasoning_content;
  assert.ok(text, 'neither content nor reasoning_content present');
  assert.ok(typeof text === 'string' && text.length > 2, 'response too short');
  console.log('  Reasoning model response:', text.slice(0, 60));
});
