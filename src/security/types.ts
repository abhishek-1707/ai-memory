export type DeviceRole = 'owner' | 'admin' | 'member';
export type DeviceStatus = 'active' | 'revoked';
export type ProjectPermissionRole = 'reader' | 'editor' | 'owner';

export interface AuthenticatedIdentity {
  readonly sessionId: string;
  readonly deviceId: string;
  readonly deviceName: string;
  readonly deviceType: string;
  readonly role: DeviceRole;
  readonly expiresAt: number;
  readonly idleExpiresAt: number;
}

export interface AuthSession {
  readonly token: string;
  readonly sessionId: string;
  readonly deviceId: string;
  readonly deviceName: string;
  readonly deviceType: string;
  readonly role: DeviceRole;
  readonly expiresAt: number;
  readonly idleExpiresAt: number;
}

export interface DeviceSummary {
  readonly id: string;
  readonly name: string;
  readonly deviceType: string;
  readonly role: DeviceRole;
  readonly status: DeviceStatus;
  readonly createdAt: number;
  readonly lastSeenAt?: number | undefined;
  readonly revokedAt?: number | undefined;
}

export interface SetupStatus {
  readonly setupRequired: boolean;
}

export interface SetupOwnerInput {
  readonly setupCode: string;
  readonly password: string;
  readonly deviceName: string;
  readonly deviceType: string;
  readonly requestId: string;
}

export interface LoginInput {
  readonly password: string;
  readonly deviceName: string;
  readonly deviceType: string;
  readonly requestId: string;
}

export interface EnrollmentRequestInput {
  readonly deviceName: string;
  readonly deviceType: string;
  readonly requestId: string;
}

export interface EnrollmentClaimInput {
  readonly enrollmentToken: string;
  readonly requestId: string;
}

export interface SetupCode {
  readonly code: string;
  readonly expiresAt: number;
}

export interface AuditEventInput {
  readonly requestId: string;
  readonly action: string;
  readonly outcome: 'allowed' | 'denied' | 'failed';
  readonly actorDeviceId?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly projectId?: string | undefined;
  readonly resourceType?: string | undefined;
  readonly resourceId?: string | undefined;
  readonly metadata?: Readonly<Record<string, string | number | boolean | null>> | undefined;
}
