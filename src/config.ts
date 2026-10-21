import { resolve } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface AppConfig {
  readonly databasePath: string;
  readonly logLevel: LogLevel;
  readonly host: string;
  readonly port: number;
  readonly requestBodyLimitBytes: number;
  readonly sessionTtlMs: number;
  readonly idleSessionTtlMs: number;
  readonly enrollmentTtlMs: number;
  readonly setupCodeTtlMs: number;
  readonly authRateLimitMax: number;
}

function parseLogLevel(value: string | undefined): LogLevel {
  if (value === 'debug' || value === 'info' || value === 'warn' || value === 'error') {
    return value;
  }
  return 'info';
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const databasePath = env.OMNIMEMORY_DB_PATH?.trim() || './data/omnimemory.sqlite';

  return {
    databasePath: resolve(databasePath),
    logLevel: parseLogLevel(env.OMNIMEMORY_LOG_LEVEL),
    host: env.OMNIMEMORY_HOST?.trim() || '127.0.0.1',
    port: parsePositiveInt(env.OMNIMEMORY_PORT, 3210),
    requestBodyLimitBytes: parsePositiveInt(env.OMNIMEMORY_REQUEST_BODY_LIMIT, 256 * 1024),
    sessionTtlMs: parsePositiveInt(env.OMNIMEMORY_SESSION_TTL_MS, 30 * 24 * 60 * 60 * 1000),
    idleSessionTtlMs: parsePositiveInt(env.OMNIMEMORY_IDLE_SESSION_TTL_MS, 24 * 60 * 60 * 1000),
    enrollmentTtlMs: parsePositiveInt(env.OMNIMEMORY_ENROLLMENT_TTL_MS, 10 * 60 * 1000),
    setupCodeTtlMs: parsePositiveInt(env.OMNIMEMORY_SETUP_CODE_TTL_MS, 10 * 60 * 1000),
    authRateLimitMax: parsePositiveInt(env.OMNIMEMORY_AUTH_RATE_LIMIT_MAX, 5),
  };
}
