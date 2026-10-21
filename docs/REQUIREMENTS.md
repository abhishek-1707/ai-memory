# OmniMemory Phase 2–3 Requirements

## Functional

1. Create a project and associate memories with it.
2. Create, retrieve, search, update, and list recent memory records.
3. Preserve immutable record revisions and provenance metadata.
4. Reject stale updates instead of silently overwriting newer data.
5. Persist data across process and database reopen.
6. Record append-only activity for memory changes.
7. Use SQLite FTS5 for lexical search.

## Safety

1. Validate public service inputs.
2. Reject high-confidence secret-shaped content.
3. Treat stored text as untrusted data.
4. Use temporary databases in automated tests.
5. Keep data files out of version control.
6. Do not start a public or remote network listener.

## Non-goals

MCP, remote access, synchronization notifications, encrypted backup, embeddings, provider
adapters, mobile UI, and automatic offline conflict resolution.

## Phase 3 API and security

1. Bind the REST service to loopback only.
2. Require owner setup before protected routes become usable.
3. Hash passwords with asynchronous `scrypt` and never persist plaintext passwords.
4. Store only hashes of opaque session and enrollment tokens.
5. Support device enrollment, role changes, session revocation, and device revocation.
6. Require project-scoped permissions for non-owner devices.
7. Validate all request bodies, query parameters, and route identifiers.
8. Enforce body limits, rate limits, secure response headers, and restrictive CORS behavior.
9. Return stable public errors without internal causes or secrets.
10. Record security events in an append-only audit table.
11. Support persistent idempotency keys for memory writes.
