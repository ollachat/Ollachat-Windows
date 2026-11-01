/**
 * OllaCore OTP Simulator QA Helper
 * Retrieves intercepted OTP codes from the official test simulator.
 *
 * Usage:
 *   node scripts/get-otp.js <phone> [--since <timestamp_ms>]
 *   npm run get-otp -- <phone> [--since <timestamp_ms>]
 *
 * Supported QA test routes:
 *   +15550001111 (QA1)
 *   +15550002222 (QA2)
 *   +15550003333 (QA1-Partial)
 */

export const SIMULATOR_BASE_URL = 'https://ollacore-otp-sim.vikas4988.workers.dev';
export const SUPPORTED_QA_PHONES = ['+15550001111', '+15550002222', '+15550003333'];

/**
 * Resolves SIM_TOKEN or OLLACORE_SIM_TOKEN from environment.
 * Priority: SIM_TOKEN first, then OLLACORE_SIM_TOKEN.
 * Strips surrounding whitespace and quotes.
 *
 * @param {object} [env=process.env]
 * @returns {string} Sanitized token
 * @throws {Error} If neither variable is set or token is empty
 */
export function resolveSimToken(env = process.env) {
  const rawToken = env.SIM_TOKEN || env.OLLACORE_SIM_TOKEN;
  if (!rawToken || typeof rawToken !== 'string') {
    throw new Error('Error: SIM_TOKEN (or OLLACORE_SIM_TOKEN) environment variable is not set in this terminal session.');
  }

  const sanitized = sanitizeToken(rawToken);
  if (!sanitized) {
    throw new Error('Error: SIM_TOKEN (or OLLACORE_SIM_TOKEN) environment variable is not set in this terminal session.');
  }

  return sanitized;
}

/**
 * Sanitizes token:
 * - trim leading/trailing whitespace
 * - remove accidental surrounding single or double quotes
 * - trim again
 *
 * @param {string} token
 * @returns {string}
 */
export function sanitizeToken(token) {
  if (typeof token !== 'string') return '';
  let cleaned = token.trim();
  if ((cleaned.startsWith('"') && cleaned.endsWith('"')) || (cleaned.startsWith("'") && cleaned.endsWith("'"))) {
    cleaned = cleaned.slice(1, -1);
  }
  return cleaned.trim();
}

/**
 * Validates that phone is a valid E.164 phone number.
 *
 * @param {string} phone
 * @returns {string} Validated phone number
 * @throws {Error} If invalid
 */
export function validatePhone(phone) {
  if (!phone || typeof phone !== 'string') {
    throw new Error('Error: Phone number is required. Usage: npm run get-otp -- +15550001111');
  }

  const trimmed = phone.trim();
  // Strict E.164: '+' followed by 7 to 15 digits
  if (!/^\+[1-9]\d{6,14}$/.test(trimmed)) {
    throw new Error(`Error: Invalid phone format "${phone}". Phone must be in E.164 format (e.g. +15550001111).`);
  }

  return trimmed;
}

/**
 * Parses CLI arguments.
 *
 * @param {string[]} [args=process.argv.slice(2)]
 * @returns {{ phone: string, since: number }}
 */
export function parseArgs(args = process.argv.slice(2)) {
  let phone = null;
  let since = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--since') {
      const next = args[++i];
      if (!next || !/^\d+$/.test(next.trim())) {
        throw new Error('Error: Invalid --since value. It must be a positive integer timestamp in milliseconds.');
      }
      since = parseInt(next.trim(), 10);
      if (since <= 0) {
        throw new Error('Error: Invalid --since value. It must be a positive integer timestamp in milliseconds.');
      }
    } else if (arg.startsWith('--since=')) {
      const val = arg.slice(8).trim();
      if (!val || !/^\d+$/.test(val)) {
        throw new Error('Error: Invalid --since value. It must be a positive integer timestamp in milliseconds.');
      }
      since = parseInt(val, 10);
      if (since <= 0) {
        throw new Error('Error: Invalid --since value. It must be a positive integer timestamp in milliseconds.');
      }
    } else if (!arg.startsWith('-') && !phone) {
      phone = arg;
    }
  }

  if (!phone) {
    throw new Error('Error: Phone number is required. Usage: npm run get-otp -- +15550001111 [--since <timestamp_ms>]');
  }

  const validPhone = validatePhone(phone);

  // If since is not provided, calculate once: Date.now() - 30000
  if (since === null) {
    since = Date.now() - 30000;
  }

  return { phone: validPhone, since };
}

