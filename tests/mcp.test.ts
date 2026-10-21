import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';
import { openDatabase } from '../src/database/database.js';
import { createLogger } from '../src/logging.js';
import { MemoryEngine } from '../src/memory/engine.js';
import { createMcpServer } from '../src/mcp/server.js';
import { AuthService } from '../src/security/auth.js';

interface Fixture {
  readonly directory: string;
  readonly database: ReturnType<typeof openDatabase>;
  readonly token: string;
  readonly projectId: string;
}

interface Connection {
  readonly fixture: Fixture;
  readonly client: Client;
  readonly close: () => Promise<void>;
}

interface MemoryPayload {
  readonly id: string;
  readonly version: number;
  readonly content: string;
}

interface ProjectContextPayload {
  readonly project: { readonly id: string };
  readonly recentMemories: readonly MemoryPayload[];
}

interface ActivityPayload {
  readonly projectId: string;
}

interface HistoryPayload {
  readonly version: number;
}

interface TaskPayload {
  readonly id: string;
  readonly version: number;
  readonly status: string;
}

interface HandoffPayload {
  readonly id: string;
  readonly taskId: string;
}

const resources: Array<Fixture | Connection> = [];

afterEach(async () => {
  for (const resource of resources.splice(0)) {
    if ('client' in resource) {
      await resource.close();
      continue;
    }
    try {
      resource.database.close();
    } catch {
      // A failure test may have already closed the database.
    }
    rmSync(resource.directory, { recursive: true, force: true });
  }
});

