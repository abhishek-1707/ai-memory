import { z } from 'zod';

import { ValidationError } from '../errors.js';
import type {
  CreateMemoryInput,
  CreateProjectInput,
  ListActivityInput,
  ListRecentMemoriesInput,
  MemoryHistoryInput,
  RecordActivityInput,
  SearchMemoryInput,
  UpdateMemoryInput,
} from './types.js';

const uuidSchema = z.string().uuid();

const provenanceSchema = z.object({
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
});

const memoryFields = {
  recordType: z.enum(['profile', 'project_fact', 'finding', 'constraint', 'requirement', 'note']),
  title: z.string().trim().min(1).max(200),
  content: z.string().trim().min(1).max(100_000),
};

const createMemorySchema = z.object({
  projectId: uuidSchema.optional(),
  idempotencyKey: z.string().trim().min(1).max(200).optional(),
  ...memoryFields,
  provenance: provenanceSchema,
});

const updateMemorySchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    idempotencyKey: z.string().trim().min(1).max(200).optional(),
    title: memoryFields.title.optional(),
    content: memoryFields.content.optional(),
    recordType: memoryFields.recordType.optional(),
    provenance: provenanceSchema,
    changeReason: z.string().trim().min(1).max(500).optional(),
  })
  .refine(
    (input) =>
      input.title !== undefined || input.content !== undefined || input.recordType !== undefined,
    'At least one memory field must change',
  );

const searchMemorySchema = z.object({
  query: z.string().trim().min(1).max(500),
  projectId: uuidSchema.optional(),
  limit: z.number().int().min(1).max(100).default(20),
});

const listRecentMemoriesSchema = z.object({
  projectId: uuidSchema.optional(),
  limit: z.number().int().min(1).max(100).default(20),
});

const projectSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2_000).optional(),
});

const activitySchema = z.object({
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
  actorDeviceId: uuidSchema.optional(),
});

const listActivitySchema = z.object({
  projectId: uuidSchema,
  limit: z.number().int().min(1).max(100).default(50),
});

const secretPatterns = [
  /-----BEGIN [^-]+ PRIVATE KEY-----/i,
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password)\s*[:=]\s*\S+/i,
  /\b(?:sk-[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{20,})\b/,
];

export function parseCreateMemoryInput(input: unknown): CreateMemoryInput {
  return parse(createMemorySchema, input, 'Invalid memory input');
}

export function parseUpdateMemoryInput(input: unknown): UpdateMemoryInput {
  return parse(updateMemorySchema, input, 'Invalid memory update');
}

export function parseSearchMemoryInput(input: unknown): SearchMemoryInput {
  return parse(searchMemorySchema, input, 'Invalid memory search');
}

export function parseListRecentMemoriesInput(input: unknown): ListRecentMemoriesInput {
  return parse(listRecentMemoriesSchema, input, 'Invalid recent-memory query');
}

export function parseCreateProjectInput(input: unknown): CreateProjectInput {
  return parse(projectSchema, input, 'Invalid project input');
}

export function parseRecordActivityInput(input: unknown): RecordActivityInput {
  const parsed = parse(activitySchema, input, 'Invalid activity input');
  if (parsed.metadata !== undefined && JSON.stringify(parsed.metadata).length > 4_000) {
    throw new ValidationError('Activity metadata is too large');
  }
  return parsed;
}

export function parseListActivityInput(input: unknown): ListActivityInput {
  return parse(listActivitySchema, input, 'Invalid activity query');
}

export function parseMemoryId(input: unknown): string {
  return parse(uuidSchema, input, 'Invalid memory ID');
}

export function parseProjectId(input: unknown): string {
  return parse(uuidSchema, input, 'Invalid project ID');
}

export function parseMemoryHistoryInput(input: unknown): MemoryHistoryInput {
  return parse(z.object({ id: uuidSchema }), input, 'Invalid memory history input');
}

export function assertSafeMemoryText(title: string, content: string): void {
  const combined = `${title}\n${content}`;
  if (secretPatterns.some((pattern) => pattern.test(combined))) {
    throw new ValidationError('Memory text appears to contain a secret-shaped value', {
      reason: 'SECRET_DETECTED',
    });
  }
}

function parse<T>(schema: z.ZodType<T>, input: unknown, message: string): T {
  const result = schema.safeParse(input);
  if (result.success) {
    return result.data;
  }

  throw new ValidationError(message, {
    issues: result.error.issues.map((issue) => ({
      path: issue.path,
      message: issue.message,
    })),
  });
}
