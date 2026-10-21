import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { runInTransaction, type SqlRow } from '../database/database.js';
import {
  AuthenticationError,
  AuthorizationError,
  ConflictError,
  NotFoundError,
  SetupCompleteError,
  SetupRequiredError,
} from '../errors.js';
import type { Logger } from '../logging.js';
import { hashPassword, verifyPassword } from './passwords.js';
import { insertAuditEvent } from './audit.js';
import { createOpaqueToken, hashOpaqueToken } from './tokens.js';
import type {
  AuthSession,
  AuthenticatedIdentity,
  DeviceSummary,
  EnrollmentClaimInput,
  EnrollmentRequestInput,
  LoginInput,
  SetupCode,
  SetupOwnerInput,
  SetupStatus,
} from './types.js';

interface AuthServiceOptions {
  readonly sessionTtlMs: number;
  readonly idleSessionTtlMs: number;
  readonly enrollmentTtlMs: number;
  readonly setupCodeTtlMs: number;
  readonly now?: () => number;
  readonly createId?: () => string;
}

interface SessionRow extends SqlRow {
  session_id: string;
  device_id: string;
  device_name: string;
  device_type: string;
  role: 'owner' | 'admin' | 'member';
  device_status: 'active' | 'revoked';
  expires_at: number;
  idle_expires_at: number;
  session_revoked_at: number | null;
  device_revoked_at: number | null;
}

interface DeviceRow extends SqlRow {
  id: string;
  name: string;
  device_type: string;
  role: DeviceSummary['role'];
  status: DeviceSummary['status'];
  created_at: number;
  last_seen_at: number | null;
  revoked_at: number | null;
}

interface SetupCodeRow extends SqlRow {
  token_hash: string;
  expires_at: number;
  failed_attempts: number;
  consumed_at: number | null;
}

export class AuthService {
  private readonly now: () => number;
  private readonly createId: () => string;

  public constructor(
    private readonly database: DatabaseSync,
    private readonly logger: Logger,
    private readonly options: AuthServiceOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? randomUUID;
  }

  public getSetupStatus(): SetupStatus {
    const owner = this.database.prepare("SELECT id FROM owner_accounts WHERE id = 'owner'").get();
    return { setupRequired: owner === undefined };
  }

  public createSetupCode(): SetupCode {
    const code = createOpaqueToken();
    const createdAt = this.now();
    const expiresAt = createdAt + this.options.setupCodeTtlMs;

    runInTransaction(this.database, () => {
      if (!this.getSetupStatus().setupRequired) {
        throw new SetupCompleteError();
      }
      this.database
        .prepare(
          `INSERT INTO setup_codes (id, token_hash, created_at, expires_at, failed_attempts, consumed_at)
           VALUES ('initial', ?, ?, ?, 0, NULL)
           ON CONFLICT(id) DO UPDATE SET
             token_hash = excluded.token_hash,
             created_at = excluded.created_at,
             expires_at = excluded.expires_at,
             failed_attempts = 0,
             consumed_at = NULL`,
        )
        .run(code.hash, createdAt, expiresAt);
    });

    this.logger.info('setup_code_created', { expiresAt });
    return { code: code.raw, expiresAt };
  }

  public async setupOwner(input: SetupOwnerInput): Promise<AuthSession> {
    const tokenHash = hashOpaqueToken(input.setupCode);
    const precheck = this.database
      .prepare(
        `SELECT token_hash, expires_at, failed_attempts, consumed_at
         FROM setup_codes WHERE id = 'initial'`,
      )
      .get() as SetupCodeRow | undefined;
    const now = this.now();
    const validPrecheck =
      precheck !== undefined &&
      precheck.consumed_at === null &&
      precheck.expires_at > now &&
      precheck.failed_attempts < 5 &&
      precheck.token_hash === tokenHash;

    if (!validPrecheck) {
      this.recordSetupFailure(input.requestId);
      throw new AuthenticationError();
    }

    const passwordHash = await hashPassword(input.password);
    const session = this.newSession(input.deviceName, input.deviceType, 'owner', now);
    let completed = false;

    runInTransaction(this.database, () => {
      if (!this.getSetupStatus().setupRequired) {
        throw new SetupCompleteError();
      }

      const currentCode = this.database
        .prepare(
          `SELECT token_hash, expires_at, failed_attempts, consumed_at
           FROM setup_codes WHERE id = 'initial'`,
        )
        .get() as SetupCodeRow | undefined;
      const validCode =
        currentCode !== undefined &&
        currentCode.consumed_at === null &&
        currentCode.expires_at > now &&
        currentCode.failed_attempts < 5 &&
        currentCode.token_hash === tokenHash;
      if (!validCode) {
        throw new AuthenticationError();
      }

      this.database
        .prepare(
          "INSERT INTO owner_accounts (id, password_hash, created_at, updated_at) VALUES ('owner', ?, ?, ?)",
        )
        .run(passwordHash, now, now);
      this.insertDevice(session, now);
      this.insertSession(session, now);
      this.database.prepare("UPDATE setup_codes SET consumed_at = ? WHERE id = 'initial'").run(now);
      insertAuditEvent(
        this.database,
        {
          requestId: input.requestId,
          action: 'owner_setup',
          outcome: 'allowed',
          actorDeviceId: session.deviceId,
          sessionId: session.sessionId,
          metadata: { deviceType: input.deviceType },
        },
        now,
      );
      completed = true;
    });

    if (!completed) {
      throw new AuthenticationError();
    }
    this.logger.info('owner_setup_completed', { deviceId: session.deviceId });
    return session;
  }

