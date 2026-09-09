import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const fixture = fileURLToPath(new URL('./fixtures/live-runner.mjs', import.meta.url));

function runFixture({ enabled = true, apiKey = 'fixture-key', mode = 'success' } = {}) {
  const result = spawnSync('node', ['--test', '--test-reporter=tap', fixture], {
    env: {
      ...process.env,
      RUN_LIVE_TESTS: enabled ? '1' : '0',
      CHUTES_API_KEY: apiKey,
      LIVE_MODEL: '',
      LIVE_FIXTURE_MODE: mode,
    },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10_000,
  });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return { status: result.status, output: result.stdout + result.stderr };
}

test('disabled live tests are skipped without executing their bodies', () => {
  const { status, output } = runFixture({ enabled: false, apiKey: '' });
  assert.equal(status, 0, output);
  assert.match(output, /# skipped 1/);
  assert.match(output, /# pass 0/);
  assert.doesNotMatch(output, /LIVE_BODY_EXECUTED/);
});

test('enabled live tests fail when the API key is missing', () => {
  const { status, output } = runFixture({ apiKey: '' });
  assert.equal(status, 1, output);
  assert.match(output, /CHUTES_API_KEY is required/);
  assert.match(output, /# fail 1/);
  assert.doesNotMatch(output, /LIVE_BODY_EXECUTED/);
});

test('enabled live tests fail when no usable model is available', () => {
  const { status, output } = runFixture({ mode: 'unavailable' });
  assert.equal(status, 1, output);
  assert.match(output, /No usable live E2EE model was available/);
  assert.match(output, /# fail 1/);
  assert.match(output, /# skipped 0/);
});

test('successful live tests execute and report a real pass', () => {
  const { status, output } = runFixture();
  assert.equal(status, 0, output);
  assert.match(output, /LIVE_BODY_EXECUTED/);
  assert.match(output, /# pass 1/);
  assert.match(output, /# skipped 0/);
});
