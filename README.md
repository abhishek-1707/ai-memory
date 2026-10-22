# OmniMemory

OmniMemory is a local-first, provider-independent memory engine for authorized AI agents.
Phase 3 adds a localhost-only authenticated REST API, owner setup, device enrollment/revocation,
project permissions, request validation, rate limiting, audit events, and idempotent memory writes.
Phase 4 adds a local stdio MCP server that reuses the same authentication, authorization, and memory
services. Phase 5 adds project-scoped tasks, explicit status transitions, and immutable agent handoffs.
Phase 6 adds a responsive browser PWA served by the same loopback-only API. Phase 7 adds a Windows
Electron desktop application that manages the same backend and opens the same PWA in an integrated
window. Remote MCP access, cloud sync, backups, and provider integrations remain deferred.

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

## Use the Windows desktop application

Phase 7 packages OmniMemory as a per-user Windows Electron application. The desktop main process
starts the existing Fastify backend as an owned child process, waits for a private readiness
handshake, and then loads the existing PWA. The renderer has context isolation, no Node.js
integration, and no filesystem bridge. The backend remains bound to `127.0.0.1`.

The production database defaults to Electron's per-user `app.getPath('userData')` directory, normally
`%APPDATA%\OmniMemory\omnimemory.sqlite`. The installer never places the authoritative database in
the installation directory, and uninstall/update does not delete application data. An explicit
`OMNIMEMORY_DB_PATH` override remains available for controlled procedures.

Build the Windows executable directory and NSIS installer from a Windows development environment:

```powershell
npm run desktop:build:dir
npm run desktop:build
```

The expected artifacts are `artifacts-v2\win-unpacked\OmniMemory.exe` and
`artifacts-v2\OmniMemory-0.1.0-x64-Setup.exe`. After installing, use **File > Open in Browser** to open
the same loopback UI in the default browser. The current phase does not support phones, LAN access,
or remote MCP. See `docs/DESKTOP.md` for data paths, upgrade precautions, and smoke testing.

The packaging build and embedded-runtime smoke checks have been completed in the development
environment. The actual Windows executable and NSIS installer must still be installed and launched
on Windows before they are treated as fully validated. Run the Windows-only smoke check after the
build:

```powershell
npm run desktop:smoke
```

This smoke check uses a temporary database and port; it does not modify the authoritative database.

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

## Public website

OmniMemory includes a dedicated, production-ready static marketing website in `site/` that is kept
strictly isolated from the private authenticated PWA and database.

Preview the public website locally:

```powershell
npm run site:preview
```

Open `http://127.0.0.1:4173/` in your browser.

Build and validate the static website distribution:

```powershell
npm run site:build
```

The output bundle is exported to `dist-site/`. See `docs/WEBSITE.md` for hosting instructions,
release publishing, and download URL configuration.

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

## Scope limits for Phase 7

- The desktop package is Windows x64 only and uses the pinned Electron runtime.
- The desktop backend is loopback-only and rejects foreign browser origins as before.
- No remote networking, cross-device access, public listener, router configuration, or remote MCP was
  added.
- Production data stays in the per-user application-data directory; the installer does not migrate,
  replace, or delete an existing database automatically.
- Packaged installer and executable validation requires a Windows launch environment. Do not treat a
  cross-built artifact as validated until it has been installed and launched outside the repository.
