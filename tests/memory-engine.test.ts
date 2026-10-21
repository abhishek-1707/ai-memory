import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openDatabase } from '../src/database/database.js';
import { ConflictError, DatabaseError, NotFoundError, ValidationError } from '../src/errors.js';
import { createLogger } from '../src/logging.js';
import { MemoryEngine } from '../src/memory/engine.js';
import type { Project } from '../src/memory/types.js';

const resources: Array<{ engine: MemoryEngine; directory: string }> = [];

afterEach(() => {
  for (const resource of resources.splice(0)) {
    try {
      resource.engine.close();
    } catch {
      // A test may have already closed the engine while checking unavailable behavior.
    }
    rmSync(resource.directory, { recursive: true, force: true });
  }
});

describe('database migrations', () => {
  it('applies migrations on a fresh database and is idempotent on reopen', () => {
    const directory = mkdtempSync(join(tmpdir(), 'omnimemory-migrations-'));
    const databasePath = join(directory, 'memory.sqlite');
    const first = openDatabase(databasePath);
    const firstRows = first.prepare('SELECT version, name FROM schema_migrations').all();
    first.close();

    const second = openDatabase(databasePath);
    const secondRows = second.prepare('SELECT version, name FROM schema_migrations').all();
    second.close();
    rmSync(directory, { recursive: true, force: true });

    expect(firstRows).toEqual([
      { version: 1, name: 'initial_memory_engine' },
      { version: 2, name: 'local_auth_devices_permissions_audit' },
      { version: 3, name: 'write_idempotency_keys' },
    ]);
    expect(secondRows).toEqual(firstRows);
  });
});

