import { ApiError } from './api-error.js';

export const DEFAULT_API_BASE = 'https://api.ollacore.com/v1';
export const DEFAULT_APP_ID = 'da_3a0a2cfaabd34b7dbfb4ecd5033b0c5f';
export const DEFAULT_TIMEOUT_MS = 30000; // 30s matching Android connect/read timeouts

/**
 * Sanitizes phone number string adhering to Android reference behavior:
 * allows digits, '+', spaces, '-', '(', and ')'.
 * @param {string} phone
 * @returns {string}
 */
export function sanitizePhone(phone) {
  if (typeof phone !== 'string') return '';
  return phone.replace(/[^0-9+\s\-()]/g, '').trim();
}

/**
 * Normalizes a country code and local or international phone number into
 * standard E.164 format (+[country code][number]) required by the Ollacore Directory API.
 *
 * Requirements:
 * - Country code must include "+".
 * - Removes spaces and formatting characters: spaces, "-", "(", ")", ".".
 * - Preserves leading "+" on already international numbers.
 * - Does NOT double-prepend country code if the number is already in E.164 form.
 * - Rejects invalid, malformed, or empty values safely.
 * - Preserves digits without modification or country-specific assumptions.
 *
 * @param {string} phone Local or international phone number
 * @param {string} [countryCode='+91'] Country calling code (e.g. '+91')
 * @returns {string} E.164 formatted phone number (e.g. '+918590037717')
 * @throws {Error} If phone number cannot be converted to a valid E.164 format
 */
export function normalizeToE164(phone, countryCode = '+91') {
  // Support flexible parameter ordering if first arg is country code and second is phone
  if (
    typeof phone === 'string' &&
    typeof countryCode === 'string' &&
    /^\s*\+\d{1,4}\s*$/.test(phone) &&
    /\d{4,}/.test(countryCode)
  ) {
    const temp = phone;
    phone = countryCode;
    countryCode = temp;
  }

  if (!phone || typeof phone !== 'string') {
    throw new Error('Enter a valid phone number');
  }

  const trimmed = phone.trim();
  if (trimmed.length === 0) {
    throw new Error('Enter a valid phone number');
  }

  // Reject invalid characters (allow only digits, +, spaces, -, (, ), .)
  if (/[^0-9+\s\-().]/.test(trimmed)) {
    throw new Error('Phone number contains invalid characters');
  }

  // Reject multiple '+' characters or '+' not at the beginning
  const plusMatches = trimmed.match(/\+/g);
  if (plusMatches && plusMatches.length > 1) {
    throw new Error('Phone number cannot contain multiple plus signs');
  }
  if (plusMatches && plusMatches.length === 1 && !trimmed.startsWith('+')) {
    throw new Error('Plus sign must be at the start of the phone number');
  }

  const isAlreadyInternational = trimmed.startsWith('+');
  let finalValue;

  if (isAlreadyInternational) {
    // Preserve leading '+' and remove formatting characters
    const digitsOnly = trimmed.slice(1).replace(/[\s\-().]/g, '');
    finalValue = `+${digitsOnly}`;
  } else {
    // Local number: remove formatting characters
    const localDigits = trimmed.replace(/[\s\-().]/g, '');

    // Extract country calling code digits
    const ccStr = typeof countryCode === 'string' ? countryCode.trim() : '';
    if (/[^0-9+\s]/.test(ccStr)) {
      throw new Error('Invalid country code');
    }
    const ccDigits = ccStr.replace(/\D/g, '');
    if (!ccDigits) {
      throw new Error('Country code is required for local phone numbers');
    }

    finalValue = `+${ccDigits}${localDigits}`;
  }

  // Strict E.164 verification: exactly one leading '+', digits only after '+', 7–15 total digits
  if (!/^\+[0-9]{7,15}$/.test(finalValue)) {
    const digitCount = finalValue.slice(1).length;
    if (digitCount < 7) {
      throw new Error('Phone number is too short');
    }
    if (digitCount > 15) {
      throw new Error('Phone number is too long');
    }
    throw new Error('Phone number must be in strict E.164 format (+ followed by 7-15 digits)');
  }

  return finalValue;
}

/**
 * Validates and safely normalizes a phone number to E.164 without throwing.
 *
 * @param {string} phone
 * @param {string} [countryCode='+91']
 * @returns {{ valid: boolean, phone: string|null, error: string|null }}
 */
export function validateE164(phone, countryCode = '+91') {
  try {
    const normalized = normalizeToE164(phone, countryCode);
    return { valid: true, phone: normalized, error: null };
  } catch (err) {
    return { valid: false, phone: null, error: err.message || 'Enter a valid phone number' };
  }
}

/**
 * Sanitizes OTP code: digits only, maximum 6 digits.
 * @param {string} code
 * @returns {string}
 */
export function sanitizeOtp(code) {
  if (typeof code !== 'string') return '';
  return code.replace(/\D/g, '').slice(0, 6);
}

/**
 * Normalizes UserProfile response, mapping backwards-compatible `photo_url`
 * to `avatarUrl` if `avatar_url` is not provided.
 * @param {object} raw
 * @returns {object}
 */
