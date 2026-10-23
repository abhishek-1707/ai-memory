import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';

import { app, BrowserWindow, dialog, ipcMain, Menu, shell, type Event } from 'electron';

import {
  BackendManager,
  type BackendForker,
  type BackendStartupFailureCategory,
} from '../desktop/backend-manager.js';
import { writeDesktopDiagnostic } from '../desktop/diagnostics.js';
import {
  buildBackendEnvironment,
  ensureDesktopRuntime,
  resolveDesktopRuntimePaths,
} from '../desktop/runtime.js';

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let mainWindow: BrowserWindow | null = null;
  let backend: BackendManager | null = null;
  let shutdownPromise: Promise<void> | null = null;
  let startupFailureShown = false;
  let diagnosticsPath: string | undefined;
  let ownerBootstrapHandlerRegistered = false;

  app.on('second-instance', () => {
    if (mainWindow === null) {
      return;
    }
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.focus();
  });

  app.on('before-quit', (event: Event) => {
    if (shutdownPromise !== null) {
      return;
    }
    event.preventDefault();
    shutdownPromise = stopBackend().finally(() => {
      app.exit(0);
    });
  });

  process.once('SIGINT', () => {
    void requestQuit();
  });
  process.once('SIGTERM', () => {
    void requestQuit();
  });

  void app.whenReady().then(async () => {
    try {
      await startApplication();
    } catch (error) {
      const category = startupFailureCategory(error);
      console.error('desktop_start_failed', category);
      if (diagnosticsPath !== undefined) {
        writeDesktopDiagnostic(diagnosticsPath, 'desktop_start_failed', { category });
      }
      await stopBackend();
      await showStartupFailure(category);
      app.exit(1);
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  async function startApplication(): Promise<void> {
    const paths = resolveDesktopRuntimePaths({
      appRoot: app.getAppPath(),
      userDataDirectory: app.getPath('userData'),
      resourcesDirectory: join(dirname(app.getPath('exe')), 'resources'),
      packaged: app.isPackaged,
    });
    const currentDiagnosticsPath = join(paths.userDataDirectory, 'logs', 'desktop.log');
    diagnosticsPath = currentDiagnosticsPath;
    ensureDesktopRuntime(paths, process.execPath);
    writeDesktopDiagnostic(currentDiagnosticsPath, 'desktop_start_begin', {
      packaged: app.isPackaged,
    });
    backend = new BackendManager({
      forker: createBackendForker(),
      modulePath: paths.backendEntryPoint,
      environment: buildBackendEnvironment(paths),
      workingDirectory: paths.backendWorkingDirectory,
      healthUrl: `${paths.url}/api/v1/health`,
      startupToken: paths.startupToken,
      onExit: (info) => {
        if (shutdownPromise !== null) {
          return;
        }
        writeDesktopDiagnostic(currentDiagnosticsPath, 'backend_exit', {
          code: info.code ?? undefined,
          signal: info.signal ?? undefined,
        });
        void showUnexpectedBackendExit(info).then(() => requestQuit());
      },
    });
    await backend.start();
    registerOwnerBootstrapHandler(paths.url, paths.startupToken);
    createApplicationMenu(paths.url);
    mainWindow = createMainWindow(paths.url);
    await mainWindow.loadURL(paths.url);
  }

  function createMainWindow(url: string): BrowserWindow {
    const window = new BrowserWindow({
      width: 1440,
      height: 1000,
      minWidth: 960,
      minHeight: 640,
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: join(app.getAppPath(), 'dist', 'src', 'electron', 'preload.js'),
        sandbox: true,
        webSecurity: true,
      },
    });

    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event: Event, targetUrl: string) => {
      if (!targetUrl.startsWith(url)) {
        event.preventDefault();
      }
    });
    window.webContents.on('will-attach-webview', (event: Event) => {
      event.preventDefault();
    });
    window.once('ready-to-show', () => window.show());
    window.on('closed', () => {
      mainWindow = null;
    });
    return window;
  }

  function createApplicationMenu(url: string): void {
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: 'File',
          submenu: [
            {
              label: 'Open in Browser',
              click: () => {
                void shell.openExternal(url);
              },
            },
            { type: 'separator' },
            { role: 'quit' },
          ],
        },
      ]),
    );
  }

  async function requestQuit(): Promise<void> {
    if (shutdownPromise === null) {
      shutdownPromise = stopBackend();
    }
    await shutdownPromise;
    app.exit(0);
  }

  async function stopBackend(): Promise<void> {
    unregisterOwnerBootstrapHandler();
    await backend?.stop();
  }

  function registerOwnerBootstrapHandler(url: string, startupToken: string): void {
    if (ownerBootstrapHandlerRegistered) {
      return;
    }
    ipcMain.handle('omnimemory:create-owner', async (event, input: unknown) => {
      if (!isTrustedRenderer(event.senderFrame?.url, url)) {
        return { ok: false, status: 403, code: 'FORBIDDEN' } satisfies BootstrapFailure;
      }

      try {
        const response = await fetch(`${url}/api/v1/auth/setup/bootstrap`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-omnimemory-startup-token': startupToken,
          },
          body: JSON.stringify(input),
        });
        let payload: BootstrapPayload | null = null;
        try {
          payload = (await response.json()) as BootstrapPayload;
        } catch {
          payload = null;
        }
        if (!response.ok) {
          return {
            ok: false,
            status: response.status,
            code: typeof payload?.error?.code === 'string' ? payload.error.code : 'INTERNAL_ERROR',
          } satisfies BootstrapFailure;
        }
        return { ok: true, data: payload?.data } satisfies BootstrapSuccess;
      } catch {
        return { ok: false, status: 0, code: 'NETWORK_ERROR' } satisfies BootstrapFailure;
      }
    });
    ownerBootstrapHandlerRegistered = true;
  }

  function unregisterOwnerBootstrapHandler(): void {
    if (!ownerBootstrapHandlerRegistered) {
      return;
    }
    ipcMain.removeHandler('omnimemory:create-owner');
    ownerBootstrapHandlerRegistered = false;
  }

  async function showStartupFailure(category: StartupFailureCategory): Promise<void> {
    if (startupFailureShown) {
      return;
    }
    startupFailureShown = true;
    await dialog.showMessageBox({
      type: 'error',
      title: 'OmniMemory could not start',
      message: 'The local OmniMemory backend could not start.',
      detail: startupFailureMessage(category),
    });
  }

  async function showUnexpectedBackendExit(info: { readonly code: number | null }): Promise<void> {
    await dialog.showMessageBox({
      type: 'error',
      title: 'OmniMemory stopped',
      message: 'The local OmniMemory backend stopped unexpectedly.',
      detail:
        info.code === null
          ? 'Restart OmniMemory and check the application logs if the problem continues.'
          : `The backend exited with code ${info.code}. Restart OmniMemory and try again.`,
    });
  }
}

