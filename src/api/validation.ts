import { z } from 'zod';

import { ValidationError } from '../errors.js';

export const idParamSchema = z.object({ id: z.string().uuid() });
export const projectParamSchema = z.object({ projectId: z.string().uuid() });
export const memoryParamSchema = z.object({
  projectId: z.string().uuid(),
  memoryId: z.string().uuid(),
});

const taskStatusSchema = z.enum(['todo', 'in_progress', 'blocked', 'completed', 'cancelled']);
const taskPrioritySchema = z.enum(['low', 'normal', 'high', 'urgent']);
const handoffVerificationStatusSchema = z.enum(['unverified', 'partially_verified', 'verified']);
const boundedUuidArraySchema = z.array(z.string().uuid()).max(100);
const boundedReferenceArraySchema = z.array(z.string().trim().min(1).max(2_000)).max(100);
const dueDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const setupBodySchema = z.object({
  setupCode: z.string().min(1).max(200),
  password: z.string().min(12).max(200),
  deviceName: z.string().trim().min(1).max(100),
  deviceType: z.string().trim().min(1).max(50),
});

export const loginBodySchema = z.object({
  password: z.string().min(1).max(200),
  deviceName: z.string().trim().min(1).max(100),
  deviceType: z.string().trim().min(1).max(50),
});

export const enrollmentRequestSchema = z.object({
  deviceName: z.string().trim().min(1).max(100),
  deviceType: z.string().trim().min(1).max(50),
});

export const enrollmentClaimSchema = z.object({
  enrollmentToken: z.string().min(1).max(200),
});

export const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(12).max(200),
});

export const deviceRoleSchema = z.object({
  role: z.enum(['admin', 'member']),
});

export const projectCreateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2_000).optional(),
});

export const permissionSchema = z.object({
  role: z.enum(['reader', 'editor', 'owner']),
});

export const memoryCreateSchema = z.object({
  recordType: z.enum(['profile', 'project_fact', 'finding', 'constraint', 'requirement', 'note']),
  title: z.string().trim().min(1).max(200),
  content: z.string().trim().min(1).max(100_000),
  provenance: z.object({
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
  }),
});

export const memoryUpdateSchema = z.object({
  expectedVersion: z.number().int().positive(),
  title: z.string().trim().min(1).max(200).optional(),
  content: z.string().trim().min(1).max(100_000).optional(),
  recordType: z
    .enum(['profile', 'project_fact', 'finding', 'constraint', 'requirement', 'note'])
    .optional(),
  provenance: memoryCreateSchema.shape.provenance,
  changeReason: z.string().trim().min(1).max(500).optional(),
});

export const taskParamSchema = z.object({
  projectId: z.string().uuid(),
  taskId: z.string().uuid(),
});

export const handoffParamSchema = z.object({
  projectId: z.string().uuid(),
  handoffId: z.string().uuid(),
});

export const taskCreateSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(10_000).optional(),
  priority: taskPrioritySchema.default('normal'),
  assignedDeviceId: z.string().uuid().optional(),
  dueDate: dueDateSchema.optional(),
  linkedMemoryIds: boundedUuidArraySchema.optional(),
  evidenceReferences: boundedReferenceArraySchema.optional(),
});

export const taskListQuerySchema = z.object({
  status: taskStatusSchema.optional(),
  assignedDeviceId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const taskUpdateSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(10_000).nullable().optional(),
    priority: taskPrioritySchema.optional(),
    assignedDeviceId: z.string().uuid().nullable().optional(),
    dueDate: dueDateSchema.nullable().optional(),
    linkedMemoryIds: boundedUuidArraySchema.optional(),
    evidenceReferences: boundedReferenceArraySchema.optional(),
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

export const taskTransitionSchema = z.object({
  expectedVersion: z.number().int().positive(),
  status: taskStatusSchema,
  note: z.string().trim().max(2_000).optional(),
});

export const handoffCreateSchema = z.object({
  taskId: z.string().uuid().optional(),
  destinationDeviceId: z.string().uuid().optional(),
  summary: z.string().trim().min(1).max(10_000),
  completedWork: boundedReferenceArraySchema,
  verifiedResults: boundedReferenceArraySchema.optional(),
  blockers: boundedReferenceArraySchema.optional(),
  nextSteps: boundedReferenceArraySchema,
  evidenceReferences: boundedReferenceArraySchema.optional(),
  linkedMemoryIds: boundedUuidArraySchema.optional(),
  linkedTaskIds: boundedUuidArraySchema.optional(),
  verificationStatus: handoffVerificationStatusSchema,
});

export const handoffListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const activitySchema = z.object({
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

export const searchQuerySchema = z.object({
  query: z.string().trim().min(1).max(500),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const limitQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export function parseRequest<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (result.success) {
    return result.data;
  }
  throw new ValidationError('Invalid request', {
    issues: result.error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
  });
}
