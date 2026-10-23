# OmniMemory Architecture

## Approved baseline

- The Windows PC is the initial authoritative host.
- SQLite with FTS5 is the local source of truth.
- The memory engine owns validation, transactions, provenance, versioning, and history.
- Future REST and MCP adapters must call the same memory engine.
- Memory content is data, not trusted instructions.
- Updates use optimistic concurrency and never silently overwrite a stale version.
- The live SQLite file is not shared over a network.

## Phase 2 implementation

Phase 2 implements only the local persistence layer:

```text
MemoryEngine -> SQLite adapter -> SQLite + FTS5
```

Each write transaction creates or updates the current memory projection, appends an immutable
revision with provenance, updates the current FTS index, and records an append-only activity event.

The database uses a monotonic migration table and WAL mode. Search indexes only the current,
non-deleted record projection. Historical versions remain available through `getMemoryHistory`.

## Deferred after Phase 4

SSE, remote access, encrypted backup, provider adapters, and mobile UI remain later phases.

## Phase 3 implementation

Phase 3 adds an authenticated loopback-only REST boundary:

```text
127.0.0.1 HTTP client
        -> Fastify /api/v1
        -> AuthService + AccessControlService
        -> MemoryEngine
        -> SQLite
```

The service binds only to `127.0.0.1` by default and rejects non-loopback host configuration.
There is no CORS allowlist in this phase; cross-origin browser requests are rejected because the
mobile UI and remote access are not implemented yet.

Authentication is owner-first and device-aware:

- The desktop owner form calls `POST /api/v1/auth/setup/bootstrap` through a narrow Electron IPC
  bridge. The Electron main process supplies the private per-launch startup token.
- The bootstrap route creates the single owner account, first owner device, and first session only
  while no owner exists.
- The legacy `npm run setup-code` plus `POST /api/v1/auth/setup` path remains only for controlled
  recovery or development; it is not used by normal desktop onboarding.
- Passwords use Node's asynchronous `scrypt` implementation with per-password random salts.
- Sessions use random opaque bearer tokens; only SHA-256 token hashes are stored.
- Additional devices use short-lived, single-use enrollment tokens.
- Revoking a device revokes all of its sessions.

Project reads and writes are denied by default. The owner device can access all projects. Other
devices require a project permission (`reader`, `editor`, or `owner`). Cross-project resource
lookups return a generic not-found response.

The Phase 2 nullable global-memory behavior remains available only to owner-level internal
operations. REST memory routes require a project path, so new API-created memories are always
project-scoped.

Security-state changes write append-only records to `security_audit_events`. Domain history in
`activity_events` and synchronization history in `change_log` remain separate concerns.

## Phase 4 implementation

Phase 4 adds a local stdio MCP boundary without creating a second service or database:

```text
stdio MCP client
        -> serveStdio / McpServer
        -> AuthService + AccessControlService
        -> MemoryEngine
        -> SQLite
```

The MCP server authenticates each tool call with the configured OmniMemory bearer token and applies
the same project-scoped permissions as the REST API. It exposes only bounded memory, activity, task,
and handoff operations; arbitrary SQL, shell execution, filesystem access, and remote transports are
not available.

## Phase 5 implementation

Phase 5 adds project-scoped coordination records while keeping one database and one authorization
path:

```text
REST or local stdio MCP client
        -> AuthService + AccessControlService
        -> MemoryEngine + TaskTrackingService
        -> SQLite migrations 1-4
```

Tasks use explicit status transitions and optimistic versions. Terminal task states cannot be reopened.
Handoffs are immutable and distinguish completed claims from evidence-backed verified results. Both
adapters record successful writes in `security_audit_events`; domain tables retain the durable
coordination state.

Agents should read the bounded project context before starting work, then create or update the task
with evidence references as work progresses. When transferring work, they should create an immutable
handoff that names completed work, verified results, blockers, and recommended next steps. A result
is not described as verified unless the handoff includes supporting results or evidence references.

## Phase 6 implementation

Phase 6 adds a browser-native responsive PWA without adding a second server, database, or auth
system:

```text
Browser PWA at 127.0.0.1:3210
        -> allowlisted static assets
        -> authenticated /api/v1 REST routes
        -> AuthService + AccessControlService
        -> MemoryEngine + TaskTrackingService
        -> SQLite
```

The static shell is served from an explicit file allowlist. The browser API client keeps the opaque
bearer session in memory only and clears it on logout or a 401 response. The service worker caches
only same-origin static assets and bypasses every `/api/` request, so private memories, tasks,
handoffs, and credentials are not stored in a shared browser cache. The backend continues to reject
non-loopback host configuration and cross-origin browser requests.

## Phase 7 implementation

Phase 7 adds a Windows-only Electron shell without replacing the PWA or REST boundary:

```text
Electron main process
        -> owned Electron child process
        -> 127.0.0.1 REST/PWA backend
        -> AuthService + AccessControlService
        -> MemoryEngine + TaskTrackingService
        -> SQLite in Electron app.getPath('userData')
```

The main process uses a single-instance lock, starts the compiled backend worker, and waits for a
per-launch startup-token handshake against `/api/v1/health`. A port collision or unrelated loopback
service cannot be silently adopted by the desktop window. The main process stops only the child
process it owns.

Electron 45.0.0 is pinned because it embeds a Node 24 runtime compatible with the repository's
`node:sqlite` requirement. The backend remains separately managed so synchronous SQLite operations
do not run on the Electron UI event loop. Installed assets are resolved from the packaged app, while
the writable database defaults to the per-user application-data directory. `OMNIMEMORY_DB_PATH`
remains an explicit override.

The renderer uses context isolation, disabled Node integration, sandboxing, restricted navigation, and
a single-purpose preload bridge for owner bootstrap. The desktop exposes no filesystem, shell, startup
token, or unrestricted IPC API to the PWA. Browser access continues through the same loopback URL and
the local stdio MCP entry point continues to use the same configured database.