/**
 * Builds the URL for the simulator endpoint.
 * URL-encodes the phone number (e.g. '+' -> '%2B').
 *
 * @param {string} baseUrl
 * @param {string} phone
 * @param {number} since
 * @returns {string}
 */
export function buildSimUrl(baseUrl, phone, since) {
  const cleanBase = baseUrl.replace(/\/+$/, '');
  const encodedPhone = encodeURIComponent(phone);
  return `${cleanBase}/last-otp?phone=${encodedPhone}&since=${since}`;
}

/**
 * Polls the simulator for the latest OTP.
 *
 * @param {object} options
 * @param {string} options.phone
 * @param {number} options.since
 * @param {string} options.token
 * @param {string} [options.baseUrl=SIMULATOR_BASE_URL]
 * @param {number} [options.timeoutMs=30000]
 * @param {number} [options.intervalMs=1000]
 * @param {Function} [options.fetchFn=globalThis.fetch]
 * @param {Function} [options.sleepFn]
 * @param {Function} [options.logFn=console.log]
 * @returns {Promise<string>} 6-digit OTP code
 */
export async function pollOtp({
  phone,
  since,
  token,
  baseUrl = SIMULATOR_BASE_URL,
  timeoutMs = 30000,
  intervalMs = 1000,
  fetchFn = globalThis.fetch,
  sleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  logFn = console.log
}) {
  const url = buildSimUrl(baseUrl, phone, since);
  const startTime = Date.now();

  logFn(`Polling OTP Simulator for ${phone} (since: ${since})...`);

  while (Date.now() - startTime < timeoutMs) {
    let response;
    try {
      response = await fetchFn(url, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
    } catch (networkErr) {
      logFn(`Network error connecting to simulator: ${networkErr.message}. Retrying...`);
      await sleepFn(intervalMs);
      continue;
    }

    if (response.status === 200) {
      let data;
      try {
        data = await response.json();
      } catch {
        throw new Error('Error: Failed to parse simulator response as JSON.');
      }

      const code = data?.code;
      if (!code || typeof code !== 'string' || !/^\d{6}$/.test(code.trim())) {
        throw new Error(`Error: Simulator returned invalid OTP format: "${code}"`);
      }

      const validCode = code.trim();
      logFn(`OTP Code: ${validCode}`);
      return validCode;
    }

    if (response.status === 401) {
      throw new Error('Error: OTP Simulator rejected the SIM_TOKEN.');
    }

    if (response.status === 400) {
      let errorMsg = 'Bad request';
      try {
        const body = await response.json();
        if (body?.error) errorMsg = body.error;
      } catch {}
      throw new Error(`Error: Simulator validation error (HTTP 400): ${errorMsg}`);
    }

    if (response.status === 404) {
      let errKey = 'no_code';
      try {
        const body = await response.json();
        if (body?.error) errKey = body.error;
      } catch {}

      if (errKey === 'no_code' || errKey === 'no_fresh_code') {
        await sleepFn(intervalMs);
        continue;
      } else {
        logFn(`Simulator returned 404 (${errKey}). Retrying...`);
        await sleepFn(intervalMs);
        continue;
      }
    }

    if (response.status === 429) {
      const retryAfterHeader = response.headers?.get?.('retry-after') || response.headers?.['retry-after'];
      let waitSeconds = 2;
      if (retryAfterHeader) {
        const parsed = parseInt(retryAfterHeader, 10);
        if (!isNaN(parsed) && parsed > 0) {
          waitSeconds = parsed;
        }
      }
      logFn(`Rate limited (HTTP 429). Waiting ${waitSeconds}s per Retry-After header...`);
      await sleepFn(waitSeconds * 1000);
      continue;
    }

    // Unexpected status
    let errBody = '';
    try {
      errBody = await response.text();
    } catch {}
    logFn(`Unexpected response from simulator (HTTP ${response.status}): ${errBody}. Retrying...`);
    await sleepFn(intervalMs);
  }

  throw new Error('Error: Timed out waiting for a fresh OTP.');
}

// CLI entrypoint
const isMain = process.argv[1] && (import.meta.url === `file://${process.argv[1]}` || process.argv[1].replace(/\\/g, '/').endsWith('scripts/get-otp.js'));
if (isMain) {
  (async () => {
    try {
      const token = resolveSimToken();
      const { phone, since } = parseArgs();
      await pollOtp({ phone, since, token });
      process.exit(0);
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  })();
}
