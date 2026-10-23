# OmniMemory Windows Desktop Application

## Architecture

Phase 7 packages the existing PWA and REST backend in Electron without creating a second memory,
authentication, or authorization implementation:

```text
Electron main process
    -> managed Electron child process
        -> Fastify REST API + PWA static assets
            -> AuthService + AccessControlService
                -> MemoryEngine + TaskTrackingService
                    -> SQLite in the per-user application-data directory
```

The backend remains a separately managed process so synchronous `node:sqlite` work does not run on
the Electron UI event loop. Electron 45.0.0 is pinned for the desktop runtime; it embeds a Node 24
runtime compatible with this repository's `node >=24.0.0` requirement. The packaged backend uses the
same compiled services, migrations, REST routes, static asset allowlist, and local stdio MCP entry
point as development.

The packaged worker is launched from `resources\app.asar.unpacked` rather than using `app.asar` as
its process working directory. `app.asar` is an archive-backed application path, not a normal
writable Windows directory. The desktop process launches the bundled Electron executable with
`ELECTRON_RUN_AS_NODE=1`, passes the unpacked worker entry point, and waits for the startup-token
health response before creating the window.

The desktop window uses context isolation, disabled Node.js integration, Electron sandboxing, and a
single-purpose preload bridge used only for owner bootstrap. It also enforces restricted same-origin
navigation, denied new windows and webviews, and a single-instance lock. The preload bridge does not
provide filesystem, shell, token, or arbitrary IPC access.

The backend is always forced to `127.0.0.1`. The desktop process generates a per-launch handshake
token and accepts readiness only from the backend it started. If the configured port is occupied,
the desktop application reports startup failure rather than loading an unrelated service.

## Installation and launch

Run the Windows installer produced by `npm run desktop:build` and launch **OmniMemory** from the
Start menu or desktop shortcut. The installer is per-user by default and does not require
administrator access. The uninstaller does not delete the application-data directory.

On first launch with no owner account, the desktop UI shows **Create your OmniMemory account**. The
user chooses a password, confirms it, and enters the initial device name and type. No setup code is
displayed or required. The renderer sends the form through a single-purpose context-isolated IPC
bridge; the Electron main process adds the private per-launch startup token and calls the protected
loopback bootstrap route. The startup token is never exposed to the renderer or written to logs.

The legacy `npm run setup-code` flow remains only for controlled recovery or development. It is not
used by normal desktop onboarding. If a database already contains a setup-code row but no owner, the
desktop bootstrap ignores that legacy row, preserves it, and still creates the owner exactly once.

The same UI remains available in a normal browser at the desktop backend URL, normally:

```text
http://127.0.0.1:3210/
```

Use **File > Open in Browser** in the desktop window to open the owned backend in the user's default
browser. The backend remains loopback-only; phones and other computers cannot connect in this phase.

## Data and migrations

The production database defaults to Electron's `app.getPath('userData')` directory. On a typical
Windows installation this is:

```text
%APPDATA%\OmniMemory\omnimemory.sqlite
```

The exact path is controlled by the Electron runtime and may vary with Windows profile settings.
SQLite WAL and shared-memory files are stored beside the database. The installation directory is
not used for authoritative writable data.

`OMNIMEMORY_DB_PATH` remains supported as an explicit override for controlled migration, backup, or
diagnostic procedures. The desktop application never copies, replaces, or deletes an existing
database automatically. Migrations run through the existing transactional migration system before
the backend becomes ready.

Back up the database and its SQLite sidecar files while OmniMemory is stopped. Test a backup before
performing an upgrade. Do not copy a live WAL database while it is being written.

## Shutdown and restart

Closing the desktop window quits the application on Windows. The main process stops only the
backend child process that it started, waits for its exit, and then exits. It does not search for
or terminate unrelated Node.js processes. Windows shutdown follows the same owned-process cleanup
path.

If startup fails, the desktop window shows a safe error explaining that the loopback port or
application-data directory may be unavailable. It does not show filesystem paths, setup codes,
tokens, passwords, or internal exception details. Owner-creation failures are shown in the setup form
as safe validation or current-state messages.

Diagnostics are written to:

```text
%APPDATA%\OmniMemory\logs\desktop.log
```

Only safe startup categories, exit codes, signals, and lifecycle events are recorded. Startup and
session tokens are redacted and are never written to the diagnostic file.

## Build and smoke test

Build prerequisites are Windows 10 or newer for packaged launch validation, Node.js 24 or newer,
npm, and a network connection on the first Electron/electron-builder install.

From the repository root:

```powershell
npm install
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
npm run desktop:build:dir
npm run desktop:build
```

Expected Windows artifacts are:

```text
artifacts-v2\win-unpacked\OmniMemory.exe
artifacts-v2\OmniMemory-0.1.0-x64-Setup.exe
```

On Windows, run the packaged executable smoke test with:

```powershell
npm run desktop:smoke
```

The smoke test uses a temporary SQLite database and an isolated port. It does not touch the user's
authoritative database. Real installer validation still requires installing the generated NSIS
installer, launching the installed executable from outside the repository, completing the first-run
flow, and confirming the browser URL.

## MCP compatibility

The local stdio MCP server remains a separate process and uses `OMNIMEMORY_DB_PATH` plus
`OMNIMEMORY_MCP_TOKEN`. Development continues to use:

```powershell
$env:OMNIMEMORY_DB_PATH = 'C:\path\to\omnimemory.sqlite'
$env:OMNIMEMORY_MCP_TOKEN = '<local-session-token>'
npm run mcp
```

The packaged application includes the compiled MCP entry point and the same production database
path. Do not put a real token in installer assets, scripts, or committed configuration. Packaged MCP
launcher integration is intentionally kept separate from the desktop window so stdout remains
reserved for MCP JSON-RPC.

## Current limitations

- No LAN, public networking, router port forwarding, remote relay, or remote MCP.
- No phone or cross-device connectivity claim is made.
- The Windows installer is unsigned unless a later release adds a controlled signing step.
- Automatic database backup, rollback, and cross-version database copying are not provided.
- Electron and the Windows installer must be upgraded deliberately because the embedded runtime and
  `node:sqlite` compatibility are part of the packaged runtime contract.
