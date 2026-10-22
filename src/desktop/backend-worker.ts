import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import { buildApp } from '../api/app.js';
import { loadConfig } from '../config.js';
import { createLogger } from '../logging.js';

export async function runBackend(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info('desktop_backend_shutdown_started', { signal });
    if (app !== undefined) {
      await app.close();
    }
    logger.info('desktop_backend_shutdown_completed', { signal });
  };

  process.once('SIGINT', () => {
    void shutdown('SIGINT').then(() => process.exit(0));
  });
  process.once('SIGTERM', () => {
    void shutdown('SIGTERM').then(() => process.exit(0));
  });

  try {
    app = await buildApp({ config, logger });
    await app.listen({ host: config.host, port: config.port });
    logger.info('desktop_backend_started', { host: config.host, port: config.port });
  } catch (error) {
    logger.error('desktop_backend_start_failed', {
      error: error instanceof Error ? error.name : 'unknown',
    });
    if (app !== undefined) {
      await app.close();
    }
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] === undefined ? '' : resolve(process.argv[1]);
if (invokedPath === fileURLToPath(import.meta.url)) {
  void runBackend();
}