export function normalizeUserProfile(raw, baseUrl = DEFAULT_API_BASE) {
  if (!raw || typeof raw !== 'object') return raw;
  const userId = raw.id || raw.user_id || '';
  const avatarVersion = raw.avatar_version || raw.avatarVersion || null;
  const avatar = raw.avatar_url || raw.photo_url || (userId && avatarVersion ? `${baseUrl}/directory/users/${encodeURIComponent(userId)}/avatar?v=${encodeURIComponent(avatarVersion)}` : null);
  return {
    id: userId,
    userId: userId,
    phone: raw.phone || '',
    displayName: raw.display_name || null,
    about: raw.about || null,
    avatarUrl: avatar,
    avatarVersion: avatarVersion,
    avatar_version: avatarVersion,
    // Keep snake_case keys for direct API contract compatibility
    display_name: raw.display_name || null,
    avatar_url: avatar,
    photo_url: raw.photo_url || avatar
  };
}

/**
 * Ollacore REST API Client.
 * Handles Directory authentication, profile management, and session invalidation.
 */
export class OllacoreApi {
  /**
   * @param {object} [options={}]
   * @param {string} [options.baseUrl=DEFAULT_API_BASE] Base API URL
   * @param {string} [options.appId=DEFAULT_APP_ID] Application ID
   * @param {number} [options.timeoutMs=DEFAULT_TIMEOUT_MS] Request timeout in milliseconds
   * @param {Function} [options.fetchFn=globalThis.fetch] Injectable HTTP transport for testing
   */
  constructor({
    baseUrl = DEFAULT_API_BASE,
    appId = DEFAULT_APP_ID,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchFn = globalThis.fetch
  } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.appId = appId;
    this.timeoutMs = timeoutMs;
    this.fetchFn = fetchFn;
  }

