export type TaskStatus = 'todo' | 'in_progress' | 'blocked' | 'completed' | 'cancelled';
export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent';
export type HandoffVerificationStatus = 'unverified' | 'partially_verified' | 'verified';

export interface TaskRecord {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly description?: string | undefined;
  readonly status: TaskStatus;
  readonly priority: TaskPriority;
  readonly createdByDeviceId: string;
  readonly assignedDeviceId?: string | undefined;
  readonly dueDate?: string | undefined;
  readonly linkedMemoryIds: readonly string[];
  readonly evidenceReferences: readonly string[];
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface HandoffRecord {
  readonly id: string;
  readonly projectId: string;
  readonly taskId?: string | undefined;
  readonly sourceDeviceId: string;
  readonly destinationDeviceId?: string | undefined;
  readonly summary: string;
  readonly completedWork: readonly string[];
  readonly verifiedResults: readonly string[];
  readonly blockers: readonly string[];
  readonly nextSteps: readonly string[];
  readonly evidenceReferences: readonly string[];
  readonly linkedMemoryIds: readonly string[];
  readonly linkedTaskIds: readonly string[];
  readonly verificationStatus: HandoffVerificationStatus;
  readonly createdAt: string;
}

export interface CreateTaskInput {
  readonly projectId: string;
  readonly title: string;
  readonly description?: string | undefined;
  readonly priority: TaskPriority;
  readonly createdByDeviceId: string;
  readonly assignedDeviceId?: string | undefined;
  readonly dueDate?: string | undefined;
  readonly linkedMemoryIds?: readonly string[] | undefined;
  readonly evidenceReferences?: readonly string[] | undefined;
  readonly idempotencyKey?: string | undefined;
}

export interface ListTasksInput {
  readonly projectId: string;
  readonly status?: TaskStatus | undefined;
  readonly assignedDeviceId?: string | undefined;
  readonly limit?: number | undefined;
}

export interface UpdateTaskInput {
  readonly expectedVersion: number;
  readonly actorDeviceId: string;
  readonly title?: string | undefined;
  readonly description?: string | null | undefined;
  readonly priority?: TaskPriority | undefined;
  readonly assignedDeviceId?: string | null | undefined;
  readonly dueDate?: string | null | undefined;
  readonly linkedMemoryIds?: readonly string[] | undefined;
  readonly evidenceReferences?: readonly string[] | undefined;
  readonly idempotencyKey?: string | undefined;
}

export interface TransitionTaskInput {
  readonly expectedVersion: number;
  readonly status: TaskStatus;
  readonly actorDeviceId: string;
  readonly note?: string | undefined;
  readonly idempotencyKey?: string | undefined;
}

export interface CreateHandoffInput {
  readonly projectId: string;
  readonly taskId?: string | undefined;
  readonly sourceDeviceId: string;
  readonly destinationDeviceId?: string | undefined;
  readonly summary: string;
  readonly completedWork: readonly string[];
  readonly verifiedResults?: readonly string[] | undefined;
  readonly blockers?: readonly string[] | undefined;
  readonly nextSteps: readonly string[];
  readonly evidenceReferences?: readonly string[] | undefined;
  readonly linkedMemoryIds?: readonly string[] | undefined;
  readonly linkedTaskIds?: readonly string[] | undefined;
  readonly verificationStatus: HandoffVerificationStatus;
  readonly idempotencyKey?: string | undefined;
}

export interface ListHandoffsInput {
  readonly projectId: string;
  readonly taskId?: string | undefined;
  readonly verificationStatus?: HandoffVerificationStatus | undefined;
  readonly limit?: number | undefined;
}

export interface TaskTrackingServiceDependencies {
  readonly now?: () => string;
  readonly createId?: () => string;
}
