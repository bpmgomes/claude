/** Violação de constraint única, independente do banco. */
export class UniqueViolationError extends Error {
  /** @param {string|undefined} constraint */
  constructor(constraint, options) {
    super(`Unique constraint violated${constraint ? `: ${constraint}` : ''}`, options);
    this.name = 'UniqueViolationError';
    this.constraint = constraint;
  }
}

/**
 * Violação de restrição de exclusão (sobreposição), independente do banco. SQLite: trigger com
 * RAISE(ABORT, '<constraint>') (AF-11, `appointments_no_overlap`); PostgreSQL: SQLSTATE 23P01
 * (`exclusion_violation`), com o nome da constraint `EXCLUDE`.
 */
export class ExclusionViolationError extends Error {
  /** @param {string|undefined} constraint */
  constructor(constraint, options) {
    super(`Exclusion constraint violated${constraint ? `: ${constraint}` : ''}`, options);
    this.name = 'ExclusionViolationError';
    this.constraint = constraint;
  }
}
