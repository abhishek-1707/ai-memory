import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { openDatabase } from '../database/database.js';
import {
  AuthenticationError,
  AuthorizationError,
  ConflictError,
  DatabaseError,
  MigrationError,
  NotFoundError,
  OmniMemoryError,
  RateLimitedError,
  SetupCompleteError,
  SetupRequiredError,
  ValidationError,
} from '../errors.js';
import type { AppConfig } from '../config.js';
import { loadConfig } from '../config.js';
import { createLogger, type Logger } from '../logging.js';
import { MemoryEngine } from '../memory/engine.js';
import { AccessControlService } from '../security/access-control.js';
import { AuditService } from '../security/audit.js';
import { AuthService } from '../security/auth.js';
import type { AuthenticatedIdentity } from '../security/types.js';
import { TaskTrackingService } from '../tasks/service.js';
import {
  activitySchema,
  deviceRoleSchema,
  enrollmentClaimSchema,
  enrollmentRequestSchema,
  handoffCreateSchema,
  handoffListQuerySchema,
  handoffParamSchema,
  idParamSchema,
  limitQuerySchema,
  loginBodySchema,
  memoryCreateSchema,
  memoryParamSchema,
  memoryUpdateSchema,
  passwordChangeSchema,
  parseRequest,
  permissionSchema,
  projectCreateSchema,
  projectParamSchema,
  searchQuerySchema,
  setupBodySchema,
  taskCreateSchema,
  taskListQuerySchema,
  taskParamSchema,
  taskTransitionSchema,
  taskUpdateSchema,
} from './validation.js';
import { registerStaticAssetRoutes, STATIC_ASSET_ROUTES } from './static-assets.js';

declare module 'fastify' {
  interface FastifyRequest {
    identity: AuthenticatedIdentity | null;
  }
}

export interface BuildAppOptions {
  readonly config?: Partial<AppConfig>;
  readonly database?: DatabaseSync;
  readonly logger?: Logger;
}

