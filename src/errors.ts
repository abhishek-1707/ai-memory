export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'DATABASE_ERROR'
  | 'MIGRATION_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'RATE_LIMITED'
  | 'SETUP_REQUIRED'
  | 'SETUP_COMPLETE';

export class OmniMemoryError extends Error {
  public readonly code: ErrorCode;
  public readonly details?: Readonly<Record<string, unknown>> | undefined;

  public constructor(
    code: ErrorCode,
    message: string,
    details?: Readonly<Record<string, unknown>>,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'OmniMemoryError';
    this.code = code;
    this.details = details;
  }
}

export class ValidationError extends OmniMemoryError {
  public constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super('VALIDATION_ERROR', message, details);
    this.name = 'ValidationError';
  }
}

export class NotFoundError extends OmniMemoryError {
  public constructor(resource: string, id: string) {
    super('NOT_FOUND', `${resource} not found: ${id}`, { resource, id });
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends OmniMemoryError {
  public constructor(message: string, details?: Readonly<Record<string, unknown>>) {
    super('CONFLICT', message, details);
    this.name = 'ConflictError';
  }
}

export class DatabaseError extends OmniMemoryError {
  public constructor(message: string, cause?: unknown) {
    super('DATABASE_ERROR', message, undefined, {
      cause: cause instanceof Error ? cause : undefined,
    });
    this.name = 'DatabaseError';
  }
}

export class MigrationError extends OmniMemoryError {
  public constructor(message: string, cause?: unknown) {
    super('MIGRATION_ERROR', message, undefined, {
      cause: cause instanceof Error ? cause : undefined,
    });
    this.name = 'MigrationError';
  }
}

export class AuthenticationError extends OmniMemoryError {
  public constructor(message = 'Authentication required') {
    super('UNAUTHORIZED', message);
    this.name = 'AuthenticationError';
  }
}

export class AuthorizationError extends OmniMemoryError {
  public constructor(message = 'Forbidden') {
    super('FORBIDDEN', message);
    this.name = 'AuthorizationError';
  }
}

export class RateLimitedError extends OmniMemoryError {
  public constructor(message = 'Too many requests') {
    super('RATE_LIMITED', message);
    this.name = 'RateLimitedError';
  }
}

export class SetupRequiredError extends OmniMemoryError {
  public constructor() {
    super('SETUP_REQUIRED', 'Owner setup is required');
    this.name = 'SetupRequiredError';
  }
}

export class SetupCompleteError extends OmniMemoryError {
  public constructor() {
    super('SETUP_COMPLETE', 'Owner setup is already complete');
    this.name = 'SetupCompleteError';
  }
}

export function isOmniMemoryError(error: unknown): error is OmniMemoryError {
  return error instanceof OmniMemoryError;
}
