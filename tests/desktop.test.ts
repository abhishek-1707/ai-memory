import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/api/app.js';
import {
  BackendManager,
  type BackendChild,
  type BackendForker,
} from '../src/desktop/backend-manager.js';
import { writeDesktopDiagnostic } from '../src/desktop/diagnostics.js';
import {
  buildBackendEnvironment,
  ensureDesktopRuntime,
  resolveDesktopRuntimePaths,
} from '../src/desktop/runtime.js';
import { openDatabase } from '../src/database/database.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('desktop runtime configuration', () => {
  it('keeps production data outside the application root and forces loopback', () => {
    const paths = resolveDesktopRuntimePaths({
      appRoot: '/opt/omnimemory',
      userDataDirectory: '/home/tester/.local/share/omnimemory',
      packaged: false,
      env: { OMNIMEMORY_PORT: '3321', OMNIMEMORY_HOST: '0.0.0.0' },
    });
    const environment = buildBackendEnvironment(paths, {
      OMNIMEMORY_HOST: '0.0.0.0',
      OMNIMEMORY_PORT: '4000',
    });

    expect(paths.databasePath).toBe(
      join('/home/tester/.local/share/omnimemory', 'omnimemory.sqlite'),
    );
    expect(paths.port).toBe(3321);
    expect(paths.backendEntryPoint).toBe(
      join('/opt/omnimemory', 'dist', 'src', 'desktop', 'backend-worker.js'),
    );
    expect(environment.OMNIMEMORY_HOST).toBe('127.0.0.1');
    expect(environment.OMNIMEMORY_PORT).toBe('3321');
    expect(environment.OMNIMEMORY_DB_PATH).toBe(paths.databasePath);
    expect(environment.OMNIMEMORY_STARTUP_TOKEN).toBe(paths.startupToken);
  });

  it('preserves an explicitly configured database path', () => {
    const paths = resolveDesktopRuntimePaths({
      appRoot: '/opt/omnimemory',
      userDataDirectory: '/home/tester/.local/share/omnimemory',
      packaged: true,
      resourcesDirectory: '/opt/omnimemory/resources',
      env: { OMNIMEMORY_DB_PATH: '/var/lib/omnimemory/custom.sqlite' },
    });

    expect(paths.databasePath).toBe(resolve('/var/lib/omnimemory/custom.sqlite'));
    expect(paths.backendEntryPoint).toBe(
      join(
        '/opt/omnimemory',
        'resources',
        'app.asar.unpacked',
        'dist',
        'src',
        'desktop',
        'backend-worker.js',
      ),
    );
  });

  it('prepares packaged paths and writable application data before launch', () => {
    const directory = makeTemporaryDirectory();
    const resourcesDirectory = join(directory, 'resources');
    const backendDirectory = join(
      resourcesDirectory,
      'app.asar.unpacked',
      'dist',
      'src',
      'desktop',
    );
    const executablePath = join(directory, 'OmniMemory.exe');
    mkdirSync(backendDirectory, { recursive: true });
    writeFileSync(join(backendDirectory, 'backend-worker.js'), '');
    writeFileSync(executablePath, '');

    const paths = resolveDesktopRuntimePaths({
      appRoot: join(resourcesDirectory, 'app.asar'),
      userDataDirectory: join(directory, 'user-data'),
      resourcesDirectory,
      packaged: true,
    });

    ensureDesktopRuntime(paths, executablePath);

    expect(paths.backendWorkingDirectory).toBe(join(resourcesDirectory, 'app.asar.unpacked'));
    expect(existsSync(paths.userDataDirectory)).toBe(true);
    expect(existsSync(dirname(paths.databasePath))).toBe(true);
  });

  it('opens and migrates the production-style database path without overwriting it', () => {
    const directory = makeTemporaryDirectory();
    const databasePath = join(directory, 'omnimemory.sqlite');
    const first = openDatabase(databasePath);
    first.close();

    const second = openDatabase(databasePath);
    const migrations = second.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get() as {
      count: number;
    };
    second.close();

    expect(migrations.count).toBe(4);
  });
});