const API_PREFIX = '/api/v1';

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const config = { ...loadConfig(), ...options.config };
  assertLoopbackHost(config.host);
  const logger = options.logger ?? createLogger(config.logLevel);
  const database = options.database ?? openDatabase(config.databasePath);
  const ownsDatabase = options.database === undefined;
  const engine = new MemoryEngine(database, logger);
  const tasks = new TaskTrackingService(database, logger);
  const auth = new AuthService(database, logger, {
    sessionTtlMs: config.sessionTtlMs,
    idleSessionTtlMs: config.idleSessionTtlMs,
    enrollmentTtlMs: config.enrollmentTtlMs,
    setupCodeTtlMs: config.setupCodeTtlMs,
  });
  const access = new AccessControlService(database);
  const audit = new AuditService(database, logger);
  const app = Fastify({
    logger: false,
    bodyLimit: config.requestBodyLimitBytes,
    requestIdHeader: 'x-request-id',
    genReqId: () => cryptoRandomId(),
  });

  await app.register(helmet, {
    global: true,
    contentSecurityPolicy: false,
  });
  await app.register(rateLimit, {
    global: true,
    max: 120,
    timeWindow: '1 minute',
    keyGenerator: (request) => request.ip,
  });

  app.decorateRequest('identity', null);
  app.server.requestTimeout = 30_000;
  app.server.headersTimeout = 35_000;

  app.addHook('onRequest', async (request, reply) => {
    reply.header('x-request-id', request.id);
    reply.header('cache-control', 'no-store');
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-frame-options', 'DENY');
    reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=()');
    if (
      request.headers.origin !== undefined &&
      !isAllowedBrowserOrigin(request.headers.origin, config)
    ) {
      throw new AuthorizationError('Cross-origin browser access is disabled');
    }
  });

  app.addHook('onResponse', async (request, reply) => {
    logger.info('http_request_completed', {
      requestId: request.id,
      method: request.method,
      route: request.routeOptions.url,
      statusCode: reply.statusCode,
    });
  });

  app.get(`${API_PREFIX}/health`, async (_request, reply) => {
    if (config.startupToken !== undefined) {
      const suppliedToken = _request.headers['x-omnimemory-startup-token'];
      if (suppliedToken !== config.startupToken) {
        throw new AuthorizationError('Desktop backend handshake required');
      }
    }
    return sendData(reply, { status: 'ok' });
  });

  app.get(`${API_PREFIX}/auth/setup/status`, async (_request, reply) => {
    return sendData(reply, auth.getSetupStatus());
  });

  app.post(
    `${API_PREFIX}/auth/setup`,
    { config: { rateLimit: { max: config.authRateLimitMax, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const body = parseRequest(setupBodySchema, request.body);
      const session = await auth.setupOwner({ ...body, requestId: request.id });
      return sendData(reply, toSessionResponse(session), 201);
    },
  );

  app.post(
    `${API_PREFIX}/auth/login`,
    { config: { rateLimit: { max: config.authRateLimitMax, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const body = parseRequest(loginBodySchema, request.body);
      const session = await auth.login({ ...body, requestId: request.id });
      return sendData(reply, toSessionResponse(session));
    },
  );

  app.post(
    `${API_PREFIX}/auth/enrollments/claim`,
    { config: { rateLimit: { max: config.authRateLimitMax, timeWindow: '15 minutes' } } },
    async (request, reply) => {
      const body = parseRequest(enrollmentClaimSchema, request.body);
      const session = await auth.claimEnrollment({ ...body, requestId: request.id });
      return sendData(reply, toSessionResponse(session));
    },
  );

  app.addHook('preHandler', async (request) => {
    if (isPublicRoute(request)) {
      return;
    }
    request.identity = authenticateRequest(request, auth);
  });

  registerStaticAssetRoutes(app, config.staticAssetsDirectory);

  app.get(`${API_PREFIX}/auth/me`, async (request, reply) => {
    const identity = requireIdentity(request);
    return sendData(reply, identity);
  });

  app.post(`${API_PREFIX}/auth/logout`, async (request, reply) => {
    const identity = requireIdentity(request);
    auth.logout(identity, request.id);
    return sendData(reply, null);
  });

  app.post(`${API_PREFIX}/auth/password`, async (request, reply) => {
    const identity = requireIdentity(request);
    const body = parseRequest(passwordChangeSchema, request.body);
    await auth.changePassword(identity, body.currentPassword, body.newPassword, request.id);
    return sendData(reply, null);
  });

  app.post(`${API_PREFIX}/auth/enrollments`, async (request, reply) => {
    const identity = requireIdentity(request);
    const body = parseRequest(enrollmentRequestSchema, request.body);
    const token = await auth.createEnrollment(identity, { ...body, requestId: request.id });
    return sendData(reply, token, 201);
  });

  app.get(`${API_PREFIX}/devices`, async (request, reply) => {
    const identity = requireIdentity(request);
    return sendData(reply, auth.listDevices(identity));
  });

  app.post(`${API_PREFIX}/devices/:id/revoke`, async (request, reply) => {
    const identity = requireIdentity(request);
    const params = parseRequest(idParamSchema, request.params);
    auth.revokeDevice(identity, params.id, request.id);
    return sendData(reply, null);
  });

  app.patch(`${API_PREFIX}/devices/:id/role`, async (request, reply) => {
    const identity = requireIdentity(request);
    const params = parseRequest(idParamSchema, request.params);
    const body = parseRequest(deviceRoleSchema, request.body);
    auth.changeDeviceRole(identity, params.id, body.role, request.id);
    return sendData(reply, null);
  });

  app.put(`${API_PREFIX}/devices/:id/projects/:projectId`, async (request, reply) => {
    const identity = requireIdentity(request);
    const params = parseRequest(
      idParamSchema.extend({ projectId: projectParamSchema.shape.projectId }),
      request.params,
    );
    const body = parseRequest(permissionSchema, request.body);
    access.grantProjectPermission(identity, params.id, params.projectId, body.role);
    audit.record({
      requestId: request.id,
      action: 'project_permission_granted',
      outcome: 'allowed',
      actorDeviceId: identity.deviceId,
      sessionId: identity.sessionId,
      projectId: params.projectId,
      resourceType: 'device',
      resourceId: params.id,
      metadata: { role: body.role },
    });
    return sendData(reply, null);
  });

  app.delete(`${API_PREFIX}/devices/:id/projects/:projectId`, async (request, reply) => {
    const identity = requireIdentity(request);
    const params = parseRequest(
      idParamSchema.extend({ projectId: projectParamSchema.shape.projectId }),
      request.params,
    );
    access.revokeProjectPermission(identity, params.id, params.projectId);
    audit.record({
      requestId: request.id,
      action: 'project_permission_revoked',
      outcome: 'allowed',
      actorDeviceId: identity.deviceId,
      sessionId: identity.sessionId,
      projectId: params.projectId,
      resourceType: 'device',
      resourceId: params.id,
    });
    return sendData(reply, null);
  });

  app.get(`${API_PREFIX}/projects`, async (request, reply) => {
    const identity = requireIdentity(request);
    return sendData(reply, access.listAccessibleProjects(identity));
  });

  app.post(`${API_PREFIX}/projects`, async (request, reply) => {
    const identity = requireIdentity(request);
    access.requireGlobalAdmin(identity);
    const body = parseRequest(projectCreateSchema, request.body);
    const project = engine.createProject(body);
    if (identity.role !== 'owner') {
      access.grantProjectPermissionForNewProject(identity.deviceId, project.id);
    }
    audit.record({
      requestId: request.id,
      action: 'project_created',
      outcome: 'allowed',
      actorDeviceId: identity.deviceId,
      sessionId: identity.sessionId,
      projectId: project.id,
      resourceType: 'project',
      resourceId: project.id,
    });
    return sendData(reply, project, 201);
  });

  app.get(`${API_PREFIX}/projects/:projectId`, async (request, reply) => {
    const identity = requireIdentity(request);
    const params = parseRequest(projectParamSchema, request.params);
    access.requireProjectAccess(identity, params.projectId, 'read');
    return sendData(reply, engine.getProject(params.projectId));
  });

  app.get(`${API_PREFIX}/projects/:projectId/context`, async (request, reply) => {
    const identity = requireIdentity(request);
    const params = parseRequest(projectParamSchema, request.params);
    const query = parseRequest(limitQuerySchema, request.query);
    access.requireProjectAccess(identity, params.projectId, 'read');
    return sendData(reply, {
      project: engine.getProject(params.projectId),
      recentMemories: engine.listRecentMemories({
        projectId: params.projectId,
        limit: query.limit,
      }),
      recentTasks: tasks.listTasks({
        projectId: params.projectId,
        limit: Math.min(query.limit, 20),
      }),
      recentHandoffs: tasks.listHandoffs({
        projectId: params.projectId,
        limit: Math.min(query.limit, 20),
      }),
    });
  });

  app.get(`${API_PREFIX}/projects/:projectId/memories/search`, async (request, reply) => {
    const identity = requireIdentity(request);
    const params = parseRequest(projectParamSchema, request.params);
    const query = parseRequest(searchQuerySchema, request.query);
    access.requireProjectAccess(identity, params.projectId, 'read');
    return sendData(
      reply,
      engine.searchMemory({ query: query.query, projectId: params.projectId, limit: query.limit }),
    );
  });

  app.get(`${API_PREFIX}/projects/:projectId/memories/recent`, async (request, reply) => {
    const identity = requireIdentity(request);
    const params = parseRequest(projectParamSchema, request.params);
    const query = parseRequest(limitQuerySchema, request.query);
    access.requireProjectAccess(identity, params.projectId, 'read');
    return sendData(
      reply,
      engine.listRecentMemories({ projectId: params.projectId, limit: query.limit }),
    );
  });

  app.post(`${API_PREFIX}/projects/:projectId/memories`, async (request, reply) => {
    const identity = requireIdentity(request);
    const params = parseRequest(projectParamSchema, request.params);
    const body = parseRequest(memoryCreateSchema, request.body);
    access.requireProjectAccess(identity, params.projectId, 'write');
    const memory = engine.createMemory({
      ...body,
      projectId: params.projectId,
      idempotencyKey: scopedIdempotencyKey(request, identity),
    });
    recordMemoryAudit(audit, request, identity, 'memory_created', params.projectId, memory.id);
    return sendData(reply, memory, 201);
  });

  app.get(`${API_PREFIX}/projects/:projectId/memories/:memoryId`, async (request, reply) => {
    const identity = requireIdentity(request);
    const params = parseRequest(memoryParamSchema, request.params);
    access.requireProjectAccess(identity, params.projectId, 'read');
    const memory = engine.getMemory(params.memoryId);
    assertMemoryProject(memory.projectId, params.projectId);
    return sendData(reply, memory);
  });

  app.get(
    `${API_PREFIX}/projects/:projectId/memories/:memoryId/history`,
    async (request, reply) => {
      const identity = requireIdentity(request);
      const params = parseRequest(memoryParamSchema, request.params);
      access.requireProjectAccess(identity, params.projectId, 'read');
      const memory = engine.getMemory(params.memoryId);
      assertMemoryProject(memory.projectId, params.projectId);
      return sendData(reply, engine.getMemoryHistory({ id: params.memoryId }));
    },
  );

  app.patch(`${API_PREFIX}/projects/:projectId/memories/:memoryId`, async (request, reply) => {
    const identity = requireIdentity(request);
    const params = parseRequest(memoryParamSchema, request.params);
    const body = parseRequest(memoryUpdateSchema, request.body);
    access.requireProjectAccess(identity, params.projectId, 'write');
    const current = engine.getMemory(params.memoryId);
    assertMemoryProject(current.projectId, params.projectId);
    const memory = engine.updateMemory(params.memoryId, {
      ...body,
      idempotencyKey: scopedIdempotencyKey(request, identity),
    });
    recordMemoryAudit(audit, request, identity, 'memory_updated', params.projectId, memory.id);
    return sendData(reply, memory);
  });

  app.get(`${API_PREFIX}/projects/:projectId/activity`, async (request, reply) => {
    const identity = requireIdentity(request);
    const params = parseRequest(projectParamSchema, request.params);
    const query = parseRequest(limitQuerySchema, request.query);
    access.requireProjectAccess(identity, params.projectId, 'read');
    return sendData(
      reply,
      engine.listActivity({ projectId: params.projectId, limit: query.limit }),
    );
  });

  app.post(`${API_PREFIX}/projects/:projectId/activity`, async (request, reply) => {
    const identity = requireIdentity(request);
    const params = parseRequest(projectParamSchema, request.params);
    const body = parseRequest(activitySchema, request.body);
    access.requireProjectAccess(identity, params.projectId, 'write');
    const activity = engine.recordActivity({
      ...body,
      projectId: params.projectId,
      actorDeviceId: identity.deviceId,
    });
    audit.record({
      requestId: request.id,
      action: 'activity_recorded',
      outcome: 'allowed',
      actorDeviceId: identity.deviceId,
      sessionId: identity.sessionId,
      projectId: params.projectId,
      resourceType: 'activity',
      resourceId: activity.id,
    });
    return sendData(reply, activity, 201);
  });

  app.post(`${API_PREFIX}/projects/:projectId/tasks`, async (request, reply) => {
    const identity = requireIdentity(request);
    const params = parseRequest(projectParamSchema, request.params);
    const body = parseRequest(taskCreateSchema, request.body);
    access.requireProjectAccess(identity, params.projectId, 'write');
    const task = tasks.createTask({
      ...body,
      projectId: params.projectId,
      createdByDeviceId: identity.deviceId,
      idempotencyKey: scopedIdempotencyKey(request, identity),
    });
    audit.record({
      requestId: request.id,
      action: 'task_created',
      outcome: 'allowed',
      actorDeviceId: identity.deviceId,
      sessionId: identity.sessionId,
      projectId: params.projectId,
      resourceType: 'task',
      resourceId: task.id,
    });
    return sendData(reply, task, 201);
  });

  app.get(`${API_PREFIX}/projects/:projectId/tasks`, async (request, reply) => {
    const identity = requireIdentity(request);
    const params = parseRequest(projectParamSchema, request.params);
    const query = parseRequest(taskListQuerySchema, request.query);
    access.requireProjectAccess(identity, params.projectId, 'read');
    return sendData(reply, tasks.listTasks({ projectId: params.projectId, ...query }));
  });

  app.get(`${API_PREFIX}/projects/:projectId/tasks/:taskId`, async (request, reply) => {
    const identity = requireIdentity(request);
    const params = parseRequest(taskParamSchema, request.params);
    access.requireProjectAccess(identity, params.projectId, 'read');
    const task = tasks.getTask(params.taskId);
    assertTaskProject(task.projectId, params.projectId, params.taskId);
    return sendData(reply, task);
  });

  app.patch(`${API_PREFIX}/projects/:projectId/tasks/:taskId`, async (request, reply) => {
    const identity = requireIdentity(request);
    const params = parseRequest(taskParamSchema, request.params);
    const body = parseRequest(taskUpdateSchema, request.body);
    access.requireProjectAccess(identity, params.projectId, 'write');
    const current = tasks.getTask(params.taskId);
    assertTaskProject(current.projectId, params.projectId, params.taskId);
    const task = tasks.updateTask(params.taskId, {
      ...body,
      actorDeviceId: identity.deviceId,
      idempotencyKey: scopedIdempotencyKey(request, identity),
    });
    audit.record({
      requestId: request.id,
      action: 'task_updated',
      outcome: 'allowed',
      actorDeviceId: identity.deviceId,
      sessionId: identity.sessionId,
      projectId: params.projectId,
      resourceType: 'task',
      resourceId: task.id,
    });
    return sendData(reply, task);
  });

  app.post(
    `${API_PREFIX}/projects/:projectId/tasks/:taskId/transitions`,
    async (request, reply) => {
      const identity = requireIdentity(request);
      const params = parseRequest(taskParamSchema, request.params);
      const body = parseRequest(taskTransitionSchema, request.body);
      access.requireProjectAccess(identity, params.projectId, 'write');
      const current = tasks.getTask(params.taskId);
      assertTaskProject(current.projectId, params.projectId, params.taskId);
      const task = tasks.transitionTask(params.taskId, {
        ...body,
        actorDeviceId: identity.deviceId,
        idempotencyKey: scopedIdempotencyKey(request, identity),
      });
      audit.record({
        requestId: request.id,
        action: 'task_transitioned',
        outcome: 'allowed',
        actorDeviceId: identity.deviceId,
        sessionId: identity.sessionId,
        projectId: params.projectId,
        resourceType: 'task',
        resourceId: task.id,
      });
      return sendData(reply, task);
    },
  );

  app.post(`${API_PREFIX}/projects/:projectId/handoffs`, async (request, reply) => {
    const identity = requireIdentity(request);
    const params = parseRequest(projectParamSchema, request.params);
    const body = parseRequest(handoffCreateSchema, request.body);
    access.requireProjectAccess(identity, params.projectId, 'write');
    if (body.taskId !== undefined) {
      const task = tasks.getTask(body.taskId);
      assertTaskProject(task.projectId, params.projectId, body.taskId);
    }
    const handoff = tasks.createHandoff({
      ...body,
      projectId: params.projectId,
      sourceDeviceId: identity.deviceId,
      idempotencyKey: scopedIdempotencyKey(request, identity),
    });
    audit.record({
      requestId: request.id,
      action: 'handoff_created',
      outcome: 'allowed',
      actorDeviceId: identity.deviceId,
      sessionId: identity.sessionId,
      projectId: params.projectId,
      resourceType: 'handoff',
      resourceId: handoff.id,
    });
    return sendData(reply, handoff, 201);
  });

  app.get(`${API_PREFIX}/projects/:projectId/handoffs`, async (request, reply) => {
    const identity = requireIdentity(request);
    const params = parseRequest(projectParamSchema, request.params);
    const query = parseRequest(handoffListQuerySchema, request.query);
    access.requireProjectAccess(identity, params.projectId, 'read');
    return sendData(reply, tasks.listHandoffs({ projectId: params.projectId, ...query }));
  });

  app.get(`${API_PREFIX}/projects/:projectId/handoffs/:handoffId`, async (request, reply) => {
    const identity = requireIdentity(request);
    const params = parseRequest(handoffParamSchema, request.params);
    access.requireProjectAccess(identity, params.projectId, 'read');
    const handoff = tasks.getHandoff(params.handoffId);
    assertHandoffProject(handoff.projectId, params.projectId, params.handoffId);
    return sendData(reply, handoff);
  });

  app.setErrorHandler((error, request, reply) => {
    const mapped = mapPublicError(error);
    recordDeniedRequestAudit(audit, request, error);
    logger.error('http_request_failed', {
      requestId: request.id,
      method: request.method,
      route: request.routeOptions.url,
      errorCode: mapped.code,
      statusCode: mapped.statusCode,
    });
    if (mapped.statusCode === 429) {
      reply.header('retry-after', '60');
    }
    reply.code(mapped.statusCode).send({
      error: {
        code: mapped.code,
        message: mapped.message,
        requestId: request.id,
      },
    });
  });

  app.addHook('onClose', async () => {
    if (ownsDatabase) {
      database.close();
    }
  });

  return app;
}

function authenticateRequest(request: FastifyRequest, auth: AuthService): AuthenticatedIdentity {
  const value = request.headers.authorization;
  if (value === undefined) {
    throw new AuthenticationError();
  }
  const match = /^Bearer\s+([^\s]+)$/.exec(value);
  if (match === null || match[1] === undefined || match[1].length > 200) {
    throw new AuthenticationError();
  }
  return auth.authenticate(match[1]);
}

function requireIdentity(request: FastifyRequest): AuthenticatedIdentity {
  if (request.identity === null) {
    throw new AuthenticationError();
  }
  return request.identity;
}

function isPublicRoute(request: FastifyRequest): boolean {
  return (
    (request.method === 'GET' &&
      (STATIC_ASSET_ROUTES.includes(request.routeOptions.url ?? '') ||
        request.routeOptions.url === `${API_PREFIX}/health` ||
        request.routeOptions.url === `${API_PREFIX}/auth/setup/status`)) ||
    (request.method === 'POST' &&
      (request.routeOptions.url === `${API_PREFIX}/auth/setup` ||
        request.routeOptions.url === `${API_PREFIX}/auth/login` ||
        request.routeOptions.url === `${API_PREFIX}/auth/enrollments/claim`))
  );
}

function sendData(
  reply: {
    code: (statusCode: number) => typeof reply;
    send: (payload: unknown) => unknown;
    request: { id: string };
  },
  data: unknown,
  statusCode = 200,
): unknown {
  return reply.code(statusCode).send({ data, meta: { requestId: reply.request.id } });
}

function toSessionResponse(session: {
  readonly token: string;
  readonly sessionId: string;
  readonly deviceId: string;
  readonly deviceName: string;
  readonly deviceType: string;
  readonly role: string;
  readonly expiresAt: number;
  readonly idleExpiresAt: number;
}): Record<string, unknown> {
  return {
    token: session.token,
    sessionId: session.sessionId,
    deviceId: session.deviceId,
    deviceName: session.deviceName,
    deviceType: session.deviceType,
    role: session.role,
    expiresAt: session.expiresAt,
    idleExpiresAt: session.idleExpiresAt,
  };
}

function recordMemoryAudit(
  audit: AuditService,
  request: FastifyRequest,
  identity: AuthenticatedIdentity,
  action: string,
  projectId: string,
  memoryId: string,
): void {
  audit.record({
    requestId: request.id,
    action,
    outcome: 'allowed',
    actorDeviceId: identity.deviceId,
    sessionId: identity.sessionId,
    projectId,
    resourceType: 'memory',
    resourceId: memoryId,
  });
}

function assertMemoryProject(memoryProjectId: string | undefined, expectedProjectId: string): void {
  if (memoryProjectId !== expectedProjectId) {
    throw new NotFoundError('Memory', expectedProjectId);
  }
}

function assertTaskProject(
  taskProjectId: string | undefined,
  expectedProjectId: string,
  taskId: string,
): void {
  if (taskProjectId !== expectedProjectId) {
    throw new NotFoundError('Task', taskId);
  }
}

function assertHandoffProject(
  handoffProjectId: string | undefined,
  expectedProjectId: string,
  handoffId: string,
): void {
  if (handoffProjectId !== expectedProjectId) {
    throw new NotFoundError('Handoff', handoffId);
  }
}

function scopedIdempotencyKey(
  request: FastifyRequest,
  identity: AuthenticatedIdentity,
): string | undefined {
  const header = request.headers['idempotency-key'];
  if (header === undefined) {
    return undefined;
  }
  if (Array.isArray(header) || header.length < 1 || header.length > 200) {
    throw new ValidationError('Invalid Idempotency-Key header');
  }
  return `${identity.deviceId}:${header}`;
}

function assertLoopbackHost(host: string): void {
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    throw new ValidationError('Only loopback hosts are allowed in Phase 3');
  }
}

function isAllowedBrowserOrigin(origin: string, config: AppConfig): boolean {
  const allowedOrigins = new Set([`http://${config.host}:${config.port}`]);
  if (config.host === '127.0.0.1') {
    allowedOrigins.add(`http://localhost:${config.port}`);
  }
  if (config.host === 'localhost') {
    allowedOrigins.add(`http://127.0.0.1:${config.port}`);
  }
  if (config.host === '::1') {
    allowedOrigins.add(`http://[::1]:${config.port}`);
  }
  return allowedOrigins.has(origin);
}

function cryptoRandomId(): string {
  return randomUUID();
}

function mapPublicError(error: unknown): { statusCode: number; code: string; message: string } {
  if (error instanceof ValidationError) {
    return { statusCode: 400, code: 'INVALID_REQUEST', message: 'Invalid request' };
  }
  if (error instanceof AuthenticationError) {
    return { statusCode: 401, code: 'UNAUTHORIZED', message: 'Authentication required' };
  }
  if (error instanceof AuthorizationError) {
    return { statusCode: 403, code: 'FORBIDDEN', message: 'Forbidden' };
  }
  if (error instanceof NotFoundError) {
    return { statusCode: 404, code: 'NOT_FOUND', message: 'Resource not found' };
  }
  if (error instanceof ConflictError || error instanceof SetupCompleteError) {
    return {
      statusCode: 409,
      code: error.code === 'SETUP_COMPLETE' ? 'SETUP_COMPLETE' : 'CONFLICT',
      message: 'Request conflicts with current state',
    };
  }
  if (error instanceof SetupRequiredError) {
    return { statusCode: 409, code: 'SETUP_REQUIRED', message: 'Owner setup is required' };
  }
  if (error instanceof RateLimitedError) {
    return { statusCode: 429, code: 'RATE_LIMITED', message: 'Too many requests' };
  }
  if (isFastifyError(error) && error.statusCode === 413) {
    return { statusCode: 413, code: 'REQUEST_TOO_LARGE', message: 'Request body is too large' };
  }
  if (isFastifyError(error) && error.statusCode === 415) {
    return { statusCode: 415, code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Unsupported content type' };
  }
  if (isFastifyError(error) && error.statusCode === 429) {
    return { statusCode: 429, code: 'RATE_LIMITED', message: 'Too many requests' };
  }
  if (isFastifyError(error) && error.statusCode === 400) {
    return { statusCode: 400, code: 'INVALID_REQUEST', message: 'Invalid request' };
  }
  if (isFastifyError(error) && error.statusCode === 404) {
    return { statusCode: 404, code: 'NOT_FOUND', message: 'Resource not found' };
  }
  if (
    error instanceof OmniMemoryError ||
    error instanceof DatabaseError ||
    error instanceof MigrationError
  ) {
    return { statusCode: 500, code: 'INTERNAL_ERROR', message: 'Internal server error' };
  }
  return { statusCode: 500, code: 'INTERNAL_ERROR', message: 'Internal server error' };
}

function isFastifyError(error: unknown): error is { statusCode?: number } {
  return typeof error === 'object' && error !== null && 'statusCode' in error;
}

function recordDeniedRequestAudit(
  audit: AuditService,
  request: FastifyRequest,
  error: unknown,
): void {
  const isAuthFailure = error instanceof AuthenticationError;
  const isDenied =
    isAuthFailure || error instanceof AuthorizationError || error instanceof NotFoundError;
  const isRateLimited =
    error instanceof RateLimitedError || (isFastifyError(error) && error.statusCode === 429);
  if (!isDenied && !isRateLimited) {
    return;
  }

  try {
    audit.record({
      requestId: request.id,
      action: isRateLimited
        ? 'rate_limit_exceeded'
        : isAuthFailure
          ? 'authentication_denied'
          : 'authorization_denied',
      outcome: isRateLimited ? 'failed' : 'denied',
      actorDeviceId: request.identity?.deviceId,
      sessionId: request.identity?.sessionId,
      projectId: requestProjectId(request),
    });
  } catch {
    // The original public error is safer than replacing it with an audit failure.
  }
}

function requestProjectId(request: FastifyRequest): string | undefined {
  const params = request.params;
  if (typeof params !== 'object' || params === null || !('projectId' in params)) {
    return undefined;
  }
  const projectId = params.projectId;
  return typeof projectId === 'string' && /^[0-9a-f-]{36}$/i.test(projectId)
    ? projectId
    : undefined;
}
