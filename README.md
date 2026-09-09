# Chutes E2EE Chat

Chutes E2EE Chat is a desktop chat client for Chutes.ai confidential inference. It combines an Electron main process, a statically exported Next.js renderer, and a small IPC bridge so encrypted Chutes requests run from Node.js instead of the browser.

If you prefer Go + Wails: https://github.com/alex-drocks/chutes-e2ee-chat-go

## Features

- Electron desktop app with a Next.js and Tailwind renderer.
- Chutes.ai E2EE transport in the main process, avoiding browser CORS limits.
- ML-KEM-768 key encapsulation and ChaCha20-Poly1305 authenticated encryption.
- Streaming and non-streaming chat completions.
- Local encrypted API-key storage through Electron `safeStorage`, with an encrypted fallback.
- Model discovery, retry handling, web search support, and clipboard image support.

<img width="3826" height="2054" alt="image" src="https://github.com/user-attachments/assets/fe0d43ba-7bed-4d85-85bf-0c7d0d8ee8af" />

## Security Model

The renderer never receives the saved API key. It calls a narrow preload API, and the Electron main process owns Chutes API calls, encryption, credential storage, and external URL handling.

Electron is configured with `contextIsolation: true`, `nodeIntegration: false`, and `sandbox: true`. External navigation is denied from the renderer and opened through the system browser only after URL validation.

This project is not a substitute for a formal security audit. Review [SECURITY.md](SECURITY.md) before reporting vulnerabilities.

## Requirements

- Windows, macOS, or Linux for development.
- Bun 1.4.2 or newer.
- Node.js 22.12 or newer for tooling compatibility.
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

## GitHub Releases

Release automation lives in `.github/workflows/release.yml`.

Every push to `main`, including a merged pull request, automatically builds and publishes a new Windows release. The workflow chooses the next patch version from the existing Git tags (for example, `v0.2.1` becomes `v0.2.2`), runs the audit and CI tests, and builds the installer and portable executable. It then attaches the executables, blockmap, and `latest.yml` to a **draft** GitHub Release and publishes it only after the uploads succeed. Release runs are serialized to prevent concurrent runs from selecting the same version.

**Do not click “Publish release” before the workflow finishes.** This repository uses immutable releases: GitHub locks their assets at publication. The workflow publishes the release for you. Deleting a published immutable release does not make its version reusable. See [GitHub's immutable release documentation](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases).

To choose a minor, major, or exact version manually:

1. Open [Actions → Release](https://github.com/alex-drocks/chutes-e2ee-chat/actions/workflows/release.yml).
2. Click **Run workflow** and select `main`.
3. Choose `patch`, `minor`, or `major`, or enter an exact **unpublished** version.

Alternatively, push a new version tag to build and publish that commit:

```bash
git tag v0.3.0
git push origin v0.3.0
```

If publication fails after the build, the run's **Artifacts** section still contains a `windows-release-vX.Y.Z` download. An unpublished draft can be retried with its exact version. If the release was already published, use a new version instead.

The Windows executables are currently unsigned, so Windows SmartScreen may warn until a signing certificate is added.

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
Disabled live tests are reported as skipped. When explicitly enabled, they fail if the API key is missing, authentication fails, or no usable E2EE model is available.

## Dependency Audit

```bash
bun audit
```

This repository uses a small `overrides` block in `package.json` to keep transitive packages patched. Electron Builder and its Squirrel helper are pinned to the same tested release.

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
