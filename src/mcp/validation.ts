import { z } from 'zod/v4';

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
const taskStatusSchema = z.enum(['todo', 'in_progress', 'blocked', 'completed', 'cancelled']);
const taskPrioritySchema = z.enum(['low', 'normal', 'high', 'urgent']);
const handoffVerificationStatusSchema = z.enum(['unverified', 'partially_verified', 'verified']);
const boundedUuidArraySchema = z.array(uuidSchema).max(100);
const boundedReferenceArraySchema = z.array(z.string().trim().min(1).max(2_000)).max(100);
const requiredReferenceArraySchema = boundedReferenceArraySchema.min(1);
const dueDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

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

export const createTaskSchema = z.object({
  projectId: uuidSchema,
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(10_000).optional(),
  priority: taskPrioritySchema.default('normal'),
  assignedDeviceId: uuidSchema.optional(),
  dueDate: dueDateSchema.optional(),
  linkedMemoryIds: boundedUuidArraySchema.optional(),
  evidenceReferences: boundedReferenceArraySchema.optional(),
  idempotencyKey: idempotencyKeySchema,
});

export const listTasksSchema = z.object({
  projectId: uuidSchema,
  status: taskStatusSchema.optional(),
  assignedDeviceId: uuidSchema.optional(),
  limit: z.number().int().min(1).max(50).default(20),
});

export const getTaskSchema = z.object({
  projectId: uuidSchema,
  taskId: uuidSchema,
});

export const updateTaskSchema = z
  .object({
    projectId: uuidSchema,
    taskId: uuidSchema,
    expectedVersion: z.number().int().positive(),
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(10_000).nullable().optional(),
    priority: taskPrioritySchema.optional(),
    assignedDeviceId: uuidSchema.nullable().optional(),
    dueDate: dueDateSchema.nullable().optional(),
    linkedMemoryIds: boundedUuidArraySchema.optional(),
    evidenceReferences: boundedReferenceArraySchema.optional(),
    idempotencyKey: idempotencyKeySchema,
  })
  .refine(
    (input) =>
      input.title !== undefined ||
      input.description !== undefined ||
      input.priority !== undefined ||
      input.assignedDeviceId !== undefined ||
      input.dueDate !== undefined ||
      input.linkedMemoryIds !== undefined ||
      input.evidenceReferences !== undefined,
    'At least one task field must change',
  );

export const transitionTaskSchema = z.object({
  projectId: uuidSchema,
  taskId: uuidSchema,
  expectedVersion: z.number().int().positive(),
  status: taskStatusSchema,
  note: z.string().trim().max(2_000).optional(),
  idempotencyKey: idempotencyKeySchema,
});

export const createHandoffSchema = z.object({
  projectId: uuidSchema,
  taskId: uuidSchema.optional(),
  destinationDeviceId: uuidSchema.optional(),
  summary: z.string().trim().min(1).max(10_000),
  completedWork: requiredReferenceArraySchema,
  verifiedResults: boundedReferenceArraySchema.optional(),
  blockers: boundedReferenceArraySchema.optional(),
  nextSteps: requiredReferenceArraySchema,
  evidenceReferences: boundedReferenceArraySchema.optional(),
  linkedMemoryIds: boundedUuidArraySchema.optional(),
  linkedTaskIds: boundedUuidArraySchema.optional(),
  verificationStatus: handoffVerificationStatusSchema,
  idempotencyKey: idempotencyKeySchema,
});

export const listHandoffsSchema = z.object({
  projectId: uuidSchema,
  limit: z.number().int().min(1).max(50).default(20),
});

export const getHandoffSchema = z.object({
  projectId: uuidSchema,
  handoffId: uuidSchema,
});

export type CreateMemoryArgs = z.infer<typeof createMemorySchema>;
export type UpdateMemoryArgs = z.infer<typeof updateMemorySchema>;
export type SearchMemoryArgs = z.infer<typeof searchMemorySchema>;
export type GetMemoryArgs = z.infer<typeof getMemorySchema>;
export type ProjectContextArgs = z.infer<typeof projectContextSchema>;
export type RecentMemoriesArgs = z.infer<typeof recentMemoriesSchema>;
export type RecordActivityArgs = z.infer<typeof recordActivitySchema>;
export type CreateTaskArgs = z.infer<typeof createTaskSchema>;
export type ListTasksArgs = z.infer<typeof listTasksSchema>;
export type GetTaskArgs = z.infer<typeof getTaskSchema>;
export type UpdateTaskArgs = z.infer<typeof updateTaskSchema>;
export type TransitionTaskArgs = z.infer<typeof transitionTaskSchema>;
export type CreateHandoffArgs = z.infer<typeof createHandoffSchema>;
export type ListHandoffsArgs = z.infer<typeof listHandoffsSchema>;
export type GetHandoffArgs = z.infer<typeof getHandoffSchema>;
