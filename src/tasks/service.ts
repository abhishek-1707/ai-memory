import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { runInTransaction, type SqlRow } from '../database/database.js';
import { ConflictError, DatabaseError, NotFoundError, isOmniMemoryError } from '../errors.js';
import { assertSafeText } from '../memory/validation.js';
import type { Logger } from '../logging.js';
import type {
  CreateHandoffInput,
  CreateTaskInput,
  HandoffRecord,
  ListHandoffsInput,
  ListTasksInput,
  TaskPriority,
  TaskRecord,
  TaskStatus,
  TaskTrackingServiceDependencies,
  TransitionTaskInput,
  UpdateTaskInput,
} from './types.js';
import {
  parseCreateHandoffInput,
  parseCreateTaskInput,
  parseHandoffId,
  parseListHandoffsInput,
  parseListTasksInput,
  parseTaskId,
  parseTransitionTaskInput,
  parseUpdateTaskInput,
} from './validation.js';

interface TaskRow extends SqlRow {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  created_by_device_id: string;
  assigned_device_id: string | null;
  due_date: string | null;
  linked_memory_ids_json: string;
  evidence_references_json: string;
  version: number;
  created_at: string;
  updated_at: string;
}

interface HandoffRow extends SqlRow {
  id: string;
  project_id: string;
  task_id: string | null;
  source_device_id: string;
  destination_device_id: string | null;
  summary: string;
  completed_work_json: string;
  verified_results_json: string;
  blockers_json: string;
  next_steps_json: string;
  evidence_references_json: string;
  linked_memory_ids_json: string;
  linked_task_ids_json: string;
  verification_status: HandoffRecord['verificationStatus'];
  created_at: string;
}

interface IdempotencyRow extends SqlRow {
  request_hash: string;
  resource_type: string;
  resource_id: string;
  resource_version: number;
  expires_at: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const VALID_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  todo: ['in_progress', 'blocked', 'cancelled'],
  in_progress: ['todo', 'blocked', 'completed', 'cancelled'],
  blocked: ['in_progress', 'cancelled'],
  completed: [],
  cancelled: [],
};

export class TaskTrackingService {
  private readonly now: () => string;
  private readonly createId: () => string;

