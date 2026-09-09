import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { YAML } from 'bun';

const workflow = YAML.parse(readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'));
const steps = workflow.jobs.windows.steps;
const script = name => steps.find(step => step.name === name).run;

// Run the actual workflow PowerShell against fake Git/GitHub commands and files.
// No tags, releases, or network requests are created by these tests.
function runStep(name, { env = {}, setup = () => {}, before = '' } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'chutes-release-test-'));
  try {
    setup(directory);
    const scriptPath = join(directory, 'step.ps1');
    const outputPath = join(directory, 'output.txt');
    writeFileSync(outputPath, '');
    writeFileSync(scriptPath, `$ErrorActionPreference = 'Stop'\n${before}\n${script(name)}`);
    const result = spawnSync(process.platform === 'win32' ? 'powershell.exe' : 'pwsh',
      ['-NoProfile', '-NonInteractive', '-File', scriptPath], {
        cwd: directory,
        env: { ...process.env, GITHUB_OUTPUT: outputPath, ...env },
        encoding: 'utf8', windowsHide: true, timeout: 15_000,
      });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    // Windows PowerShell's append redirection uses UTF-16; pwsh uses UTF-8.
    const bytes = readFileSync(outputPath);
    const output = bytes.toString(bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf16le' : 'utf8').replace(/^\uFEFF/, '');
    return {
      status: result.status,
      log: result.stdout + result.stderr,
      outputs: Object.fromEntries(output.trim().split(/\r?\n/).filter(Boolean).map(line => line.split('='))),
    };
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('chutes-release-test-'));
    rmSync(directory, { recursive: true, force: true });
  }
}

function resolveVersion(env = {}) {
  return runStep('Resolve release version', {
    env: {
      RELEASE_EVENT: 'push', RELEASE_REF_TYPE: 'branch', RELEASE_REF_NAME: 'main',
      RELEASE_INPUT_VERSION: '', RELEASE_INPUT_BUMP: '',
      FIXTURE_FETCH_EXIT: '0', FIXTURE_TAGS: 'v0.2.1,v0.2.0,v0.1.0',
      ...env,
    },
    before: `
function git {
  $global:LASTEXITCODE = 0
  switch ($args[0]) {
    'fetch' { $global:LASTEXITCODE = [int] $env:FIXTURE_FETCH_EXIT }
    'tag' { if ($env:FIXTURE_TAGS) { $env:FIXTURE_TAGS.Split(',') } }
    'rev-parse' {
      if ($args[-1] -notin @($env:FIXTURE_TAGS.Split(',') | ForEach-Object { "refs/tags/$_" })) {
        $global:LASTEXITCODE = 1
      }
    }
    default { throw "Unexpected git command: $args" }
  }
}`,
  });
}

test('main pushes trigger serialized release runs', () => {
  assert.ok(workflow.on.push.branches.includes('main'));
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  assert.equal(workflow.concurrency.group, 'release');
});

test('a main push automatically selects the next patch after the highest tag', () => {
  const result = resolveVersion();
  assert.equal(result.status, 0, result.log);
  assert.deepEqual(result.outputs, { version: '0.2.2', tag: 'v0.2.2', create_tag: 'true' });
});

for (const [bump, version] of [['minor', '0.3.0'], ['major', '1.0.0']]) {
  test(`manual ${bump} releases still use the requested bump`, () => {
    const result = resolveVersion({ RELEASE_EVENT: 'workflow_dispatch', RELEASE_INPUT_BUMP: bump });
    assert.equal(result.status, 0, result.log);
    assert.deepEqual(result.outputs, { version, tag: `v${version}`, create_tag: 'true' });
  });
}

test('a tag push builds its exact version without creating another tag', () => {
  const result = resolveVersion({ RELEASE_REF_TYPE: 'tag', RELEASE_REF_NAME: 'v0.3.0' });
  assert.equal(result.status, 0, result.log);
  assert.deepEqual(result.outputs, { version: '0.3.0', tag: 'v0.3.0', create_tag: 'false' });
});

test('a manual retry keeps the existing version and tag', () => {
  const result = resolveVersion({ RELEASE_EVENT: 'workflow_dispatch', RELEASE_INPUT_VERSION: '0.2.1' });
  assert.equal(result.status, 0, result.log);
  assert.deepEqual(result.outputs, { version: '0.2.1', tag: 'v0.2.1', create_tag: 'false' });
});

test('a failed tag refresh cannot allocate a release version', () => {
  const result = resolveVersion({ FIXTURE_FETCH_EXIT: '1' });
  assert.notEqual(result.status, 0);
  assert.match(result.log, /Could not refresh release tags/);
  assert.deepEqual(result.outputs, {});
});

test('manual version input is validated as data', () => {
  const result = resolveVersion({ RELEASE_EVENT: 'workflow_dispatch', RELEASE_INPUT_VERSION: '$(throw "executed input")' });
  assert.notEqual(result.status, 0);
  assert.match(result.log, /must use MAJOR.MINOR.PATCH format/);
  assert.deepEqual(result.outputs, {});
});

const assetNames = [
  'Chutes E2EE Chat 0.2.2.exe', 'Chutes E2EE Chat Setup 0.2.2.exe',
  'Chutes E2EE Chat Setup 0.2.2.exe.blockmap', 'latest.yml',
];
for (const missing of [null, ...assetNames]) {
  test(missing ? `release publication requires ${missing}` : 'a complete Windows artifact set passes validation', () => {
    const result = runStep('List release files', {
      env: { RELEASE_VERSION: '0.2.2' },
      setup(directory) {
        mkdirSync(join(directory, 'release'));
        for (const name of assetNames) {
          if (name !== missing) writeFileSync(join(directory, 'release', name), 'fixture');
        }
      },
    });
    if (missing) {
      assert.notEqual(result.status, 0);
      assert.match(result.log, /Refusing to publish an incomplete release/);
    } else {
      assert.equal(result.status, 0, result.log);
    }
  });
}
