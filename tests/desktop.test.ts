import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/api/app.js';
import {
  BackendManager,
  type BackendChild,
  type BackendForker,
} from '../src/desktop/backend-manager.js';
import { buildBackendEnvironment, resolveDesktopRuntimePaths } from '../src/desktop/runtime.js';
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

    expect(paths.databasePath).toBe('/home/tester/.local/share/omnimemory/omnimemory.sqlite');
    expect(paths.port).toBe(3321);
    expect(paths.backendEntryPoint).toBe('/opt/omnimemory/dist/src/desktop/backend-worker.js');
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

    expect(paths.databasePath).toBe('/var/lib/omnimemory/custom.sqlite');
    expect(paths.backendEntryPoint).toBe(
      '/opt/omnimemory/resources/app.asar.unpacked/dist/src/desktop/backend-worker.js',
    );
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
        return {
          ok: healthChecks > 1,
          status: healthChecks > 1 ? 200 : 503,
          json: async () => ({ data: { status: 'ok' } }),
        };
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
        return { ok: false, status: 503, json: async () => ({}) };
      },
    });

    await expect(manager.start()).rejects.toThrow('backend exited during startup');
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

    await expect(manager.start()).rejects.toThrow('did not become ready');
    expect(child.killCalls).toBe(1);
    expect(manager.isReady).toBe(false);
  });
});

describe('packaged static asset configuration', () => {
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
