import { z } from 'zod';

import { ValidationError } from '../errors.js';
import type {
  CreateHandoffInput,
  CreateTaskInput,
  ListHandoffsInput,
  ListTasksInput,
  TaskStatus,
  TransitionTaskInput,
  UpdateTaskInput,
} from './types.js';

const uuidSchema = z.string().uuid();
const idempotencyKeySchema = z.string().trim().min(1).max(200).optional();
const taskStatusSchema = z.enum(['todo', 'in_progress', 'blocked', 'completed', 'cancelled']);
const prioritySchema = z.enum(['low', 'normal', 'high', 'urgent']);
const verificationStatusSchema = z.enum(['unverified', 'partially_verified', 'verified']);
const stringArraySchema = z.array(z.string().trim().min(1).max(2_000)).min(1).max(100);
const optionalStringArraySchema = z.array(z.string().trim().min(1).max(2_000)).max(100).optional();
const dateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a date in YYYY-MM-DD format')
  .refine(isValidDateOnly, 'Expected a valid calendar date');

const createTaskSchema = z.object({
  projectId: uuidSchema,
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(10_000).optional(),
  priority: prioritySchema,
  createdByDeviceId: uuidSchema,
  assignedDeviceId: uuidSchema.optional(),
  dueDate: dateOnlySchema.optional(),
  linkedMemoryIds: z.array(uuidSchema).max(100).optional(),
  evidenceReferences: optionalStringArraySchema,
  idempotencyKey: idempotencyKeySchema,
});

const listTasksSchema = z.object({
  projectId: uuidSchema,
  status: taskStatusSchema.optional(),
  assignedDeviceId: uuidSchema.optional(),
  limit: z.number().int().min(1).max(100).default(50),
});

const updateTaskSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    actorDeviceId: uuidSchema,
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(10_000).nullable().optional(),
    priority: prioritySchema.optional(),
    assignedDeviceId: uuidSchema.nullable().optional(),
    dueDate: dateOnlySchema.nullable().optional(),
    linkedMemoryIds: z.array(uuidSchema).max(100).optional(),
    evidenceReferences: optionalStringArraySchema,
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
    'At least one non-status task field must change',
  );

const transitionTaskSchema = z.object({
  expectedVersion: z.number().int().positive(),
  status: taskStatusSchema,
  actorDeviceId: uuidSchema,
  note: z.string().trim().max(2_000).optional(),
  idempotencyKey: idempotencyKeySchema,
});

const createHandoffSchema = z.object({
  projectId: uuidSchema,
  taskId: uuidSchema.optional(),
  sourceDeviceId: uuidSchema,
  destinationDeviceId: uuidSchema.optional(),
  summary: z.string().trim().min(1).max(10_000),
  completedWork: stringArraySchema,
  verifiedResults: optionalStringArraySchema,
  blockers: optionalStringArraySchema,
  nextSteps: stringArraySchema,
  evidenceReferences: optionalStringArraySchema,
  linkedMemoryIds: z.array(uuidSchema).max(100).optional(),
  linkedTaskIds: z.array(uuidSchema).max(100).optional(),
  verificationStatus: verificationStatusSchema,
  idempotencyKey: idempotencyKeySchema,
});

const listHandoffsSchema = z.object({
  projectId: uuidSchema,
  taskId: uuidSchema.optional(),
  verificationStatus: verificationStatusSchema.optional(),
  limit: z.number().int().min(1).max(100).default(50),
});

export function parseCreateTaskInput(input: unknown): CreateTaskInput {
  return parse(createTaskSchema, input, 'Invalid task input');
}

export function parseListTasksInput(input: unknown): ListTasksInput {
  return parse(listTasksSchema, input, 'Invalid task query');
}

export function parseUpdateTaskInput(input: unknown): UpdateTaskInput {
  return parse(updateTaskSchema, input, 'Invalid task update');
}

export function parseTransitionTaskInput(input: unknown): TransitionTaskInput {
  return parse(transitionTaskSchema, input, 'Invalid task transition');
}

export function parseCreateHandoffInput(input: unknown): CreateHandoffInput {
  const parsed = parse(createHandoffSchema, input, 'Invalid handoff input');
  if (
    (parsed.verificationStatus === 'verified' ||
      parsed.verificationStatus === 'partially_verified') &&
    (parsed.verifiedResults?.length ?? 0) === 0 &&
    (parsed.evidenceReferences?.length ?? 0) === 0
  ) {
    throw new ValidationError('Verified handoffs require verified results or evidence references');
  }
  return parsed;
}

export function parseListHandoffsInput(input: unknown): ListHandoffsInput {
  return parse(listHandoffsSchema, input, 'Invalid handoff query');
}

export function parseTaskId(input: unknown): string {
  return parse(uuidSchema, input, 'Invalid task ID');
}

export function parseHandoffId(input: unknown): string {
  return parse(uuidSchema, input, 'Invalid handoff ID');
}

export function assertTaskStatus(value: string): asserts value is TaskStatus {
  if (!taskStatusSchema.safeParse(value).success) {
    throw new ValidationError('Invalid task status');
  }
}

function isValidDateOnly(value: string): boolean {
  const [yearText, monthText, dayText] = value.split('-');
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
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
