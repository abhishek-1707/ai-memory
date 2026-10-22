# OmniMemory

OmniMemory is a local-first, provider-independent memory engine for authorized AI agents.
Phase 3 adds a localhost-only authenticated REST API, owner setup, device enrollment/revocation,
project permissions, request validation, rate limiting, audit events, and idempotent memory writes.
Phase 4 adds a local stdio MCP server that reuses the same authentication, authorization, and memory
services. Phase 5 adds project-scoped tasks, explicit status transitions, and immutable agent handoffs.
Phase 6 adds a responsive browser PWA served by the same loopback-only API. Remote MCP access, cloud
sync, backups, and provider integrations remain deferred.

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

The REST contract is documented in `docs/API_AND_MCP.md`. Agents should read project context before
starting work, update task evidence as they proceed, and record an evidence-backed handoff before
transferring work.

## Open the local PWA

Start the loopback-only API from the repository root, then open:

```text
http://127.0.0.1:3210/
```

The PWA uses the existing setup/login endpoints and keeps the bearer session in memory only. It does
not store credentials, cache API responses, or provide an offline write queue. The service worker
caches only the static shell. Access from another computer or phone is not supported in this phase;
the backend remains loopback-only.

## Start the local MCP server

The MCP server uses the same database and an existing OmniMemory bearer session token. Set the token
only in the local process environment; do not put it in a committed file:

```powershell
$env:OMNIMEMORY_DB_PATH = '.\data\omnimemory.sqlite'
$env:OMNIMEMORY_MCP_TOKEN = '<local-session-token>'
npm run mcp
```

The MCP server communicates over stdio only. Its tools are documented in `docs/MCP.md`.

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

## Scope limits for Phase 6

- The REST API is now available on loopback only; it has no remote listener or permissive CORS.
- The MCP server is available through local stdio only; no remote MCP transport is enabled.
- Tasks and handoffs are project-scoped; task status transitions are version-protected and handoffs
  are immutable.
- The PWA is served locally and caches static assets only; private API responses are not cached.
- No remote networking, SSE, cloud sync, or provider adapter.
- No embeddings or external AI API calls.
- Stored content is treated as untrusted text and is never executed.
- General offline write queues and automatic conflict merging are deferred.