describe('MCP integration', () => {
  it('discovers every tool and completes the authorized memory flow', async () => {
    const connection = await connectInMemory(await createFixture());
    const tools = await connection.client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        'search_memory',
        'get_memory',
        'get_project_context',
        'list_recent_memories',
        'record_activity',
        'create_memory',
        'update_memory',
        'get_memory_history',
        'create_task',
        'list_tasks',
        'get_task',
        'update_task',
        'transition_task',
        'create_handoff',
        'list_handoffs',
        'get_handoff',
      ]),
    );

    const created = await call<MemoryPayload>(connection.client, 'create_memory', {
      projectId: connection.fixture.projectId,
      recordType: 'finding',
      title: 'MCP storage',
      content: 'The MCP server uses the existing memory engine.',
      provenance: {
        sourceKind: 'user_provided',
        verificationStatus: 'user_confirmed',
      },
      idempotencyKey: 'mcp-create-1',
    });
    expect(created.id).toBeTypeOf('string');
    expect(created.version).toBe(1);

    const repeated = await call<MemoryPayload>(connection.client, 'create_memory', {
      projectId: connection.fixture.projectId,
      recordType: 'finding',
      title: 'MCP storage',
      content: 'The MCP server uses the existing memory engine.',
      provenance: {
        sourceKind: 'user_provided',
        verificationStatus: 'user_confirmed',
      },
      idempotencyKey: 'mcp-create-1',
    });
    expect(repeated.id).toBe(created.id);

    const search = await call<readonly MemoryPayload[]>(connection.client, 'search_memory', {
      projectId: connection.fixture.projectId,
      query: 'memory engine',
      limit: 10,
    });
    expect(search).toHaveLength(1);

    const retrieved = await call<MemoryPayload>(connection.client, 'get_memory', {
      projectId: connection.fixture.projectId,
      memoryId: created.id,
    });
    expect(retrieved.content).toContain('existing memory engine');

    const context = await call<ProjectContextPayload>(connection.client, 'get_project_context', {
      projectId: connection.fixture.projectId,
      limit: 10,
    });
    expect(context.project.id).toBe(connection.fixture.projectId);
    expect(context.recentMemories).toHaveLength(1);

    const recent = await call<readonly MemoryPayload[]>(connection.client, 'list_recent_memories', {
      projectId: connection.fixture.projectId,
      limit: 10,
    });
    expect(recent[0]?.id).toBe(created.id);

    const activity = await call<ActivityPayload>(connection.client, 'record_activity', {
      projectId: connection.fixture.projectId,
      eventType: 'test_recorded',
      summary: 'MCP integration test completed',
      metadata: { source: 'vitest' },
    });
    expect(activity.projectId).toBe(connection.fixture.projectId);

    const updated = await call<MemoryPayload>(connection.client, 'update_memory', {
      projectId: connection.fixture.projectId,
      memoryId: created.id,
      expectedVersion: 1,
      content: 'The MCP server uses the existing memory engine and API authorization.',
      provenance: {
        sourceKind: 'test_result',
        verificationStatus: 'test_verified',
        verificationMethod: 'MCP integration test',
      },
    });
    expect(updated.version).toBe(2);

    const history = await call<readonly HistoryPayload[]>(connection.client, 'get_memory_history', {
      projectId: connection.fixture.projectId,
      memoryId: created.id,
    });
    expect(history).toHaveLength(2);
    expect(history[1]?.version).toBe(2);
  });

  it('completes the authorized task and handoff workflow', async () => {
    const connection = await connectInMemory(await createFixture());
    const projectId = connection.fixture.projectId;

    const created = await call<TaskPayload>(connection.client, 'create_task', {
      projectId,
      title: 'Coordinate MCP agents',
      priority: 'high',
      evidenceReferences: ['tests/mcp.test.ts'],
      idempotencyKey: 'mcp-task-create-1',
    });
    const repeated = await call<TaskPayload>(connection.client, 'create_task', {
      projectId,
      title: 'Coordinate MCP agents',
      priority: 'high',
      evidenceReferences: ['tests/mcp.test.ts'],
      idempotencyKey: 'mcp-task-create-1',
    });
    expect(repeated.id).toBe(created.id);

    const listed = await call<readonly TaskPayload[]>(connection.client, 'list_tasks', {
      projectId,
      status: 'todo',
      limit: 10,
    });
    expect(listed).toHaveLength(1);

    const updated = await call<TaskPayload>(connection.client, 'update_task', {
      projectId,
      taskId: created.id,
      expectedVersion: 1,
      title: 'Coordinate authorized MCP agents',
      idempotencyKey: 'mcp-task-update-1',
    });
    expect(updated.version).toBe(2);

    const started = await call<TaskPayload>(connection.client, 'transition_task', {
      projectId,
      taskId: created.id,
      expectedVersion: 2,
      status: 'in_progress',
      note: 'Started after reading project context.',
      idempotencyKey: 'mcp-task-transition-1',
    });
    expect(started.status).toBe('in_progress');

    const retrieved = await call<TaskPayload>(connection.client, 'get_task', {
      projectId,
      taskId: created.id,
    });
    expect(retrieved.id).toBe(created.id);

    const handoff = await call<HandoffPayload>(connection.client, 'create_handoff', {
      projectId,
      taskId: created.id,
      summary: 'Pass the task to the next MCP agent.',
      completedWork: ['Created and started the task.'],
      verifiedResults: ['MCP task workflow passed.'],
      blockers: [],
      nextSteps: ['Complete the task after review.'],
      evidenceReferences: ['tests/mcp.test.ts'],
      linkedTaskIds: [created.id],
      verificationStatus: 'verified',
      idempotencyKey: 'mcp-handoff-create-1',
    });
    expect(handoff.taskId).toBe(created.id);

    const handoffs = await call<readonly HandoffPayload[]>(connection.client, 'list_handoffs', {
      projectId,
      limit: 10,
    });
    expect(handoffs).toHaveLength(1);

    const handoffById = await call<HandoffPayload>(connection.client, 'get_handoff', {
      projectId,
      handoffId: handoff.id,
    });
    expect(handoffById.id).toBe(handoff.id);

    const context = await call<{
      readonly recentTasks: readonly TaskPayload[];
      readonly recentHandoffs: readonly HandoffPayload[];
    }>(connection.client, 'get_project_context', { projectId, limit: 10 });
    expect(context.recentTasks).toHaveLength(1);
    expect(context.recentHandoffs).toHaveLength(1);

    const stale = await connection.client.callTool({
      name: 'update_task',
      arguments: {
        projectId,
        taskId: created.id,
        expectedVersion: 1,
        description: 'Stale update.',
      },
    });
    expect(stale.isError).toBe(true);
    expect(readToolPayload(stale)).toEqual({
      error: { code: 'CONFLICT', message: 'Request conflicts with current state' },
    });

    const secret = 'api_key=synthetic-mcp-task-secret';
    const rejectedSecret = await connection.client.callTool({
      name: 'create_task',
      arguments: {
        projectId,
        title: 'Sensitive task',
        description: secret,
        priority: 'normal',
      },
    });
    expect(rejectedSecret.isError).toBe(true);
    expect(JSON.stringify(rejectedSecret)).not.toContain(secret);
  });

  it('rejects stale writes, invalid arguments, secret-shaped content, and unauthorized access', async () => {
    const fixture = await createFixture();
    const connection = await connectInMemory(fixture);

    const created = await call<MemoryPayload>(connection.client, 'create_memory', {
      projectId: fixture.projectId,
      recordType: 'note',
      title: 'Conflict test',
      content: 'Current content.',
      provenance: { sourceKind: 'user_provided', verificationStatus: 'unverified' },
    });

    await call<MemoryPayload>(connection.client, 'update_memory', {
      projectId: fixture.projectId,
      memoryId: created.id,
      expectedVersion: 1,
      content: 'First update wins.',
      provenance: { sourceKind: 'test_result', verificationStatus: 'test_verified' },
    });

    const stale = await connection.client.callTool({
      name: 'update_memory',
      arguments: {
        projectId: fixture.projectId,
        memoryId: created.id,
        expectedVersion: 1,
        content: 'Stale content.',
        provenance: { sourceKind: 'agent_inferred', verificationStatus: 'unverified' },
      },
    });
    expect(stale.isError).toBe(true);
    expect(readToolPayload(stale)).toEqual({
      error: { code: 'CONFLICT', message: 'Request conflicts with current state' },
    });

    const invalid = await connection.client.callTool({
      name: 'search_memory',
      arguments: { projectId: fixture.projectId },
    });
    expect(invalid.isError).toBe(true);
    expect(JSON.stringify(invalid)).toContain('Input validation error');

    const secret = 'api_key=synthetic-test-secret-value';
    const rejectedSecret = await connection.client.callTool({
      name: 'create_memory',
      arguments: {
        projectId: fixture.projectId,
        recordType: 'note',
        title: 'Credential-shaped input',
        content: secret,
        provenance: { sourceKind: 'user_provided', verificationStatus: 'unverified' },
      },
    });
    expect(rejectedSecret.isError).toBe(true);
    expect(JSON.stringify(rejectedSecret)).not.toContain(secret);

    const member = await createMemberSession(fixture);
    const unauthorized = await connectInMemory({ ...fixture, token: member });
    const denied = await unauthorized.client.callTool({
      name: 'get_project_context',
      arguments: { projectId: fixture.projectId, limit: 10 },
    });
    expect(denied.isError).toBe(true);
    expect(readToolPayload(denied)).toEqual({
      error: { code: 'NOT_FOUND', message: 'Resource not found' },
    });
    resources.push(unauthorized);
  });

  it('returns a safe internal error when the database fails', async () => {
    const fixture = await createFixture();
    const connection = await connectInMemory(fixture);
    fixture.database.close();

    const result = await connection.client.callTool({
      name: 'get_project_context',
      arguments: { projectId: fixture.projectId, limit: 10 },
    });
    expect(result.isError).toBe(true);
    expect(readToolPayload(result)).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
  });

  it('starts through stdio and supports discovery and calls from an MCP client', async () => {
    const fixture = await createFixture();
    const tsxPath = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const scriptPath = join(process.cwd(), 'scripts', 'mcp-stdio.ts');
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [tsxPath, scriptPath],
      cwd: process.cwd(),
      env: {
        OMNIMEMORY_DB_PATH: join(fixture.directory, 'memory.sqlite'),
        OMNIMEMORY_MCP_TOKEN: fixture.token,
        PATH: process.env.PATH ?? '',
      },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'omnimemory-test-client', version: '1.0.0' });
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.some((tool) => tool.name === 'search_memory')).toBe(true);

    const created = await call<MemoryPayload>(client, 'create_memory', {
      projectId: fixture.projectId,
      recordType: 'note',
      title: 'Stdio memory',
      content: 'Created through the real stdio transport.',
      provenance: { sourceKind: 'test_result', verificationStatus: 'test_verified' },
    });
    const retrieved = await call<MemoryPayload>(client, 'get_memory', {
      projectId: fixture.projectId,
      memoryId: created.id,
    });
    expect(retrieved.content).toContain('real stdio transport');

    await client.close();
    fixture.database.close();
    rmSync(fixture.directory, { recursive: true, force: true });
    resources.splice(resources.indexOf(fixture), 1);
  });
});

