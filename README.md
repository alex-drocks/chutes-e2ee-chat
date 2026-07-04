# Chutes E2EE Chat

Chutes E2EE Chat is a desktop chat client for Chutes.ai confidential inference. It combines an Electron main process, a statically exported Next.js renderer, and a small IPC bridge so encrypted Chutes requests run from Node.js instead of the browser.

## Features

- Electron desktop app with a Next.js and Tailwind renderer.
- Chutes.ai E2EE transport in the main process, avoiding browser CORS limits.
- ML-KEM-768 key encapsulation and ChaCha20-Poly1305 authenticated encryption.
- Streaming and non-streaming chat completions.
- Local encrypted API-key storage through Electron `safeStorage`, with an encrypted fallback.
- Model discovery, retry handling, web search support, and clipboard image support.

## Security Model

The renderer never receives the saved API key. It calls a narrow preload API, and the Electron main process owns Chutes API calls, encryption, credential storage, and external URL handling.

Electron is configured with `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true`. External navigation is denied from the renderer and opened through the system browser only after URL validation.

This project is not a substitute for a formal security audit. Review [SECURITY.md](SECURITY.md) before reporting vulnerabilities.

## Requirements

- Windows, macOS, or Linux for development.
- Bun 1.3.13 or newer.
- Node.js 22 or newer for tooling compatibility.
- A Chutes API key for real chat requests.

## Setup

```bash
bun install
```

For development:

```bash
bun run dev
```

This starts the Next.js renderer on `http://localhost:3000` and then opens Electron against that dev server.

## API Key

Open Settings in the app and paste your Chutes API key. The app stores it encrypted on the local machine.

For live tests only, you can set this in your shell or local `.env`:

```bash
CHUTES_API_KEY=cpk_xxx
```

Do not commit `.env` or real API keys. `.env` is ignored by Git.

## Build

Build the static renderer:

```bash
bun run build
```

Smoke-test the production renderer in Electron:

```bash
bun run start
```

## Package Windows Executables

Create an unpacked app for local testing:

```bash
bun run pack
```

Create distributable Windows executables:

```bash
bun run dist
```

Outputs are written to `release/`:

- `Chutes E2EE Chat Setup 0.1.0.exe`: Windows installer.
- `Chutes E2EE Chat 0.1.0.exe`: portable single-file app.
- `win-unpacked/Chutes E2EE Chat.exe`: unpacked app for debugging. Keep it with the rest of `win-unpacked/`.

`release/` is ignored because these files are generated artifacts.

## Tests

Run fast local tests:

```bash
bun run test:ci
```

Run the full default test suite. Live tests are registered but skip themselves unless explicitly enabled:

```bash
bun test
```

Run live Chutes tests:

```bash
RUN_LIVE_TESTS=1 CHUTES_API_KEY=cpk_xxx bun run test:live
```

Live tests call the Chutes API and may consume account quota.

## Dependency Audit

```bash
bun audit
```

This repository uses a small `overrides` block in `package.json` to keep vulnerable transitive packages patched while preserving the Electron Builder version that works with Bun's module layout.

## Project Structure

```text
electron.js                 Electron main process and Chutes transport bridge
preload.js                  Isolated renderer IPC API
lib/chutes/                 E2EE protocol, discovery, retry, and errors
renderer/                   Next.js renderer workspace
scripts/run-electron.mjs    Development launcher
tests/                      Unit, regression, integration, and live tests
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. See [LICENSE](LICENSE).
