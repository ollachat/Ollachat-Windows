/**
 * Standard error class for Ollacore API failures.
 * Encapsulates error codes, messages, and HTTP status codes,
 * mirroring the Android `ApiException` and `ApiError` data models.
 */
export class ApiError extends Error {
  /**
   * @param {string} message Human-readable error message
   * @param {string|null} [code=null] Backend error code (e.g. 'invalid_otp', 'user_not_found')
   * @param {number|null} [httpStatus=null] HTTP status code (e.g. 400, 401, 500)
   */
  constructor(message, code = null, httpStatus = null) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.httpStatus = httpStatus;

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, ApiError);
    }
  }

  /**
   * Safe serialization that does not leak internal stacks or sensitive details.
   */
  toJSON() {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      httpStatus: this.httpStatus
    };
  }
}
