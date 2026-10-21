import { openDatabase } from '../src/database/database.js';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/logging.js';
import { AuthService } from '../src/security/auth.js';

const config = loadConfig();
const database = openDatabase(config.databasePath);
const auth = new AuthService(database, createLogger(config.logLevel), {
  sessionTtlMs: config.sessionTtlMs,
  idleSessionTtlMs: config.idleSessionTtlMs,
  enrollmentTtlMs: config.enrollmentTtlMs,
  setupCodeTtlMs: config.setupCodeTtlMs,
});

try {
  const setupCode = auth.createSetupCode();
  console.log(`Setup code (displayed once): ${setupCode.code}`);
  console.log(`Expires at: ${new Date(setupCode.expiresAt).toISOString()}`);
} finally {
  database.close();
}
