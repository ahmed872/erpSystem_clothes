/**
 * Base class for business-rule violations raised from the Application/
 * Domain layers. Controllers never throw these directly; they let the
 * global exception filter translate `code` into an HTTP status via
 * DOMAIN_ERROR_HTTP_STATUS so use-cases stay framework-agnostic.
 */
export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export class ValidationFailedError extends DomainError {
  constructor(message: string, details?: unknown) {
    super('VALIDATION_FAILED', message, details);
  }
}

export class NotFoundDomainError extends DomainError {
  constructor(entity: string, id?: string) {
    super('NOT_FOUND', `${entity} not found${id ? `: ${id}` : ''}`);
  }
}

export class ConflictDomainError extends DomainError {
  constructor(message: string, details?: unknown) {
    super('CONFLICT', message, details);
  }
}

export class UnauthorizedDomainError extends DomainError {
  constructor(message = 'Invalid credentials') {
    super('UNAUTHORIZED', message);
  }
}

export class ForbiddenDomainError extends DomainError {
  constructor(message = 'Insufficient permissions') {
    super('FORBIDDEN', message);
  }
}

/** Raised when a decrease movement would push a StockBalance negative and
 * negative inventory isn't allowed (tenant setting off, or the actor
 * lacks inventory.allow_negative even when the setting is on). */
export class InsufficientStockDomainError extends DomainError {
  constructor(message = 'Insufficient stock available', details?: unknown) {
    super('INSUFFICIENT_STOCK', message, details);
  }
}
