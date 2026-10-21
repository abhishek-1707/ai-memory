# OmniMemory REST and MCP Contract

## REST status

Phase 3 implements the local REST API under:

```text
/api/v1
```

The server binds to `127.0.0.1` by default. Remote access and MCP are not enabled.

## Response envelope

Success:

```json
{
  "data": {},
  "meta": { "requestId": "..." }
}
```

Error:

```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Authentication required",
    "requestId": "..."
  }
}
```

Public errors do not contain stack traces, SQL, filesystem paths, tokens, passwords, request bodies,
or internal error details.

## Authentication routes

```text
GET  /api/v1/auth/setup/status
POST /api/v1/auth/setup
POST /api/v1/auth/login
POST /api/v1/auth/password
POST /api/v1/auth/logout
GET  /api/v1/auth/me
POST /api/v1/auth/enrollments
POST /api/v1/auth/enrollments/claim
```

Bearer authentication uses:

```http
Authorization: Bearer <opaque-token>
```

The raw token is returned only when a session is created. Only its SHA-256 hash is stored.

`npm run setup-code` generates the one-time initial setup code. The API does not manufacture a
default password or permanent administrator token.

## Device and permission routes

```text
GET    /api/v1/devices
POST   /api/v1/devices/:id/revoke
PATCH  /api/v1/devices/:id/role
PUT    /api/v1/devices/:id/projects/:projectId
DELETE /api/v1/devices/:id/projects/:projectId
```

## Project and memory routes

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
```

The URL project is authoritative. A memory must belong to that project or the response is generic
`404 Not Found`. Memory writes accept `Idempotency-Key`; the key is scoped to the authenticated
device and persisted for 24 hours.

## Activity routes

```text
GET  /api/v1/projects/:projectId/activity
POST /api/v1/projects/:projectId/activity
```

Task and handoff endpoints are deferred because those domain tables do not yet exist.

## MCP status

Phase 4 implements a local stdio MCP server. It does not open an HTTP listener, expose remote MCP,
or create a second database. The server authenticates each tool call with the bearer token supplied
through `OMNIMEMORY_MCP_TOKEN`, then calls the existing `AuthService`, `AccessControlService`, and
`MemoryEngine`.

MCP tools:

```text
search_memory
get_memory
get_project_context
list_recent_memories
record_activity
create_memory
update_memory
get_memory_history
```

All tools require a project ID. Read tools require project read access; activity and memory writes
require project write access. Memory updates require `expectedVersion`, and memory writes accept an
optional idempotency key scoped to the authenticated device. Tool arguments are schema-validated,
limits are bounded, and public tool errors do not expose internal exception details or credentials.

The stdio entry point is:

```text
npm run mcp
```

Use a local environment variable for `OMNIMEMORY_MCP_TOKEN`; never commit a real token to source
control. Claude Code setup details are in `docs/MCP.md`.
