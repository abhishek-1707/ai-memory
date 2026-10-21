import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { runInTransaction } from '../database/database.js';
import type { Logger } from '../logging.js';
import type { AuditEventInput } from './types.js';

export function insertAuditEvent(
  database: DatabaseSync,
  event: AuditEventInput,
  occurredAt = Date.now(),
): string {
  const eventId = randomUUID();
  const metadata = event.metadata === undefined ? null : JSON.stringify(event.metadata);
  database
    .prepare(
      `INSERT INTO security_audit_events
        (event_id, occurred_at, actor_device_id, session_id, request_id, project_id,
         action, outcome, resource_type, resource_id, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      eventId,
      occurredAt,
      event.actorDeviceId ?? null,
      event.sessionId ?? null,
      event.requestId,
      event.projectId ?? null,
      event.action,
      event.outcome,
      event.resourceType ?? null,
      event.resourceId ?? null,
      metadata,
    );
  return eventId;
}

export class AuditService {
  public constructor(
    private readonly database: DatabaseSync,
    private readonly logger: Logger,
  ) {}

  public record(event: AuditEventInput): void {
    try {
      runInTransaction(this.database, () => {
        insertAuditEvent(this.database, event);
      });
    } catch (error) {
      this.logger.error('audit_write_failed', { action: event.action, outcome: event.outcome });
      throw error;
    }
  }
}
