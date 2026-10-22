# OmniMemory Phase 3 Threat Model

## Scope

This document covers the local REST API, owner setup, password authentication, device sessions,
project permissions, request validation, rate limiting, and audit logging.

The API is intentionally loopback-only. Remote access, cloud MCP, mobile clients, and encrypted
backups are outside this phase.

## Assets

- Owner password hash.
- Setup and enrollment token hashes.
- Session token hashes.
- Project and memory content.
- Provenance and history.
- Device and permission state.
- Security audit events.

## Threats and controls

| Threat                      | Controls                                                                   | Residual risk                                                                                     |
| --------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Unauthorized local process  | Opaque bearer sessions, setup gate, device revocation, project ACLs        | A process with full local-user control can still access the host or inspect the running process   |
| Password disclosure         | `scrypt`, random salt, no plaintext persistence, generic login errors      | The owner must still protect the local machine and setup code                                     |
| Token theft                 | Tokens returned only on creation, hashes stored, no URL tokens, revocation | A stolen active token remains usable until expiry or revocation                                   |
| Cross-project access        | Membership checks before memory reads, path/project matching, generic 404  | Project metadata is still visible to authorized members of that project                           |
| Brute-force login           | Fastify rate limits, bounded password length, async scrypt                 | The first implementation uses process-level rate limiting; persistent account lockout is deferred |
| Malicious request body      | Zod validation, body limits, content-type handling, safe error mapping     | Validation is not a complete content-DLP system                                                   |
| Audit tampering             | Append-only table triggers, no update/delete application routes            | A host administrator with direct database write access can bypass application controls            |
| Secret leakage through logs | Request IDs and allowlisted metadata only; no bodies/tokens/passwords      | Future integrations must preserve the same logging discipline                                     |
| Remote exposure             | Loopback host enforcement and no permissive CORS                           | Deploying behind a proxy or changing host policy requires a later security review                 |

## Important decisions

1. The first account is a single owner account, not public registration.
2. Devices are separate identities from sessions.
3. Project permissions are device-scoped in this phase.
4. The owner device has global project access; admin devices manage devices but require project membership for content.
5. REST memory routes require a project scope.
6. Global/null-scoped Phase 2 memories are not exposed to ordinary devices.
7. Errors use stable public codes and never serialize internal causes.
8. Audit events contain identifiers and outcomes, not memory bodies or credentials.

## Known gaps

- No OS-level database permission hardening is performed by the application yet.
- No password reset or recovery flow exists.
- No remote TLS termination or cloud identity flow exists.
- The secret detector remains heuristic.
- Security audit writes for domain memory mutations occur after the memory-engine transaction; the
  domain activity event remains transactional with the memory write.

## Phase 6 browser controls

- The PWA is served only by the existing loopback-only Fastify process; no LAN or public listener is
  enabled.
- The browser client keeps the bearer token in memory and never writes it to localStorage,
  sessionStorage, URLs, service-worker caches, or committed configuration.
- Logout clears the in-memory token and private UI state. A 401 response also clears the session.
- The service worker has an explicit static-asset allowlist and bypasses all `/api/` requests. It does
  not provide offline writes, private-data caching, or conflict merging.
- The browser still relies on the REST API for authentication, project authorization, validation,
  audit logging, and optimistic concurrency. Frontend controls are not security boundaries.
- Foreign browser origins remain rejected. The exact configured loopback origin and its localhost
  alias are allowed so same-origin PWA POST requests work without enabling permissive CORS.

## Phase 7 desktop controls

- The Electron main process takes a single-instance lock before starting a backend.
- The backend is launched as an owned child process and is stopped only through that owned process
  handle; unrelated Node.js processes are not searched for or terminated.
- Desktop readiness requires a per-launch startup token sent to the loopback health endpoint. A
  process already occupying the configured port is not accepted as the desktop backend.
- The renderer has context isolation, disabled Node integration, sandboxing, restricted navigation,
  denied new windows, and no preload filesystem or shell bridge.
- The backend receives `OMNIMEMORY_HOST=127.0.0.1` even if the parent environment requests another
  host. The desktop does not add CORS or remote listeners.
- The authoritative database defaults to Electron's per-user `userData` directory, outside the
  installed binaries. The installer and uninstaller do not delete it, and startup never replaces an
  existing database.

## Phase 7 residual risks

- A local process running as the same Windows user can inspect or interfere with loopback traffic and
  the desktop process; the application does not provide OS-level isolation from that user.
- The Windows installer is unsigned until a release-signing process is added.
- Database backup, rollback, and recovery remain operational responsibilities; no automatic backup is
  performed.
