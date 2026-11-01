import { sanitizePhone, sanitizeOtp } from '../api/ollacore-api.js';
import { ApiError } from '../api/api-error.js';

export const AUTH_STEPS = Object.freeze({
  PHONE: 'phone',
  OTP: 'otp',
  AUTHENTICATED: 'authenticated'
});

export const DEFAULT_RESEND_COOLDOWN = 60; // 60 seconds matching Android RESEND_SECONDS

/**
 * AuthController orchestrates the authentication flow:
 * Phone Input -> Request OTP -> Verify OTP -> Session Persistence -> Profile Fetch -> Logout.
 *
 * Keeps state synchronized and does not expose raw networking to the renderer.
 */
export class AuthController {
  /**
   * @param {object} options
   * @param {import('../api/ollacore-api.js').OllacoreApi} options.api
   * @param {import('../storage/session-store.js').SessionStore} options.sessionStore
   * @param {number} [options.cooldownSeconds=DEFAULT_RESEND_COOLDOWN]
   */
  constructor({ api, sessionStore, cooldownSeconds = DEFAULT_RESEND_COOLDOWN }) {
    if (!api) throw new Error('AuthController requires an api client instance');
    if (!sessionStore) throw new Error('AuthController requires a sessionStore instance');

    this.api = api;
    this.sessionStore = sessionStore;
    this.cooldownSeconds = cooldownSeconds;

    this._state = {
      step: AUTH_STEPS.PHONE,
      phone: '',
      otpCode: '',
      isLoading: false,
      error: null,
      cooldownRemaining: 0,
      cooldownTargetTime: null,
      session: null
    };

    this._timer = null;
  }

  /**
   * Returns a copy of the current authentication state.
   */
  getState() {
    this._updateCooldown();
    return {
      step: this._state.step,
      phone: this._state.phone,
      otpCode: this._state.otpCode,
      isLoading: this._state.isLoading,
      error: this._state.error,
      cooldownRemaining: this._state.cooldownRemaining,
      session: this._state.session ? { ...this._state.session } : null
    };
  }

  /**
   * Recalculates remaining cooldown seconds based on timestamp.
   * @private
   */
  _updateCooldown() {
    if (!this._state.cooldownTargetTime) {
      this._state.cooldownRemaining = 0;
      return;
    }
    const diff = Math.ceil((this._state.cooldownTargetTime - Date.now()) / 1000);
    this._state.cooldownRemaining = diff > 0 ? diff : 0;
    if (this._state.cooldownRemaining === 0) {
      this._state.cooldownTargetTime = null;
    }
  }

  /**
   * Restores session on application startup:
   * Checks if a valid session token exists in SessionStore.
   * If yes, transitions immediately to AUTHENTICATED.
   */
  async init() {
    const session = await this.sessionStore.load();
    if (session && session.sessionToken) {
      this._state.step = AUTH_STEPS.AUTHENTICATED;
      this._state.session = session;
      this._state.phone = session.phone || '';
      // Attempt background profile refresh if session exists
      this.refreshProfile().catch(() => {});
    } else {
      this._state.step = AUTH_STEPS.PHONE;
      this._state.session = session;
    }
    return this.getState();
  }

  /**
   * Sets or updates phone input, applying sanitization.
   * @param {string} phone
   */
  updatePhone(phone) {
    this._state.phone = sanitizePhone(phone);
    this._state.error = null;
    return this.getState();
  }

  /**
   * Sets or updates OTP input: digits only, maximum 6 characters.
   * @param {string} code
   */
  updateOtp(code) {
    this._state.otpCode = sanitizeOtp(code);
    this._state.error = null;
    return this.getState();
  }

