import type { DatabaseSync } from 'node:sqlite';

import { runInTransaction, type SqlRow } from '../database/database.js';
import { AuthorizationError, ConflictError, NotFoundError } from '../errors.js';
import type { Project } from '../memory/types.js';
import type { AuthenticatedIdentity, ProjectPermissionRole } from './types.js';

export type ProjectAction = 'read' | 'write' | 'manage';

interface PermissionRow extends SqlRow {
  role: ProjectPermissionRole;
}

interface ProjectWithPermissionRow extends SqlRow {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  permission_role: ProjectPermissionRole;
}

export class AccessControlService {
  public constructor(private readonly database: DatabaseSync) {}

  public requireProjectAccess(
    identity: AuthenticatedIdentity,
    projectId: string,
    action: ProjectAction,
  ): void {
    if (identity.role === 'owner') {
      this.assertProjectExists(projectId);
      return;
    }

    const permission = this.database
      .prepare(
        `SELECT pp.role
         FROM project_permissions pp
         JOIN devices d ON d.id = pp.device_id
         WHERE pp.device_id = ? AND pp.project_id = ? AND d.status = 'active'`,
      )
      .get(identity.deviceId, projectId) as PermissionRow | undefined;
    if (permission === undefined) {
      throw new NotFoundError('Project', projectId);
    }
    if (!isAllowed(permission.role, action)) {
      throw new AuthorizationError();
    }
    this.assertProjectExists(projectId);
  }

  public requireGlobalAdmin(identity: AuthenticatedIdentity): void {
    if (identity.role !== 'owner' && identity.role !== 'admin') {
      throw new AuthorizationError();
    }
  }

  public listAccessibleProjects(identity: AuthenticatedIdentity): readonly Project[] {
    if (identity.role === 'owner') {
      return this.database
        .prepare('SELECT id, name, description, created_at, updated_at FROM projects ORDER BY name')
        .all()
        .map((row) => toProject(row as ProjectWithPermissionRow));
    }

    return this.database
      .prepare(
        `SELECT p.id, p.name, p.description, p.created_at, p.updated_at,
                pp.role AS permission_role
         FROM projects p
         JOIN project_permissions pp ON pp.project_id = p.id
         WHERE pp.device_id = ?
         ORDER BY p.name`,
      )
      .all(identity.deviceId)
      .map((row) => toProject(row as ProjectWithPermissionRow));
  }

  public grantProjectPermission(
    identity: AuthenticatedIdentity,
    deviceId: string,
    projectId: string,
    role: ProjectPermissionRole,
  ): void {
    this.requireProjectManagement(identity, projectId);
    this.assertProjectExists(projectId);
    this.assertActiveDevice(deviceId);
    const now = Date.now();
    runInTransaction(this.database, () => {
      this.database
        .prepare(
          `INSERT INTO project_permissions (device_id, project_id, role, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(device_id, project_id) DO UPDATE SET role = excluded.role, updated_at = excluded.updated_at`,
        )
        .run(deviceId, projectId, role, now, now);
    });
  }

  public grantProjectPermissionForNewProject(deviceId: string, projectId: string): void {
    this.assertActiveDevice(deviceId);
    const now = Date.now();
    runInTransaction(this.database, () => {
      this.database
        .prepare(
          `INSERT INTO project_permissions (device_id, project_id, role, created_at, updated_at)
           VALUES (?, ?, 'owner', ?, ?)`,
        )
        .run(deviceId, projectId, now, now);
    });
  }

  public revokeProjectPermission(
    identity: AuthenticatedIdentity,
    deviceId: string,
    projectId: string,
  ): void {
    this.requireProjectManagement(identity, projectId);
    runInTransaction(this.database, () => {
      const current = this.database
        .prepare('SELECT role FROM project_permissions WHERE device_id = ? AND project_id = ?')
        .get(deviceId, projectId) as PermissionRow | undefined;
      if (current === undefined) {
        throw new NotFoundError('Project permission', `${deviceId}:${projectId}`);
      }
      if (current.role === 'owner') {
        const ownerCount = this.database
          .prepare(
            "SELECT COUNT(*) AS count FROM project_permissions WHERE project_id = ? AND role = 'owner'",
          )
          .get(projectId) as { count: number };
        if (Number(ownerCount.count) <= 1) {
          throw new ConflictError('A project must retain at least one owner');
        }
      }
      this.database
        .prepare('DELETE FROM project_permissions WHERE device_id = ? AND project_id = ?')
        .run(deviceId, projectId);
    });
  }

  private requireProjectManagement(identity: AuthenticatedIdentity, projectId: string): void {
    if (identity.role === 'owner' || identity.role === 'admin') {
      return;
    }
    this.requireProjectAccess(identity, projectId, 'manage');
  }

  private assertProjectExists(projectId: string): void {
    const row = this.database.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
    if (row === undefined) {
      throw new NotFoundError('Project', projectId);
    }
  }

  private assertActiveDevice(deviceId: string): void {
    const row = this.database
      .prepare("SELECT id FROM devices WHERE id = ? AND status = 'active'")
      .get(deviceId);
    if (row === undefined) {
      throw new NotFoundError('Device', deviceId);
    }
  }
}

function isAllowed(role: ProjectPermissionRole, action: ProjectAction): boolean {
  if (action === 'read') {
    return true;
  }
  if (action === 'write') {
    return role === 'editor' || role === 'owner';
  }
  return role === 'owner';
}

function toProject(row: ProjectWithPermissionRow): Project {
  return {
    id: row.id,
    name: row.name,
    ...(row.description === null ? {} : { description: row.description }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
