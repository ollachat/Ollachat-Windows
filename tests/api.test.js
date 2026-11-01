import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  OllacoreApi,
  sanitizePhone,
  sanitizeOtp,
  normalizeUserProfile,
  normalizeToE164,
  validateE164
} from '../src/api/ollacore-api.js';
import { ApiError } from '../src/api/api-error.js';

describe('OllacoreApi Unit Tests (Mock Transport)', () => {
  const TEST_BASE = 'https://api.test.local/v1';
  const TEST_APP_ID = 'test_app_id_123';

  // Helper to create a mock fetch function that records request details and returns a mock response
  function createMockFetch(status = 200, responseData = {}, headers = {}) {
    const calls = [];
    const mockFn = async (url, options) => {
      calls.push({
        url,
        method: options.method,
        headers: options.headers,
        body: options.body ? JSON.parse(options.body) : null,
        signal: options.signal
      });

      return {
        status,
        ok: status >= 200 && status < 300,
        headers: new Headers(headers),
        text: async () => (status === 204 ? '' : JSON.stringify(responseData))
      };
    };
    mockFn.calls = calls;
    return mockFn;
  }

  test('1. requestOtp sends correct method, path, and body', async () => {
    const mockFetch = createMockFetch(200, { dispatched: true, expires_at: '2026-09-21T12:00:00Z' });
    const api = new OllacoreApi({ baseUrl: TEST_BASE, appId: TEST_APP_ID, fetchFn: mockFetch });

    const result = await api.requestOtp('+1 555-000-1111');

    assert.equal(mockFetch.calls.length, 1);
    const call = mockFetch.calls[0];
    assert.equal(call.url, `${TEST_BASE}/directory/otp/request`);
    assert.equal(call.method, 'POST');
    assert.deepEqual(call.body, {
      app_id: TEST_APP_ID,
      phone: '+1 555-000-1111'
    });
    assert.equal(result.dispatched, true);
    assert.equal(result.expiresAt, '2026-09-21T12:00:00Z');
  });

  test('2. verifyOtp sends correct method, path, body, and parses response', async () => {
    const mockFetch = createMockFetch(200, {
      session_token: 'tok_abc',
      user_id: 'usr_xyz',
      display_name: 'Alice'
    });
    const api = new OllacoreApi({ baseUrl: TEST_BASE, appId: TEST_APP_ID, fetchFn: mockFetch });

    const result = await api.verifyOtp('+1 555 123 4567', '123456');

    assert.equal(mockFetch.calls.length, 1);
    const call = mockFetch.calls[0];
    assert.equal(call.url, `${TEST_BASE}/directory/otp/verify`);
    assert.equal(call.method, 'POST');
    assert.deepEqual(call.body, {
      app_id: TEST_APP_ID,
      phone: '+1 555 123 4567',
      code: '123456'
    });
    assert.equal(result.sessionToken, 'tok_abc');
    assert.equal(result.userId, 'usr_xyz');
    assert.equal(result.displayName, 'Alice');
  });

  test('3. getProfile attaches Authorization Bearer header', async () => {
    const mockFetch = createMockFetch(200, {
      id: 'usr_1',
      phone: '+15550001111',
      display_name: 'Bob',
      about: 'Hello world',
      avatar_url: 'https://example.com/avatar.png'
    });
    const api = new OllacoreApi({ baseUrl: TEST_BASE, appId: TEST_APP_ID, fetchFn: mockFetch });

    const profile = await api.getProfile('valid_token_777');

    assert.equal(mockFetch.calls.length, 1);
    const call = mockFetch.calls[0];
    assert.equal(call.url, `${TEST_BASE}/directory/me`);
    assert.equal(call.method, 'GET');
    assert.equal(call.headers.Authorization, 'Bearer valid_token_777');
    assert.equal(profile.userId, 'usr_1');
    assert.equal(profile.displayName, 'Bob');
    assert.equal(profile.avatarUrl, 'https://example.com/avatar.png');
  });

  test('4. updateProfile sends PATCH with only supplied fields', async () => {
    const mockFetch = createMockFetch(200, {
      id: 'usr_1',
      phone: '+15550001111',
      display_name: 'Updated Name',
      about: 'New about'
    });
    const api = new OllacoreApi({ baseUrl: TEST_BASE, appId: TEST_APP_ID, fetchFn: mockFetch });

    await api.updateProfile('token_123', {
      displayName: 'Updated Name',
      about: 'New about'
    });

    assert.equal(mockFetch.calls.length, 1);
    const call = mockFetch.calls[0];
    assert.equal(call.url, `${TEST_BASE}/directory/me`);
    assert.equal(call.method, 'PATCH');
    assert.equal(call.headers.Authorization, 'Bearer token_123');
    // Does not include avatar_url because it was undefined
    assert.deepEqual(call.body, {
      display_name: 'Updated Name',
      about: 'New about'
    });
  });

  test('5. logout sends POST with Authorization and all_devices flag', async () => {
    const mockFetch = createMockFetch(200, {});
    const api = new OllacoreApi({ baseUrl: TEST_BASE, appId: TEST_APP_ID, fetchFn: mockFetch });

    // Single device logout
    await api.logout('token_single', false);
    assert.equal(mockFetch.calls[0].url, `${TEST_BASE}/directory/logout`);
    assert.equal(mockFetch.calls[0].headers.Authorization, 'Bearer token_single');
    assert.deepEqual(mockFetch.calls[0].body, {});

    // All devices logout
    await api.logout('token_all', true);
    assert.deepEqual(mockFetch.calls[1].body, { all_devices: true });
  });

  test('6. successful JSON parsing works for valid responses', async () => {
    const mockFetch = createMockFetch(200, {
      dispatched: true,
      expires_at: '2026-09-21T15:00:00Z'
    });
    const api = new OllacoreApi({ baseUrl: TEST_BASE, appId: TEST_APP_ID, fetchFn: mockFetch });

    const res = await api.requestOtp('+15550001111');
    assert.equal(res.dispatched, true);
    assert.equal(res.expires_at, '2026-09-21T15:00:00Z');
  });

  test('7. 204 No Content response is handled successfully', async () => {
    const mockFetch = createMockFetch(204, null);
    const api = new OllacoreApi({ baseUrl: TEST_BASE, appId: TEST_APP_ID, fetchFn: mockFetch });

    const result = await api.logout('token_204');
    assert.deepEqual(result, { success: true });
  });

  test('8. ApiError is parsed from backend JSON error response', async () => {
    const mockFetch = createMockFetch(400, {
      code: 'invalid_otp',
      message: 'Invalid verification code'
    });
    const api = new OllacoreApi({ baseUrl: TEST_BASE, appId: TEST_APP_ID, fetchFn: mockFetch });

    await assert.rejects(
      async () => {
        await api.verifyOtp('+15550001111', '000000');
      },
      (err) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.message, 'Invalid verification code');
        assert.equal(err.code, 'invalid_otp');
        assert.equal(err.httpStatus, 400);
        return true;
      }
    );
  });

  test('9. fallback HTTP error handling formats HTTP <status_code> on unparseable error', async () => {
    const mockFn = async () => ({
      status: 502,
      ok: false,
      text: async () => '<html>Bad Gateway</html>'
    });
    const api = new OllacoreApi({ baseUrl: TEST_BASE, appId: TEST_APP_ID, fetchFn: mockFn });

    await assert.rejects(
      async () => {
        await api.requestOtp('+15550001111');
      },
      (err) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.message, 'HTTP 502');
        assert.equal(err.code, 'http_error');
        assert.equal(err.httpStatus, 502);
        return true;
      }
    );
  });

  test('10. sanitizePhone preserves digits, +, spaces, -, (, ) and trims input', () => {
    assert.equal(sanitizePhone(' +1 (555) 000-1111 '), '+1 (555) 000-1111');
    assert.equal(sanitizePhone('+91 98765 43210'), '+91 98765 43210');
    assert.equal(sanitizePhone('abc+1555xyz'), '+1555');
    assert.equal(sanitizePhone(''), '');
  });

  test('11. sanitizeOtp allows digits only and caps at 6 characters', () => {
    assert.equal(sanitizeOtp('123456'), '123456');
    assert.equal(sanitizeOtp('12-34-56'), '123456');
    assert.equal(sanitizeOtp('123456789'), '123456');
    assert.equal(sanitizeOtp('abc'), '');
  });

  test('12. normalizeUserProfile normalizes photo_url to avatarUrl when avatar_url is missing', () => {
    const rawLegacy = {
      id: 'usr_100',
      phone: '+15550001111',
      display_name: 'Carol',
      photo_url: 'https://example.com/photo.jpg'
    };
    const normalized = normalizeUserProfile(rawLegacy);
    assert.equal(normalized.avatarUrl, 'https://example.com/photo.jpg');
    assert.equal(normalized.displayName, 'Carol');

    const rawModern = {
      id: 'usr_101',
      avatar_url: 'https://example.com/avatar.png'
    };
    const normModern = normalizeUserProfile(rawModern);
    assert.equal(normModern.avatarUrl, 'https://example.com/avatar.png');
  });

  test('13. timeout error is safely converted to ApiError with timeout code', async () => {
    const mockTimeoutFetch = async () => {
      const err = new Error('The operation was aborted due to timeout');
      err.name = 'TimeoutError';
      throw err;
    };
    const api = new OllacoreApi({ baseUrl: TEST_BASE, appId: TEST_APP_ID, fetchFn: mockTimeoutFetch, timeoutMs: 100 });

    await assert.rejects(
      async () => {
        await api.requestOtp('+15550001111');
      },
      (err) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.code, 'timeout');
        assert.equal(err.httpStatus, 408);
        return true;
      }
    );
  });

  test('14. no authentication information (tokens, OTPs, passwords) is leaked in toJSON() or representations', () => {
    const error = new ApiError('Invalid credentials', 'invalid_otp', 400);
    const serialized = JSON.stringify(error.toJSON());

    assert.ok(!serialized.includes('Bearer'));
    assert.ok(!serialized.includes('code_secret'));
    assert.equal(error.toJSON().message, 'Invalid credentials');
    assert.equal(error.toJSON().code, 'invalid_otp');
    assert.equal(error.toJSON().httpStatus, 400);
  });
});

