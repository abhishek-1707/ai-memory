import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export type DesktopStartupFailureCategory =
  'backend_executable_not_found' | 'backend_entry_point_missing' | 'data_directory_inaccessible';

export class DesktopRuntimeError extends Error {
  public readonly category: DesktopStartupFailureCategory;

  public constructor(category: DesktopStartupFailureCategory) {
    super(category);
    this.name = 'DesktopRuntimeError';
    this.category = category;
  }
}

export interface DesktopRuntimePaths {
  readonly appRoot: string;
  readonly userDataDirectory: string;
  readonly publicDirectory: string;
  readonly backendEntryPoint: string;
  readonly backendWorkingDirectory: string;
  readonly mcpEntryPoint: string;
  readonly databasePath: string;
  readonly port: number;
  readonly url: string;
  readonly startupToken: string;
}

export interface DesktopRuntimePathOptions {
  readonly appRoot: string;
  readonly userDataDirectory: string;
  readonly resourcesDirectory?: string;
  readonly packaged: boolean;
  readonly env?: NodeJS.ProcessEnv;
}

export function resolveDesktopRuntimePaths(
  options: DesktopRuntimePathOptions,
): DesktopRuntimePaths {
  const env = options.env ?? process.env;
  const databaseOverride = env.OMNIMEMORY_DB_PATH?.trim();
  const port = parsePositiveInt(env.OMNIMEMORY_PORT, 3210);
  const backendRoot = options.packaged
    ? join(options.resourcesDirectory ?? options.appRoot, 'app.asar.unpacked', 'dist', 'src')
    : join(options.appRoot, 'dist', 'src');
  const backendWorkingDirectory = options.packaged
    ? join(options.resourcesDirectory ?? options.appRoot, 'app.asar.unpacked')
    : options.appRoot;

  const databasePath =
    databaseOverride === undefined || databaseOverride.length === 0
      ? join(options.userDataDirectory, 'omnimemory.sqlite')
      : resolve(databaseOverride);

  return {
    appRoot: options.appRoot,
    userDataDirectory: options.userDataDirectory,
    publicDirectory: join(options.appRoot, 'public'),
    backendEntryPoint: join(backendRoot, 'desktop', 'backend-worker.js'),
    backendWorkingDirectory,
    mcpEntryPoint: join(backendRoot, 'scripts', 'mcp-stdio.js'),
    databasePath,
    port,
    url: `http://127.0.0.1:${port}`,
    startupToken: randomBytes(32).toString('hex'),
  };
}

export function ensureDesktopRuntime(paths: DesktopRuntimePaths, executablePath: string): void {
  if (!existsSync(executablePath)) {
    throw new DesktopRuntimeError('backend_executable_not_found');
  }
  if (!existsSync(paths.backendEntryPoint)) {
    throw new DesktopRuntimeError('backend_entry_point_missing');
  }

  try {
    ensureWritableDirectory(paths.userDataDirectory);
    ensureWritableDirectory(dirname(paths.databasePath));
  } catch {
    throw new DesktopRuntimeError('data_directory_inaccessible');
  }
}

function ensureWritableDirectory(directory: string): void {
  mkdirSync(directory, { recursive: true });
  const probePath = join(directory, `.omnimemory-write-test-${process.pid}-${Date.now()}`);
  writeFileSync(probePath, 'ok', { flag: 'wx' });
  unlinkSync(probePath);
}

export function buildBackendEnvironment(
  paths: DesktopRuntimePaths,
  baseEnvironment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...baseEnvironment,
    OMNIMEMORY_DB_PATH: paths.databasePath,
    OMNIMEMORY_HOST: '127.0.0.1',
    OMNIMEMORY_PORT: String(paths.port),
    OMNIMEMORY_PUBLIC_DIRECTORY: paths.publicDirectory,
    OMNIMEMORY_STARTUP_TOKEN: paths.startupToken,
  };
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
