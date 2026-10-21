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

- `npm run setup-code` creates a short-lived one-time setup code and stores only its hash.
- `POST /api/v1/auth/setup` creates the single owner account, first owner device, and first session.
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
the same project-scoped permissions as the REST API. It exposes only bounded memory and activity
operations; arbitrary SQL, shell execution, filesystem access, and remote transports are not
available.