async function createFixture(): Promise<Fixture> {
  const directory = mkdtempSync(join(tmpdir(), 'omnimemory-mcp-'));
  const database = openDatabase(join(directory, 'memory.sqlite'));
  const logger = createLogger('error');
  const config = loadConfig();
  const auth = new AuthService(database, logger, {
    sessionTtlMs: config.sessionTtlMs,
    idleSessionTtlMs: config.idleSessionTtlMs,
    enrollmentTtlMs: config.enrollmentTtlMs,
    setupCodeTtlMs: config.setupCodeTtlMs,
  });
  const session = await auth.setupOwner({
    setupCode: auth.createSetupCode().code,
    password: 'correct horse battery staple',
    deviceName: 'MCP Test Device',
    deviceType: 'test',
    requestId: 'mcp-test-setup',
  });
  const engine = new MemoryEngine(database, logger);
  const project = engine.createProject({ name: `MCP Project ${Date.now()}` });
  const fixture = { directory, database, token: session.token, projectId: project.id };
  resources.push(fixture);
  return fixture;
}

async function createMemberSession(fixture: Fixture): Promise<string> {
  const logger = createLogger('error');
  const config = loadConfig();
  const auth = new AuthService(fixture.database, logger, {
    sessionTtlMs: config.sessionTtlMs,
    idleSessionTtlMs: config.idleSessionTtlMs,
    enrollmentTtlMs: config.enrollmentTtlMs,
    setupCodeTtlMs: config.setupCodeTtlMs,
  });
  const session = await auth.login({
    password: 'correct horse battery staple',
    deviceName: 'Unauthorized Test Device',
    deviceType: 'test',
    requestId: 'mcp-test-member',
  });
  return session.token;
}

async function connectInMemory(fixture: Fixture): Promise<Connection> {
  const server = createMcpServer({
    database: fixture.database,
    token: fixture.token,
    logger: createLogger('error'),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'omnimemory-test-client', version: '1.0.0' });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const connection = {
    fixture,
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
  resources.push(connection);
  return connection;
}

async function call<T>(
  client: Client,
  name: string,
  arguments_: Record<string, unknown>,
): Promise<T> {
  const result = await client.callTool({ name, arguments: arguments_ });
  expect(result.isError).not.toBe(true);
  return readToolPayload(result) as T;
}

function readToolPayload(result: { content: Array<{ type: string; text?: string }> }): unknown {
  const text = result.content.find((item) => item.type === 'text')?.text;
  if (text === undefined) {
    throw new Error('MCP result did not contain text content');
  }
  return JSON.parse(text) as unknown;
}
