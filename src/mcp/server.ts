import { McpServer, type CallToolResult } from '@modelcontextprotocol/server';
import type { DatabaseSync } from 'node:sqlite';
import * as z from 'zod/v4';

import { loadConfig, type AppConfig } from '../config.js';
import {
  AuthenticationError,
  AuthorizationError,
  ConflictError,
  DatabaseError,
  MigrationError,
  NotFoundError,
  OmniMemoryError,
  SetupRequiredError,
  ValidationError,
} from '../errors.js';
import { createLogger, type Logger } from '../logging.js';
import { MemoryEngine } from '../memory/engine.js';
import { AccessControlService } from '../security/access-control.js';
import { AuditService } from '../security/audit.js';
import { AuthService } from '../security/auth.js';
import type { AuthenticatedIdentity } from '../security/types.js';

const MAX_LIMIT = 50;
const MAX_OUTPUT_CHARACTERS = 512_000;

const uuidSchema = z.string().uuid();
const recordTypeSchema = z.enum([
  'profile',
  'project_fact',
  'finding',
  'constraint',
  'requirement',
  'note',
]);
const provenanceSchema = z
  .object({
    sourceKind: z.enum([
      'user_provided',
      'file_observed',
      'system_observed',
      'agent_inferred',
      'test_result',
    ]),
    sourceReference: z.string().trim().min(1).max(500).optional(),
    verificationStatus: z.enum([
      'unverified',
      'user_confirmed',
      'test_verified',
      'superseded',
      'disputed',
    ]),
    verificationMethod: z.string().trim().min(1).max(500).optional(),
    observedAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
const limitSchema = z.number().int().min(1).max(MAX_LIMIT).default(20);

const searchMemorySchema = z
  .object({
    projectId: uuidSchema,
    query: z.string().trim().min(1).max(500),
    limit: limitSchema,
  })
  .strict();

const projectMemorySchema = z
  .object({
    projectId: uuidSchema,
    limit: limitSchema,
  })
  .strict();

const memoryLookupSchema = z
  .object({
    projectId: uuidSchema,
    memoryId: uuidSchema,
  })
  .strict();

const createMemorySchema = z
  .object({
    projectId: uuidSchema,
    recordType: recordTypeSchema,
    title: z.string().trim().min(1).max(200),
    content: z.string().trim().min(1).max(100_000),
    provenance: provenanceSchema,
    idempotencyKey: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

const updateMemorySchema = z
  .object({
    projectId: uuidSchema,
    memoryId: uuidSchema,
    expectedVersion: z.number().int().positive(),
    title: z.string().trim().min(1).max(200).optional(),
    content: z.string().trim().min(1).max(100_000).optional(),
    recordType: recordTypeSchema.optional(),
    provenance: provenanceSchema,
    changeReason: z.string().trim().min(1).max(500).optional(),
    idempotencyKey: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

const recordActivitySchema = z
  .object({
    projectId: uuidSchema,
    eventType: z.enum([
      'finding_recorded',
      'task_started',
      'task_updated',
      'handoff_created',
      'test_recorded',
      'note',
    ]),
    summary: z.string().trim().min(1).max(2_000),
    metadata: z.record(z.string(), z.string().max(500)).optional(),
  })
  .strict();

export interface CreateMcpServerOptions {
  readonly database: DatabaseSync;
  readonly token: string;
  readonly config?: AppConfig;
  readonly logger?: Logger;
  readonly serverName?: string;
  readonly serverVersion?: string;
}

export type BuildMcpServerOptions = CreateMcpServerOptions;

export function createMcpServer(options: CreateMcpServerOptions): McpServer {
  const token = options.token.trim();
  if (token.length === 0) {
    throw new ValidationError('MCP authentication token is required');
  }

  const logger = options.logger ?? createLogger('error');
  const config = options.config ?? loadConfig();
  const engine = new MemoryEngine(options.database, logger);
  const auth = new AuthService(options.database, logger, {
    sessionTtlMs: config.sessionTtlMs,
    idleSessionTtlMs: config.idleSessionTtlMs,
    enrollmentTtlMs: config.enrollmentTtlMs,
    setupCodeTtlMs: config.setupCodeTtlMs,
  });
  const access = new AccessControlService(options.database);
  const audit = new AuditService(options.database, logger);
  const server = new McpServer(
    {
      name: options.serverName ?? 'omnimemory',
      version: options.serverVersion ?? '0.1.0',
    },
    { capabilities: { tools: {} } },
  );

  const run = <T>(
    operation: string,
    callback: (identity: AuthenticatedIdentity) => T,
  ): Promise<CallToolResult> =>
    Promise.resolve().then(() => {
      try {
        const identity = auth.authenticate(token);
        return successResult(callback(identity));
      } catch (error) {
        return failureResult(operation, error, logger);
      }
    });

  server.registerTool(
    'search_memory',
    {
      description: 'Search current memories in an authorized project using lexical search.',
      inputSchema: searchMemorySchema,
    },
    async (input) =>
      run('search_memory', (identity) => {
        access.requireProjectAccess(identity, input.projectId, 'read');
        return engine.searchMemory({
          projectId: input.projectId,
          query: input.query,
          limit: input.limit,
        });
      }),
  );

  server.registerTool(
    'get_memory',
    {
      description: 'Retrieve one memory from an authorized project.',
      inputSchema: memoryLookupSchema,
    },
    async (input) =>
      run('get_memory', (identity) => {
        access.requireProjectAccess(identity, input.projectId, 'read');
        const memory = engine.getMemory(input.memoryId);
        assertMemoryProject(memory.projectId, input.projectId, input.memoryId);
        return memory;
      }),
  );

  server.registerTool(
    'get_project_context',
    {
      description: 'Retrieve an authorized project and its recent memories.',
      inputSchema: projectMemorySchema,
    },
    async (input) =>
      run('get_project_context', (identity) => {
        access.requireProjectAccess(identity, input.projectId, 'read');
        return {
          project: engine.getProject(input.projectId),
          recentMemories: engine.listRecentMemories({
            projectId: input.projectId,
            limit: input.limit,
          }),
        };
      }),
  );

  server.registerTool(
    'list_recent_memories',
    {
      description: 'List recent current memories in an authorized project.',
      inputSchema: projectMemorySchema,
    },
    async (input) =>
      run('list_recent_memories', (identity) => {
        access.requireProjectAccess(identity, input.projectId, 'read');
        return engine.listRecentMemories({
          projectId: input.projectId,
          limit: input.limit,
        });
      }),
  );

  server.registerTool(
    'record_activity',
    {
      description: 'Record validated activity in an authorized project.',
      inputSchema: recordActivitySchema,
    },
    async (input) =>
      run('record_activity', (identity) => {
        access.requireProjectAccess(identity, input.projectId, 'write');
        const activity = engine.recordActivity({
          ...input,
          actorDeviceId: identity.deviceId,
        });
        audit.record({
          requestId: `mcp:${identity.sessionId}`,
          action: 'activity_recorded',
          outcome: 'allowed',
          actorDeviceId: identity.deviceId,
          sessionId: identity.sessionId,
          projectId: input.projectId,
          resourceType: 'activity',
          resourceId: activity.id,
        });
        return activity;
      }),
  );

  server.registerTool(
    'create_memory',
    {
      description: 'Create a validated memory in an authorized project.',
      inputSchema: createMemorySchema,
    },
    async (input) =>
      run('create_memory', (identity) => {
        access.requireProjectAccess(identity, input.projectId, 'write');
        const memory = engine.createMemory({
          ...input,
          idempotencyKey: scopeIdempotencyKey(identity, input.idempotencyKey),
        });
        audit.record({
          requestId: `mcp:${identity.sessionId}`,
          action: 'memory_created',
          outcome: 'allowed',
          actorDeviceId: identity.deviceId,
          sessionId: identity.sessionId,
          projectId: input.projectId,
          resourceType: 'memory',
          resourceId: memory.id,
        });
        return memory;
      }),
  );

  server.registerTool(
    'update_memory',
    {
      description: 'Update a memory with optimistic version protection.',
      inputSchema: updateMemorySchema,
    },
    async (input) =>
      run('update_memory', (identity) => {
        access.requireProjectAccess(identity, input.projectId, 'write');
        const current = engine.getMemory(input.memoryId);
        assertMemoryProject(current.projectId, input.projectId, input.memoryId);
        const memory = engine.updateMemory(input.memoryId, {
          ...input,
          idempotencyKey: scopeIdempotencyKey(identity, input.idempotencyKey),
        });
        audit.record({
          requestId: `mcp:${identity.sessionId}`,
          action: 'memory_updated',
          outcome: 'allowed',
          actorDeviceId: identity.deviceId,
          sessionId: identity.sessionId,
          projectId: input.projectId,
          resourceType: 'memory',
          resourceId: memory.id,
        });
        return memory;
      }),
  );

  server.registerTool(
    'get_memory_history',
    {
      description: 'Retrieve immutable revision history for an authorized memory.',
      inputSchema: memoryLookupSchema,
    },
    async (input) =>
      run('get_memory_history', (identity) => {
        access.requireProjectAccess(identity, input.projectId, 'read');
        const memory = engine.getMemory(input.memoryId);
        assertMemoryProject(memory.projectId, input.projectId, input.memoryId);
        return engine.getMemoryHistory({ id: input.memoryId });
      }),
  );

  return server;
}

export const buildMcpServer = createMcpServer;

function scopeIdempotencyKey(
  identity: AuthenticatedIdentity,
  key: string | undefined,
): string | undefined {
  return key === undefined ? undefined : `${identity.deviceId}:${key}`;
}

function assertMemoryProject(
  memoryProjectId: string | undefined,
  expectedProjectId: string,
  memoryId: string,
): void {
  if (memoryProjectId !== expectedProjectId) {
    throw new NotFoundError('Memory', memoryId);
  }
}

function successResult(data: unknown): CallToolResult {
  const text = JSON.stringify(redactMcpOutput(data));
  if (text.length > MAX_OUTPUT_CHARACTERS) {
    return failurePayload(
      'RESULT_TOO_LARGE',
      'Result is too large; narrow the query or reduce the limit',
    );
  }
  return { content: [{ type: 'text', text }] };
}

function failureResult(operation: string, error: unknown, logger: Logger): CallToolResult {
  const mapped = mapMcpError(error);
  logger.error('mcp_tool_failed', { operation, errorCode: mapped.code });
  return failurePayload(mapped.code, mapped.message);
}

function failurePayload(code: string, message: string): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: { code, message } }) }],
    isError: true,
  };
}

