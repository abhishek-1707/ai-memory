# OmniMemory Project Documentation

**Documentation snapshot:** October 23, 2026
**Repository:** `D:\aimemory`
**Application:** OmniMemory 0.1.0
**Primary platform:** Windows x64 desktop application, with cross-platform local development support

This document is the consolidated project guide. It explains what OmniMemory does, how the repository
is organized, how data and security work, how to run each interface, how to build the desktop package,
and what remains unvalidated.

The source documentation remains split by concern in `docs/`. This document is intentionally broader
and is suitable for onboarding a maintainer, operator, or agent who needs the whole system picture.

## Contents

1. [Product summary](#product-summary)
2. [Capabilities](#capabilities)
3. [Repository map](#repository-map)
4. [Architecture](#architecture)
5. [Memory model](#memory-model)
6. [Projects, tasks, and handoffs](#projects-tasks-and-handoffs)
7. [Authentication and authorization](#authentication-and-authorization)
8. [First-run desktop onboarding](#first-run-desktop-onboarding)
9. [REST API](#rest-api)
10. [Browser PWA](#browser-pwa)
11. [Local MCP integration](#local-mcp-integration)
12. [SQLite database and migrations](#sqlite-database-and-migrations)
13. [Configuration](#configuration)
14. [Desktop runtime and packaging](#desktop-runtime-and-packaging)
15. [Public marketing website](#public-marketing-website)
16. [Security model](#security-model)
17. [Installation and operating procedures](#installation-and-operating-procedures)
18. [Testing and verification](#testing-and-verification)
19. [Current deliverables](#current-deliverables)
20. [Limitations and deferred work](#limitations-and-deferred-work)
21. [Maintainer checklist](#maintainer-checklist)

## Product summary

OmniMemory is a local-first memory and coordination system for authorized AI agents. It keeps the
authoritative store in SQLite on the local machine and exposes several controlled interfaces over the
same service layer:

- An authenticated loopback-only REST API.
- A responsive browser PWA served by that API.
- A local stdio MCP server for coding agents.
- A Windows Electron desktop shell that owns and supervises the backend process.
- A separate static public marketing website.

The system is intentionally provider-independent. It does not call external AI APIs, does not sync
to a cloud service, does not expose a LAN listener, and does not provide remote MCP transport.

The authoritative design principle is:

> Memory, authorization, validation, persistence, and history live in shared local services. REST,
> PWA, MCP, and Electron are adapters around those services rather than separate implementations.

## Capabilities

### Memory and knowledge

- Create and manage projects.
- Store project-scoped memories with typed records.
- Store provenance for every memory revision.
- Search current records with SQLite FTS5 lexical search.
- Keep immutable revision history.
- Reject stale updates using optimistic version checks.
- Record memory-domain activity and commit sequencing.
- Enforce idempotent writes for safe retries.
- Reject high-confidence secret-shaped text before persistence.

### Coordination

- Create project-scoped tasks.
- Track task status and priority.
- Enforce a permitted status-transition graph.
- Protect task edits with optimistic versions.
- Store task evidence references and linked memory IDs.
- Create immutable agent handoffs.
- Separate completed work, verified results, blockers, next steps, and evidence.
- Require evidence for verified or partially verified handoffs.

### Identity and access

- Create exactly one initial owner account.
- Hash passwords with asynchronous Node `scrypt`.
- Create device identities separately from sessions.
- Use opaque bearer sessions with hashed storage.
- Support device enrollment, role changes, revocation, and session expiry.
- Support project-level reader, editor, and owner permissions.
- Keep global owner access separate from project membership.
- Record security outcomes in an append-only audit table.

### Desktop

- Start the backend automatically.
- Keep the backend bound to `127.0.0.1`.
- Require a private per-launch startup-token readiness handshake.
- Refuse to adopt an unrelated service occupying the configured port.
- Store production data under Electron `userData`, outside installed binaries.
- Preserve application data during uninstall and update.
- Create the first owner directly in the desktop UI without a setup code.
- Use a narrow, context-isolated IPC bridge only for first-owner bootstrap.

## Repository map

```text
D:\aimemory\
├── README.md                         Main quick-start guide
├── package.json                      Scripts, dependencies, Electron Builder config
├── package-lock.json                 Locked dependency graph
├── tsconfig.json                     TypeScript compiler configuration
├── vitest.config.ts                  Test configuration
├── public/                           Private authenticated PWA shell
├── site/                             Public marketing website source
├── src/
│   ├── api/                          Fastify REST API and static asset routes
│   ├── database/                     SQLite connection and migrations
│   ├── desktop/                      Backend worker, runtime paths, diagnostics, lifecycle
│   ├── electron/                     Electron main process and preload bridge
│   ├── memory/                       Memory domain engine and validation
│   ├── mcp/                          Local MCP server and schemas
│   ├── security/                     Auth, tokens, passwords, access control, audit
│   └── tasks/                        Tasks, transitions, and immutable handoffs
├── scripts/
│   ├── demo.ts                       Persistence demonstration
│   ├── mcp-stdio.ts                  MCP stdio entry point
│   ├── desktop-smoke.ts              Windows-only packaged smoke test
│   ├── create-setup-code.ts          Legacy controlled recovery helper
│   ├── preview-site.ts                Local marketing-site preview server
│   └── build-site.ts                 Static marketing-site build and validation
├── tests/                            API, desktop, MCP, PWA, memory, task, and site tests
├── docs/                             Detailed subsystem documentation
└── installer/                        Locally generated installer output, ignored by Git
```

The `installer/` directory is intentionally ignored because installers and block maps are generated
artifacts. The current installer is documented in [Current deliverables](#current-deliverables).

## Architecture

### Shared service graph

```text
Electron main process ─┐
Browser PWA ───────────┼─> Fastify REST API
Local MCP stdio ──────┘          │
                                 ├─> AuthService
                                 ├─> AccessControlService
                                 ├─> MemoryEngine
                                 ├─> TaskTrackingService
                                 ├─> AuditService
                                 └─> SQLite + FTS5
```

The Electron backend worker is a separately managed child process. This prevents synchronous
`node:sqlite` work from blocking the Electron UI event loop.

### Runtime boundaries

- **Database:** one authoritative SQLite database per installation/configuration.
- **REST:** `/api/v1`, loopback-only, authenticated except for narrowly defined public setup/status,
  health, login, recovery, and desktop bootstrap boundaries.
- **PWA:** static assets served from an explicit allowlist by Fastify.
- **MCP:** stdio only; no HTTP transport or remote listener.
- **Electron:** owns the backend child, supplies environment configuration, and supervises readiness.
- **Website:** separate static files in `site/`; no access to private app data or APIs.

### Phase history

| Phase | Delivered capability                                                                    |
| ----: | --------------------------------------------------------------------------------------- |
|     2 | SQLite memory engine, FTS5, provenance, revisions, activity, migrations                 |
|     3 | Loopback REST API, authentication, project permissions, validation, rate limits, audits |
|     4 | Local stdio MCP server reusing the same services                                        |
|     5 | Tasks, status transitions, optimistic versions, immutable handoffs                      |
|     6 | Responsive PWA and static-shell service worker                                          |
|     7 | Windows Electron shell, packaged backend, data-path protection, desktop onboarding      |

## Memory model

### Record types

Memory records use one of:

- `profile`
- `project_fact`
- `finding`
- `constraint`
- `requirement`
- `note`

### Provenance

Each memory revision has provenance fields:

- `sourceKind`: `user_provided`, `file_observed`, `system_observed`, `agent_inferred`, or
  `test_result`.
- Optional source reference.
- Verification status: `unverified`, `user_confirmed`, `test_verified`, `superseded`, or `disputed`.
- Optional verification method.
- Optional observed timestamp.

### Revisions and concurrency

The current memory projection is separate from immutable revisions. Updates require
`expectedVersion`; a stale version is rejected rather than silently overwritten.

Memory creation and update transactions can reserve an idempotency key. Repeating the same request
returns the original result; reusing the key with different input returns a conflict.

### Search

SQLite FTS5 indexes the current memory projection. Historical revisions remain available through the
history route but are not treated as current search results.

## Projects, tasks, and handoffs

### Projects

Projects are the primary authorization boundary for ordinary devices. The owner device can access
all projects. Other devices need a project permission.

### Task statuses

```text
todo -> in_progress | blocked | cancelled
in_progress -> todo | blocked | completed | cancelled
blocked -> in_progress | cancelled
completed -> terminal
cancelled -> terminal
```

Every accepted transition records a status-history row with the actor, note, source status,
destination status, and resulting version.

### Task priorities

`low`, `normal`, `high`, and `urgent` are supported.

### Handoffs

Handoffs are immutable. A handoff may link a task, destination device, memories, and other tasks. It
stores:

- Summary.
- Completed work.
- Verified results.
- Blockers.
- Next steps.
- Evidence references.
- Verification status.

Verified and partially verified handoffs require supporting results or evidence references.

## Authentication and authorization

### Passwords

Passwords are never stored in plaintext. The implementation uses asynchronous Node `scrypt` with:

- Derived-key length: 64 bytes.
- Random 16-byte salt.
- Default cost parameters encoded with the stored hash.
- Timing-safe verification.

The API requires at least 12 characters for owner creation and password changes.

### Sessions

Sessions use random opaque bearer tokens. The raw token is returned only when a session is created.
Only a SHA-256 hash is stored in `sessions`.

Each session has:

- Absolute expiry.
- Idle expiry.
- Last-seen time.
- Revocation state.
- Device association.

The browser client stores the raw token only in JavaScript memory. Logout and protected-route 401
responses clear it.

### Devices and roles

Global device roles:

- `owner`: initial owner device with global project access.
- `admin`: device-management capability; content still requires project membership.
- `member`: project-scoped access only.

Project permission roles:

- `reader`: read/search/history.
- `editor`: reader plus memory/activity/task/handoff writes.
- `owner`: editor plus project membership management.

Revoking a device revokes its sessions. Changing the owner device role is prohibited.

### Audit logging

Security events are append-only and include identifiers, outcomes, request IDs, and safe metadata.
Passwords, bearer tokens, setup codes, memory bodies, and internal exception details are not logged.

## First-run desktop onboarding

### Normal flow

For a new installation with no row in `owner_accounts`:

1. Electron starts the owned backend worker.
2. The backend completes the private startup-token health handshake.
3. The PWA calls `GET /api/v1/auth/setup/status`.
4. The UI renders **Create your OmniMemory account**.
5. The user enters a password, confirmation, device name, and device type.
6. The renderer invokes the narrow `omnimemory:create-owner` preload channel.
7. Electron main verifies the renderer origin and submits the request with the startup token.
8. `POST /api/v1/auth/setup/bootstrap` validates the request and opens a transaction.
9. The transaction creates the owner account, owner device, session, and audit event.
10. The session is returned to the renderer and held in memory.
11. The UI loads projects and navigates to the dashboard.

### Security properties

- The bootstrap route requires the per-launch startup token.
- The token is created in Electron main and is not exposed through preload.
- A normal browser cannot call the bootstrap route without the token.
- The operation is allowed only while no owner exists.
- Concurrent creation attempts cannot replace the owner.
- Existing setup-code rows are not deleted, reset, or consumed by bootstrap.

### Legacy recovery

`npm run setup-code` and `POST /api/v1/auth/setup` remain for controlled recovery/development. This
path is not used by the normal desktop UI. A legacy setup-code row is retained for database
compatibility and is not required for ordinary first-run onboarding.

## REST API

The API base path is `/api/v1`. Responses use:

```json
{
  "data": {},
  "meta": { "requestId": "..." }
}
```

Errors use:

```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Authentication required",
    "requestId": "..."
  }
}
```

### Authentication routes

```text
GET  /api/v1/auth/setup/status
POST /api/v1/auth/setup                 Legacy recovery/development setup-code path
POST /api/v1/auth/setup/bootstrap       Electron-only first-owner path
POST /api/v1/auth/login
POST /api/v1/auth/password
POST /api/v1/auth/logout
GET  /api/v1/auth/me
POST /api/v1/auth/enrollments
POST /api/v1/auth/enrollments/claim
```

### Device and permission routes

```text
GET    /api/v1/devices
POST   /api/v1/devices/:id/revoke
PATCH  /api/v1/devices/:id/role
PUT    /api/v1/devices/:id/projects/:projectId
DELETE /api/v1/devices/:id/projects/:projectId
```

### Memory and project routes

```text
GET   /api/v1/projects
POST  /api/v1/projects
GET   /api/v1/projects/:projectId
GET   /api/v1/projects/:projectId/context
GET   /api/v1/projects/:projectId/memories/search
GET   /api/v1/projects/:projectId/memories/recent
POST  /api/v1/projects/:projectId/memories
GET   /api/v1/projects/:projectId/memories/:memoryId
PATCH /api/v1/projects/:projectId/memories/:memoryId
GET   /api/v1/projects/:projectId/memories/:memoryId/history
GET   /api/v1/projects/:projectId/activity
POST  /api/v1/projects/:projectId/activity
```

### Task and handoff routes

```text
POST  /api/v1/projects/:projectId/tasks
GET   /api/v1/projects/:projectId/tasks
GET   /api/v1/projects/:projectId/tasks/:taskId
PATCH /api/v1/projects/:projectId/tasks/:taskId
POST  /api/v1/projects/:projectId/tasks/:taskId/transitions
POST  /api/v1/projects/:projectId/handoffs
GET   /api/v1/projects/:projectId/handoffs
GET   /api/v1/projects/:projectId/handoffs/:handoffId
```

All public request bodies, query parameters, route IDs, and idempotency headers are bounded and
validated. Cross-project resource lookups use generic not-found behavior to avoid leaking resource
existence.

## Browser PWA

The PWA is served by the same Fastify process and exposes only this static allowlist:

```text
/
/app.js
/api-client.js
/styles.css
/manifest.webmanifest
/sw.js
/icon.svg
```

The service worker caches static assets only and bypasses `/api/` requests. It does not cache bearer
tokens, private API responses, or offline writes.

The browser supports normal login and workspace use. First-owner creation is intended for the
Electron desktop shell because the bootstrap operation is protected by the private startup token.

## Local MCP integration

The MCP server is local stdio only:

```powershell
$env:OMNIMEMORY_DB_PATH = '.\data\omnimemory.sqlite'
$env:OMNIMEMORY_MCP_TOKEN = '<local-session-token>'
npm run mcp
```

The token must be an existing OmniMemory bearer session token. It is authenticated again for every
tool call, so expiry and revocation remain effective.

Available tools include:

```text
search_memory, get_memory, get_project_context, list_recent_memories,
record_activity, create_memory, update_memory, get_memory_history,
create_task, list_tasks, get_task, update_task, transition_task,
create_handoff, list_handoffs, get_handoff
```

Every tool requires a project ID. Tool arguments are schema-validated and bounded. Arbitrary SQL,
shell execution, unrestricted filesystem access, HTTP transport, and remote MCP are not provided.

## SQLite database and migrations

SQLite is the authoritative local store. The application enables:

- Foreign keys.
- WAL journal mode.
- A 5-second busy timeout.
- Transactional migrations.

Migration versions:

| Version | Name                                   | Main contents                                                          |
| ------: | -------------------------------------- | ---------------------------------------------------------------------- |
|       1 | `initial_memory_engine`                | Projects, memories, provenance, revisions, FTS5, activity, change log  |
|       2 | `local_auth_devices_permissions_audit` | Owner, setup codes, devices, sessions, enrollments, permissions, audit |
|       3 | `write_idempotency_keys`               | Persistent retry protection                                            |
|       4 | `project_tasks_and_immutable_handoffs` | Tasks, status history, immutable handoffs                              |

Important tables include:

- `projects`
- `memories`
- `memory_revisions`
- `provenance`
- `memory_fts`
- `activity_events`
- `change_log`
- `owner_accounts`
- `setup_codes`
- `devices`
- `sessions`
- `device_enrollments`
- `project_permissions`
- `agent_activity_events`
- `security_audit_events`
- `idempotency_keys`
- `tasks`
- `task_status_history`
- `handoffs`

The application does not copy, replace, relocate, or delete a user database during startup, update,
or uninstall. SQLite WAL and shared-memory sidecars live beside the database.

## Configuration

Configuration is loaded from environment variables in `src/config.ts`.

| Variable                         | Default                                                                        | Purpose                                         |
| -------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------- |
| `OMNIMEMORY_DB_PATH`             | `./data/omnimemory.sqlite` in server mode; Electron `userData` in desktop mode | SQLite path                                     |
| `OMNIMEMORY_PUBLIC_DIRECTORY`    | `./public`                                                                     | Static PWA directory                            |
| `OMNIMEMORY_STARTUP_TOKEN`       | unset outside desktop                                                          | Private desktop readiness/bootstrap capability  |
| `OMNIMEMORY_LOG_LEVEL`           | `info`                                                                         | `debug`, `info`, `warn`, or `error`             |
| `OMNIMEMORY_HOST`                | `127.0.0.1`                                                                    | Loopback host; non-loopback values are rejected |
| `OMNIMEMORY_PORT`                | `3210`                                                                         | Local API port                                  |
| `OMNIMEMORY_REQUEST_BODY_LIMIT`  | `262144`                                                                       | Request body bytes                              |
| `OMNIMEMORY_SESSION_TTL_MS`      | 30 days                                                                        | Absolute session lifetime                       |
| `OMNIMEMORY_IDLE_SESSION_TTL_MS` | 24 hours                                                                       | Idle session lifetime                           |
| `OMNIMEMORY_ENROLLMENT_TTL_MS`   | 10 minutes                                                                     | Device enrollment lifetime                      |
| `OMNIMEMORY_SETUP_CODE_TTL_MS`   | 10 minutes                                                                     | Legacy recovery setup-code lifetime             |
| `OMNIMEMORY_AUTH_RATE_LIMIT_MAX` | 5                                                                              | Auth attempts per rate-limit window             |
| `OMNIMEMORY_MCP_TOKEN`           | unset                                                                          | Local MCP bearer token                          |

The desktop runtime overrides host, port, public directory, database path, and startup token through
the owned backend environment while preserving an explicit `OMNIMEMORY_DB_PATH` override.

## Desktop runtime and packaging

### Development

```powershell
npm run desktop:dev
```

This builds TypeScript and launches Electron from the repository.

### Packaging

```powershell
npm run desktop:build:dir
npm run desktop:build
```

Electron Builder targets Windows x64 and NSIS. Electron 45.0.0 is pinned because its embedded Node
runtime is compatible with the repository's `node:sqlite` requirement.

The packaged worker is launched from:

```text
resources\app.asar.unpacked\dist\src\desktop\backend-worker.js
```

The archive path `app.asar` is not used as the child process working directory. The Electron `RunAsNode`
fuse is enabled so the packaged Electron executable can run the backend worker with
`ELECTRON_RUN_AS_NODE=1`.

### Runtime checks

Before starting, the desktop process checks:

- Bundled executable exists.
- Backend worker exists.
- User-data directory can be created.
- Database parent directory is writable.

Startup readiness requires a successful health response with the per-launch startup token. The
desktop does not adopt an unrelated process already using the port.

### Diagnostics

The desktop writes safe diagnostics to:

```text
%APPDATA%\OmniMemory\logs\desktop.log
```

Diagnostics contain lifecycle categories, status codes, exit codes, and signals. Startup tokens,
bearer tokens, long hexadecimal secrets, passwords, and request bodies are not written.

## Public marketing website

The public website is isolated under `site/` and builds to `dist-site/`. It is not the private PWA,
does not access the database, and does not expose internal APIs or credentials.

Preview:

```powershell
npm run site:preview
```

Build:

```powershell
npm run site:build
```

The site build validates required assets, scans for development paths and secrets, and produces a
static bundle suitable for GitHub Pages, Cloudflare Pages, Netlify, Vercel, or another static host.

## Security model

### Controls

- Loopback-only host enforcement.
- Foreign browser-origin rejection.
- Request body limits.
- Global and authentication-specific rate limits.
- Zod validation at API boundaries.
- Async `scrypt` password hashing.
- Opaque token hashing.
- Session expiry and revocation.
- Device and project authorization.
- Optimistic concurrency for memories and tasks.
- Idempotency keys for retry-safe writes.
- Secret-shaped text rejection.
- Append-only audit records.
- Safe public error mapping.
- Electron context isolation, sandboxing, restricted navigation, and denied webviews.
- Narrow preload bridge with no filesystem or shell access.
- No remote listener, cloud identity, LAN access, or remote MCP.

### Residual risks

OmniMemory does not provide OS-level isolation from another process running as the same local user.
An administrator or same-user process can potentially inspect or interfere with local files, loopback
traffic, or running processes. The installer is unsigned until a release-signing process is added.
Backup, rollback, and password recovery remain operational responsibilities.

## Installation and operating procedures

### Development setup

```powershell
npm install
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
```

### Start the API

```powershell
npm start
```

Default address:

```text
http://127.0.0.1:3210/
```

### First desktop launch

1. Install the Windows x64 NSIS installer.
2. Launch OmniMemory from the Start menu or desktop shortcut.
3. Complete **Create your OmniMemory account**.
4. Use a password of at least 12 characters and confirm it.
5. Choose the initial device name and type.
6. Create the account and confirm the dashboard loads.

No terminal, PowerShell, Node.js installation, setup-code copy/paste, or manual backend start is
required for the installed application.

### Existing installation

If an owner exists, the UI shows normal sign-in. The application does not recreate the owner, reset
credentials, or create an empty replacement database.

### Database backup

Stop OmniMemory before backing up the database and its SQLite sidecars. Do not copy a live WAL database
while it is being written. Test a backup before upgrading.

## Testing and verification

Primary checks:

```powershell
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
npm run demo
```

The test suite covers:

- API authentication and authorization.
- First-owner desktop bootstrap.
- Concurrent owner creation.
- Existing-owner preservation.
- Legacy setup-code state preservation.
- Session expiry and revocation.
- Memory revisions, provenance, search, and idempotency.
- Task versions, transitions, and handoffs.
- MCP discovery and tool calls.
- PWA static assets and client error handling.
- Desktop paths, startup handshakes, writable directories, and diagnostics.
- Public website assets and security scans.

The current Linux environment can run automated checks and cross-build the Windows installer. It
cannot claim real Windows GUI validation. `npm run desktop:smoke` reports the Windows-only limitation
when run on Linux.

## Current deliverables

The current rebuilt installer is staged at:

```text
D:\aimemory\installer\OmniMemory-0.1.0-x64-Setup.exe
```

Current artifact metadata:

- Size: 116,173,520 bytes.
- SHA-256: `592c5d38b53faa00036a356be18b8374648499e09f3bfd9024d70d02bb93b475`.
- Companion files: `.blockmap`, `latest.yml`, and `builder-debug.yml`.
- ASAR includes the Electron main process, preload bridge, backend worker, MCP entry point, updated
  PWA, and API client.
- Electron fuse inspection reports `RunAsNode is Enabled`.

The artifact is cross-built and inspected. It still requires installation and launch on supported
Windows for final GUI acceptance.

## Limitations and deferred work

- Windows-only packaged launch validation is still required.
- The installer is unsigned.
- No LAN, public networking, cloud sync, remote relay, or remote MCP.
- No mobile client.
- No embeddings or external AI API calls.
- No automatic database backup, rollback, or cross-version database copying.
- No password reset or password recovery flow beyond controlled legacy setup procedures.
- No general offline write queue or automatic conflict merging.
- The secret detector is heuristic.
- Same-user local processes are not isolated at the OS level.

## Maintainer checklist

Before changing behavior:

1. Read the relevant source file and all callers.
2. Inspect the existing tests and documentation.
3. Use an isolated temporary database for tests.
4. Preserve loopback-only binding and data-path rules.
5. Never log secrets, passwords, bearer tokens, or private memory content.
6. Add a regression test for non-trivial behavior.

Before committing:

```powershell
git status --short --untracked-files=all
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
npm run demo
```

Before releasing the desktop package:

1. Build the Windows x64 NSIS installer.
2. Inspect the ASAR contents and Electron fuses.
3. Confirm the installer path and checksum.
4. Run `npm run desktop:smoke` on Windows.
5. Install and launch outside the repository.
6. Complete first-owner creation and verify the dashboard.
7. Verify an existing database is preserved across restart and update.
8. Publish only after physical Windows validation.

## Related documentation

- `README.md` — concise quick-start guide.
- `docs/REQUIREMENTS.md` — functional and security requirements.
- `docs/ARCHITECTURE.md` — phase architecture and service boundaries.
- `docs/API_AND_MCP.md` — REST, PWA, MCP, and desktop contracts.
- `docs/DATABASE_DESIGN.md` — migrations, tables, and persistence rules.
- `docs/DESKTOP.md` — Electron runtime, installer, paths, and smoke testing.
- `docs/MCP.md` — local MCP setup and agent workflow.
- `docs/THREAT_MODEL.md` — threats, controls, and residual risk.
- `docs/WEBSITE.md` — public website build and release workflow.
