import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { openDatabase } from '../src/database/database.js';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/logging.js';
import { createMcpServer } from '../src/mcp/server.js';

const config = loadConfig();
const token = process.env.OMNIMEMORY_MCP_TOKEN?.trim();

if (token === undefined || token.length === 0) {
  console.error('OMNIMEMORY_MCP_TOKEN is required');
  process.exitCode = 1;
} else {
  try {
    const database = openDatabase(config.databasePath);
    const logger = createLogger(config.logLevel);
    const server = createMcpServer({ token, database, config, logger });
    const handle = serveStdio(() => server, {
      onerror: (error) => logger.error('mcp_stdio_error', { error: error.name }),
    });

    let closed = false;
    const close = (): void => {
      if (closed) {
        return;
      }
      closed = true;
      void handle.close().finally(() => database.close());
    };

    process.stdin.once('end', close);
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
  } catch {
    console.error('Unable to start the OmniMemory MCP server');
    process.exitCode = 1;
  }
}