describe('desktop backend lifecycle', () => {
  it('waits for the owned backend handshake and stops only that process', async () => {
    const child = new FakeBackendChild();
    const forker = new FakeBackendForker(child);
    let healthChecks = 0;
    const manager = new BackendManager({
      forker,
      modulePath: '/opt/omnimemory/backend-worker.js',
      environment: { OMNIMEMORY_HOST: '127.0.0.1' },
      workingDirectory: '/opt/omnimemory',
      healthUrl: 'http://127.0.0.1:3210/api/v1/health',
      startupToken: 'startup-token',
      pollIntervalMs: 1,
      fetchImpl: async (_input, init) => {
        expect(init.headers['x-omnimemory-startup-token']).toBe('startup-token');
        healthChecks += 1;
        if (healthChecks === 1) {
          throw new Error('backend still starting');
        }
        return { ok: true, status: 200, json: async () => ({ data: { status: 'ok' } }) };
      },
    });

    await manager.start();
    expect(manager.isReady).toBe(true);
    expect(forker.modulePath).toBe('/opt/omnimemory/backend-worker.js');
    await manager.stop();

    expect(child.killCalls).toBe(1);
    expect(manager.isReady).toBe(false);
  });

  it('fails closed when the owned backend exits before readiness', async () => {
    const child = new FakeBackendChild();
    const forker = new FakeBackendForker(child);
    const manager = new BackendManager({
      forker,
      modulePath: '/opt/omnimemory/backend-worker.js',
      environment: {},
      workingDirectory: '/opt/omnimemory',
      healthUrl: 'http://127.0.0.1:3210/api/v1/health',
      startupToken: 'startup-token',
      pollIntervalMs: 1,
      fetchImpl: async () => {
        child.emitExit(1, null);
        throw new Error('backend exited');
      },
    });

    await expect(manager.start()).rejects.toMatchObject({ category: 'backend_process_exited' });
    expect(manager.isReady).toBe(false);
  });

  it('does not adopt an unrelated service occupying the configured port', async () => {
    const child = new FakeBackendChild();
    const forker = new FakeBackendForker(child);
    const manager = new BackendManager({
      forker,
      modulePath: '/opt/omnimemory/backend-worker.js',
      environment: {},
      workingDirectory: '/opt/omnimemory',
      healthUrl: 'http://127.0.0.1:3210/api/v1/health',
      startupToken: 'desktop-secret',
      startupTimeoutMs: 10,
      pollIntervalMs: 1,
      fetchImpl: async (_input, init) => {
        expect(init.headers['x-omnimemory-startup-token']).toBe('desktop-secret');
        return {
          ok: false,
          status: 403,
          json: async () => ({ error: { code: 'FORBIDDEN' } }),
        };
      },
    });

    await expect(manager.start()).rejects.toMatchObject({ category: 'port_occupied' });
    expect(child.killCalls).toBe(1);
    expect(manager.isReady).toBe(false);
  });

  it('reports a bounded startup timeout when the port is unreachable', async () => {
    const child = new FakeBackendChild();
    const manager = new BackendManager({
      forker: new FakeBackendForker(child),
      modulePath: '/opt/omnimemory/backend-worker.js',
      environment: {},
      workingDirectory: '/opt/omnimemory',
      healthUrl: 'http://127.0.0.1:3210/api/v1/health',
      startupToken: 'desktop-secret',
      startupTimeoutMs: 10,
      pollIntervalMs: 1,
      fetchImpl: async () => {
        throw new Error('port is not reachable');
      },
    });

    await expect(manager.start()).rejects.toMatchObject({ category: 'startup_timeout' });
  });
});

