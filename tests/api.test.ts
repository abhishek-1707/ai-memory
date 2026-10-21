import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';

import { buildApp } from '../src/api/app.js';
import type { AppConfig } from '../src/config.js';
import { openDatabase } from '../src/database/database.js';
import { createLogger } from '../src/logging.js';
import { AuthService } from '../src/security/auth.js';

interface TestApp {
  readonly app: FastifyInstance;
  readonly database: ReturnType<typeof openDatabase>;
  readonly auth: AuthService;
  readonly directory: string;
}

const resources: TestApp[] = [];

afterEach(async () => {
  for (const resource of resources.splice(0)) {
    await resource.app.close();
    resource.database.close();
    rmSync(resource.directory, { recursive: true, force: true });
  }
});

describe('authenticated REST API', () => {
  it('requires setup and authentication before exposing project data', async () => {
    const testApp = await createTestApp();
    const status = await testApp.app.inject({ method: 'GET', url: '/api/v1/auth/setup/status' });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ data: { setupRequired: true } });

    const unauthorized = await testApp.app.inject({ method: 'GET', url: '/api/v1/projects' });
    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.json()).toMatchObject({
      error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
    });
    const auditActions = testApp.database
      .prepare('SELECT action FROM security_audit_events ORDER BY sequence')
      .all() as Array<{ action: string }>;
    expect(auditActions.map((event) => event.action)).toContain('authentication_denied');
  });

  it('performs first-run setup, project-scoped memory operations, and safe errors', async () => {
    const testApp = await createTestApp();
    const setupCode = testApp.auth.createSetupCode().code;
    const setup = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: {
        setupCode,
        password: 'correct horse battery staple',
        deviceName: 'Owner PC',
        deviceType: 'windows',
      },
    });
    expect(setup.statusCode).toBe(201);
    const ownerSession = setup.json().data as { token: string; deviceId: string };
    const ownerHash = testApp.database
      .prepare("SELECT password_hash FROM owner_accounts WHERE id = 'owner'")
      .get() as { password_hash: string };
    expect(ownerHash.password_hash).not.toContain('correct horse battery staple');

    const projectResponse = await request(
      testApp.app,
      'POST',
      '/api/v1/projects',
      ownerSession.token,
      {
        name: 'API Project',
      },
    );
    expect(projectResponse.statusCode).toBe(201);
    const project = projectResponse.json().data as { id: string };

    const createMemory = await request(
      testApp.app,
      'POST',
      `/api/v1/projects/${project.id}/memories`,
      ownerSession.token,
      {
        recordType: 'finding',
        title: 'Storage',
        content: 'SQLite is the local source of truth.',
        provenance: {
          sourceKind: 'user_provided',
          verificationStatus: 'user_confirmed',
        },
      },
      { 'idempotency-key': 'memory-create-1' },
    );
    expect(createMemory.statusCode).toBe(201);
    const memory = createMemory.json().data as { id: string; version: number };

    const repeatedCreate = await request(
      testApp.app,
      'POST',
      `/api/v1/projects/${project.id}/memories`,
      ownerSession.token,
      {
        recordType: 'finding',
        title: 'Storage',
        content: 'SQLite is the local source of truth.',
        provenance: {
          sourceKind: 'user_provided',
          verificationStatus: 'user_confirmed',
        },
      },
      { 'idempotency-key': 'memory-create-1' },
    );
    expect(repeatedCreate.statusCode).toBe(201);
    expect(repeatedCreate.json().data.id).toBe(memory.id);

    const reusedKey = await request(
      testApp.app,
      'POST',
      `/api/v1/projects/${project.id}/memories`,
      ownerSession.token,
      {
        recordType: 'finding',
        title: 'Different request',
        content: 'This must not reuse the previous idempotency key.',
        provenance: {
          sourceKind: 'user_provided',
          verificationStatus: 'unverified',
        },
      },
      { 'idempotency-key': 'memory-create-1' },
    );
    expect(reusedKey.statusCode).toBe(409);

    const search = await request(
      testApp.app,
      'GET',
      `/api/v1/projects/${project.id}/memories/search?query=SQLite`,
      ownerSession.token,
    );
    expect(search.statusCode).toBe(200);
    expect(search.json().data).toHaveLength(1);

    const update = await request(
      testApp.app,
      'PATCH',
      `/api/v1/projects/${project.id}/memories/${memory.id}`,
      ownerSession.token,
      {
        expectedVersion: memory.version,
        content: 'SQLite remains the local source of truth with FTS5 search.',
        provenance: {
          sourceKind: 'test_result',
          verificationStatus: 'test_verified',
          verificationMethod: 'API integration test',
        },
      },
    );
    expect(update.statusCode).toBe(200);
    expect(update.json().data.version).toBe(2);

    const staleUpdate = await request(
      testApp.app,
      'PATCH',
      `/api/v1/projects/${project.id}/memories/${memory.id}`,
      ownerSession.token,
      {
        expectedVersion: 1,
        content: 'This stale update must be rejected.',
        provenance: {
          sourceKind: 'agent_inferred',
          verificationStatus: 'unverified',
        },
      },
    );
    expect(staleUpdate.statusCode).toBe(409);
    expect(staleUpdate.json().error).not.toHaveProperty('stack');
    expect(staleUpdate.json().error).not.toHaveProperty('details');

    const badLogin = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {
        password: 'wrong password that is not returned',
        deviceName: 'Attacker',
        deviceType: 'unknown',
      },
    });
    expect(badLogin.statusCode).toBe(401);
    expect(JSON.stringify(badLogin.json())).not.toContain('wrong password');

    const passwordChange = await request(
      testApp.app,
      'POST',
      '/api/v1/auth/password',
      ownerSession.token,
      {
        currentPassword: 'correct horse battery staple',
        newPassword: 'new correct horse battery staple',
      },
    );
    expect(passwordChange.statusCode).toBe(200);

    const oldPasswordLogin = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: {
        password: 'correct horse battery staple',
        deviceName: 'Old Password Device',
        deviceType: 'test',
      },
    });
    expect(oldPasswordLogin.statusCode).toBe(401);

    const auditActions = testApp.database
      .prepare('SELECT action FROM security_audit_events ORDER BY sequence')
      .all() as Array<{ action: string }>;
    expect(auditActions.map((event) => event.action)).toEqual(
      expect.arrayContaining([
        'owner_setup',
        'project_created',
        'memory_created',
        'password_changed',
      ]),
    );
  });

  it('enrolls, scopes, and revokes a second device', async () => {
    const testApp = await createTestApp();
    const owner = await setupOwner(testApp);
    const projectResponse = await request(testApp.app, 'POST', '/api/v1/projects', owner.token, {
      name: 'Private Project',
    });
    const project = projectResponse.json().data as { id: string };
    const memoryResponse = await request(
      testApp.app,
      'POST',
      `/api/v1/projects/${project.id}/memories`,
      owner.token,
      {
        recordType: 'note',
        title: 'Private note',
        content: 'Only authorized project devices should read this.',
        provenance: { sourceKind: 'user_provided', verificationStatus: 'unverified' },
      },
    );
    const memory = memoryResponse.json().data as { id: string };

    const enrollment = await request(testApp.app, 'POST', '/api/v1/auth/enrollments', owner.token, {
      deviceName: 'Phone',
      deviceType: 'mobile',
    });
    expect(enrollment.statusCode).toBe(201);
    const enrollmentToken = enrollment.json().data.code as string;
    const claim = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/enrollments/claim',
      payload: { enrollmentToken },
    });
    expect(claim.statusCode).toBe(200);
    const deviceSession = claim.json().data as { token: string; deviceId: string };

    const beforeGrant = await request(
      testApp.app,
      'GET',
      `/api/v1/projects/${project.id}/memories/${memory.id}`,
      deviceSession.token,
    );
    expect(beforeGrant.statusCode).toBe(404);

    const grant = await request(
      testApp.app,
      'PUT',
      `/api/v1/devices/${deviceSession.deviceId}/projects/${project.id}`,
      owner.token,
      { role: 'reader' },
    );
    expect(grant.statusCode).toBe(200);

    const read = await request(
      testApp.app,
      'GET',
      `/api/v1/projects/${project.id}/memories/${memory.id}`,
      deviceSession.token,
    );
    expect(read.statusCode).toBe(200);

    const write = await request(
      testApp.app,
      'PATCH',
      `/api/v1/projects/${project.id}/memories/${memory.id}`,
      deviceSession.token,
      {
        expectedVersion: 1,
        content: 'Reader devices cannot write.',
        provenance: { sourceKind: 'agent_inferred', verificationStatus: 'unverified' },
      },
    );
    expect(write.statusCode).toBe(403);

    const revoke = await request(
      testApp.app,
      'POST',
      `/api/v1/devices/${deviceSession.deviceId}/revoke`,
      owner.token,
    );
    expect(revoke.statusCode).toBe(200);

    const afterRevoke = await request(testApp.app, 'GET', '/api/v1/auth/me', deviceSession.token);
    expect(afterRevoke.statusCode).toBe(401);
  });

  it('rejects cross-origin browser requests and applies auth rate limits', async () => {
    const testApp = await createTestApp({ authRateLimitMax: 2 });
    const setupCode = testApp.auth.createSetupCode().code;
    const setup = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      headers: { origin: 'https://untrusted.example' },
      payload: {
        setupCode,
        password: 'correct horse battery staple',
        deviceName: 'Owner PC',
        deviceType: 'windows',
      },
    });
    expect(setup.statusCode).toBe(403);

    const validSetup = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: {
        setupCode,
        password: 'correct horse battery staple',
        deviceName: 'Owner PC',
        deviceType: 'windows',
      },
    });
    expect(validSetup.statusCode).toBe(201);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await testApp.app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { password: 'wrong password', deviceName: 'Bad', deviceType: 'test' },
      });
      expect(response.statusCode).toBe(401);
    }
    const limited = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { password: 'wrong password', deviceName: 'Bad', deviceType: 'test' },
    });
    expect(limited.statusCode).toBe(429);
  });
});

