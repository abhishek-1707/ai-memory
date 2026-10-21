# OmniMemory Phase 4 MCP Integration

## Scope

Phase 4 provides a local-only MCP server over stdio. A compatible coding agent launches the server
as a child process and communicates over stdin/stdout. stdout is reserved for MCP JSON-RPC messages;
diagnostic logging goes to stderr.

The server reuses the Phase 3 database and services:

```text
MCP stdio client
    -> scripts/mcp-stdio.ts
    -> AuthService + AccessControlService
    -> MemoryEngine
    -> SQLite
```

There is no remote MCP listener, HTTP transport, arbitrary SQL tool, shell tool, or unrestricted
filesystem tool in this phase.

## Authentication

The server requires an existing OmniMemory bearer session token in:

```text
OMNIMEMORY_MCP_TOKEN
```

The token is authenticated again for every tool call, so session expiry and device revocation remain
effective. The raw token must stay in local process configuration and must not be committed to Git.

The database path is controlled by the existing setting:

```text
OMNIMEMORY_DB_PATH
```

Start it manually from the repository root in PowerShell:

```powershell
$env:OMNIMEMORY_DB_PATH = '.\data\omnimemory.sqlite'
$env:OMNIMEMORY_MCP_TOKEN = '<local-session-token>'
npm run mcp
```

## Tools

| Tool                   | Access        | Purpose                                                           |
| ---------------------- | ------------- | ----------------------------------------------------------------- |
| `search_memory`        | Project read  | Search current project memories with SQLite FTS5.                 |
| `get_memory`           | Project read  | Retrieve one memory by ID.                                        |
| `get_project_context`  | Project read  | Retrieve project metadata and bounded recent memories.            |
| `list_recent_memories` | Project read  | List bounded recent current memories.                             |
| `record_activity`      | Project write | Record validated activity attributed to the authenticated device. |
| `create_memory`        | Project write | Create a validated, project-scoped memory.                        |
| `update_memory`        | Project write | Update a memory using optimistic version checks.                  |
| `get_memory_history`   | Project read  | Retrieve immutable memory revisions.                              |

All tools require a UUID `projectId`. The server verifies that the memory belongs to that project
before returning or changing it. Unauthorized cross-project lookups use a generic not-found result.
Tool results are JSON text content, bounded to prevent unreasonably large responses. Secret-shaped
write input is rejected by the existing memory validation, and sensitive-looking text is redacted in
MCP output as a defense-in-depth measure.

## Claude Code configuration

Claude Code supports local stdio servers with `claude mcp add`, `--env` variables, and `--` to
separate Claude Code flags from the child-process command. Use local scope so the token remains in
your local Claude Code settings rather than a project file.

From PowerShell, set the token in the current session and substitute the absolute repository path:

```powershell
$env:OMNIMEMORY_MCP_TOKEN = '<local-session-token>'
$repo = (Get-Location).Path
$db = Join-Path $repo 'data\omnimemory.sqlite'
$tsx = Join-Path $repo 'node_modules\tsx\dist\cli.mjs'
$entry = Join-Path $repo 'scripts\mcp-stdio.ts'

claude mcp add --scope local --transport stdio omnimemory `
  --env "OMNIMEMORY_DB_PATH=$db" `
  --env "OMNIMEMORY_MCP_TOKEN=$env:OMNIMEMORY_MCP_TOKEN" `
  -- node $tsx $entry
```

Do not replace the placeholder with a token inside a committed file. The command above stores the
server in Claude Code's local configuration. Verify it with:

```powershell
claude mcp list
claude mcp get omnimemory
```

Then open Claude Code's `/mcp` view and confirm that the OmniMemory tools are discoverable. Ask the
agent to search the authorized project, create a memory, and retrieve it by ID.

## Verification commands

```powershell
npm run typecheck
npm run lint
npm run format:check
npm test
npm run demo
```

The MCP integration test also starts `scripts/mcp-stdio.ts` through a real MCP stdio client and
checks discovery, memory creation, and retrieval in the same SQLite database.