describe('packaged static asset configuration', () => {
  it('exposes only the owner bootstrap operation through the preload bridge', () => {
    const preload = readFileSync(join(process.cwd(), 'src', 'electron', 'preload.ts'), 'utf8');
    const main = readFileSync(join(process.cwd(), 'src', 'electron', 'main.ts'), 'utf8');

    expect(preload).toContain('contextBridge.exposeInMainWorld');
    expect(preload).toContain("'omnimemory:create-owner'");
    expect(preload).toContain('ipcRenderer.invoke');
    expect(preload).not.toContain('OMNIMEMORY_STARTUP_TOKEN');
    expect(main).toContain('/api/v1/auth/setup/bootstrap');
    expect(main).toContain(
      "preload: join(app.getAppPath(), 'dist', 'src', 'electron', 'preload.js')",
    );
    expect(main).not.toContain('showInitialSetupCode');
  });

  it('serves assets from the configured packaged directory instead of the working directory', async () => {
    const directory = makeTemporaryDirectory();
    const publicDirectory = join(directory, 'public');
    mkdirSync(publicDirectory);
    writeFileSync(join(publicDirectory, 'index.html'), '<title>Packaged OmniMemory</title>');
    const database = openDatabase(join(directory, 'memory.sqlite'));
    const app = await buildApp({ database, config: { staticAssetsDirectory: publicDirectory } });

    const response = await app.inject({ method: 'GET', url: '/' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('Packaged OmniMemory');

    await app.close();
    database.close();
  });

  it('requires the desktop startup token for the readiness endpoint', async () => {
    const directory = makeTemporaryDirectory();
    const database = openDatabase(join(directory, 'memory.sqlite'));
    const app = await buildApp({
      database,
      config: {
        staticAssetsDirectory: join(process.cwd(), 'public'),
        startupToken: 'expected-startup-token',
      },
    });

    const missingToken = await app.inject({ method: 'GET', url: '/api/v1/health' });
    const correctToken = await app.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: { 'x-omnimemory-startup-token': 'expected-startup-token' },
    });

    expect(missingToken.statusCode).toBe(403);
    expect(correctToken.statusCode).toBe(200);
    await app.close();
    database.close();
  });

  it('redacts startup tokens from desktop diagnostics', () => {
    const directory = makeTemporaryDirectory();
    const diagnosticsPath = join(directory, 'logs', 'desktop.log');

    writeDesktopDiagnostic(diagnosticsPath, 'startup_failed', {
      detail: 'OMNIMEMORY_STARTUP_TOKEN=0123456789abcdef0123456789abcdef',
    });

    const diagnostics = readFileSync(diagnosticsPath, 'utf8');
    expect(diagnostics).not.toContain('0123456789abcdef0123456789abcdef');
    expect(diagnostics).toContain('<redacted>');
  });
});

function makeTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'omnimemory-desktop-'));
  temporaryDirectories.push(directory);
  return directory;
}

class FakeBackendChild implements BackendChild {
  public killCalls = 0;
  private exitListener: ((code: number | null, signal: string | null) => void) | undefined;
  private errorListener: ((error: Error) => void) | undefined;

  public kill(): boolean {
    this.killCalls += 1;
    queueMicrotask(() => this.emitExit(0, null));
    return true;
  }

  public once(event: 'exit' | 'error', listener: (...args: never[]) => void): this {
    if (event === 'exit') {
      this.exitListener = listener as unknown as (
        code: number | null,
        signal: string | null,
      ) => void;
    } else {
      this.errorListener = listener as unknown as (error: Error) => void;
    }
    return this;
  }

  public emitExit(code: number | null, signal: string | null): void {
    this.exitListener?.(code, signal);
  }

  public emitError(error: Error): void {
    this.errorListener?.(error);
  }
}

class FakeBackendForker implements BackendForker {
  public modulePath = '';

  public constructor(private readonly child: FakeBackendChild) {}

  public fork(modulePath: string): BackendChild {
    this.modulePath = modulePath;
    return this.child;
  }
}
