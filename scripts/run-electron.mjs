import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const electronPath = require('electron');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const args = [];
for (const arg of process.argv.slice(2)) {
  if (arg.startsWith('--renderer-url=')) {
    env.ELECTRON_RENDERER_URL = arg.slice('--renderer-url='.length);
  } else {
    args.push(arg);
  }
}

const child = spawn(electronPath, args.length ? args : ['.'], {
  env,
  stdio: 'inherit',
  windowsHide: false,
});

let childClosed = false;
child.on('close', (code, signal) => {
  childClosed = true;
  if (code === null) {
    console.error(`${electronPath} exited with signal ${signal}`);
    process.exit(1);
  }
  process.exit(code);
});

for (const signal of ['SIGINT', 'SIGTERM', 'SIGUSR2']) {
  process.on(signal, () => {
    if (!childClosed) child.kill(signal);
  });
}
