/** Violação de constraint única, independente do banco. */
export class UniqueViolationError extends Error {
  /** @param {string|undefined} constraint */
  constructor(constraint, options) {
    super(`Unique constraint violated${constraint ? `: ${constraint}` : ''}`, options);
    this.name = 'UniqueViolationError';
    this.constraint = constraint;
  }
}
