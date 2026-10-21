import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/database/database.js';
import { ConflictError, ValidationError } from '../src/errors.js';
import { createLogger } from '../src/logging.js';
import { MemoryEngine } from '../src/memory/engine.js';
import { AuthService } from '../src/security/auth.js';
import { TaskTrackingService } from '../src/tasks/service.js';

interface Fixture {
  directory: string;
  database: ReturnType<typeof openDatabase>;
  projectId: string;
  deviceId: string;
}

const resources: Fixture[] = [];

afterEach(() => {
  for (const resource of resources.splice(0)) {
    try {
      resource.database.close();
    } catch {
      // Persistence checks may already have closed the original connection.
    }
    rmSync(resource.directory, { recursive: true, force: true });
  }
});

describe('TaskTrackingService', () => {
  it('creates, updates, transitions, and persists tasks with immutable handoffs', async () => {
    const fixture = await createFixture();
    const logger = createLogger('error');
    const memoryEngine = new MemoryEngine(fixture.database, logger);
    const tasks = new TaskTrackingService(fixture.database, logger);
    const memory = memoryEngine.createMemory({
      projectId: fixture.projectId,
      recordType: 'finding',
      title: 'Evidence',
      content: 'The task is supported by a project-scoped memory.',
      provenance: { sourceKind: 'test_result', verificationStatus: 'test_verified' },
    });

    const created = tasks.createTask({
      projectId: fixture.projectId,
      title: 'Implement handoffs',
      description: 'Coordinate the next agent through a bounded record.',
      priority: 'high',
      createdByDeviceId: fixture.deviceId,
      linkedMemoryIds: [memory.id],
      evidenceReferences: ['tests/tasks.test.ts'],
      idempotencyKey: 'task-create-1',
    });
    expect(created).toMatchObject({
      projectId: fixture.projectId,
      status: 'todo',
      priority: 'high',
      version: 1,
      linkedMemoryIds: [memory.id],
    });

    const repeated = tasks.createTask({
      projectId: fixture.projectId,
      title: 'Implement handoffs',
      description: 'Coordinate the next agent through a bounded record.',
      priority: 'high',
      createdByDeviceId: fixture.deviceId,
      linkedMemoryIds: [memory.id],
      evidenceReferences: ['tests/tasks.test.ts'],
      idempotencyKey: 'task-create-1',
    });
    expect(repeated.id).toBe(created.id);

    const updated = tasks.updateTask(created.id, {
      expectedVersion: 1,
      actorDeviceId: fixture.deviceId,
      title: 'Implement structured handoffs',
      idempotencyKey: 'task-update-1',
    });
    expect(updated).toMatchObject({ title: 'Implement structured handoffs', version: 2 });

    expect(() =>
      tasks.updateTask(created.id, {
        expectedVersion: 1,
        actorDeviceId: fixture.deviceId,
        description: 'This stale update must not overwrite the task.',
      }),
    ).toThrow(ConflictError);

    const started = tasks.transitionTask(created.id, {
      expectedVersion: 2,
      status: 'in_progress',
      actorDeviceId: fixture.deviceId,
      note: 'Work started after reviewing the evidence.',
      idempotencyKey: 'task-transition-1',
    });
    expect(started).toMatchObject({ status: 'in_progress', version: 3 });

    const blocked = tasks.transitionTask(created.id, {
      expectedVersion: 3,
      status: 'blocked',
      actorDeviceId: fixture.deviceId,
      note: 'Waiting for the next agent.',
    });
    expect(blocked).toMatchObject({ status: 'blocked', version: 4 });

    expect(() =>
      tasks.transitionTask(created.id, {
        expectedVersion: 4,
        status: 'completed',
        actorDeviceId: fixture.deviceId,
      }),
    ).toThrow(ConflictError);

    const resumed = tasks.transitionTask(created.id, {
      expectedVersion: 4,
      status: 'in_progress',
      actorDeviceId: fixture.deviceId,
    });
    const completed = tasks.transitionTask(created.id, {
      expectedVersion: resumed.version,
      status: 'completed',
      actorDeviceId: fixture.deviceId,
    });
    expect(completed.status).toBe('completed');

    const handoff = tasks.createHandoff({
      projectId: fixture.projectId,
      taskId: created.id,
      sourceDeviceId: fixture.deviceId,
      summary: 'The implementation is ready for review.',
      completedWork: ['Added task persistence and status transitions.'],
      verifiedResults: ['Task workflow test passes.'],
      blockers: [],
      nextSteps: ['Review the API and MCP adapters.'],
      evidenceReferences: ['tests/tasks.test.ts'],
      linkedMemoryIds: [memory.id],
      linkedTaskIds: [created.id],
      verificationStatus: 'verified',
      idempotencyKey: 'handoff-create-1',
    });
    expect(handoff).toMatchObject({
      projectId: fixture.projectId,
      taskId: created.id,
      verificationStatus: 'verified',
    });
    expect(
      tasks.createHandoff({
        projectId: fixture.projectId,
        taskId: created.id,
        sourceDeviceId: fixture.deviceId,
        summary: 'The implementation is ready for review.',
        completedWork: ['Added task persistence and status transitions.'],
        verifiedResults: ['Task workflow test passes.'],
        blockers: [],
        nextSteps: ['Review the API and MCP adapters.'],
        evidenceReferences: ['tests/tasks.test.ts'],
        linkedMemoryIds: [memory.id],
        linkedTaskIds: [created.id],
        verificationStatus: 'verified',
        idempotencyKey: 'handoff-create-1',
      }).id,
    ).toBe(handoff.id);

    expect(tasks.listTasks({ projectId: fixture.projectId })).toHaveLength(1);
    expect(tasks.listHandoffs({ projectId: fixture.projectId })).toHaveLength(1);
    expect(
      fixture.database
        .prepare('SELECT COUNT(*) AS count FROM task_status_history WHERE task_id = ?')
        .get(created.id),
    ).toMatchObject({ count: 4 });

    fixture.database.close();
    fixture.database = openDatabase(join(fixture.directory, 'memory.sqlite'));
    const reopened = new TaskTrackingService(fixture.database, logger);
    expect(reopened.getTask(created.id)).toMatchObject({ status: 'completed', version: 6 });
    expect(reopened.getHandoff(handoff.id).id).toBe(handoff.id);

    expect(() =>
      fixture.database
        .prepare('UPDATE handoffs SET summary = ? WHERE id = ?')
        .run('mutated', handoff.id),
    ).toThrow();
    expect(() =>
      fixture.database.prepare('DELETE FROM handoffs WHERE id = ?').run(handoff.id),
    ).toThrow();
  });

  it('rejects invalid verification, secrets, and cross-project links', async () => {
    const fixture = await createFixture();
    const logger = createLogger('error');
    const memoryEngine = new MemoryEngine(fixture.database, logger);
    const tasks = new TaskTrackingService(fixture.database, logger);
    const otherProject = memoryEngine.createProject({ name: `Other ${Date.now()}` });
    const otherMemory = memoryEngine.createMemory({
      projectId: otherProject.id,
      recordType: 'note',
      title: 'Other evidence',
      content: 'This belongs to a different project.',
      provenance: { sourceKind: 'user_provided', verificationStatus: 'unverified' },
    });

    expect(() =>
      tasks.createHandoff({
        projectId: fixture.projectId,
        sourceDeviceId: fixture.deviceId,
        summary: 'Unverified claim',
        completedWork: ['Work claimed without evidence.'],
        nextSteps: ['Add evidence.'],
        verificationStatus: 'verified',
      }),
    ).toThrow(ValidationError);

    const secret = 'api_key=synthetic-task-secret';
    expect(() =>
      tasks.createTask({
        projectId: fixture.projectId,
        title: 'Do not store credentials',
        description: secret,
        priority: 'normal',
        createdByDeviceId: fixture.deviceId,
      }),
    ).toThrow(ValidationError);

    expect(() =>
      tasks.createTask({
        projectId: fixture.projectId,
        title: 'Cross-project link',
        priority: 'normal',
        createdByDeviceId: fixture.deviceId,
        linkedMemoryIds: [otherMemory.id],
      }),
    ).toThrow(ConflictError);
  });
});

async function createFixture(): Promise<Fixture> {
  const directory = mkdtempSync(join(tmpdir(), 'omnimemory-tasks-'));
  const database = openDatabase(join(directory, 'memory.sqlite'));
  const logger = createLogger('error');
  const config = loadConfig();
  const auth = new AuthService(database, logger, {
    sessionTtlMs: config.sessionTtlMs,
    idleSessionTtlMs: config.idleSessionTtlMs,
    enrollmentTtlMs: config.enrollmentTtlMs,
    setupCodeTtlMs: config.setupCodeTtlMs,
  });
  const session = await auth.setupOwner({
    setupCode: auth.createSetupCode().code,
    password: 'correct horse battery staple',
    deviceName: 'Task Test Device',
    deviceType: 'test',
    requestId: 'tasks-test-setup',
  });
  const project = new MemoryEngine(database, logger).createProject({ name: `Task ${Date.now()}` });
  const fixture = { directory, database, projectId: project.id, deviceId: session.deviceId };
  resources.push(fixture);
  return fixture;
}