  /**
   * Core HTTP request execution with timeouts, error parsing, and status handling.
   * @private
   */
  async _request(endpoint, { method = 'GET', headers = {}, body = null } = {}) {
    const url = `${this.baseUrl}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;
    const requestHeaders = {
      Accept: 'application/json',
      ...headers
    };

    let payload = null;
    if (body !== null && body !== undefined) {
      requestHeaders['Content-Type'] = 'application/json; charset=utf-8';
      payload = JSON.stringify(body);
    }

    let response;
    try {
      const signal = AbortSignal.timeout(this.timeoutMs);
      response = await this.fetchFn(url, {
        method,
        headers: requestHeaders,
        body: payload,
        signal
      });
    } catch (err) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        throw new ApiError(`Request to ${endpoint} timed out after ${this.timeoutMs}ms`, 'timeout', 408);
      }
      throw new ApiError(err.message || 'Network request failed', 'network_error', null);
    }

    // 204 No Content
    if (response.status === 204) {
      return null;
    }

    // Read response text
    const text = await response.text();
    let data = null;
    if (text && text.trim()) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }

    if (!response.ok) {
      const message = data && data.message ? data.message : `HTTP ${response.status}`;
      const code = data && data.code ? data.code : 'http_error';
      throw new ApiError(message, code, response.status);
    }

    return data || {};
  }

  /**
   * Dispatches an OTP to the given phone number.
   * POST /directory/otp/request
   *
   * @param {string} phone International phone number
   * @returns {Promise<{ dispatched: boolean, expiresAt: string|null, expires_at: string|null }>}
   */
  async requestOtp(phone) {
    const sanitized = sanitizePhone(phone);
    if (!sanitized) {
      throw new ApiError('Enter a valid phone number', 'validation_error', 400);
    }

    const res = await this._request('/directory/otp/request', {
      method: 'POST',
      body: {
        app_id: this.appId,
        phone: sanitized
      }
    });

    return {
      dispatched: Boolean(res.dispatched),
      expiresAt: res.expires_at || null,
      expires_at: res.expires_at || null
    };
  }

  /**
   * Verifies an OTP code and returns authentication credentials.
   * POST /directory/otp/verify
   *
   * Note: This method does NOT automatically persist the session;
   * session persistence is handled by the calling orchestration layer.
   *
   * @param {string} phone
   * @param {string} code 6-digit numeric OTP
   * @returns {Promise<{ sessionToken: string, userId: string, displayName: string|null, session_token: string, user_id: string, display_name: string|null }>}
   */
  async verifyOtp(phone, code) {
    const sanitizedPhone = sanitizePhone(phone);
    if (!sanitizedPhone) {
      throw new ApiError('Enter a valid phone number', 'validation_error', 400);
    }

    const sanitizedCode = sanitizeOtp(code);
    if (sanitizedCode.length !== 6) {
      throw new ApiError('Enter the 6-digit OTP', 'validation_error', 400);
    }

    const res = await this._request('/directory/otp/verify', {
      method: 'POST',
      body: {
        app_id: this.appId,
        phone: sanitizedPhone,
        code: sanitizedCode
      }
    });

    const sessionToken = res.session_token || res.sessionToken || '';
    const userId = res.user_id || res.userId || '';
    const displayName = res.display_name || res.displayName || null;

    return {
      sessionToken,
      userId,
      displayName,
      session_token: sessionToken,
      user_id: userId,
      display_name: displayName
    };
  }

  /**
   * Fetches the current user profile using Bearer authentication.
   * GET /directory/me
   *
   * @param {string} sessionToken Bearer session token
   * @returns {Promise<object>} Normalized UserProfile
   */
  async getProfile(sessionToken) {
    if (!sessionToken || typeof sessionToken !== 'string') {
      throw new ApiError('Authentication token required', 'unauthorized', 401);
    }

    const res = await this._request('/directory/me', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${sessionToken}`
      }
    });

    return normalizeUserProfile(res);
  }

  /**
   * Generates public/authenticated avatar URL for a given user and optional version.
   * @param {string} userId User UUID
   * @param {string|null} [avatarVersion=null] Optional avatar timestamp/version
   * @returns {string|null}
   */
  getAvatarUrl(userId, avatarVersion = null) {
    if (!userId) return null;
    const versionParam = avatarVersion ? `?v=${encodeURIComponent(avatarVersion)}` : '';
    return `${this.baseUrl}/directory/users/${encodeURIComponent(userId)}/avatar${versionParam}`;
  }

  /**
   * Initializes a profile avatar upload.
   * POST /directory/me/avatar/init
   *
   * @param {string} sessionToken Bearer session token
   * @param {object} options
   * @param {string} [options.mime='image/jpeg'] Declared MIME type
   * @param {number} options.byteSize Size in bytes
   * @returns {Promise<{ upload_id: string, upload_url: string, expires_at: string, max_bytes: number }>}
   */
  async initAvatarUpload(sessionToken, { mime = 'image/jpeg', byteSize }) {
    if (!sessionToken || typeof sessionToken !== 'string') {
      throw new ApiError('Authentication token required', 'unauthorized', 401);
    }
    return this._request('/directory/me/avatar/init', {
      method: 'POST',
      headers: { Authorization: `Bearer ${sessionToken}` },
      body: {
        declared_mime: mime,
        byte_size: byteSize
      }
    });
  }

  /**
   * Completes a profile avatar upload after binary PUT.
   * POST /directory/me/avatar/complete
   *
   * @param {string} sessionToken Bearer session token
   * @param {string} uploadId The upload ID returned from init
   * @returns {Promise<object>} Normalized updated UserProfile
   */
  async completeAvatarUpload(sessionToken, uploadId) {
    if (!sessionToken || typeof sessionToken !== 'string') {
      throw new ApiError('Authentication token required', 'unauthorized', 401);
    }
    const res = await this._request('/directory/me/avatar/complete', {
      method: 'POST',
      headers: { Authorization: `Bearer ${sessionToken}` },
      body: { upload_id: uploadId }
    });
    return normalizeUserProfile(res, this.baseUrl);
  }

  /**
   * Deletes the user's avatar.
   * DELETE /directory/me/avatar
   *
   * @param {string} sessionToken Bearer session token
   * @returns {Promise<object>} Normalized updated UserProfile
   */
  async deleteAvatar(sessionToken) {
    if (!sessionToken || typeof sessionToken !== 'string') {
      throw new ApiError('Authentication token required', 'unauthorized', 401);
    }
    const res = await this._request('/directory/me/avatar', {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${sessionToken}` }
    });
    return normalizeUserProfile(res, this.baseUrl);
  }

  /**
   * Updates user profile fields (display_name, about).
   * Note: The backend PATCH /directory/me accepts only display_name and about.
   * Avatar uploads are performed via initAvatarUpload / completeAvatarUpload.
   * PATCH /directory/me
   *
   * @param {string} sessionToken Bearer session token
   * @param {object} profile Profile fields to update
   * @param {string} [profile.displayName]
   * @param {string} [profile.display_name]
   * @param {string} [profile.about]
   * @returns {Promise<object>} Normalized updated UserProfile
   */
  async updateProfile(sessionToken, profile = {}) {
    if (!sessionToken || typeof sessionToken !== 'string') {
      throw new ApiError('Authentication token required', 'unauthorized', 401);
    }

    const body = {};
    const displayName = profile.display_name !== undefined ? profile.display_name : profile.displayName;
    const about = profile.about;

    if (displayName !== undefined) body.display_name = displayName;
    if (about !== undefined) body.about = about;

    if (Object.keys(body).length === 0) {
      return this.getProfile(sessionToken);
    }

    const res = await this._request('/directory/me', {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${sessionToken}`
      },
      body
    });

    return normalizeUserProfile(res, this.baseUrl);
  }

  /**
   * Invalidates session on the server.
   * POST /directory/logout
   *
   * @param {string} sessionToken Bearer session token
   * @param {boolean} [allDevices=false] Whether to revoke tokens across all linked devices
   * @returns {Promise<{ success: boolean }>}
   */
  async logout(sessionToken, allDevices = false) {
    if (!sessionToken || typeof sessionToken !== 'string') {
      throw new ApiError('Authentication token required', 'unauthorized', 401);
    }

    const body = allDevices ? { all_devices: true } : {};

    await this._request('/directory/logout', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${sessionToken}`
      },
      body
    });

    return { success: true };
  }
}
