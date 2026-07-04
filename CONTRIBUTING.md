# Contributing

Thanks for taking the time to improve Chutes E2EE Chat.

## Development Setup

1. Install Bun 1.3.13 or newer.
2. Run `bun install` from the repository root.
3. Run `bun run dev` to start the Next.js renderer and Electron app.

The app does not need a Chutes API key to build or run the local UI, but chat requests require a key configured in the app Settings screen.

## Checks Before Opening A Pull Request

Run these before submitting code:

```bash
bun run test:ci
bun run build
bun audit
```

Use `bun run test:live` only when you intentionally want to hit the Chutes API. It requires `RUN_LIVE_TESTS=1` and `CHUTES_API_KEY` in your local environment.

## Pull Request Guidelines

- Keep changes focused and explain user-visible behavior changes.
- Add or update tests when touching crypto, retry, discovery, IPC, or renderer data flow.
- Do not commit `.env`, release artifacts, generated renderer output, or local credentials.
- Prefer existing project patterns over new abstractions.

## Dependency Changes

This repo uses Bun and commits `bun.lock`. If you change dependencies, run `bun install` and include the lockfile update.
