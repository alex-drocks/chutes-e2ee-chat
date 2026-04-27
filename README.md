# Chutes E2EE Chat

An Electron.js + Next.js + Tailwind chat application using Chutes.ai's end-to-end encrypted (E2EE) inference with TEE GPU instances.

## Architecture

- **Electron Main Process** — Handles all Chutes E2EE transport (ML-KEM-768, ChaCha20-Poly1305, instance discovery) via Node.js native modules. Zero CORS issues because everything runs server-side in the main process.
- **Electron Preload** — Secure IPC bridge exposing only `chutes.chat()` and `chutes.abort()` to the renderer.
- **Next.js Renderer** — Chat UI built with Next.js Pages Router and Tailwind CSS.

## E2EE Protocol

The app implements the full Chutes.ai E2EE protocol:

- **ML-KEM-768** (FIPS 203) post-quantum key encapsulation via `mlkem`
- **HKDF-SHA256** key derivation via `node:crypto`
- **ChaCha20-Poly1305** authenticated encryption via `@stablelib/chacha20poly1305`
- **Gzip** compression via `node:zlib`

All encrypted requests route through `/e2e/invoke` so only the specific TEE GPU instance can decrypt the prompt.

## Getting Started

```bash
# Install dependencies
bun install

# Development (starts Next.js dev server + Electron)
bun run dev

# Build for production
bun run build

# Start the built renderer
bun run start
```

Use `bun run dev` for day-to-day development. `bun run start` loads the static renderer from `renderer/dist`, so run `bun run build` first when you want to smoke-test the built app.

## Authentication

Set your Chutes API key:

```bash
export CHUTES_API_KEY=cpk_xxx
```

Or add it to `.env`.
