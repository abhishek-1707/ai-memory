export type MemoryRecordType =
  'profile' | 'project_fact' | 'finding' | 'constraint' | 'requirement' | 'note';

export type ProvenanceSourceKind =
  'user_provided' | 'file_observed' | 'system_observed' | 'agent_inferred' | 'test_result';

export type VerificationStatus =
  'unverified' | 'user_confirmed' | 'test_verified' | 'superseded' | 'disputed';

export interface ProvenanceInput {
  readonly sourceKind: ProvenanceSourceKind;
  readonly sourceReference?: string | undefined;
  readonly verificationStatus: VerificationStatus;
  readonly verificationMethod?: string | undefined;
  readonly observedAt?: string | undefined;
}

export interface Provenance extends ProvenanceInput {
  readonly id: string;
  readonly recordedAt: string;
  readonly verifiedAt?: string | undefined;
}

export interface Project {
  readonly id: string;
  readonly name: string;
  readonly description?: string | undefined;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface MemoryRecord {
  readonly id: string;
  readonly projectId?: string | undefined;
  readonly recordType: MemoryRecordType;
  readonly title: string;
  readonly content: string;
  readonly version: number;
  readonly provenance: Provenance;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly commitSequence: number;
}

export interface MemoryRevision extends MemoryRecord {
  readonly changeReason?: string | undefined;
}

export interface ActivityEvent {
  readonly id: string;
  readonly projectId?: string;
  readonly memoryId: string;
  readonly eventType: 'memory_created' | 'memory_updated';
  readonly summary: string;
  readonly createdAt: string;
}

export type AgentActivityEventType =
  | 'finding_recorded'
  | 'task_started'
  | 'task_updated'
  | 'handoff_created'
  | 'test_recorded'
  | 'note';

export interface AgentActivityEvent {
  readonly id: string;
  readonly projectId: string;
  readonly eventType: AgentActivityEventType;
  readonly summary: string;
  readonly metadata?: Readonly<Record<string, string>> | undefined;
  readonly actorDeviceId?: string | undefined;
  readonly createdAt: number;
}

export interface RecordActivityInput {
  readonly projectId: string;
  readonly eventType: AgentActivityEventType;
  readonly summary: string;
  readonly metadata?: Readonly<Record<string, string>> | undefined;
  readonly actorDeviceId?: string | undefined;
}

export interface ListActivityInput {
  readonly projectId: string;
  readonly limit?: number | undefined;
}

export interface CreateProjectInput {
  readonly name: string;
  readonly description?: string | undefined;
}

export interface CreateMemoryInput {
  readonly projectId?: string | undefined;
  readonly recordType: MemoryRecordType;
  readonly title: string;
  readonly content: string;
  readonly provenance: ProvenanceInput;
  readonly idempotencyKey?: string | undefined;
}

export interface UpdateMemoryInput {
  readonly expectedVersion: number;
  readonly title?: string | undefined;
  readonly content?: string | undefined;
  readonly recordType?: MemoryRecordType | undefined;
  readonly provenance: ProvenanceInput;
  readonly changeReason?: string | undefined;
  readonly idempotencyKey?: string | undefined;
}

export interface SearchMemoryInput {
  readonly query: string;
  readonly projectId?: string | undefined;
  readonly limit?: number | undefined;
}

export interface ListRecentMemoriesInput {
  readonly projectId?: string | undefined;
  readonly limit?: number | undefined;
}

export interface MemoryHistoryInput {
  readonly id: string;
}

export interface MemoryEngineDependencies {
  readonly now?: () => string;
  readonly createId?: () => string;
}
