import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { runInTransaction, type SqlRow } from '../database/database.js';
import { DatabaseError, ConflictError, NotFoundError, isOmniMemoryError } from '../errors.js';
import type { Logger } from '../logging.js';
import type {
  ActivityEvent,
  AgentActivityEvent,
  CreateMemoryInput,
  CreateProjectInput,
  ListActivityInput,
  RecordActivityInput,
  ListRecentMemoriesInput,
  MemoryEngineDependencies,
  MemoryHistoryInput,
  MemoryRecord,
  MemoryRevision,
  Project,
  Provenance,
  ProvenanceInput,
  SearchMemoryInput,
  UpdateMemoryInput,
} from './types.js';
import {
  assertSafeMemoryText,
  parseCreateMemoryInput,
  parseCreateProjectInput,
  parseListRecentMemoriesInput,
  parseListActivityInput,
  parseMemoryId,
  parseMemoryHistoryInput,
  parseProjectId,
  parseRecordActivityInput,
  parseSearchMemoryInput,
  parseUpdateMemoryInput,
} from './validation.js';

interface CurrentMemoryRow extends SqlRow {
  id: string;
  project_id: string | null;
  record_type: MemoryRecord['recordType'];
  title: string;
  content: string;
  current_version: number;
  created_at: string;
  updated_at: string;
  provenance_id: string;
  source_kind: Provenance['sourceKind'];
  source_reference: string | null;
  verification_status: Provenance['verificationStatus'];
  verification_method: string | null;
  observed_at: string | null;
  recorded_at: string;
  verified_at: string | null;
  commit_sequence: number;
}

interface RevisionRow extends SqlRow {
  memory_id: string;
  version: number;
  project_id: string | null;
  record_type: MemoryRecord['recordType'];
  title: string;
  content: string;
  provenance_id: string;
  source_kind: Provenance['sourceKind'];
  source_reference: string | null;
  verification_status: Provenance['verificationStatus'];
  verification_method: string | null;
  observed_at: string | null;
  recorded_at: string;
  verified_at: string | null;
  change_reason: string | null;
  created_at: string;
  commit_sequence: number;
}

interface ProjectRow extends SqlRow {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
}

interface AgentActivityRow extends SqlRow {
  id: string;
  project_id: string;
  event_type: AgentActivityEvent['eventType'];
  summary: string;
  metadata_json: string | null;
  actor_device_id: string | null;
  created_at: number;
}

interface CommitResult {
  readonly memoryId: string;
  readonly sequence: number;
  readonly version: number;
}

interface IdempotencyRow extends SqlRow {
  request_hash: string;
  resource_id: string;
  resource_version: number;
  expires_at: number;
}

const CURRENT_MEMORY_SELECT = `
  SELECT
    m.id,
    m.project_id,
    m.record_type,
    m.title,
    m.content,
    m.current_version,
    m.created_at,
    m.updated_at,
    p.id AS provenance_id,
    p.source_kind,
    p.source_reference,
    p.verification_status,
    p.verification_method,
    p.observed_at,
    p.recorded_at,
    p.verified_at,
    COALESCE(cl.sequence, 0) AS commit_sequence
  FROM memories m
  JOIN memory_revisions r
    ON r.memory_id = m.id AND r.version = m.current_version
  JOIN provenance p ON p.id = r.provenance_id
  LEFT JOIN change_log cl
    ON cl.resource_type = 'memory'
    AND cl.resource_id = m.id
    AND cl.resource_version = m.current_version
`;

const SEARCH_MEMORY_SELECT = CURRENT_MEMORY_SELECT.replace(
  'FROM memories m',
  'FROM memories m JOIN memory_fts ON memory_fts.memory_id = m.id',
);

export class MemoryEngine {
  private readonly now: () => string;
  private readonly createId: () => string;

