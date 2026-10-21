import { z } from 'zod';

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

const idempotencyKeySchema = z.string().trim().min(1).max(200).optional();

export const searchMemorySchema = z.object({
  projectId: uuidSchema,
  query: z.string().trim().min(1).max(500),
  limit: z.number().int().min(1).max(100).default(20),
});

export const getMemorySchema = z.object({
  projectId: uuidSchema,
  memoryId: uuidSchema,
});

export const projectContextSchema = z.object({
  projectId: uuidSchema,
  limit: z.number().int().min(1).max(100).default(20),
});

export const recentMemoriesSchema = projectContextSchema;

export const recordActivitySchema = z.object({
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
});

export const createMemorySchema = z.object({
  projectId: uuidSchema,
  idempotencyKey: idempotencyKeySchema,
  ...memoryFields,
  provenance: provenanceSchema,
});

export const updateMemorySchema = z
  .object({
    projectId: uuidSchema,
    memoryId: uuidSchema,
    expectedVersion: z.number().int().positive(),
    idempotencyKey: idempotencyKeySchema,
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

export const memoryHistorySchema = getMemorySchema;

export type CreateMemoryArgs = z.infer<typeof createMemorySchema>;
export type UpdateMemoryArgs = z.infer<typeof updateMemorySchema>;
export type SearchMemoryArgs = z.infer<typeof searchMemorySchema>;
export type GetMemoryArgs = z.infer<typeof getMemorySchema>;
export type ProjectContextArgs = z.infer<typeof projectContextSchema>;
export type RecentMemoriesArgs = z.infer<typeof recentMemoriesSchema>;
export type RecordActivityArgs = z.infer<typeof recordActivitySchema>;
