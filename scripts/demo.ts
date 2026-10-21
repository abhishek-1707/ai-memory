import { resolve } from 'node:path';

import { openDatabase } from '../src/database/database.js';
import { createLogger } from '../src/logging.js';
import { MemoryEngine } from '../src/memory/engine.js';

const databasePath = resolve(
  process.env.OMNIMEMORY_DEMO_DB_PATH ?? './data/omnimemory-demo.sqlite',
);
const database = openDatabase(databasePath);
const engine = new MemoryEngine(database, createLogger('info'));

try {
  const existingProject = engine.getProjectByName('OmniMemory Demo');
  const project =
    existingProject ??
    engine.createProject({
      name: 'OmniMemory Demo',
      description: 'Synthetic Phase 2 demonstration project',
    });

  const existingMemory = engine
    .searchMemory({ query: 'SQLite', projectId: project.id, limit: 10 })
    .find((memory) => memory.title === 'Primary local database');

  const memory =
    existingMemory ??
    engine.createMemory({
      projectId: project.id,
      recordType: 'project_fact',
      title: 'Primary local database',
      content: 'OmniMemory uses SQLite as its primary local database.',
      provenance: {
        sourceKind: 'user_provided',
        verificationStatus: 'user_confirmed',
        sourceReference: 'Phase 2 synthetic demonstration',
      },
    });

  const searchResults = engine.searchMemory({
    query: 'SQLite',
    projectId: project.id,
  });
  const retrieved = engine.getMemory(memory.id);
  const updated = retrieved.content.includes('FTS5')
    ? retrieved
    : engine.updateMemory(memory.id, {
        expectedVersion: retrieved.version,
        content: 'OmniMemory uses SQLite as its primary local database, with FTS5 lexical search.',
        provenance: {
          sourceKind: 'system_observed',
          verificationStatus: 'test_verified',
          sourceReference: 'Phase 2 synthetic demonstration',
          verificationMethod: 'Local demonstration execution',
        },
        changeReason: 'Document FTS5 support after the search demonstration',
      });
  const history = engine.getMemoryHistory({ id: updated.id });

  console.log(`Project: ${project.name} (${project.id})`);
  console.log(`Search results for SQLite: ${searchResults.length}`);
  console.log(`Retrieved record: ${retrieved.id}, version ${retrieved.version}`);
  console.log(`Current record: version ${updated.version}`);
  console.log(`History versions: ${history.map((entry) => entry.version).join(', ')}`);

  engine.close();
  const reopenedDatabase = openDatabase(databasePath);
  const reopenedEngine = new MemoryEngine(reopenedDatabase, createLogger('warn'));
  const persisted = reopenedEngine.getMemory(updated.id);
  console.log(`Reopened record: ${persisted.id}, version ${persisted.version}`);
  console.log('DEMO_OK');
  reopenedEngine.close();
} catch (error) {
  try {
    engine.close();
  } catch {
    // The original error is the useful failure for the development demonstration.
  }
  throw error;
}
