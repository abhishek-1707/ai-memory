import type { LogLevel } from './config.js';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface Logger {
  debug(event: string, fields?: Readonly<Record<string, unknown>>): void;
  info(event: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(event: string, fields?: Readonly<Record<string, unknown>>): void;
  error(event: string, fields?: Readonly<Record<string, unknown>>): void;
}

function writeLog(
  level: LogLevel,
  minimumLevel: LogLevel,
  event: string,
  fields: Readonly<Record<string, unknown>> = {},
): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minimumLevel]) {
    return;
  }

  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    event,
    ...fields,
  });

  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export function createLogger(minimumLevel: LogLevel = 'info'): Logger {
  return {
    debug: (event, fields) => writeLog('debug', minimumLevel, event, fields),
    info: (event, fields) => writeLog('info', minimumLevel, event, fields),
    warn: (event, fields) => writeLog('warn', minimumLevel, event, fields),
    error: (event, fields) => writeLog('error', minimumLevel, event, fields),
  };
}
