export class AppError extends Error {
  /**
   * @param {number} status HTTP status
   * @param {string} message human-readable message
   * @param {string} code machine code (e.g. VALIDATION_ERROR, DUPLICATE)
   * @param {object} [extra] extra JSON fields merged into the error response (e.g. { fields })
   */
  constructor(status, message, code = "ERROR", extra = undefined) {
    super(message);
    this.status = status;
    this.code = code;
    if (extra && typeof extra === "object") this.extra = extra;
  }
}
