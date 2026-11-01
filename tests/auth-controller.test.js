import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AuthController, AUTH_STEPS } from '../src/auth/auth-controller.js';
import { SessionStore } from '../src/storage/session-store.js';
import { ApiError } from '../src/api/api-error.js';

describe('AuthController Unit Tests', () => {
  let tempDir;
  let sessionStore;

  // Mock API client factory
  function createMockApi(overrides = {}) {
    return {
      requestOtpCalls: [],
      verifyOtpCalls: [],
      getProfileCalls: [],
      logoutCalls: [],

      async requestOtp(phone) {
        this.requestOtpCalls.push(phone);
        if (overrides.requestOtpError) throw overrides.requestOtpError;
        return overrides.requestOtpResponse || { dispatched: true, expires_at: '2026-09-21T16:00:00Z' };
      },

      async verifyOtp(phone, code) {
        this.verifyOtpCalls.push({ phone, code });
        if (overrides.verifyOtpError) throw overrides.verifyOtpError;
        return overrides.verifyOtpResponse || {
          sessionToken: 'mock_token_abc',
          userId: 'user_123',
          displayName: 'Test User'
        };
      },

      async getProfile(token) {
        this.getProfileCalls.push(token);
        if (overrides.getProfileError) throw overrides.getProfileError;
        return overrides.getProfileResponse || {
          id: 'user_123',
          userId: 'user_123',
          phone: '+15550001111',
          displayName: 'Updated Profile Name',
          about: 'Testing OllaChat',
          avatarUrl: 'https://example.com/photo.jpg'
        };
      },

      async logout(token, allDevices) {
        this.logoutCalls.push({ token, allDevices });
        if (overrides.logoutError) throw overrides.logoutError;
        return { success: true };
      },

      updateProfileCalls: [],
      async updateProfile(token, profile) {
        this.updateProfileCalls.push({ token, profile });
        if (overrides.updateProfileError) throw overrides.updateProfileError;
        return overrides.updateProfileResponse || {
          displayName: profile.displayName || profile.display_name,
          about: profile.about
        };
      }
    };
  }

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ollacore-auth-test-'));
    sessionStore = new SessionStore(tempDir);
  });

  afterEach(async () => {
    if (tempDir && fsSync.existsSync(tempDir)) {
      try {
        await fs.rm(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      } catch {}
    }
  });

  test('1. phone validation: rejects empty or too short phone numbers', async () => {
    const api = createMockApi();
    const controller = new AuthController({ api, sessionStore });

    await assert.rejects(
      async () => {
        await controller.requestOtp('');
      },
      (err) => {
        assert.equal(err.code, 'validation_error');
        assert.match(err.message, /valid phone/i);
        return true;
      }
    );
    assert.equal(controller.getState().step, AUTH_STEPS.PHONE);
  });

  test('2. phone sanitization: preserves international characters (+, -, spaces, digits)', () => {
    const api = createMockApi();
    const controller = new AuthController({ api, sessionStore });

    controller.updatePhone(' +1 (555) 000-2222 abc ');
    assert.equal(controller.getState().phone, '+1 (555) 000-2222');
  });

  test('3. OTP validation: requires exactly 6 digits', async () => {
    const api = createMockApi();
    const controller = new AuthController({ api, sessionStore });
    controller.updatePhone('+15550001111');

    await assert.rejects(
      async () => {
        await controller.verifyOtp('123'); // only 3 digits
      },
      (err) => {
        assert.equal(err.code, 'validation_error');
        assert.match(err.message, /6-digit/i);
        return true;
      }
    );
  });

  test('4. OTP length restriction: caps at 6 digits and strips non-digits', () => {
    const api = createMockApi();
    const controller = new AuthController({ api, sessionStore });

    controller.updateOtp('12-34-56-78');
    assert.equal(controller.getState().otpCode, '123456');
  });

  test('5. request OTP success: transitions to OTP step and sets cooldown', async () => {
    const api = createMockApi();
    const controller = new AuthController({ api, sessionStore, cooldownSeconds: 30 });

    const result = await controller.requestOtp('+1 555 000 1111');

    assert.equal(api.requestOtpCalls.length, 1);
    assert.equal(api.requestOtpCalls[0], '+1 555 000 1111');
    assert.equal(result.state.step, AUTH_STEPS.OTP);
    assert.equal(result.state.phone, '+1 555 000 1111');
    assert.ok(result.state.cooldownRemaining > 0);
    assert.equal(result.state.isLoading, false);
  });

  test('6. request OTP failure: keeps PHONE step and sets error message', async () => {
    const api = createMockApi({
      requestOtpError: new ApiError('Invalid mobile operator', 'operator_rejected', 400)
    });
    const controller = new AuthController({ api, sessionStore });

    await assert.rejects(
      async () => {
        await controller.requestOtp('+1 555 000 1111');
      },
      (err) => {
        assert.equal(err.message, 'Invalid mobile operator');
        return true;
      }
    );

    const state = controller.getState();
    assert.equal(state.step, AUTH_STEPS.PHONE);
    assert.equal(state.error, 'Invalid mobile operator');
    assert.equal(state.isLoading, false);
  });

  test('7. resend cooldown: blocks resend while cooldown is active, allows when 0', async () => {
    const api = createMockApi();
    const controller = new AuthController({ api, sessionStore, cooldownSeconds: 60 });

    await controller.requestOtp('+15550001111');
    assert.ok(controller.getState().cooldownRemaining > 0);

    // Attempting resend immediately must fail
    await assert.rejects(
      async () => {
        await controller.resendOtp();
      },
      (err) => {
        assert.equal(err.code, 'cooldown_active');
        assert.match(err.message, /wait/i);
        return true;
      }
    );

    // Fast-forward cooldown target time
    controller._state.cooldownTargetTime = Date.now() - 1000;
    assert.equal(controller.getState().cooldownRemaining, 0);

    // Resend must now succeed
    const resendRes = await controller.resendOtp();
    assert.equal(api.requestOtpCalls.length, 2);
    assert.equal(resendRes.state.step, AUTH_STEPS.OTP);
  });

  test('8. verify OTP success: saves session and updates profile', async () => {
    const api = createMockApi({
      verifyOtpResponse: {
        sessionToken: 'auth_token_999',
        userId: 'user_999',
        displayName: 'Alice In Wonderland'
      },
      getProfileResponse: {
        id: 'user_999',
        userId: 'user_999',
        phone: '+15550001111',
        displayName: 'Alice In Wonderland',
        about: 'Chasing the white rabbit',
        avatarUrl: 'https://example.com/alice.png'
      }
    });
    const controller = new AuthController({ api, sessionStore });
    await controller.requestOtp('+15550001111');

    const result = await controller.verifyOtp('654321');

    assert.equal(result.state.step, AUTH_STEPS.AUTHENTICATED);
    assert.equal(result.session.sessionToken, 'auth_token_999');
    assert.equal(result.session.userId, 'user_999');
    assert.equal(result.session.displayName, 'Alice In Wonderland');
    assert.equal(result.session.about, 'Chasing the white rabbit');
  });

  test('9. verify OTP failure: remains on OTP step and sets error', async () => {
    const api = createMockApi({
      verifyOtpError: new ApiError('Incorrect code', 'invalid_otp', 400)
    });
    const controller = new AuthController({ api, sessionStore });
    await controller.requestOtp('+15550001111');

    await assert.rejects(
      async () => {
        await controller.verifyOtp('000000');
      },
      (err) => {
        assert.equal(err.message, 'Incorrect code');
        return true;
      }
    );

    const state = controller.getState();
    assert.equal(state.step, AUTH_STEPS.OTP);
    assert.equal(state.error, 'Incorrect code');
    assert.equal(state.isLoading, false);
  });

  test('10. session saved after successful verification in SessionStore', async () => {
    const api = createMockApi();
    const controller = new AuthController({ api, sessionStore });
    await controller.requestOtp('+15550001111');
    await controller.verifyOtp('123456');

    // Reload directly from disk
    const diskStore = new SessionStore(tempDir);
    const persisted = await diskStore.load();
    assert.equal(persisted.sessionToken, 'mock_token_abc');
    assert.equal(persisted.userId, 'user_123');
    assert.equal(persisted.phone, '+15550001111');
  });

  test('11. session restoration: init() restores AUTHENTICATED step if token exists', async () => {
    // Pre-seed session
    await sessionStore.saveSession({
      sessionToken: 'existing_token_456',
      userId: 'user_456',
      phone: '+15550002222',
      displayName: 'Existing User'
    });

    const api = createMockApi();
    const controller = new AuthController({ api, sessionStore });
    const state = await controller.init();

    assert.equal(state.step, AUTH_STEPS.AUTHENTICATED);
    assert.equal(state.session.sessionToken, 'existing_token_456');
    assert.equal(state.session.userId, 'user_456');
  });

  test('12. logout clears session and transitions back to PHONE step', async () => {
    const api = createMockApi();
    const controller = new AuthController({ api, sessionStore });
    await controller.requestOtp('+15550001111');
    await controller.verifyOtp('123456');

    assert.equal(controller.getState().step, AUTH_STEPS.AUTHENTICATED);

    const postLogoutState = await controller.logout(false);

    assert.equal(api.logoutCalls.length, 1);
    assert.equal(postLogoutState.step, AUTH_STEPS.PHONE);
    assert.equal(postLogoutState.session.sessionToken, null);

    // Verify disk state
    const diskStore = new SessionStore(tempDir);
    const diskSession = await diskStore.load();
    assert.equal(diskSession.sessionToken, null);
  });

  test('13. onboarding state survives logout (Android parity)', async () => {
    await sessionStore.setOnboardingDone(true);
    await sessionStore.saveSession({
      sessionToken: 'temp_token',
      userId: 'temp_user',
      phone: '+15550003333'
    });

    const api = createMockApi();
    const controller = new AuthController({ api, sessionStore });
    await controller.init();

    assert.equal(controller.getState().session.onboardingDone, true);

    await controller.logout();

    const finalState = controller.getState();
    assert.equal(finalState.session.onboardingDone, true, 'onboardingDone must survive logout');
  });

  test('14. profile loading/update behavior: refreshProfile updates SessionStore', async () => {
    await sessionStore.saveSession({
      sessionToken: 'token_prof',
      userId: 'user_prof',
      phone: '+15550004444'
    });

    const api = createMockApi({
      getProfileResponse: {
        id: 'user_prof',
        userId: 'user_prof',
        displayName: 'Newly Fetched Name',
        about: 'Testing profile refresh',
        avatarUrl: 'https://example.com/avatar.jpg'
      }
    });
    const controller = new AuthController({ api, sessionStore });
    await controller.init();

    await controller.refreshProfile();

    const session = controller.getState().session;
    assert.equal(session.displayName, 'Newly Fetched Name');
    assert.equal(session.about, 'Testing profile refresh');
    assert.equal(session.avatarUrl, 'https://example.com/avatar.jpg');
  });

  test('15. backToPhone navigation returns to PHONE step and resets otpCode', async () => {
    const api = createMockApi();
    const controller = new AuthController({ api, sessionStore });
    await controller.requestOtp('+15550001111');
    controller.updateOtp('123');

    assert.equal(controller.getState().step, AUTH_STEPS.OTP);

    const state = controller.backToPhone();
    assert.equal(state.step, AUTH_STEPS.PHONE);
    assert.equal(state.otpCode, '');
  });

  test('16. updateProfile persists displayName and about while preserving userId and tokens', async () => {
    await sessionStore.saveSession({
      sessionToken: 'token_profile_update',
      userId: 'uuid_stable_123',
      phone: '+15550007777',
      displayName: 'Old Name',
      about: 'Old Bio'
    });

    const api = createMockApi();
    const controller = new AuthController({ api, sessionStore });
    await controller.init();

    const updated = await controller.updateProfile({
      displayName: 'Brand New Name',
      about: 'Brand New Bio'
    });

    assert.equal(updated.displayName, 'Brand New Name');
    assert.equal(updated.about, 'Brand New Bio');
    assert.equal(updated.userId, 'uuid_stable_123');
    assert.equal(updated.sessionToken, 'token_profile_update');
    assert.equal(api.updateProfileCalls.length, 1);
    assert.equal(api.updateProfileCalls[0].token, 'token_profile_update');
  });
});
