export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: 'initial_memory_engine',
    sql: `
      CREATE TABLE projects (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL UNIQUE,
        description TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE provenance (
        id TEXT PRIMARY KEY NOT NULL,
        source_kind TEXT NOT NULL CHECK (
          source_kind IN (
            'user_provided',
            'file_observed',
            'system_observed',
            'agent_inferred',
            'test_result'
          )
        ),
        source_reference TEXT,
        verification_status TEXT NOT NULL CHECK (
          verification_status IN (
            'unverified',
            'user_confirmed',
            'test_verified',
            'superseded',
            'disputed'
          )
        ),
        verification_method TEXT,
        observed_at TEXT,
        recorded_at TEXT NOT NULL,
        verified_at TEXT
      );

      CREATE TABLE memories (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT,
        record_type TEXT NOT NULL CHECK (
          record_type IN (
            'profile',
            'project_fact',
            'finding',
            'constraint',
            'requirement',
            'note'
          )
        ),
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        current_version INTEGER NOT NULL CHECK (current_version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );

      CREATE INDEX memories_project_updated_idx ON memories(project_id, updated_at DESC);
      CREATE INDEX memories_updated_idx ON memories(updated_at DESC);

      CREATE TABLE memory_revisions (
        memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE RESTRICT,
        version INTEGER NOT NULL CHECK (version > 0),
        project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT,
        record_type TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        provenance_id TEXT NOT NULL REFERENCES provenance(id) ON DELETE RESTRICT,
        change_reason TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (memory_id, version)
      );

      CREATE INDEX memory_revisions_project_idx ON memory_revisions(project_id, created_at DESC);

      CREATE TABLE activity_events (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT,
        memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE RESTRICT,
        event_type TEXT NOT NULL CHECK (event_type IN ('memory_created', 'memory_updated')),
        summary TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX activity_events_project_created_idx ON activity_events(project_id, created_at DESC);
      CREATE INDEX activity_events_memory_created_idx ON activity_events(memory_id, created_at DESC);

      CREATE TABLE change_log (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT REFERENCES projects(id) ON DELETE RESTRICT,
        resource_type TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        resource_version INTEGER NOT NULL,
        change_type TEXT NOT NULL CHECK (change_type IN ('created', 'updated')),
        created_at TEXT NOT NULL
      );

      CREATE INDEX change_log_project_sequence_idx ON change_log(project_id, sequence);

      CREATE VIRTUAL TABLE memory_fts USING fts5(
        memory_id UNINDEXED,
        project_id UNINDEXED,
        record_type UNINDEXED,
        title,
        content,
        tokenize = 'unicode61'
      );
    `,
  },
  {
    version: 2,
    name: 'local_auth_devices_permissions_audit',
    sql: `
      CREATE TABLE owner_accounts (
        id TEXT PRIMARY KEY NOT NULL CHECK (id = 'owner'),
        password_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE setup_codes (
        id TEXT PRIMARY KEY NOT NULL CHECK (id = 'initial'),
        token_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
        consumed_at INTEGER
      );

      CREATE TABLE devices (
        id TEXT PRIMARY KEY NOT NULL,
        name TEXT NOT NULL,
        device_type TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
        status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER,
        revoked_at INTEGER
      );

      CREATE INDEX devices_status_idx ON devices(status);

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY NOT NULL,
        device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER,
        expires_at INTEGER NOT NULL,
        idle_expires_at INTEGER NOT NULL,
        revoked_at INTEGER
      );

      CREATE INDEX sessions_device_idx ON sessions(device_id);
      CREATE INDEX sessions_expiry_idx ON sessions(expires_at, idle_expires_at);

      CREATE TABLE device_enrollments (
        id TEXT PRIMARY KEY NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        device_name TEXT NOT NULL,
        device_type TEXT NOT NULL,
        created_by_device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE RESTRICT,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
        claimed_at INTEGER
      );

      CREATE INDEX device_enrollments_expiry_idx ON device_enrollments(expires_at, claimed_at);

      CREATE TABLE project_permissions (
        device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('reader', 'editor', 'owner')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (device_id, project_id)
      );

      CREATE INDEX project_permissions_project_idx ON project_permissions(project_id, role);

      CREATE TABLE agent_activity_events (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        event_type TEXT NOT NULL,
        summary TEXT NOT NULL,
        metadata_json TEXT,
        actor_device_id TEXT REFERENCES devices(id) ON DELETE SET NULL,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX agent_activity_project_created_idx
        ON agent_activity_events(project_id, created_at DESC);

      CREATE TABLE security_audit_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        occurred_at INTEGER NOT NULL,
        actor_device_id TEXT REFERENCES devices(id) ON DELETE SET NULL,
        session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        request_id TEXT NOT NULL,
        project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
        action TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('allowed', 'denied', 'failed')),
        resource_type TEXT,
        resource_id TEXT,
        metadata_json TEXT
      );

      CREATE INDEX security_audit_occurred_idx ON security_audit_events(occurred_at DESC);
      CREATE INDEX security_audit_project_idx ON security_audit_events(project_id, occurred_at DESC);

      CREATE TRIGGER security_audit_events_no_update
      BEFORE UPDATE ON security_audit_events
      BEGIN
        SELECT RAISE(ABORT, 'security audit events are append-only');
      END;

      CREATE TRIGGER security_audit_events_no_delete
      BEFORE DELETE ON security_audit_events
      BEGIN
        SELECT RAISE(ABORT, 'security audit events are append-only');
      END;
    `,
  },
  {
    version: 3,
    name: 'write_idempotency_keys',
    sql: `
      CREATE TABLE idempotency_keys (
        key TEXT PRIMARY KEY NOT NULL,
        request_hash TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        resource_version INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );

      CREATE INDEX idempotency_keys_expiry_idx ON idempotency_keys(expires_at);
    `,
  },
  {
    version: 4,
    name: 'project_tasks_and_immutable_handoffs',
    sql: `
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL CHECK (
          status IN ('todo', 'in_progress', 'blocked', 'completed', 'cancelled')
        ),
        priority TEXT NOT NULL CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
        created_by_device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE RESTRICT,
        assigned_device_id TEXT REFERENCES devices(id) ON DELETE RESTRICT,
        due_date TEXT,
        linked_memory_ids_json TEXT NOT NULL,
        evidence_references_json TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version > 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX tasks_project_updated_idx ON tasks(project_id, updated_at DESC);
      CREATE INDEX tasks_project_status_idx ON tasks(project_id, status);
      CREATE INDEX tasks_project_assigned_idx ON tasks(project_id, assigned_device_id);

      CREATE TABLE task_status_history (
        id TEXT PRIMARY KEY NOT NULL,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        from_status TEXT NOT NULL CHECK (
          from_status IN ('todo', 'in_progress', 'blocked', 'completed', 'cancelled')
        ),
        to_status TEXT NOT NULL CHECK (
          to_status IN ('todo', 'in_progress', 'blocked', 'completed', 'cancelled')
        ),
        note TEXT,
        actor_device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE RESTRICT,
        task_version INTEGER NOT NULL CHECK (task_version > 1),
        created_at TEXT NOT NULL
      );

      CREATE INDEX task_status_history_task_created_idx
        ON task_status_history(task_id, created_at ASC);

      CREATE TRIGGER task_status_history_no_update
      BEFORE UPDATE ON task_status_history
      BEGIN
        SELECT RAISE(ABORT, 'task status history is append-only');
      END;

      CREATE TRIGGER task_status_history_no_delete
      BEFORE DELETE ON task_status_history
      BEGIN
        SELECT RAISE(ABORT, 'task status history is append-only');
      END;

      CREATE TABLE handoffs (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        task_id TEXT REFERENCES tasks(id) ON DELETE RESTRICT,
        source_device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE RESTRICT,
        destination_device_id TEXT REFERENCES devices(id) ON DELETE RESTRICT,
        summary TEXT NOT NULL,
        completed_work_json TEXT NOT NULL,
        verified_results_json TEXT NOT NULL,
        blockers_json TEXT NOT NULL,
        next_steps_json TEXT NOT NULL,
        evidence_references_json TEXT NOT NULL,
        linked_memory_ids_json TEXT NOT NULL,
        linked_task_ids_json TEXT NOT NULL,
        verification_status TEXT NOT NULL CHECK (
          verification_status IN ('unverified', 'partially_verified', 'verified')
        ),
        created_at TEXT NOT NULL
      );

      CREATE INDEX handoffs_project_created_idx ON handoffs(project_id, created_at DESC);
      CREATE INDEX handoffs_task_created_idx ON handoffs(task_id, created_at DESC);

      CREATE TRIGGER handoffs_no_update
      BEFORE UPDATE ON handoffs
      BEGIN
        SELECT RAISE(ABORT, 'handoffs are immutable');
      END;

      CREATE TRIGGER handoffs_no_delete
      BEFORE DELETE ON handoffs
      BEGIN
        SELECT RAISE(ABORT, 'handoffs are immutable');
      END;
    `,
  },
];
