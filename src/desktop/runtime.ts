import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';

export interface DesktopRuntimePaths {
  readonly appRoot: string;
  readonly userDataDirectory: string;
  readonly publicDirectory: string;
  readonly backendEntryPoint: string;
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

  const databasePath =
    databaseOverride === undefined || databaseOverride.length === 0
      ? join(options.userDataDirectory, 'omnimemory.sqlite')
      : resolve(databaseOverride);

  return {
    appRoot: options.appRoot,
    userDataDirectory: options.userDataDirectory,
    publicDirectory: join(options.appRoot, 'public'),
    backendEntryPoint: join(backendRoot, 'desktop', 'backend-worker.js'),
    mcpEntryPoint: join(backendRoot, 'scripts', 'mcp-stdio.js'),
    databasePath,
    port,
    url: `http://127.0.0.1:${port}`,
    startupToken: randomBytes(32).toString('hex'),
  };
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