  /**
   * Requests an OTP for the phone number.
   * @param {string} [phone] Optional override; otherwise uses stored phone.
   */
  async requestOtp(phone) {
    const targetPhone = phone !== undefined ? sanitizePhone(phone) : this._state.phone;
    if (!targetPhone || targetPhone.length < 6) {
      this._state.error = 'Enter a valid phone number';
      throw new ApiError('Enter a valid phone number', 'validation_error', 400);
    }

    this._state.phone = targetPhone;
    this._state.isLoading = true;
    this._state.error = null;

    try {
      const response = await this.api.requestOtp(targetPhone);
      this._state.step = AUTH_STEPS.OTP;
      this._state.otpCode = '';
      this._state.isLoading = false;
      this._state.error = null;

      // Start 60-second cooldown
      this._state.cooldownTargetTime = Date.now() + this.cooldownSeconds * 1000;
      this._updateCooldown();

      return {
        state: this.getState(),
        response
      };
    } catch (err) {
      this._state.isLoading = false;
      this._state.error = err.message || 'Unable to send OTP';
      throw err;
    }
  }

  /**
   * Resends OTP if cooldown has expired.
   */
  async resendOtp() {
    this._updateCooldown();
    if (this._state.cooldownRemaining > 0) {
      const msg = `Please wait ${this._state.cooldownRemaining}s before requesting another code`;
      this._state.error = msg;
      throw new ApiError(msg, 'cooldown_active', 429);
    }
    return this.requestOtp(this._state.phone);
  }

  /**
   * Verifies OTP code and authenticates the user.
   * On success:
   * 1. Saves session credentials into SessionStore.
   * 2. Fetches profile and updates SessionStore.
   * 3. Transitions to AUTHENTICATED.
   *
   * @param {string} [code] Optional override; otherwise uses stored otpCode.
   */
  async verifyOtp(code) {
    const targetCode = code !== undefined ? sanitizeOtp(code) : this._state.otpCode;
    if (targetCode.length !== 6) {
      this._state.error = 'Enter the 6-digit OTP';
      throw new ApiError('Enter the 6-digit OTP', 'validation_error', 400);
    }

    this._state.otpCode = targetCode;
    this._state.isLoading = true;
    this._state.error = null;

    try {
      const verifyRes = await this.api.verifyOtp(this._state.phone, targetCode);

      // Persist session
      await this.sessionStore.saveSession({
        sessionToken: verifyRes.sessionToken,
        userId: verifyRes.userId,
        phone: this._state.phone,
        displayName: verifyRes.displayName
      });

      // Attempt to load fresh profile
      try {
        const profile = await this.api.getProfile(verifyRes.sessionToken);
        await this.sessionStore.updateProfile({
          displayName: profile.displayName || verifyRes.displayName,
          about: profile.about,
          avatarUrl: profile.avatarUrl
        });
      } catch {
        // Non-blocking: profile fetch error does not prevent login
      }

      this._state.session = this.sessionStore.getSession();
      this._state.step = AUTH_STEPS.AUTHENTICATED;
      this._state.isLoading = false;
      this._state.error = null;
      this._state.otpCode = '';

      return {
        state: this.getState(),
        session: this._state.session
      };
    } catch (err) {
      this._state.isLoading = false;
      this._state.error = err.message || 'OTP verification failed';
      throw err;
    }
  }

  /**
   * Refreshes user profile from server and updates local SessionStore.
   */
  async refreshProfile() {
    const session = this.sessionStore.getSession();
    if (!session || !session.sessionToken) return null;

    try {
      const profile = await this.api.getProfile(session.sessionToken);
      await this.sessionStore.updateProfile({
        displayName: profile.displayName,
        about: profile.about !== undefined && profile.about !== null ? profile.about : session.about,
        avatarUrl: profile.avatarUrl || session.avatarUrl,
        avatarVersion: profile.avatarVersion || session.avatarVersion
      });
      this._state.session = this.sessionStore.getSession();
      return this._state.session;
    } catch (err) {
      return null;
    }
  }

