# OmniMemory

OmniMemory is a local-first, provider-independent memory engine for authorized AI agents.
Phase 3 adds a localhost-only authenticated REST API, owner setup, device enrollment/revocation,
project permissions, request validation, rate limiting, audit events, and idempotent memory writes.
Remote access, MCP, mobile UI, backups, and provider integrations remain deferred.

## Requirements

- Windows, macOS, or Linux
- Node.js 24 or newer
- npm

Node 24 is required because Phase 2 uses the built-in `node:sqlite` module, avoiding a native
database dependency while keeping the authoritative store local.

## Setup on Windows

From PowerShell in the repository root:

```powershell
npm install
npm run typecheck
npm run lint
npm test
```

The default database path is `data/omnimemory.sqlite`. Override it for a local run with:

```powershell
$env:OMNIMEMORY_DB_PATH = '.\data\omnimemory.sqlite'
```

The database directory and SQLite files are ignored by Git.

## Start the local API

Generate the one-time first-run setup code:

```powershell
npm run setup-code
```

The code is printed once and only its hash is stored. Start the loopback-only API:

```powershell
npm start
```

The API listens on `http://127.0.0.1:3210` by default. It will not bind to a non-loopback host in
Phase 3.

Use `POST /api/v1/auth/setup` with the setup code, a password of at least 12 characters, and the
initial device name/type. The response contains the initial opaque bearer token once. Store it in
the authorized client; it is never returned again.

The REST contract is documented in `docs/API_AND_MCP.md`.

## Development demonstration

```powershell
npm run demo
```

The demonstration creates or reuses a synthetic `OmniMemory Demo` project, creates a SQLite
memory record, searches it, retrieves it, updates it with optimistic versioning, prints history,
closes the database, reopens it, and verifies persistence.

## Checks

```powershell
npm run typecheck
npm run lint
npm run format:check
npm test
npm run demo
```

## Scope limits for Phase 3

- The REST API is now available on loopback only; it has no remote listener or permissive CORS.
- No remote networking, SSE, PWA, MCP transport, or provider adapter.
- No embeddings or external AI API calls.
- Stored content is treated as untrusted text and is never executed.
- General offline write queues and automatic conflict merging are deferred.
