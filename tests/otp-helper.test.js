import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveSimToken,
  sanitizeToken,
  validatePhone,
  parseArgs,
  buildSimUrl,
  pollOtp
} from '../scripts/get-otp.js';

describe('OTP Simulator QA Helper Unit Tests', () => {

  // 1. Missing Token
  test('1. resolveSimToken throws clear error when neither SIM_TOKEN nor OLLACORE_SIM_TOKEN is set', () => {
    assert.throws(
      () => resolveSimToken({}),
      /Error: SIM_TOKEN \(or OLLACORE_SIM_TOKEN\) environment variable is not set in this terminal session\./
    );

    assert.throws(
      () => resolveSimToken({ SIM_TOKEN: '   ' }),
      /Error: SIM_TOKEN \(or OLLACORE_SIM_TOKEN\) environment variable is not set in this terminal session\./
    );

    assert.throws(
      () => resolveSimToken({ OLLACORE_SIM_TOKEN: '""' }),
      /Error: SIM_TOKEN \(or OLLACORE_SIM_TOKEN\) environment variable is not set in this terminal session\./
    );
  });

  // 2. SIM_TOKEN Priority
  test('2. resolveSimToken prioritizes SIM_TOKEN over OLLACORE_SIM_TOKEN', () => {
    const token = resolveSimToken({
      SIM_TOKEN: 'token_primary',
      OLLACORE_SIM_TOKEN: 'token_secondary'
    });
    assert.equal(token, 'token_primary');
  });

  // 3. OLLACORE_SIM_TOKEN Fallback
  test('3. resolveSimToken falls back to OLLACORE_SIM_TOKEN when SIM_TOKEN is missing', () => {
    const token = resolveSimToken({
      OLLACORE_SIM_TOKEN: 'token_fallback'
    });
    assert.equal(token, 'token_fallback');
  });

  // 4. Token Sanitization
  test('4. sanitizeToken strips surrounding double/single quotes and whitespace', () => {
    assert.equal(sanitizeToken('  "sim_xyz123"  '), 'sim_xyz123');
    assert.equal(sanitizeToken("  'sim_abc456'  "), 'sim_abc456');
    assert.equal(sanitizeToken('sim_raw_token'), 'sim_raw_token');
    assert.equal(sanitizeToken(''), '');
    assert.equal(sanitizeToken(null), '');
  });

  // 5. Phone Validation
  test('5. validatePhone validates E.164 and rejects invalid formats', () => {
    assert.equal(validatePhone('+15550001111'), '+15550001111');
    assert.equal(validatePhone('+15550002222'), '+15550002222');
    assert.equal(validatePhone('+15550003333'), '+15550003333');
    assert.equal(validatePhone(' +15550001111 '), '+15550001111');

    assert.throws(() => validatePhone('15550001111'), /Invalid phone format/);
    assert.throws(() => validatePhone('invalid'), /Invalid phone format/);
    assert.throws(() => validatePhone(''), /Phone number is required/);
    assert.throws(() => validatePhone(null), /Phone number is required/);
  });

  // 6. '+' URL-encoding in Simulator URL
  test('6. buildSimUrl encodes "+" as "%2B" in the query string', () => {
    const url = buildSimUrl('https://sim.example.com', '+15550001111', 1758440000000);
    assert.ok(url.includes('phone=%2B15550001111'));
    assert.ok(!url.includes('phone=+15550001111'));
    assert.ok(url.includes('since=1758440000000'));
  });

  // 7. --since Validation
  test('7. parseArgs validates --since as a positive integer and falls back to Date.now() - 30000', () => {
    // Explicit --since
    const explicit = parseArgs(['+15550001111', '--since', '1758440000000']);
    assert.equal(explicit.phone, '+15550001111');
    assert.equal(explicit.since, 1758440000000);

    // Explicit --since=<val>
    const inline = parseArgs(['+15550001111', '--since=1758440000000']);
    assert.equal(inline.since, 1758440000000);

    // Invalid --since (non-numeric)
    assert.throws(() => parseArgs(['+15550001111', '--since', 'abc']), /positive integer/);
    // Invalid --since (negative)
    assert.throws(() => parseArgs(['+15550001111', '--since', '-1']), /positive integer/);

    // Default since calculation
    const before = Date.now() - 30000;
    const def = parseArgs(['+15550001111']);
    const after = Date.now() - 30000;
    assert.ok(def.since >= before && def.since <= after);
  });

  // 8. 200 Response
  test('8. pollOtp returns 6-digit code on HTTP 200 and sends Bearer Authorization header', async () => {
    const fetchCalls = [];
    const mockFetch = async (url, options) => {
      fetchCalls.push({ url, options });
      return {
        status: 200,
        json: async () => ({ code: '123456', phone: '+15550001111' })
      };
    };

    const code = await pollOtp({
      phone: '+15550001111',
      since: 1758440000000,
      token: 'mock_sim_token',
      fetchFn: mockFetch,
      logFn: () => {}
    });

    assert.equal(code, '123456');
    assert.equal(fetchCalls.length, 1);
    assert.equal(fetchCalls[0].options.headers['Authorization'], 'Bearer mock_sim_token');
  });

  // 9. 404 no_code recovery
  test('9. pollOtp handles 404 no_code by polling until code becomes available', async () => {
    let callCount = 0;
    const sleepCalls = [];
    const mockFetch = async () => {
      callCount++;
      if (callCount === 1) {
        return {
          status: 404,
          json: async () => ({ error: 'no_code' })
        };
      }
      return {
        status: 200,
        json: async () => ({ code: '654321' })
      };
    };

    const code = await pollOtp({
      phone: '+15550001111',
      since: 1758440000000,
      token: 'mock_sim_token',
      intervalMs: 10,
      fetchFn: mockFetch,
      sleepFn: (ms) => { sleepCalls.push(ms); return Promise.resolve(); },
      logFn: () => {}
    });

    assert.equal(code, '654321');
    assert.equal(callCount, 2);
    assert.equal(sleepCalls.length, 1);
    assert.equal(sleepCalls[0], 10);
  });

  // 10. 404 no_fresh_code recovery
  test('10. pollOtp handles 404 no_fresh_code by continuing to poll', async () => {
    let callCount = 0;
    const mockFetch = async () => {
      callCount++;
      if (callCount === 1) {
        return {
          status: 404,
          json: async () => ({ error: 'no_fresh_code' })
        };
      }
      return {
        status: 200,
        json: async () => ({ code: '777888' })
      };
    };

    const code = await pollOtp({
      phone: '+15550001111',
      since: 1758440000000,
      token: 'mock_sim_token',
      intervalMs: 5,
      fetchFn: mockFetch,
      sleepFn: () => Promise.resolve(),
      logFn: () => {}
    });

    assert.equal(code, '777888');
    assert.equal(callCount, 2);
  });

  // 11. 401 Rejection
  test('11. pollOtp halts immediately on HTTP 401 with clear rejection message', async () => {
    const mockFetch = async () => ({
      status: 401,
      json: async () => ({ error: 'unauthorized' })
    });

    await assert.rejects(
      async () => {
        await pollOtp({
          phone: '+15550001111',
          since: 1758440000000,
          token: 'invalid_token',
          fetchFn: mockFetch,
          logFn: () => {}
        });
      },
      /Error: OTP Simulator rejected the SIM_TOKEN\./
    );
  });

  // 12. 429 Retry-After Handling
  test('12. pollOtp obeys Retry-After header on HTTP 429 rate limiting', async () => {
    let callCount = 0;
    const sleepCalls = [];
    const mockFetch = async () => {
      callCount++;
      if (callCount === 1) {
        return {
          status: 429,
          headers: new Headers({ 'retry-after': '5' }),
          json: async () => ({ error: 'rate_limited' })
        };
      }
      return {
        status: 200,
        json: async () => ({ code: '999111' })
      };
    };

    const code = await pollOtp({
      phone: '+15550001111',
      since: 1758440000000,
      token: 'mock_sim_token',
      fetchFn: mockFetch,
      sleepFn: (ms) => { sleepCalls.push(ms); return Promise.resolve(); },
      logFn: () => {}
    });

    assert.equal(code, '999111');
    assert.equal(callCount, 2);
    // Verifies it waited 5000ms (5s from Retry-After header)
    assert.equal(sleepCalls[0], 5000);
  });

  // 13. Timeout Handling
  test('13. pollOtp times out with clear error when no fresh OTP arrives within timeout period', async () => {
    const mockFetch = async () => ({
      status: 404,
      json: async () => ({ error: 'no_code' })
    });

    await assert.rejects(
      async () => {
        await pollOtp({
          phone: '+15550001111',
          since: 1758440000000,
          token: 'mock_sim_token',
          timeoutMs: 25,
          intervalMs: 5,
          fetchFn: mockFetch,
          sleepFn: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          logFn: () => {}
        });
      },
      /Error: Timed out waiting for a fresh OTP\./
    );
  });
});