  public constructor(
    private readonly database: DatabaseSync,
    private readonly logger: Logger,
    dependencies: MemoryEngineDependencies = {},
  ) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.createId = dependencies.createId ?? randomUUID;
  }

  public createProject(input: CreateProjectInput): Project {
    return this.execute('create_project', () => {
      const parsed = parseCreateProjectInput(input);
      const id = this.createId();
      const timestamp = this.now();

      try {
        runInTransaction(this.database, () => {
          this.database
            .prepare(
              'INSERT INTO projects (id, name, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
            )
            .run(id, parsed.name, parsed.description ?? null, timestamp, timestamp);
        });
      } catch (error) {
        if (isUniqueConstraintError(error, 'projects.name')) {
          throw new ConflictError(`Project name already exists: ${parsed.name}`);
        }
        throw error;
      }

      return {
        id,
        name: parsed.name,
        ...(parsed.description === undefined ? {} : { description: parsed.description }),
        createdAt: timestamp,
        updatedAt: timestamp,
      };
    });
  }

  public getProjectByName(name: string): Project | undefined {
    return this.execute('get_project_by_name', () => {
      const row = this.database
        .prepare(
          'SELECT id, name, description, created_at, updated_at FROM projects WHERE name = ?',
        )
        .get(name.trim()) as ProjectRow | undefined;
      return row === undefined ? undefined : toProject(row);
    });
  }

  public getProject(id: string): Project {
    return this.execute('get_project', () => {
      const projectId = parseProjectId(id);
      const row = this.database
        .prepare('SELECT id, name, description, created_at, updated_at FROM projects WHERE id = ?')
        .get(projectId) as ProjectRow | undefined;
      if (row === undefined) {
        throw new NotFoundError('Project', projectId);
      }
      return toProject(row);
    });
  }

  public listProjects(): readonly Project[] {
    return this.execute('list_projects', () => {
      const rows = this.database
        .prepare('SELECT id, name, description, created_at, updated_at FROM projects ORDER BY name')
        .all() as ProjectRow[];
      return rows.map(toProject);
    });
  }

  public createMemory(input: CreateMemoryInput): MemoryRecord {
    return this.execute('create_memory', () => {
      const parsed = parseCreateMemoryInput(input);
      assertSafeMemoryText(parsed.title, parsed.content);
      if (parsed.projectId !== undefined) {
        this.assertProjectExists(parsed.projectId);
      }

      const memoryId = this.createId();
      const provenanceId = this.createId();
      const activityId = this.createId();
      const timestamp = this.now();
      const version = 1;
      const requestHash = hashRequest(parsed);

      const commit = runInTransaction(this.database, () => {
        const existing = this.findIdempotency(parsed.idempotencyKey, requestHash);
        if (existing !== undefined) {
          return {
            memoryId: existing.resource_id,
            sequence: this.findCommitSequence(existing.resource_id, existing.resource_version),
            version: existing.resource_version,
          } satisfies CommitResult;
        }
        this.reserveIdempotency(parsed.idempotencyKey, requestHash, memoryId, version, Date.now());
        this.insertProvenance(provenanceId, parsed.provenance, timestamp);
        this.database
          .prepare(
            `INSERT INTO memories
              (id, project_id, record_type, title, content, current_version, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            memoryId,
            parsed.projectId ?? null,
            parsed.recordType,
            parsed.title,
            parsed.content,
            version,
            timestamp,
            timestamp,
          );
        this.insertRevision(memoryId, version, parsed, provenanceId, timestamp);
        this.replaceFts(
          memoryId,
          parsed.projectId,
          parsed.recordType,
          parsed.title,
          parsed.content,
        );
        this.insertActivity(
          activityId,
          parsed.projectId,
          memoryId,
          'memory_created',
          `Created memory: ${parsed.title}`,
          timestamp,
        );
        const sequence = this.insertChangeLog(
          parsed.projectId,
          memoryId,
          version,
          'created',
          timestamp,
        );
        return { memoryId, sequence, version } satisfies CommitResult;
      });

      this.logger.info('memory_created', {
        memoryId,
        version: commit.version,
        sequence: commit.sequence,
      });
      return this.readMemory(commit.memoryId, commit.sequence);
    });
  }

  public getMemory(id: string): MemoryRecord {
    return this.execute('get_memory', () => this.readMemory(parseMemoryId(id)));
  }

  public searchMemory(input: SearchMemoryInput): readonly MemoryRecord[] {
    return this.execute('search_memory', () => {
      const parsed = parseSearchMemoryInput(input);
      const ftsQuery = toFtsQuery(parsed.query);
      const parameters: Array<string | number> = [ftsQuery];
      let projectClause = '';

      if (parsed.projectId !== undefined) {
        projectClause = ' AND m.project_id = ?';
        parameters.push(parsed.projectId);
      }
      parameters.push(parsed.limit ?? 20);

      const rows = this.database
        .prepare(
          `${SEARCH_MEMORY_SELECT}
           WHERE m.deleted_at IS NULL
             AND memory_fts MATCH ?${projectClause}
           ORDER BY bm25(memory_fts), m.updated_at DESC
           LIMIT ?`,
        )
        .all(...parameters) as CurrentMemoryRow[];

      return rows.map(toMemoryRecord);
    });
  }

  public updateMemory(id: string, input: UpdateMemoryInput): MemoryRecord {
    return this.execute('update_memory', () => {
      const memoryId = parseMemoryId(id);
      const parsed = parseUpdateMemoryInput(input);
      const requestHash = hashRequest(parsed);
      const commit = runInTransaction(this.database, () => {
        const current = this.readMemoryRow(memoryId);
        const existing = this.findIdempotency(parsed.idempotencyKey, requestHash);
        if (existing !== undefined) {
          return {
            memoryId: existing.resource_id,
            sequence: this.findCommitSequence(existing.resource_id, existing.resource_version),
            version: existing.resource_version,
          } satisfies CommitResult;
        }
        const title = parsed.title ?? current.title;
        const content = parsed.content ?? current.content;
        const recordType = parsed.recordType ?? current.record_type;
        assertSafeMemoryText(title, content);

        if (current.current_version !== parsed.expectedVersion) {
          throw new ConflictError(`Memory version is stale: expected ${parsed.expectedVersion}`, {
            memoryId: memoryId,
            expectedVersion: parsed.expectedVersion,
            currentVersion: current.current_version,
          });
        }

        const version = current.current_version + 1;
        const provenanceId = this.createId();
        const activityId = this.createId();
        const timestamp = this.now();

        this.reserveIdempotency(parsed.idempotencyKey, requestHash, memoryId, version, Date.now());
        this.insertProvenance(provenanceId, parsed.provenance, timestamp);
        this.database
          .prepare(
            `INSERT INTO memory_revisions
              (memory_id, version, project_id, record_type, title, content, provenance_id, change_reason, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            memoryId,
            version,
            current.project_id,
            recordType,
            title,
            content,
            provenanceId,
            parsed.changeReason ?? null,
            timestamp,
          );
        this.database
          .prepare(
            `UPDATE memories
             SET record_type = ?, title = ?, content = ?, current_version = ?, updated_at = ?
             WHERE id = ? AND current_version = ?`,
          )
          .run(recordType, title, content, version, timestamp, memoryId, parsed.expectedVersion);
        this.replaceFts(memoryId, current.project_id, recordType, title, content);
        this.insertActivity(
          activityId,
          current.project_id,
          memoryId,
          'memory_updated',
          `Updated memory: ${title}`,
          timestamp,
        );
        const sequence = this.insertChangeLog(
          current.project_id,
          memoryId,
          version,
          'updated',
          timestamp,
        );
        return { memoryId, sequence, version } satisfies CommitResult;
      });

      this.logger.info('memory_updated', {
        memoryId,
        version: commit.version,
        sequence: commit.sequence,
      });
      return this.readMemory(memoryId, commit.sequence);
    });
  }

  public listRecentMemories(input: ListRecentMemoriesInput = {}): readonly MemoryRecord[] {
    return this.execute('list_recent_memories', () => {
      const parsed = parseListRecentMemoriesInput(input);
      const parameters: Array<string | number> = [];
      let projectClause = '';
      if (parsed.projectId !== undefined) {
        projectClause = ' AND m.project_id = ?';
        parameters.push(parsed.projectId);
      }
      parameters.push(parsed.limit ?? 20);

      const rows = this.database
        .prepare(
          `${CURRENT_MEMORY_SELECT}
           WHERE m.deleted_at IS NULL${projectClause}
           ORDER BY m.updated_at DESC
           LIMIT ?`,
        )
        .all(...parameters) as CurrentMemoryRow[];
      return rows.map(toMemoryRecord);
    });
  }

  public getMemoryHistory(input: MemoryHistoryInput): readonly MemoryRevision[] {
    return this.execute('get_memory_history', () => {
      const parsed = parseMemoryHistoryInput(input);
      const memory = this.readMemoryRow(parsed.id);
      const rows = this.database
        .prepare(
          `SELECT
             r.memory_id,
             r.version,
             r.project_id,
             r.record_type,
             r.title,
             r.content,
             r.provenance_id,
             p.source_kind,
             p.source_reference,
             p.verification_status,
             p.verification_method,
             p.observed_at,
             p.recorded_at,
             p.verified_at,
             r.change_reason,
             r.created_at,
             COALESCE(cl.sequence, 0) AS commit_sequence
           FROM memory_revisions r
           JOIN provenance p ON p.id = r.provenance_id
           LEFT JOIN change_log cl
             ON cl.resource_type = 'memory'
            AND cl.resource_id = r.memory_id
            AND cl.resource_version = r.version
           WHERE r.memory_id = ?
           ORDER BY r.version ASC`,
        )
        .all(memory.id) as RevisionRow[];
      return rows.map(toMemoryRevision);
    });
  }

  public recordActivity(input: RecordActivityInput): AgentActivityEvent {
    return this.execute('record_activity', () => {
      const parsed = parseRecordActivityInput(input);
      this.assertProjectExists(parsed.projectId);
      if (parsed.actorDeviceId !== undefined) {
        const device = this.database
          .prepare("SELECT id FROM devices WHERE id = ? AND status = 'active'")
          .get(parsed.actorDeviceId);
        if (device === undefined) {
          throw new NotFoundError('Device', parsed.actorDeviceId);
        }
      }

      const id = this.createId();
      const createdAt = Date.now();
      const metadataJson = parsed.metadata === undefined ? null : JSON.stringify(parsed.metadata);
      runInTransaction(this.database, () => {
        this.database
          .prepare(
            `INSERT INTO agent_activity_events
              (id, project_id, event_type, summary, metadata_json, actor_device_id, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            parsed.projectId,
            parsed.eventType,
            parsed.summary,
            metadataJson,
            parsed.actorDeviceId ?? null,
            createdAt,
          );
      });
      return {
        id,
        projectId: parsed.projectId,
        eventType: parsed.eventType,
        summary: parsed.summary,
        ...(parsed.metadata === undefined ? {} : { metadata: parsed.metadata }),
        ...(parsed.actorDeviceId === undefined ? {} : { actorDeviceId: parsed.actorDeviceId }),
        createdAt,
      };
    });
  }

  public listActivity(input: ListActivityInput): readonly AgentActivityEvent[] {
    return this.execute('list_activity', () => {
      const parsed = parseListActivityInput(input);
      const rows = this.database
        .prepare(
          `SELECT id, project_id, event_type, summary, metadata_json, actor_device_id, created_at
           FROM agent_activity_events
           WHERE project_id = ?
           ORDER BY created_at DESC
           LIMIT ?`,
        )
        .all(parsed.projectId, parsed.limit ?? 50) as AgentActivityRow[];
      return rows.map(toAgentActivityEvent);
    });
  }

  public close(): void {
    this.database.close();
  }

  private assertProjectExists(projectId: string): void {
    const row = this.database.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
    if (row === undefined) {
      throw new NotFoundError('Project', projectId);
    }
  }

  private insertProvenance(id: string, input: ProvenanceInput, timestamp: string): void {
    const verifiedAt =
      input.verificationStatus === 'user_confirmed' || input.verificationStatus === 'test_verified'
        ? timestamp
        : null;
    this.database
      .prepare(
        `INSERT INTO provenance
          (id, source_kind, source_reference, verification_status, verification_method, observed_at, recorded_at, verified_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.sourceKind,
        input.sourceReference ?? null,
        input.verificationStatus,
        input.verificationMethod ?? null,
        input.observedAt ?? null,
        timestamp,
        verifiedAt,
      );
  }

  private insertRevision(
    memoryId: string,
    version: number,
    input: CreateMemoryInput,
    provenanceId: string,
    timestamp: string,
  ): void {
    this.database
      .prepare(
        `INSERT INTO memory_revisions
          (memory_id, version, project_id, record_type, title, content, provenance_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        memoryId,
        version,
        input.projectId ?? null,
        input.recordType,
        input.title,
        input.content,
        provenanceId,
        timestamp,
      );
  }

  private replaceFts(
    memoryId: string,
    projectId: string | null | undefined,
    recordType: string,
    title: string,
    content: string,
  ): void {
    this.database.prepare('DELETE FROM memory_fts WHERE memory_id = ?').run(memoryId);
    this.database
      .prepare(
        'INSERT INTO memory_fts (memory_id, project_id, record_type, title, content) VALUES (?, ?, ?, ?, ?)',
      )
      .run(memoryId, projectId ?? null, recordType, title, content);
  }

  private insertActivity(
    id: string,
    projectId: string | null | undefined,
    memoryId: string,
    eventType: ActivityEvent['eventType'],
    summary: string,
    timestamp: string,
  ): void {
    this.database
      .prepare(
        `INSERT INTO activity_events
          (id, project_id, memory_id, event_type, summary, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, projectId ?? null, memoryId, eventType, summary, timestamp);
  }

  private insertChangeLog(
    projectId: string | null | undefined,
    memoryId: string,
    version: number,
    changeType: 'created' | 'updated',
    timestamp: string,
  ): number {
    this.database
      .prepare(
        `INSERT INTO change_log
          (project_id, resource_type, resource_id, resource_version, change_type, created_at)
         VALUES (?, 'memory', ?, ?, ?, ?)`,
      )
      .run(projectId ?? null, memoryId, version, changeType, timestamp);
    const row = this.database.prepare('SELECT last_insert_rowid() AS sequence').get() as SqlRow;
    return Number(row.sequence);
  }

  private findIdempotency(
    key: string | undefined,
    requestHash: string,
  ): IdempotencyRow | undefined {
    if (key === undefined) {
      return undefined;
    }
    const row = this.database
      .prepare(
        `SELECT request_hash, resource_id, resource_version, expires_at
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
    if (row.request_hash !== requestHash) {
      throw new ConflictError('Idempotency key was reused with a different request');
    }
    return row;
  }

  private reserveIdempotency(
    key: string | undefined,
    requestHash: string,
    resourceId: string,
    resourceVersion: number,
    createdAt: number,
  ): void {
    if (key === undefined) {
      return;
    }
    this.database
      .prepare(
        `INSERT INTO idempotency_keys
          (key, request_hash, resource_type, resource_id, resource_version, created_at, expires_at)
         VALUES (?, ?, 'memory', ?, ?, ?, ?)`,
      )
      .run(
        key,
        requestHash,
        resourceId,
        resourceVersion,
        createdAt,
        createdAt + 24 * 60 * 60 * 1000,
      );
  }

  private findCommitSequence(memoryId: string, version: number): number {
    const row = this.database
      .prepare(
        `SELECT sequence FROM change_log
         WHERE resource_type = 'memory' AND resource_id = ? AND resource_version = ?
         ORDER BY sequence DESC LIMIT 1`,
      )
      .get(memoryId, version) as { sequence: number } | undefined;
    return row === undefined ? 0 : Number(row.sequence);
  }

  private readMemory(id: string, commitSequence?: number): MemoryRecord {
    const row = this.readMemoryRow(id);
    return toMemoryRecord({
      ...row,
      commit_sequence: commitSequence ?? row.commit_sequence,
    });
  }

  private readMemoryRow(id: string): CurrentMemoryRow {
    const row = this.database
      .prepare(`${CURRENT_MEMORY_SELECT} WHERE m.id = ? AND m.deleted_at IS NULL`)
      .get(id) as CurrentMemoryRow | undefined;
    if (row === undefined) {
      throw new NotFoundError('Memory', id);
    }
    return row;
  }

  private execute<T>(operation: string, callback: () => T): T {
    try {
      return callback();
    } catch (error) {
      if (isOmniMemoryError(error)) {
        throw error;
      }
      this.logger.error('memory_engine_error', { operation });
      throw new DatabaseError(`Memory operation failed: ${operation}`, error);
    }
  }
}

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    ...(row.description === null ? {} : { description: row.description }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toProvenance(row: {
  provenance_id: string;
  source_kind: Provenance['sourceKind'];
  source_reference: string | null;
  verification_status: Provenance['verificationStatus'];
  verification_method: string | null;
  observed_at: string | null;
  recorded_at: string;
  verified_at: string | null;
}): Provenance {
  return {
    id: row.provenance_id,
    sourceKind: row.source_kind,
    ...(row.source_reference === null ? {} : { sourceReference: row.source_reference }),
    verificationStatus: row.verification_status,
    ...(row.verification_method === null ? {} : { verificationMethod: row.verification_method }),
    ...(row.observed_at === null ? {} : { observedAt: row.observed_at }),
    recordedAt: row.recorded_at,
    ...(row.verified_at === null ? {} : { verifiedAt: row.verified_at }),
  };
}

function toMemoryRecord(row: CurrentMemoryRow): MemoryRecord {
  return {
    id: row.id,
    ...(row.project_id === null ? {} : { projectId: row.project_id }),
    recordType: row.record_type,
    title: row.title,
    content: row.content,
    version: row.current_version,
    provenance: toProvenance(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    commitSequence: row.commit_sequence,
  };
}

function toMemoryRevision(row: RevisionRow): MemoryRevision {
  return {
    id: row.memory_id,
    ...(row.project_id === null ? {} : { projectId: row.project_id }),
    recordType: row.record_type,
    title: row.title,
    content: row.content,
    version: row.version,
    provenance: toProvenance(row),
    createdAt: row.created_at,
    updatedAt: row.created_at,
    ...(row.change_reason === null ? {} : { changeReason: row.change_reason }),
    commitSequence: row.commit_sequence,
  };
}

function toAgentActivityEvent(row: AgentActivityRow): AgentActivityEvent {
  const metadata =
    row.metadata_json === null
      ? undefined
      : (JSON.parse(row.metadata_json) as Record<string, string>);
  return {
    id: row.id,
    projectId: row.project_id,
    eventType: row.event_type,
    summary: row.summary,
    ...(metadata === undefined ? {} : { metadata }),
    ...(row.actor_device_id === null ? {} : { actorDeviceId: row.actor_device_id }),
    createdAt: row.created_at,
  };
}

function toFtsQuery(query: string): string {
  const tokens = query.match(/[\p{L}\p{N}_-]+/gu) ?? [];
  if (tokens.length === 0) {
    throw new DatabaseError('Search query contained no searchable terms');
  }
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(' AND ');
}

function isUniqueConstraintError(error: unknown, field: string): boolean {
  return error instanceof Error && error.message.includes(`UNIQUE constraint failed: ${field}`);
}

function hashRequest(input: unknown): string {
  return createHash('sha256').update(JSON.stringify(input), 'utf8').digest('hex');
}