describe('MemoryEngine', () => {
  it('creates and retrieves a memory with provenance', () => {
    const { engine } = createTestEngine();
    const project = createProject(engine, 'Project A');
    const memory = engine.createMemory({
      projectId: project.id,
      recordType: 'finding',
      title: 'Database choice',
      content: 'SQLite is the primary local database.',
      provenance: {
        sourceKind: 'user_provided',
        verificationStatus: 'user_confirmed',
        sourceReference: 'test input',
      },
    });

    expect(memory.version).toBe(1);
    expect(memory.projectId).toBe(project.id);
    expect(memory.provenance.sourceKind).toBe('user_provided');
    expect(engine.getMemory(memory.id)).toEqual(memory);
  });

  it('searches current content with FTS5 and scopes results by project', () => {
    const { engine } = createTestEngine();
    const projectA = createProject(engine, 'Project A');
    const projectB = createProject(engine, 'Project B');
    const create = (projectId: string, content: string) =>
      engine.createMemory({
        projectId,
        recordType: 'project_fact',
        title: 'Storage',
        content,
        provenance: {
          sourceKind: 'system_observed',
          verificationStatus: 'unverified',
        },
      });

    create(projectA.id, 'SQLite is used here.');
    create(projectB.id, 'SQLite is used there.');

    const results = engine.searchMemory({ query: 'SQLite', projectId: projectA.id });
    expect(results).toHaveLength(1);
    expect(results[0]?.projectId).toBe(projectA.id);
  });

  it('updates records with optimistic versioning and preserves history', () => {
    const { engine } = createTestEngine();
    const project = createProject(engine, 'Project A');
    const memory = engine.createMemory({
      projectId: project.id,
      recordType: 'note',
      title: 'Current database',
      content: 'SQLite is used for persistence.',
      provenance: {
        sourceKind: 'user_provided',
        verificationStatus: 'unverified',
      },
    });

    const updated = engine.updateMemory(memory.id, {
      expectedVersion: 1,
      content: 'SQLite with FTS5 is used for persistence and search.',
      provenance: {
        sourceKind: 'test_result',
        verificationStatus: 'test_verified',
        verificationMethod: 'integration test',
      },
      changeReason: 'Confirm full-text search support',
    });

    expect(updated.version).toBe(2);
    expect(engine.searchMemory({ query: 'persistence' })).toHaveLength(1);
    expect(engine.searchMemory({ query: 'FTS5' })).toHaveLength(1);
    expect(engine.getMemoryHistory({ id: memory.id })).toMatchObject([
      { version: 1, content: 'SQLite is used for persistence.' },
      { version: 2, content: 'SQLite with FTS5 is used for persistence and search.' },
    ]);

    expect(() =>
      engine.updateMemory(memory.id, {
        expectedVersion: 1,
        content: 'This stale write must not win.',
        provenance: {
          sourceKind: 'agent_inferred',
          verificationStatus: 'unverified',
        },
      }),
    ).toThrow(ConflictError);
    expect(engine.getMemory(memory.id).content).toContain('FTS5');
    expect(engine.getMemoryHistory({ id: memory.id })).toHaveLength(2);
  });

  it('does not return old content after an update', () => {
    const { engine } = createTestEngine();
    const memory = engine.createMemory({
      recordType: 'finding',
      title: 'Searchable record',
      content: 'The old engine was SQLite.',
      provenance: {
        sourceKind: 'user_provided',
        verificationStatus: 'unverified',
      },
    });

    engine.updateMemory(memory.id, {
      expectedVersion: 1,
      content: 'The current engine is PostgreSQL.',
      provenance: {
        sourceKind: 'user_provided',
        verificationStatus: 'unverified',
      },
    });

    expect(engine.searchMemory({ query: 'SQLite' })).toHaveLength(0);
    expect(engine.searchMemory({ query: 'PostgreSQL' })).toHaveLength(1);
  });

  it('lists recent memories and survives database reopen', () => {
    const directory = mkdtempSync(join(tmpdir(), 'omnimemory-persistence-'));
    const databasePath = join(directory, 'memory.sqlite');
    const firstDatabase = openDatabase(databasePath);
    const firstEngine = new MemoryEngine(firstDatabase, createLogger('error'));
    const memory = firstEngine.createMemory({
      recordType: 'note',
      title: 'Persistent record',
      content: 'This record survives reopening the database.',
      provenance: {
        sourceKind: 'test_result',
        verificationStatus: 'test_verified',
      },
    });
    expect(firstEngine.listRecentMemories()).toHaveLength(1);
    firstEngine.close();

    const secondDatabase = openDatabase(databasePath);
    const secondEngine = new MemoryEngine(secondDatabase, createLogger('error'));
    expect(secondEngine.getMemory(memory.id).content).toContain('survives');
    secondEngine.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('rejects invalid input, secret-shaped text, and missing projects', () => {
    const { engine } = createTestEngine();

    expect(() =>
      engine.createMemory({
        recordType: 'note',
        title: '',
        content: 'Invalid title',
        provenance: {
          sourceKind: 'user_provided',
          verificationStatus: 'unverified',
        },
      }),
    ).toThrow(ValidationError);

    expect(() =>
      engine.createMemory({
        recordType: 'note',
        title: 'Credential',
        content: 'api_key=do-not-store-this-value',
        provenance: {
          sourceKind: 'user_provided',
          verificationStatus: 'unverified',
        },
      }),
    ).toThrow(ValidationError);

    expect(() =>
      engine.createMemory({
        projectId: '00000000-0000-0000-0000-000000000000',
        recordType: 'note',
        title: 'Missing project',
        content: 'This should fail.',
        provenance: {
          sourceKind: 'user_provided',
          verificationStatus: 'unverified',
        },
      }),
    ).toThrow(NotFoundError);
  });

  it('fails safely when the database is unavailable', () => {
    const { engine } = createTestEngine();
    const memory = engine.createMemory({
      recordType: 'note',
      title: 'Unavailable database test',
      content: 'The database will be closed before the read.',
      provenance: {
        sourceKind: 'test_result',
        verificationStatus: 'test_verified',
      },
    });
    engine.close();

    expect(() => engine.getMemory(memory.id)).toThrow(DatabaseError);
  });
});

function createTestEngine(): { engine: MemoryEngine; directory: string } {
  const directory = mkdtempSync(join(tmpdir(), 'omnimemory-test-'));
  const database = openDatabase(join(directory, 'memory.sqlite'));
  const engine = new MemoryEngine(database, createLogger('error'));
  resources.push({ engine, directory });
  return { engine, directory };
}

function createProject(engine: MemoryEngine, name: string): Project {
  return engine.createProject({ name });
}