interface BootstrapSuccess {
  readonly ok: true;
  readonly data: unknown;
}

interface BootstrapPayload {
  readonly data?: unknown;
  readonly error?: { readonly code?: unknown };
}

interface BootstrapFailure {
  readonly ok: false;
  readonly status: number;
  readonly code: string;
}

function isTrustedRenderer(frameUrl: string | undefined, applicationUrl: string): boolean {
  if (frameUrl === undefined) {
    return false;
  }
  try {
    return new URL(frameUrl).origin === new URL(applicationUrl).origin;
  } catch {
    return false;
  }
}

function createBackendForker(): BackendForker {
  return {
    fork(modulePath, args, options) {
      const child = spawn(process.execPath, [modulePath, ...args], {
        cwd: options.cwd,
        env: { ...options.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      child.stderr?.on('data', (chunk: unknown) => {
        console.error('desktop_backend_stderr', String(chunk).trim());
      });
      child.stdout?.on('data', (chunk: unknown) => {
        console.log('desktop_backend_stdout', String(chunk).trim());
      });
      return child;
    },
  };
}

type StartupFailureCategory =
  | BackendStartupFailureCategory
  | 'backend_executable_not_found'
  | 'backend_entry_point_missing'
  | 'data_directory_inaccessible'
  | 'unknown';

function startupFailureCategory(error: unknown): StartupFailureCategory {
  if (typeof error === 'object' && error !== null && 'category' in error) {
    const category = error.category;
    if (typeof category === 'string') {
      return category as StartupFailureCategory;
    }
  }
  return 'unknown';
}

function startupFailureMessage(category: StartupFailureCategory): string {
  switch (category) {
    case 'backend_executable_not_found':
      return 'The bundled backend runtime was not found. Reinstall OmniMemory.';
    case 'backend_entry_point_missing':
      return 'The bundled backend files are missing. Reinstall OmniMemory.';
    case 'data_directory_inaccessible':
      return 'The OmniMemory application-data directory is unavailable or not writable.';
    case 'port_occupied':
      return 'The configured loopback port is already used by another service.';
    case 'database_initialization_failed':
      return 'The local database could not be opened or migrated. Your existing database was not deleted.';
    case 'backend_process_exited':
      return 'The bundled backend process exited during startup.';
    case 'backend_process_start_failed':
      return 'The bundled backend process could not be launched.';
    case 'readiness_handshake_failed':
      return 'The backend started but did not complete its private readiness handshake.';
    case 'startup_timeout':
      return 'The backend did not become ready before the startup timeout.';
    default:
      return 'Check the OmniMemory desktop log in the application-data directory for details.';
  }
}
