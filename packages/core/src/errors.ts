/** A business-rule violation. The API maps `status` to the HTTP response. */
export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number = 422,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export const notFound = (what: string) => new DomainError('NOT_FOUND', `${what} not found`, 404);
export const forbidden = (message = 'You are not allowed to do that') => new DomainError('FORBIDDEN', message, 403);
export const conflict = (code: string, message: string, details?: unknown) => new DomainError(code, message, 409, details);
