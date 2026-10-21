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

MCP remains deferred. When implemented, it must call the same memory engine and authorization
service rather than introducing a second database or business-logic path.
