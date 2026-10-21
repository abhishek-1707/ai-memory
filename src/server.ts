import { buildApp } from './api/app.js';
import { loadConfig } from './config.js';
import { createLogger } from './logging.js';

const config = loadConfig();
const logger = createLogger(config.logLevel);
const app = await buildApp({ config, logger });

const shutdown = async (signal: string): Promise<void> => {
  logger.info('server_shutdown_started', { signal });
  await app.close();
  logger.info('server_shutdown_completed', { signal });
};

process.once('SIGINT', () => {
  void shutdown('SIGINT').then(() => process.exit(0));
});
process.once('SIGTERM', () => {
  void shutdown('SIGTERM').then(() => process.exit(0));
});

try {
  await app.listen({ host: config.host, port: config.port });
  logger.info('server_started', { host: config.host, port: config.port });
} catch (error) {
  logger.error('server_start_failed', { error: error instanceof Error ? error.name : 'unknown' });
  await app.close();
  process.exitCode = 1;
}