  /**
   * Updates user profile fields on server via PATCH /directory/me and persists in local SessionStore.
   * @param {object} profileData
   * @param {string} [profileData.displayName]
   * @param {string} [profileData.about]
   * @param {string} [profileData.avatarUrl]
   * @param {string} [profileData.avatarVersion]
   * @returns {Promise<object>} Updated session
   */
  async updateProfile(profileData = {}) {
    const session = this.sessionStore.getSession();
    if (!session || !session.sessionToken) {
      throw new Error('Not authenticated');
    }

    const allowed = {};
    const dName = profileData.display_name !== undefined ? profileData.display_name : profileData.displayName;
    const ab = profileData.about;
    const av = profileData.avatar_url !== undefined ? profileData.avatar_url : profileData.avatarUrl;
    const avVersion = profileData.avatar_version !== undefined ? profileData.avatar_version : profileData.avatarVersion;

    if (dName !== undefined) {
      allowed.displayName = dName;
      allowed.display_name = dName;
    }
    if (ab !== undefined) {
      allowed.about = ab;
    }
    if (av !== undefined) {
      allowed.avatarUrl = av;
      allowed.avatar_url = av;
    }

    // Backend PATCH /directory/me strictly requires display_name
    if (!allowed.displayName && !allowed.display_name) {
      const fallback = session.displayName || session.phone || 'OllaChat User';
      allowed.displayName = fallback;
      allowed.display_name = fallback;
    }

    const serverProfile = await this.api.updateProfile(session.sessionToken, allowed);

    const mergedDisplayName = serverProfile?.displayName || allowed.displayName || allowed.display_name;
    const mergedAbout = serverProfile?.about !== undefined && serverProfile?.about !== null
      ? serverProfile.about
      : (allowed.about !== undefined ? allowed.about : session.about);

    let mergedAvatarUrl;
    if (serverProfile?.avatarUrl !== undefined && serverProfile?.avatarUrl !== null) {
      mergedAvatarUrl = serverProfile.avatarUrl;
    } else if (allowed.avatarUrl !== undefined) {
      mergedAvatarUrl = allowed.avatarUrl;
    } else if (allowed.avatar_url !== undefined) {
      mergedAvatarUrl = allowed.avatar_url;
    } else {
      mergedAvatarUrl = session.avatarUrl;
    }

    let mergedAvatarVersion;
    if (serverProfile?.avatarVersion !== undefined) {
      mergedAvatarVersion = serverProfile.avatarVersion;
    } else if (avVersion !== undefined) {
      mergedAvatarVersion = avVersion;
    } else {
      mergedAvatarVersion = session.avatarVersion;
    }

    await this.sessionStore.updateProfile({
      displayName: mergedDisplayName,
      about: mergedAbout,
      avatarUrl: mergedAvatarUrl,
      avatarVersion: mergedAvatarVersion
    });

    this._state.session = this.sessionStore.getSession();
    return this._state.session;
  }

  /**
   * Logs out the user:
   * 1. Calls server logout endpoint.
   * 2. Clears local SessionStore (preserving onboardingDone).
   * 3. Resets state to PHONE.
   */
  async logout(allDevices = false) {
    const session = this.sessionStore.getSession();
    const token = session?.sessionToken;

    this._state.isLoading = true;

    // Server-side invalidation
    if (token) {
      try {
        await this.api.logout(token, allDevices);
      } catch {
        // Non-blocking: local session must be cleared even if remote call fails
      }
    }

    // Local session clearing (preserves onboardingDone)
    await this.sessionStore.clear();

    this._state.step = AUTH_STEPS.PHONE;
    this._state.phone = '';
    this._state.otpCode = '';
    this._state.isLoading = false;
    this._state.error = null;
    this._state.cooldownRemaining = 0;
    this._state.cooldownTargetTime = null;
    this._state.session = this.sessionStore.getSession();

    return this.getState();
  }

  /**
   * Navigates back to the phone input screen from the OTP screen.
   */
  backToPhone() {
    this._state.step = AUTH_STEPS.PHONE;
    this._state.otpCode = '';
    this._state.error = null;
    return this.getState();
  }

  /**
   * Clears active error message.
   */
  clearError() {
    this._state.error = null;
    return this.getState();
  }
}
