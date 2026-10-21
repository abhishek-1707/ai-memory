import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { MigrationError } from '../errors.js';
import { migrations } from './migrations.js';

export type SqlRow = Record<string, unknown>;

export function openDatabase(databasePath: string): DatabaseSync {
  try {
    if (databasePath !== ':memory:') {
      mkdirSync(dirname(databasePath), { recursive: true });
    }

    const database = new DatabaseSync(databasePath);
    database.exec('PRAGMA foreign_keys = ON;');
    database.exec('PRAGMA journal_mode = WAL;');
    database.exec('PRAGMA busy_timeout = 5000;');
    applyMigrations(database);
    return database;
  } catch (error) {
    throw new MigrationError(`Unable to open or migrate database: ${databasePath}`, error);
  }
}

export function applyMigrations(database: DatabaseSync): void {
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);

    const appliedVersions = new Set(
      database
        .prepare('SELECT version FROM schema_migrations ORDER BY version')
        .all()
        .map((row) => Number((row as SqlRow).version)),
    );

    for (const migration of migrations) {
      if (appliedVersions.has(migration.version)) {
        continue;
      }

      database.exec('BEGIN IMMEDIATE;');
      try {
        database.exec(migration.sql);
        database
          .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
          .run(migration.version, migration.name, new Date().toISOString());
        database.exec('COMMIT;');
      } catch (error) {
        database.exec('ROLLBACK;');
        throw error;
      }
    }
  } catch (error) {
    throw new MigrationError('Database migration failed', error);
  }
}

export function runInTransaction<T>(database: DatabaseSync, operation: () => T): T {
  database.exec('BEGIN IMMEDIATE;');
  try {
    const result = operation();
    database.exec('COMMIT;');
    return result;
  } catch (error) {
    try {
      database.exec('ROLLBACK;');
    } catch {
      // Preserve the original error; the connection may already be unavailable.
    }
    throw error;
  }
}