  public constructor(
    private readonly database: DatabaseSync,
    private readonly logger: Logger,
    dependencies: TaskTrackingServiceDependencies = {},
  ) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.createId = dependencies.createId ?? randomUUID;
  }

  public createTask(input: CreateTaskInput): TaskRecord {
    return this.execute('create_task', () => {
      const parsed = parseCreateTaskInput(input);
      assertSafeText(
        parsed.title,
        parsed.description ?? '',
        ...ensureArray(parsed.evidenceReferences),
      );
      const taskId = this.createId();
      const timestamp = this.now();
      const requestHash = hashRequest(parsed);

      const resourceId = runInTransaction(this.database, () => {
        this.assertProjectExists(parsed.projectId);
        this.assertActiveDevice(parsed.createdByDeviceId);
        if (parsed.assignedDeviceId !== undefined) {
          this.assertAuthorizedProjectDevice(parsed.assignedDeviceId, parsed.projectId);
        }
        this.assertLinkedMemories(parsed.projectId, parsed.linkedMemoryIds ?? []);

        const existing = this.findIdempotency(parsed.idempotencyKey, requestHash, 'task');
        if (existing !== undefined) {
          return existing.resource_id;
        }

        this.reserveIdempotency(parsed.idempotencyKey, requestHash, taskId, 1, 'task');
        this.database
          .prepare(
            `INSERT INTO tasks
              (id, project_id, title, description, status, priority, created_by_device_id,
               assigned_device_id, due_date, linked_memory_ids_json, evidence_references_json,
               version, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'todo', ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
          )
          .run(
            taskId,
            parsed.projectId,
            parsed.title,
            parsed.description ?? null,
            parsed.priority,
            parsed.createdByDeviceId,
            parsed.assignedDeviceId ?? null,
            parsed.dueDate ?? null,
            json(parsed.linkedMemoryIds ?? []),
            json(parsed.evidenceReferences ?? []),
            timestamp,
            timestamp,
          );
        return taskId;
      });

      this.logger.info('task_created', { taskId: resourceId, projectId: parsed.projectId });
      return this.readTask(resourceId);
    });
  }

  public listTasks(input: ListTasksInput): readonly TaskRecord[] {
    return this.execute('list_tasks', () => {
      const parsed = parseListTasksInput(input);
      this.assertProjectExists(parsed.projectId);
      const parameters: Array<string | number> = [parsed.projectId];
      const clauses = ['project_id = ?'];
      if (parsed.status !== undefined) {
        clauses.push('status = ?');
        parameters.push(parsed.status);
      }
      if (parsed.assignedDeviceId !== undefined) {
        this.assertAuthorizedProjectDevice(parsed.assignedDeviceId, parsed.projectId);
        clauses.push('assigned_device_id = ?');
        parameters.push(parsed.assignedDeviceId);
      }
      parameters.push(parsed.limit ?? 50);
      const rows = this.database
        .prepare(
          `SELECT id, project_id, title, description, status, priority, created_by_device_id,
                  assigned_device_id, due_date, linked_memory_ids_json, evidence_references_json,
                  version, created_at, updated_at
           FROM tasks WHERE ${clauses.join(' AND ')}
           ORDER BY updated_at DESC, id ASC LIMIT ?`,
        )
        .all(...parameters) as TaskRow[];
      return rows.map(toTaskRecord);
    });
  }

  public getTask(id: string): TaskRecord {
    return this.execute('get_task', () => this.readTask(parseTaskId(id)));
  }

  public updateTask(id: string, input: UpdateTaskInput): TaskRecord {
    return this.execute('update_task', () => {
      const taskId = parseTaskId(id);
      const parsed = parseUpdateTaskInput(input);
      const requestHash = hashRequest(parsed);
      const resourceId = runInTransaction(this.database, () => {
        const task = this.readTaskRow(taskId);
        const existing = this.findIdempotency(parsed.idempotencyKey, requestHash, 'task');
        if (existing !== undefined) {
          return existing.resource_id;
        }
        assertSafeText(
          parsed.title ?? task.title,
          parsed.description ?? task.description ?? '',
          ...ensureArray(
            parsed.evidenceReferences ?? parseJsonArray(task.evidence_references_json),
          ),
        );
        this.assertActiveDevice(parsed.actorDeviceId);
        if (task.version !== parsed.expectedVersion) {
          throw staleVersionError('Task', taskId, parsed.expectedVersion, task.version);
        }
        if (parsed.assignedDeviceId !== undefined && parsed.assignedDeviceId !== null) {
          this.assertAuthorizedProjectDevice(parsed.assignedDeviceId, task.project_id);
        }
        if (parsed.linkedMemoryIds !== undefined) {
          this.assertLinkedMemories(task.project_id, parsed.linkedMemoryIds);
        }

        const timestamp = this.now();
        const version = task.version + 1;
        this.reserveIdempotency(parsed.idempotencyKey, requestHash, taskId, version, 'task');
        const result = this.database
          .prepare(
            `UPDATE tasks
             SET title = ?, description = ?, priority = ?, assigned_device_id = ?, due_date = ?,
                 linked_memory_ids_json = ?, evidence_references_json = ?, version = ?, updated_at = ?
             WHERE id = ? AND version = ?`,
          )
          .run(
            parsed.title ?? task.title,
            parsed.description === undefined ? task.description : parsed.description,
            parsed.priority ?? task.priority,
            parsed.assignedDeviceId === undefined
              ? task.assigned_device_id
              : parsed.assignedDeviceId,
            parsed.dueDate === undefined ? task.due_date : parsed.dueDate,
            json(parsed.linkedMemoryIds ?? parseJsonArray(task.linked_memory_ids_json)),
            json(parsed.evidenceReferences ?? parseJsonArray(task.evidence_references_json)),
            version,
            timestamp,
            taskId,
            parsed.expectedVersion,
          );
        if (Number(result.changes) !== 1) {
          throw staleVersionError(
            'Task',
            taskId,
            parsed.expectedVersion,
            this.readTaskRow(taskId).version,
          );
        }
        return taskId;
      });
      const version = this.readTaskRow(resourceId).version;
      this.logger.info('task_updated', { taskId, version });
      return this.readTask(resourceId);
    });
  }

  public transitionTask(id: string, input: TransitionTaskInput): TaskRecord {
    return this.execute('transition_task', () => {
      const taskId = parseTaskId(id);
      const parsed = parseTransitionTaskInput(input);
      const requestHash = hashRequest(parsed);
      const resourceId = runInTransaction(this.database, () => {
        const task = this.readTaskRow(taskId);
        const existing = this.findIdempotency(parsed.idempotencyKey, requestHash, 'task');
        if (existing !== undefined) {
          return existing.resource_id;
        }
        this.assertActiveDevice(parsed.actorDeviceId);
        if (task.version !== parsed.expectedVersion) {
          throw staleVersionError('Task', taskId, parsed.expectedVersion, task.version);
        }
        if (!VALID_TRANSITIONS[task.status].includes(parsed.status)) {
          throw new ConflictError(
            `Invalid task status transition: ${task.status} -> ${parsed.status}`,
            {
              taskId,
              fromStatus: task.status,
              toStatus: parsed.status,
            },
          );
        }
        if (parsed.note !== undefined) {
          assertSafeText(parsed.note);
        }

        const timestamp = this.now();
        const version = task.version + 1;
        this.reserveIdempotency(parsed.idempotencyKey, requestHash, taskId, version, 'task');
        const result = this.database
          .prepare(
            'UPDATE tasks SET status = ?, version = ?, updated_at = ? WHERE id = ? AND version = ?',
          )
          .run(parsed.status, version, timestamp, taskId, parsed.expectedVersion);
        if (Number(result.changes) !== 1) {
          throw staleVersionError(
            'Task',
            taskId,
            parsed.expectedVersion,
            this.readTaskRow(taskId).version,
          );
        }
        this.database
          .prepare(
            `INSERT INTO task_status_history
              (id, task_id, project_id, from_status, to_status, note, actor_device_id, task_version, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            this.createId(),
            taskId,
            task.project_id,
            task.status,
            parsed.status,
            parsed.note ?? null,
            parsed.actorDeviceId,
            version,
            timestamp,
          );
        return taskId;
      });
      const version = this.readTaskRow(resourceId).version;
      this.logger.info('task_transitioned', { taskId, status: parsed.status, version });
      return this.readTask(resourceId);
    });
  }

  public createHandoff(input: CreateHandoffInput): HandoffRecord {
    return this.execute('create_handoff', () => {
      const parsed = parseCreateHandoffInput(input);
      assertSafeText(
        parsed.summary,
        ...parsed.completedWork,
        ...ensureArray(parsed.verifiedResults),
        ...ensureArray(parsed.blockers),
        ...parsed.nextSteps,
        ...ensureArray(parsed.evidenceReferences),
      );
      const handoffId = this.createId();
      const timestamp = this.now();
      const requestHash = hashRequest(parsed);

      const resourceId = runInTransaction(this.database, () => {
        this.assertProjectExists(parsed.projectId);
        this.assertActiveDevice(parsed.sourceDeviceId);
        if (parsed.destinationDeviceId !== undefined) {
          this.assertAuthorizedProjectDevice(parsed.destinationDeviceId, parsed.projectId);
        }
        if (parsed.taskId !== undefined) {
          this.assertTaskProject(parsed.taskId, parsed.projectId);
        }
        this.assertLinkedMemories(parsed.projectId, parsed.linkedMemoryIds ?? []);
        this.assertLinkedTasks(parsed.projectId, parsed.linkedTaskIds ?? []);

        const existing = this.findIdempotency(parsed.idempotencyKey, requestHash, 'handoff');
        if (existing !== undefined) {
          return existing.resource_id;
        }

        this.reserveIdempotency(parsed.idempotencyKey, requestHash, handoffId, 1, 'handoff');
        this.database
          .prepare(
            `INSERT INTO handoffs
              (id, project_id, task_id, source_device_id, destination_device_id, summary,
               completed_work_json, verified_results_json, blockers_json, next_steps_json,
               evidence_references_json, linked_memory_ids_json, linked_task_ids_json,
               verification_status, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            handoffId,
            parsed.projectId,
            parsed.taskId ?? null,
            parsed.sourceDeviceId,
            parsed.destinationDeviceId ?? null,
            parsed.summary,
            json(parsed.completedWork),
            json(parsed.verifiedResults ?? []),
            json(parsed.blockers ?? []),
            json(parsed.nextSteps),
            json(parsed.evidenceReferences ?? []),
            json(parsed.linkedMemoryIds ?? []),
            json(parsed.linkedTaskIds ?? []),
            parsed.verificationStatus,
            timestamp,
          );
        return handoffId;
      });

      this.logger.info('handoff_created', { handoffId: resourceId, projectId: parsed.projectId });
      return this.readHandoff(resourceId);
    });
  }

  public listHandoffs(input: ListHandoffsInput): readonly HandoffRecord[] {
    return this.execute('list_handoffs', () => {
      const parsed = parseListHandoffsInput(input);
      this.assertProjectExists(parsed.projectId);
      const parameters: Array<string | number> = [parsed.projectId];
      const clauses = ['project_id = ?'];
      if (parsed.taskId !== undefined) {
        clauses.push('task_id = ?');
        parameters.push(parsed.taskId);
      }
      if (parsed.verificationStatus !== undefined) {
        clauses.push('verification_status = ?');
        parameters.push(parsed.verificationStatus);
      }
      parameters.push(parsed.limit ?? 50);
      const rows = this.database
        .prepare(
          `SELECT id, project_id, task_id, source_device_id, destination_device_id, summary,
                  completed_work_json, verified_results_json, blockers_json, next_steps_json,
                  evidence_references_json, linked_memory_ids_json, linked_task_ids_json,
                  verification_status, created_at
           FROM handoffs WHERE ${clauses.join(' AND ')}
           ORDER BY created_at DESC, id DESC LIMIT ?`,
        )
        .all(...parameters) as HandoffRow[];
      return rows.map(toHandoffRecord);
    });
  }

  public getHandoff(id: string): HandoffRecord {
    return this.execute('get_handoff', () => this.readHandoff(parseHandoffId(id)));
  }

  private readTask(id: string): TaskRecord {
    return toTaskRecord(this.readTaskRow(id));
  }

  private readTaskRow(id: string): TaskRow {
    const row = this.database
      .prepare(
        `SELECT id, project_id, title, description, status, priority, created_by_device_id,
                assigned_device_id, due_date, linked_memory_ids_json, evidence_references_json,
                version, created_at, updated_at
         FROM tasks WHERE id = ?`,
      )
      .get(id) as TaskRow | undefined;
    if (row === undefined) {
      throw new NotFoundError('Task', id);
    }
    return row;
  }

  private readHandoff(id: string): HandoffRecord {
    const row = this.database
      .prepare(
        `SELECT id, project_id, task_id, source_device_id, destination_device_id, summary,
                completed_work_json, verified_results_json, blockers_json, next_steps_json,
                evidence_references_json, linked_memory_ids_json, linked_task_ids_json,
                verification_status, created_at
         FROM handoffs WHERE id = ?`,
      )
      .get(id) as HandoffRow | undefined;
    if (row === undefined) {
      throw new NotFoundError('Handoff', id);
    }
    return toHandoffRecord(row);
  }

  private assertProjectExists(projectId: string): void {
    if (
      this.database.prepare('SELECT id FROM projects WHERE id = ?').get(projectId) === undefined
    ) {
      throw new NotFoundError('Project', projectId);
    }
  }

  private assertActiveDevice(deviceId: string): void {
    if (
      this.database
        .prepare("SELECT id FROM devices WHERE id = ? AND status = 'active'")
        .get(deviceId) === undefined
    ) {
      throw new NotFoundError('Device', deviceId);
    }
  }

  private assertAuthorizedProjectDevice(deviceId: string, projectId: string): void {
    const row = this.database
      .prepare(
        `SELECT d.id
         FROM devices d
         LEFT JOIN project_permissions pp ON pp.device_id = d.id AND pp.project_id = ?
         WHERE d.id = ? AND d.status = 'active'
           AND (d.role = 'owner' OR pp.device_id IS NOT NULL)`,
      )
      .get(projectId, deviceId);
    if (row === undefined) {
      throw new NotFoundError('Device', deviceId);
    }
  }

  private assertLinkedMemories(projectId: string, memoryIds: readonly string[]): void {
    for (const memoryId of memoryIds) {
      const row = this.database
        .prepare('SELECT id FROM memories WHERE id = ? AND project_id = ?')
        .get(memoryId, projectId);
      if (row === undefined) {
        throw new ConflictError('Linked memory does not belong to the project', {
          memoryId,
          projectId,
        });
      }
    }
  }

  private assertLinkedTasks(projectId: string, taskIds: readonly string[]): void {
    for (const taskId of taskIds) {
      this.assertTaskProject(taskId, projectId);
    }
  }

  private assertTaskProject(taskId: string, projectId: string): void {
    const row = this.database
      .prepare('SELECT id FROM tasks WHERE id = ? AND project_id = ?')
      .get(taskId, projectId);
    if (row === undefined) {
      throw new ConflictError('Linked task does not belong to the project', { taskId, projectId });
    }
  }

  private findIdempotency(
    key: string | undefined,
    requestHash: string,
    resourceType: 'task' | 'handoff',
  ): IdempotencyRow | undefined {
    if (key === undefined) {
      return undefined;
    }
    const row = this.database
      .prepare(
        `SELECT request_hash, resource_type, resource_id, resource_version, expires_at
         FROM idempotency_keys WHERE key = ?`,
      )
      .get(key) as IdempotencyRow | undefined;
    if (row === undefined) {
      return undefined;
    }
    if (row.expires_at <= Date.now()) {
      this.database.prepare('DELETE FROM idempotency_keys WHERE key = ?').run(key);
      return undefined;
    }
    if (row.request_hash !== requestHash || row.resource_type !== resourceType) {
      throw new ConflictError('Idempotency key was reused with a different request');
    }
    return row;
  }

  private reserveIdempotency(
    key: string | undefined,
    requestHash: string,
    resourceId: string,
    resourceVersion: number,
    resourceType: 'task' | 'handoff',
  ): void {
    if (key === undefined) {
      return;
    }
    const createdAt = Date.now();
    this.database
      .prepare(
        `INSERT INTO idempotency_keys
          (key, request_hash, resource_type, resource_id, resource_version, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        key,
        requestHash,
        resourceType,
        resourceId,
        resourceVersion,
        createdAt,
        createdAt + DAY_MS,
      );
  }

  private execute<T>(operation: string, callback: () => T): T {
    try {
      return callback();
    } catch (error) {
      if (isOmniMemoryError(error)) {
        throw error;
      }
      this.logger.error('task_tracking_error', { operation });
      throw new DatabaseError(`Task tracking operation failed: ${operation}`, error);
    }
  }
}

function toTaskRecord(row: TaskRow): TaskRecord {
  const linkedMemoryIds = parseJsonArray(row.linked_memory_ids_json);
  const evidenceReferences = parseJsonArray(row.evidence_references_json);
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    ...(row.description === null ? {} : { description: row.description }),
    status: row.status,
    priority: row.priority,
    createdByDeviceId: row.created_by_device_id,
    ...(row.assigned_device_id === null ? {} : { assignedDeviceId: row.assigned_device_id }),
    ...(row.due_date === null ? {} : { dueDate: row.due_date }),
    linkedMemoryIds,
    evidenceReferences,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toHandoffRecord(row: HandoffRow): HandoffRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    ...(row.task_id === null ? {} : { taskId: row.task_id }),
    sourceDeviceId: row.source_device_id,
    ...(row.destination_device_id === null
      ? {}
      : { destinationDeviceId: row.destination_device_id }),
    summary: row.summary,
    completedWork: parseJsonArray(row.completed_work_json),
    verifiedResults: parseJsonArray(row.verified_results_json),
    blockers: parseJsonArray(row.blockers_json),
    nextSteps: parseJsonArray(row.next_steps_json),
    evidenceReferences: parseJsonArray(row.evidence_references_json),
    linkedMemoryIds: parseJsonArray(row.linked_memory_ids_json),
    linkedTaskIds: parseJsonArray(row.linked_task_ids_json),
    verificationStatus: row.verification_status,
    createdAt: row.created_at,
  };
}

function parseJsonArray(value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  return Array.isArray(parsed) && parsed.every((item): item is string => typeof item === 'string')
    ? parsed
    : [];
}

function ensureArray(value: readonly string[] | undefined): readonly string[] {
  return value ?? [];
}

function json(value: readonly string[]): string {
  return JSON.stringify(value);
}

function hashRequest(input: unknown): string {
  return createHash('sha256').update(JSON.stringify(input), 'utf8').digest('hex');
}

function staleVersionError(
  resource: string,
  id: string,
  expectedVersion: number,
  currentVersion: number,
): ConflictError {
  return new ConflictError(`${resource} version is stale: expected ${expectedVersion}`, {
    resource,
    id,
    expectedVersion,
    currentVersion,
  });
}
