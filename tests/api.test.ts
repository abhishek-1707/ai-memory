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
  it('serves the local PWA shell without making API routes public', async () => {
    const testApp = await createTestApp();

    const index = await testApp.app.inject({ method: 'GET', url: '/' });
    expect(index.statusCode).toBe(200);
    expect(index.headers['content-type']).toContain('text/html');
    expect(index.body).toContain('<title>OmniMemory</title>');

    const manifest = await testApp.app.inject({ method: 'GET', url: '/manifest.webmanifest' });
    expect(manifest.statusCode).toBe(200);
    expect(manifest.headers['content-type']).toBe('application/manifest+json');

    const projects = await testApp.app.inject({ method: 'GET', url: '/api/v1/projects' });
    expect(projects.statusCode).toBe(401);
    expect(projects.json()).toMatchObject({
      error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
    });
  });

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

  it('creates the first owner through the trusted desktop bootstrap exactly once', async () => {
    const testApp = await createTestApp({ startupToken: 'desktop-startup-token' });

    const missingStartupToken = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup/bootstrap',
      payload: {
        password: 'correct horse battery staple',
        deviceName: 'Owner PC',
        deviceType: 'windows',
      },
    });
    expect(missingStartupToken.statusCode).toBe(403);

    const invalidPassword = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup/bootstrap',
      headers: { 'x-omnimemory-startup-token': 'desktop-startup-token' },
      payload: { password: 'too-short', deviceName: 'Owner PC', deviceType: 'windows' },
    });
    expect(invalidPassword.statusCode).toBe(400);

    const first = testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup/bootstrap',
      headers: { 'x-omnimemory-startup-token': 'desktop-startup-token' },
      payload: {
        password: 'correct horse battery staple',
        deviceName: 'Owner PC',
        deviceType: 'windows',
      },
    });
    const concurrent = testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup/bootstrap',
      headers: { 'x-omnimemory-startup-token': 'desktop-startup-token' },
      payload: {
        password: 'another correct horse battery staple',
        deviceName: 'Second Owner PC',
        deviceType: 'windows',
      },
    });
    const results = await Promise.all([first, concurrent]);
    expect(results.map((response) => response.statusCode).sort()).toEqual([201, 409]);

    const success = results.find((response) => response.statusCode === 201);
    expect(success?.json().data).toMatchObject({ role: 'owner' });
    const ownerToken = success?.json().data.token as string;
    const me = await request(testApp.app, 'GET', '/api/v1/auth/me', ownerToken);
    expect(me.statusCode).toBe(200);

    const owners = testApp.database
      .prepare("SELECT COUNT(*) AS count FROM owner_accounts WHERE id = 'owner'")
      .get() as { count: number };
    const setupCodes = testApp.database
      .prepare('SELECT COUNT(*) AS count FROM setup_codes')
      .get() as { count: number };
    expect(owners.count).toBe(1);
    expect(setupCodes.count).toBe(0);
  });

  it('preserves an existing legacy setup-code row while transitioning to owner bootstrap', async () => {
    const testApp = await createTestApp({ startupToken: 'desktop-startup-token' });
    const legacyCode = testApp.auth.createSetupCode().code;

    const setup = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup/bootstrap',
      headers: { 'x-omnimemory-startup-token': 'desktop-startup-token' },
      payload: {
        password: 'correct horse battery staple',
        deviceName: 'Owner PC',
        deviceType: 'windows',
      },
    });
    expect(setup.statusCode).toBe(201);

    const storedCode = testApp.database
      .prepare("SELECT token_hash, consumed_at FROM setup_codes WHERE id = 'initial'")
      .get() as { token_hash: string; consumed_at: number | null };
    expect(storedCode.token_hash).toBeTruthy();
    expect(storedCode.consumed_at).toBeNull();

    const legacyRecovery = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: {
        setupCode: legacyCode,
        password: 'another correct horse battery staple',
        deviceName: 'Second Owner PC',
        deviceType: 'windows',
      },
    });
    expect(legacyRecovery.statusCode).toBe(409);
    expect(legacyRecovery.json()).toMatchObject({ error: { code: 'SETUP_COMPLETE' } });
  });

  it('rejects an expired setup code and an expired authenticated session', async () => {
    const testApp = await createTestApp({
      setupCodeTtlMs: 1,
      sessionTtlMs: 1,
      idleSessionTtlMs: 1,
    });
    const expiredSetupCode = testApp.auth.createSetupCode().code;
    await new Promise((resolve) => setTimeout(resolve, 5));

    const setup = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: {
        setupCode: expiredSetupCode,
        password: 'correct horse battery staple',
        deviceName: 'Owner PC',
        deviceType: 'windows',
      },
    });
    expect(setup.statusCode).toBe(401);
    expect(setup.json()).toMatchObject({ error: { code: 'SETUP_CODE_INVALID' } });

    const sessionApp = await createTestApp({ sessionTtlMs: 1, idleSessionTtlMs: 1 });
    const owner = await setupOwner(sessionApp);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const expiredSession = await request(sessionApp.app, 'GET', '/api/v1/auth/me', owner.token);
    expect(expiredSession.statusCode).toBe(401);
    expect(expiredSession.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
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

  it('tracks project tasks and evidence-backed handoffs through REST', async () => {
    const testApp = await createTestApp();
    const owner = await setupOwner(testApp);
    const projectResponse = await request(testApp.app, 'POST', '/api/v1/projects', owner.token, {
      name: 'Task API Project',
    });
    const project = projectResponse.json().data as { id: string };

    const createTask = await request(
      testApp.app,
      'POST',
      `/api/v1/projects/${project.id}/tasks`,
      owner.token,
      {
        title: 'Coordinate agents',
        priority: 'high',
        evidenceReferences: ['tests/api.test.ts'],
      },
      { 'idempotency-key': 'task-create-1' },
    );
    expect(createTask.statusCode).toBe(201);
    const task = createTask.json().data as { id: string; version: number };

    const repeatedTask = await request(
      testApp.app,
      'POST',
      `/api/v1/projects/${project.id}/tasks`,
      owner.token,
      {
        title: 'Coordinate agents',
        priority: 'high',
        evidenceReferences: ['tests/api.test.ts'],
      },
      { 'idempotency-key': 'task-create-1' },
    );
    expect(repeatedTask.statusCode).toBe(201);
    expect(repeatedTask.json().data.id).toBe(task.id);

    const list = await request(
      testApp.app,
      'GET',
      `/api/v1/projects/${project.id}/tasks?status=todo`,
      owner.token,
    );
    expect(list.statusCode).toBe(200);
    expect(list.json().data).toHaveLength(1);

    const update = await request(
      testApp.app,
      'PATCH',
      `/api/v1/projects/${project.id}/tasks/${task.id}`,
      owner.token,
      { expectedVersion: task.version, title: 'Coordinate authorized agents' },
      { 'idempotency-key': 'task-update-1' },
    );
    expect(update.statusCode).toBe(200);
    expect(update.json().data.version).toBe(2);

    const start = await request(
      testApp.app,
      'POST',
      `/api/v1/projects/${project.id}/tasks/${task.id}/transitions`,
      owner.token,
      { expectedVersion: 2, status: 'in_progress', note: 'Started after reading context.' },
      { 'idempotency-key': 'task-transition-1' },
    );
    expect(start.statusCode).toBe(200);
    expect(start.json().data.status).toBe('in_progress');

    const handoff = await request(
      testApp.app,
      'POST',
      `/api/v1/projects/${project.id}/handoffs`,
      owner.token,
      {
        taskId: task.id,
        summary: 'Pass the task to the next agent.',
        completedWork: ['Created the task tracking flow.'],
        verifiedResults: ['REST task workflow passed.'],
        blockers: [],
        nextSteps: ['Review the MCP workflow.'],
        evidenceReferences: ['tests/api.test.ts'],
        verificationStatus: 'verified',
      },
      { 'idempotency-key': 'handoff-create-1' },
    );
    expect(handoff.statusCode).toBe(201);
    const handoffRecord = handoff.json().data as { id: string };

    const handoffList = await request(
      testApp.app,
      'GET',
      `/api/v1/projects/${project.id}/handoffs`,
      owner.token,
    );
    expect(handoffList.statusCode).toBe(200);
    expect(handoffList.json().data).toHaveLength(1);

    const handoffGet = await request(
      testApp.app,
      'GET',
      `/api/v1/projects/${project.id}/handoffs/${handoffRecord.id}`,
      owner.token,
    );
    expect(handoffGet.statusCode).toBe(200);

    const context = await request(
      testApp.app,
      'GET',
      `/api/v1/projects/${project.id}/context?limit=10`,
      owner.token,
    );
    expect(context.statusCode).toBe(200);
    expect(context.json().data.recentTasks).toHaveLength(1);
    expect(context.json().data.recentHandoffs).toHaveLength(1);

    const invalidTransition = await request(
      testApp.app,
      'POST',
      `/api/v1/projects/${project.id}/tasks/${task.id}/transitions`,
      owner.token,
      { expectedVersion: 3, status: 'cancelled' },
    );
    expect(invalidTransition.statusCode).toBe(200);

    const completed = await request(
      testApp.app,
      'POST',
      `/api/v1/projects/${project.id}/tasks/${task.id}/transitions`,
      owner.token,
      { expectedVersion: 4, status: 'completed' },
    );
    expect(completed.statusCode).toBe(409);

    const secret = 'api_key=synthetic-rest-task-secret';
    const rejectedSecret = await request(
      testApp.app,
      'POST',
      `/api/v1/projects/${project.id}/tasks`,
      owner.token,
      { title: 'Sensitive', description: secret, priority: 'normal' },
    );
    expect(rejectedSecret.statusCode).toBe(400);
    expect(JSON.stringify(rejectedSecret.json())).not.toContain(secret);

    const enrollment = await request(testApp.app, 'POST', '/api/v1/auth/enrollments', owner.token, {
      deviceName: 'Task Reader',
      deviceType: 'test',
    });
    const claim = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/enrollments/claim',
      payload: { enrollmentToken: enrollment.json().data.code },
    });
    const reader = claim.json().data as { token: string; deviceId: string };
    const grant = await request(
      testApp.app,
      'PUT',
      `/api/v1/devices/${reader.deviceId}/projects/${project.id}`,
      owner.token,
      { role: 'reader' },
    );
    expect(grant.statusCode).toBe(200);

    const readerGet = await request(
      testApp.app,
      'GET',
      `/api/v1/projects/${project.id}/tasks/${task.id}`,
      reader.token,
    );
    expect(readerGet.statusCode).toBe(200);
    const readerWrite = await request(
      testApp.app,
      'POST',
      `/api/v1/projects/${project.id}/tasks`,
      reader.token,
      { title: 'Reader cannot create', priority: 'normal' },
    );
    expect(readerWrite.statusCode).toBe(403);

    const editorGrant = await request(
      testApp.app,
      'PUT',
      `/api/v1/devices/${reader.deviceId}/projects/${project.id}`,
      owner.token,
      { role: 'editor' },
    );
    expect(editorGrant.statusCode).toBe(200);
    const editorWrite = await request(
      testApp.app,
      'POST',
      `/api/v1/projects/${project.id}/tasks`,
      reader.token,
      { title: 'Editor can create', priority: 'normal' },
    );
    expect(editorWrite.statusCode).toBe(201);

    const otherProjectResponse = await request(
      testApp.app,
      'POST',
      '/api/v1/projects',
      owner.token,
      {
        name: 'Other Task Project',
      },
    );
    const otherProject = otherProjectResponse.json().data as { id: string };
    const otherTaskResponse = await request(
      testApp.app,
      'POST',
      `/api/v1/projects/${otherProject.id}/tasks`,
      owner.token,
      { title: 'Private other task', priority: 'normal' },
    );
    const otherTask = otherTaskResponse.json().data as { id: string };
    const crossProject = await request(
      testApp.app,
      'GET',
      `/api/v1/projects/${otherProject.id}/tasks/${otherTask.id}`,
      reader.token,
    );
    expect(crossProject.statusCode).toBe(404);

    const auditActions = testApp.database
      .prepare('SELECT action FROM security_audit_events ORDER BY sequence')
      .all() as Array<{ action: string }>;
    expect(auditActions.map((event) => event.action)).toEqual(
      expect.arrayContaining([
        'task_created',
        'task_updated',
        'task_transitioned',
        'handoff_created',
      ]),
    );
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

  it('allows the configured same-origin PWA while rejecting a foreign origin', async () => {
    const testApp = await createTestApp();
    const sameOrigin = await testApp.app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      headers: { origin: 'http://127.0.0.1:3210' },
      payload: {
        setupCode: testApp.auth.createSetupCode().code,
        password: 'correct horse battery staple',
        deviceName: 'Browser',
        deviceType: 'browser',
      },
    });
    expect(sameOrigin.statusCode).toBe(201);

    const foreignOrigin = await testApp.app.inject({
      method: 'GET',
      url: '/api/v1/health',
      headers: { origin: 'https://untrusted.example' },
    });
    expect(foreignOrigin.statusCode).toBe(403);
  });
});

async function createTestApp(config: Partial<AppConfig> = {}): Promise<TestApp> {
  const directory = mkdtempSync(join(tmpdir(), 'omnimemory-api-'));
  const database = openDatabase(join(directory, 'memory.sqlite'));
  const logger = createLogger('error');
  const app = await buildApp({ database, logger, config });
  const auth = new AuthService(database, logger, {
    sessionTtlMs: config.sessionTtlMs ?? 30 * 24 * 60 * 60 * 1000,
    idleSessionTtlMs: config.idleSessionTtlMs ?? 24 * 60 * 60 * 1000,
    enrollmentTtlMs: config.enrollmentTtlMs ?? 10 * 60 * 1000,
    setupCodeTtlMs: config.setupCodeTtlMs ?? 10 * 60 * 1000,
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