function mapMcpError(error: unknown): { code: string; message: string } {
  if (error instanceof ValidationError) {
    return { code: 'INVALID_ARGUMENT', message: 'Invalid tool arguments' };
  }
  if (error instanceof AuthenticationError) {
    return { code: 'UNAUTHORIZED', message: 'Authentication required' };
  }
  if (error instanceof SetupRequiredError) {
    return { code: 'SETUP_REQUIRED', message: 'Owner setup is required' };
  }
  if (error instanceof AuthorizationError) {
    return { code: 'FORBIDDEN', message: 'Forbidden' };
  }
  if (error instanceof NotFoundError) {
    return { code: 'NOT_FOUND', message: 'Resource not found' };
  }
  if (error instanceof ConflictError) {
    return { code: 'CONFLICT', message: 'Request conflicts with current state' };
  }
  if (
    error instanceof OmniMemoryError ||
    error instanceof DatabaseError ||
    error instanceof MigrationError
  ) {
    return { code: 'INTERNAL_ERROR', message: 'Internal server error' };
  }
  return { code: 'INTERNAL_ERROR', message: 'Internal server error' };
}

function redactMcpOutput(value: unknown): unknown {
  if (typeof value === 'string') {
    return redactSensitiveText(value);
  }
  if (Array.isArray(value)) {
    return value.map(redactMcpOutput);
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, redactMcpOutput(entry)]),
    );
  }
  return value;
}

function redactSensitiveText(value: string): string {
  return value
    .replace(
      /-----BEGIN [^-]+ PRIVATE KEY-----[\s\S]*?-----END [^-]+ PRIVATE KEY-----/gi,
      '[REDACTED_PRIVATE_KEY]',
    )
    .replace(
      /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password|client[_-]?secret)\s*([:=])\s*\S+/gi,
      '$1$2[REDACTED]',
    )
    .replace(/\b(?:sk-[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,})\b/g, '[REDACTED_TOKEN]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED_TOKEN]');
}
