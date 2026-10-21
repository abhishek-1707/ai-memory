# OmniMemory Database Design

## Migration versions

| Version | Name                                   | Purpose                                                                           |
| ------: | -------------------------------------- | --------------------------------------------------------------------------------- |
|       1 | `initial_memory_engine`                | Projects, memories, provenance, revisions, FTS5, activity, change log             |
|       2 | `local_auth_devices_permissions_audit` | Owner setup, devices, sessions, enrollments, project permissions, activity, audit |
|       3 | `write_idempotency_keys`               | Persistent retry protection for memory writes                                     |

Migrations are applied transactionally at startup. The live SQLite file, WAL file, and shared-memory
file are local-only and must not be shared over a network.

## Phase 3 tables

### Authentication

- `owner_accounts`: one row with the encoded `scrypt` password hash.
- `setup_codes`: one short-lived initial setup code hash with failure count and consumption state.
- `devices`: named device identity, role, active/revoked status, and timestamps.
- `sessions`: hashed opaque bearer tokens, absolute and idle expiry, and revocation state.
- `device_enrollments`: one-time device enrollment token hashes.

Authentication timestamps use Unix epoch milliseconds so expiry checks are numeric and unambiguous.

### Authorization

`project_permissions` maps a device to a project with one of:

- `reader`: read/search/history.
- `editor`: reader plus memory/activity writes.
- `owner`: editor plus membership management.

The global device role is separate:

- `owner`: initial owner device with all project access.
- `admin`: device-management capability; project content still requires membership.
- `member`: project permissions only.

### Activity and audit

- `agent_activity_events` contains validated project activity written through the memory service.
- `security_audit_events` contains authentication, authorization, device, permission, and security
  outcomes. SQLite triggers reject updates and deletes from the audit table.

These tables are intentionally separate from `activity_events` and `change_log`, which preserve
memory-domain history and synchronization order respectively.

### Idempotency

`idempotency_keys` stores a request hash and resulting memory resource/version for 24 hours. The
memory engine reserves the key inside the same SQLite transaction as the memory write. Reusing the
same key with the same request returns the original record; reusing it with different input returns
a conflict.

## Legacy nullable project scope

Phase 2 permits `NULL project_id` for internal/global memories. Phase 3 REST routes require a
project ID and do not expose null-scoped memories to member devices. A future migration may move
legacy global records into a dedicated profile project if global profile access is approved.