  public async login(input: LoginInput): Promise<AuthSession> {
    const owner = this.database
      .prepare("SELECT password_hash FROM owner_accounts WHERE id = 'owner'")
      .get() as { password_hash: string } | undefined;
    if (owner === undefined) {
      throw new SetupRequiredError();
    }

    const valid = await verifyPassword(input.password, owner.password_hash);
    if (!valid) {
      this.recordAuditFailure(input.requestId, 'login_failed');
      throw new AuthenticationError();
    }

    const now = this.now();
    const session = this.newSession(input.deviceName, input.deviceType, 'member', now);
    runInTransaction(this.database, () => {
      this.insertDevice(session, now);
      this.insertSession(session, now);
      insertAuditEvent(
        this.database,
        {
          requestId: input.requestId,
          action: 'login',
          outcome: 'allowed',
          actorDeviceId: session.deviceId,
          sessionId: session.sessionId,
          metadata: { deviceType: input.deviceType },
        },
        now,
      );
    });
    this.logger.info('login_succeeded', { deviceId: session.deviceId });
    return session;
  }

  public async createEnrollment(
    identity: AuthenticatedIdentity,
    input: EnrollmentRequestInput,
  ): Promise<SetupCode> {
    if (identity.role !== 'owner' && identity.role !== 'admin') {
      throw new AuthorizationError();
    }
    const token = createOpaqueToken();
    const now = this.now();
    const expiresAt = now + this.options.enrollmentTtlMs;
    runInTransaction(this.database, () => {
      this.database
        .prepare(
          `INSERT INTO device_enrollments
            (id, token_hash, device_name, device_type, created_by_device_id, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          this.createId(),
          token.hash,
          input.deviceName,
          input.deviceType,
          identity.deviceId,
          now,
          expiresAt,
        );
      insertAuditEvent(
        this.database,
        {
          requestId: input.requestId,
          action: 'device_enrollment_created',
          outcome: 'allowed',
          actorDeviceId: identity.deviceId,
          sessionId: identity.sessionId,
          metadata: { deviceType: input.deviceType },
        },
        now,
      );
    });
    return { code: token.raw, expiresAt };
  }

  public async claimEnrollment(input: EnrollmentClaimInput): Promise<AuthSession> {
    const tokenHash = hashOpaqueToken(input.enrollmentToken);
    const now = this.now();
    const row = this.database
      .prepare(
        `SELECT id, token_hash, device_name, device_type, expires_at, failed_attempts, claimed_at
         FROM device_enrollments WHERE token_hash = ?`,
      )
      .get(tokenHash) as
      | (SqlRow & {
          id: string;
          token_hash: string;
          device_name: string;
          device_type: string;
          expires_at: number;
          failed_attempts: number;
          claimed_at: number | null;
        })
      | undefined;
    if (
      row === undefined ||
      row.claimed_at !== null ||
      row.expires_at <= now ||
      row.failed_attempts >= 5
    ) {
      this.recordAuditFailure(input.requestId, 'device_enrollment_failed');
      throw new AuthenticationError();
    }

    const session = this.newSession(row.device_name, row.device_type, 'member', now);
    runInTransaction(this.database, () => {
      const current = this.database
        .prepare(
          `SELECT id, token_hash, device_name, device_type, expires_at, failed_attempts, claimed_at
           FROM device_enrollments WHERE id = ?`,
        )
        .get(row.id) as typeof row | undefined;
      if (
        current === undefined ||
        current.claimed_at !== null ||
        current.expires_at <= now ||
        current.failed_attempts >= 5 ||
        current.token_hash !== tokenHash
      ) {
        throw new AuthenticationError();
      }
      this.insertDevice(session, now);
      this.insertSession(session, now);
      this.database
        .prepare('UPDATE device_enrollments SET claimed_at = ? WHERE id = ?')
        .run(now, row.id);
      insertAuditEvent(
        this.database,
        {
          requestId: input.requestId,
          action: 'device_enrollment_claimed',
          outcome: 'allowed',
          actorDeviceId: session.deviceId,
          sessionId: session.sessionId,
          metadata: { deviceType: row.device_type },
        },
        now,
      );
    });
    return session;
  }

  public authenticate(rawToken: string): AuthenticatedIdentity {
    const now = this.now();
    const tokenHash = hashOpaqueToken(rawToken);
    const row = this.database
      .prepare(
        `SELECT
           s.id AS session_id,
           s.device_id,
           d.name AS device_name,
           d.device_type,
           d.role,
           d.status AS device_status,
           s.expires_at,
           s.idle_expires_at,
           s.revoked_at AS session_revoked_at,
           d.revoked_at AS device_revoked_at
         FROM sessions s
         JOIN devices d ON d.id = s.device_id
         WHERE s.token_hash = ?`,
      )
      .get(tokenHash) as SessionRow | undefined;

    if (
      row === undefined ||
      row.device_status !== 'active' ||
      row.session_revoked_at !== null ||
      row.device_revoked_at !== null ||
      row.expires_at <= now ||
      row.idle_expires_at <= now
    ) {
      throw new AuthenticationError();
    }

    const idleExpiresAt = Math.min(now + this.options.idleSessionTtlMs, row.expires_at);
    this.database
      .prepare('UPDATE sessions SET last_seen_at = ?, idle_expires_at = ? WHERE id = ?')
      .run(now, idleExpiresAt, row.session_id);
    this.database
      .prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?')
      .run(now, row.device_id);

    return {
      sessionId: row.session_id,
      deviceId: row.device_id,
      deviceName: row.device_name,
      deviceType: row.device_type,
      role: row.role,
      expiresAt: row.expires_at,
      idleExpiresAt,
    };
  }

  public logout(identity: AuthenticatedIdentity, requestId: string): void {
    const now = this.now();
    runInTransaction(this.database, () => {
      this.database
        .prepare('UPDATE sessions SET revoked_at = ? WHERE id = ?')
        .run(now, identity.sessionId);
      insertAuditEvent(
        this.database,
        {
          requestId,
          action: 'logout',
          outcome: 'allowed',
          actorDeviceId: identity.deviceId,
          sessionId: identity.sessionId,
        },
        now,
      );
    });
  }

  public async changePassword(
    identity: AuthenticatedIdentity,
    currentPassword: string,
    newPassword: string,
    requestId: string,
  ): Promise<void> {
    if (identity.role !== 'owner') {
      throw new AuthorizationError();
    }
    const owner = this.database
      .prepare("SELECT password_hash FROM owner_accounts WHERE id = 'owner'")
      .get() as { password_hash: string } | undefined;
    if (owner === undefined || !(await verifyPassword(currentPassword, owner.password_hash))) {
      this.recordAuditFailure(requestId, 'password_change_failed');
      throw new AuthenticationError();
    }

    const passwordHash = await hashPassword(newPassword);
    const now = this.now();
    runInTransaction(this.database, () => {
      this.database
        .prepare("UPDATE owner_accounts SET password_hash = ?, updated_at = ? WHERE id = 'owner'")
        .run(passwordHash, now);
      this.database
        .prepare('UPDATE sessions SET revoked_at = ? WHERE revoked_at IS NULL AND id <> ?')
        .run(now, identity.sessionId);
      insertAuditEvent(
        this.database,
        {
          requestId,
          action: 'password_changed',
          outcome: 'allowed',
          actorDeviceId: identity.deviceId,
          sessionId: identity.sessionId,
        },
        now,
      );
    });
  }

  public changeDeviceRole(
    identity: AuthenticatedIdentity,
    deviceId: string,
    role: 'admin' | 'member',
    requestId: string,
  ): void {
    if (identity.role !== 'owner') {
      throw new AuthorizationError();
    }
    const now = this.now();
    runInTransaction(this.database, () => {
      const device = this.database
        .prepare('SELECT id, role FROM devices WHERE id = ?')
        .get(deviceId) as { id: string; role: DeviceSummary['role'] } | undefined;
      if (device === undefined) {
        throw new NotFoundError('Device', deviceId);
      }
      if (device.role === 'owner') {
        throw new ConflictError('The owner device role cannot be changed');
      }
      this.database.prepare('UPDATE devices SET role = ? WHERE id = ?').run(role, deviceId);
      insertAuditEvent(
        this.database,
        {
          requestId,
          action: 'device_role_changed',
          outcome: 'allowed',
          actorDeviceId: identity.deviceId,
          sessionId: identity.sessionId,
          metadata: { deviceId, role },
        },
        now,
      );
    });
  }

  public revokeDevice(identity: AuthenticatedIdentity, deviceId: string, requestId: string): void {
    if (identity.role !== 'owner' && identity.role !== 'admin') {
      throw new AuthorizationError();
    }
    const now = this.now();
    runInTransaction(this.database, () => {
      const device = this.database
        .prepare('SELECT id, role, status FROM devices WHERE id = ?')
        .get(deviceId) as
        { id: string; role: DeviceSummary['role']; status: DeviceSummary['status'] } | undefined;
      if (device === undefined) {
        throw new NotFoundError('Device', deviceId);
      }
      if (device.role === 'owner') {
        throw new ConflictError('The owner device cannot be revoked');
      }
      this.database
        .prepare("UPDATE devices SET status = 'revoked', revoked_at = ? WHERE id = ?")
        .run(now, deviceId);
      this.database
        .prepare('UPDATE sessions SET revoked_at = ? WHERE device_id = ? AND revoked_at IS NULL')
        .run(now, deviceId);
      insertAuditEvent(
        this.database,
        {
          requestId,
          action: 'device_revoked',
          outcome: 'allowed',
          actorDeviceId: identity.deviceId,
          sessionId: identity.sessionId,
          metadata: { deviceId },
        },
        now,
      );
    });
  }

  public listDevices(identity: AuthenticatedIdentity): readonly DeviceSummary[] {
    if (identity.role !== 'owner' && identity.role !== 'admin') {
      throw new AuthorizationError();
    }
    const rows = this.database
      .prepare(
        `SELECT id, name, device_type, role, status, created_at, last_seen_at, revoked_at
         FROM devices ORDER BY created_at ASC`,
      )
      .all() as DeviceRow[];
    return rows.map(toDeviceSummary);
  }

  private newSession(
    deviceName: string,
    deviceType: string,
    role: AuthSession['role'],
    now: number,
  ): AuthSession & { readonly tokenHash: string } {
    const token = createOpaqueToken();
    const sessionId = this.createId();
    const deviceId = this.createId();
    const expiresAt = now + this.options.sessionTtlMs;
    const idleExpiresAt = Math.min(now + this.options.idleSessionTtlMs, expiresAt);
    return {
      token: token.raw,
      tokenHash: token.hash,
      sessionId,
      deviceId,
      deviceName,
      deviceType,
      role,
      expiresAt,
      idleExpiresAt,
    };
  }

  private insertDevice(session: AuthSession, now: number): void {
    this.database
      .prepare(
        `INSERT INTO devices (id, name, device_type, role, status, created_at)
         VALUES (?, ?, ?, ?, 'active', ?)`,
      )
      .run(session.deviceId, session.deviceName, session.deviceType, session.role, now);
  }

  private insertSession(session: AuthSession & { readonly tokenHash?: string }, now: number): void {
    const tokenHash = session.tokenHash;
    if (tokenHash === undefined) {
      throw new AuthenticationError();
    }
    this.database
      .prepare(
        `INSERT INTO sessions
          (id, device_id, token_hash, created_at, last_seen_at, expires_at, idle_expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.sessionId,
        session.deviceId,
        tokenHash,
        now,
        now,
        session.expiresAt,
        session.idleExpiresAt,
      );
  }

  private recordSetupFailure(requestId: string): void {
    const now = this.now();
    runInTransaction(this.database, () => {
      const row = this.database
        .prepare(
          "SELECT failed_attempts FROM setup_codes WHERE id = 'initial' AND consumed_at IS NULL",
        )
        .get() as { failed_attempts: number } | undefined;
      if (row !== undefined) {
        const attempts = row.failed_attempts + 1;
        this.database
          .prepare(
            "UPDATE setup_codes SET failed_attempts = ?, consumed_at = CASE WHEN ? >= 5 THEN ? ELSE consumed_at END WHERE id = 'initial'",
          )
          .run(attempts, attempts, now);
      }
      insertAuditEvent(
        this.database,
        {
          requestId,
          action: 'owner_setup_failed',
          outcome: 'failed',
        },
        now,
      );
    });
  }

  private recordAuditFailure(requestId: string, action: string): void {
    try {
      insertAuditEvent(this.database, { requestId, action, outcome: 'failed' }, this.now());
    } catch (error) {
      this.logger.error('auth_audit_failed', { action });
      throw error;
    }
  }
}

function toDeviceSummary(row: DeviceRow): DeviceSummary {
  return {
    id: row.id,
    name: row.name,
    deviceType: row.device_type,
    role: row.role,
    status: row.status,
    createdAt: row.created_at,
    ...(row.last_seen_at === null ? {} : { lastSeenAt: row.last_seen_at }),
    ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
  };
}
