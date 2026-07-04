# Security Policy

## Supported Versions

Security fixes target the `main` branch and the latest tagged release, when releases exist.

## Reporting A Vulnerability

Please do not open a public issue with exploit details, API keys, private prompts, or other sensitive data.

Use GitHub private vulnerability reporting when available:

https://github.com/alex-drocks/chutes-e2ee-chat/security/advisories/new

If private reporting is unavailable, open a public issue asking for a private contact path and include only a high-level description.

## Sensitive Data

Never include real Chutes API keys, `.env` contents, encrypted credential files, or user prompt data in bug reports. The Electron app stores user API keys locally through the operating-system-backed credential path or an app-local encrypted fallback.