async function createTestApp(config: Partial<AppConfig> = {}): Promise<TestApp> {
  const directory = mkdtempSync(join(tmpdir(), 'omnimemory-api-'));
  const database = openDatabase(join(directory, 'memory.sqlite'));
  const logger = createLogger('error');
  const app = await buildApp({ database, logger, config });
  const auth = new AuthService(database, logger, {
    sessionTtlMs: 30 * 24 * 60 * 60 * 1000,
    idleSessionTtlMs: 24 * 60 * 60 * 1000,
    enrollmentTtlMs: 10 * 60 * 1000,
    setupCodeTtlMs: 10 * 60 * 1000,
  });
  const resource = { app, database, auth, directory };
  resources.push(resource);
  return resource;
}

async function setupOwner(testApp: TestApp): Promise<{ token: string; deviceId: string }> {
  const response = await testApp.app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    payload: {
      setupCode: testApp.auth.createSetupCode().code,
      password: 'correct horse battery staple',
      deviceName: 'Owner PC',
      deviceType: 'windows',
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json().data as { token: string; deviceId: string };
}

async function request(
  app: FastifyInstance,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  token: string,
  payload?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<LightMyRequestResponse> {
  const options: InjectOptions = {
    method,
    url,
    headers: { authorization: `Bearer ${token}`, ...extraHeaders },
  };
  if (payload !== undefined) {
    options.payload = payload as Record<string, unknown>;
  }
  return app.inject(options);
}