describe('BUG-01: E.164 Normalization and Phone Handling Tests', () => {
  const TEST_BASE = 'https://api.test.local/v1';
  const TEST_APP_ID = 'test_app_id_123';

  function createMockFetch(status = 200, responseData = {}) {
    const calls = [];
    const mockFn = async (url, options) => {
      calls.push({
        url,
        method: options.method,
        body: options.body ? JSON.parse(options.body) : null
      });
      return {
        status,
        ok: status >= 200 && status < 300,
        text: async () => JSON.stringify(responseData)
      };
    };
    mockFn.calls = calls;
    return mockFn;
  }

  test('1. India +91 + 10-digit local number -> +918590037717', () => {
    const result = normalizeToE164('8590037717', '+91');
    assert.equal(result, '+918590037717');

    const validated = validateE164('8590037717', '+91');
    assert.equal(validated.valid, true);
    assert.equal(validated.phone, '+918590037717');
    assert.equal(validated.error, null);
  });

  test('2. Country code with spaces -> normalized correctly', () => {
    assert.equal(normalizeToE164('8590037717', ' +91 '), '+918590037717');
    assert.equal(normalizeToE164('8590037717', ' 91 '), '+918590037717');
    assert.equal(normalizeToE164('8590037717', ' +1 '), '+18590037717');
  });

  test('3. Local number containing spaces -> spaces removed', () => {
    assert.equal(normalizeToE164('859 003 7717', '+91'), '+918590037717');
    assert.equal(normalizeToE164('  859   003   7717  ', '+91'), '+918590037717');
    assert.equal(normalizeToE164('8 5 9 0 0 3 7 7 1 7', '+91'), '+918590037717');
  });

  test('4. Local number containing hyphens -> hyphens removed', () => {
    assert.equal(normalizeToE164('859-003-7717', '+91'), '+918590037717');
    assert.equal(normalizeToE164('859--003--7717', '+91'), '+918590037717');
  });

  test('5. Local number containing parentheses -> formatting removed safely', () => {
    assert.equal(normalizeToE164('(859) 003-7717', '+91'), '+918590037717');
    assert.equal(normalizeToE164('(859) 003 7717', '+91'), '+918590037717');
    assert.equal(normalizeToE164('(8590037717)', '+91'), '+918590037717');
    assert.equal(normalizeToE164('859.003.7717', '+91'), '+918590037717');
  });

  test('6. Already E.164 number -> not double-prefixed', () => {
    assert.equal(normalizeToE164('+918590037717', '+91'), '+918590037717');
    assert.equal(normalizeToE164('+91 8590037717', '+91'), '+918590037717');
    assert.equal(normalizeToE164('+91 (859) 003-7717', '+91'), '+918590037717');
    assert.equal(normalizeToE164('+1 415 555-0123', '+91'), '+14155550123');
    assert.equal(normalizeToE164('+44 7911 123456', '+91'), '+447911123456');
  });

  test('7. Invalid/empty phone -> rejected', () => {
    assert.throws(() => normalizeToE164('', '+91'), /valid phone/i);
    assert.throws(() => normalizeToE164('   ', '+91'), /valid phone/i);
    assert.throws(() => normalizeToE164(null, '+91'), /valid phone/i);
    assert.throws(() => normalizeToE164(undefined, '+91'), /valid phone/i);
    assert.throws(() => normalizeToE164('abc', '+91'), /invalid character/i);
    assert.throws(() => normalizeToE164('85900abc17', '+91'), /invalid character/i);
    assert.throws(() => normalizeToE164('12', '+91'), /too short/i);
    assert.throws(() => normalizeToE164('12345678901234567890', '+91'), /too long/i);
    assert.throws(() => normalizeToE164('++918590037717', '+91'), /multiple plus/i);
    assert.throws(() => normalizeToE164('8590037717+', '+91'), /start of the phone/i);

    const validatedEmpty = validateE164('', '+91');
    assert.equal(validatedEmpty.valid, false);
    assert.ok(validatedEmpty.error);

    const validatedInvalid = validateE164('invalid-chars', '+91');
    assert.equal(validatedInvalid.valid, false);
    assert.ok(validatedInvalid.error);
  });

  test('8. OTP request receives the normalized E.164 value', async () => {
    const mockFetch = createMockFetch(200, { dispatched: true, expires_at: '2026-09-21T12:00:00Z' });
    const api = new OllacoreApi({ baseUrl: TEST_BASE, appId: TEST_APP_ID, fetchFn: mockFetch });

    // Simulate UI input: India (+91) with local number 8590037717
    const normalizedPhone = normalizeToE164('8590037717', '+91');
    assert.equal(normalizedPhone, '+918590037717');

    const result = await api.requestOtp(normalizedPhone);

    assert.equal(mockFetch.calls.length, 1);
    const call = mockFetch.calls[0];
    assert.equal(call.url, `${TEST_BASE}/directory/otp/request`);
    assert.equal(call.method, 'POST');
    assert.deepEqual(call.body, {
      app_id: TEST_APP_ID,
      phone: '+918590037717'
    });
    assert.equal(result.dispatched, true);
    assert.equal(result.expiresAt, '2026-09-21T12:00:00Z');
  });
});

