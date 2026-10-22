import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';

import { app, BrowserWindow, dialog, Menu, shell, type Event } from 'electron';

import { BackendManager, type BackendForker } from '../desktop/backend-manager.js';
import { buildBackendEnvironment, resolveDesktopRuntimePaths } from '../desktop/runtime.js';

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let mainWindow: BrowserWindow | null = null;
  let backend: BackendManager | null = null;
  let shutdownPromise: Promise<void> | null = null;
  let startupFailureShown = false;

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
      console.error(
        'desktop_start_failed',
        error instanceof Error ? `${error.name}: ${error.message}` : 'unknown',
      );
      await stopBackend();
      await showStartupFailure();
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
    backend = new BackendManager({
      forker: createBackendForker(),
      modulePath: paths.backendEntryPoint,
      environment: buildBackendEnvironment(paths),
      workingDirectory: paths.appRoot,
      healthUrl: `${paths.url}/api/v1/health`,
      startupToken: paths.startupToken,
      onExit: (info) => {
        if (shutdownPromise !== null) {
          return;
        }
        void showUnexpectedBackendExit(info).then(() => requestQuit());
      },
    });
    await backend.start();
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
    await backend?.stop();
  }

  async function showStartupFailure(): Promise<void> {
    if (startupFailureShown) {
      return;
    }
    startupFailureShown = true;
    await dialog.showMessageBox({
      type: 'error',
      title: 'OmniMemory could not start',
      message: 'The local OmniMemory backend could not start.',
      detail:
        'Check that the configured loopback port is available and that the application data directory is writable.',
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
