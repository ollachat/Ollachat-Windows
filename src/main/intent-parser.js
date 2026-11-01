/**
 * Intent Parser for OllaChat Windows
 * Handles command-line arguments and custom protocol (ollachat://) URLs.
 *
 * Supported Actions:
 * - open_chat: ollachat://chat?roomId=<id> OR --action=open_chat --roomId=<id>
 * - incoming_call: ollachat://call?roomId=<id>&callId=<id>&type=voice|video
 *                  OR --action=incoming_call --roomId=<id> --callId=<id> --initiator=<name> --callType=voice|video
 */

const FORBIDDEN_TOKEN_PREFIXES = ['du_', 'rt_', 'ak_'];
const SAFE_ID_REGEX = /^[a-zA-Z0-9_-]{1,128}$/;

/**
 * Sanitizes and validates a string parameter.
 * Rejects control characters, path traversals, and potential credential patterns.
 *
 * @param {string|null|undefined} value
 * @param {RegExp} [pattern]
 * @returns {string|null}
 */
export function sanitizeParam(value, pattern = null) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  // Security check: Never allow session/room/API tokens in launch arguments
  for (const prefix of FORBIDDEN_TOKEN_PREFIXES) {
    if (trimmed.startsWith(prefix) || trimmed.includes(`bearer.${prefix}`)) {
      console.warn(`[IntentParser] Security rejection: forbidden credential prefix detected "${prefix}"`);
      return null;
    }
  }

  // Reject path traversal / injection attempts
  if (trimmed.includes('..') || trimmed.includes('<') || trimmed.includes('>') || trimmed.includes('"')) {
    return null;
  }

  if (pattern && !pattern.test(trimmed)) {
    return null;
  }

  return trimmed;
}

/**
 * Parses a custom URI protocol string (ollachat://...).
 *
 * @param {string} urlStr
 * @returns {object|null} Parsed intent or null if invalid
 */
export function parseProtocolUrl(urlStr) {
  if (typeof urlStr !== 'string') return null;
  const trimmed = urlStr.trim();
  if (!trimmed.toLowerCase().startsWith('ollachat://')) return null;

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'ollachat:') return null;

    const host = parsed.hostname.toLowerCase();
    const searchParams = parsed.searchParams;

    if (host === 'chat') {
      const roomId = sanitizeParam(searchParams.get('roomId') || searchParams.get('room_id'), SAFE_ID_REGEX);
      if (!roomId) return null;
      return {
        action: 'open_chat',
        roomId
      };
    }

    if (host === 'call') {
      const roomId = sanitizeParam(searchParams.get('roomId') || searchParams.get('room_id'), SAFE_ID_REGEX);
      const callId = sanitizeParam(searchParams.get('callId') || searchParams.get('call_id'), SAFE_ID_REGEX);
      if (!roomId) return null;

      const rawType = (searchParams.get('type') || searchParams.get('callType') || searchParams.get('call_type') || 'voice').toLowerCase();
      if (rawType !== 'voice' && rawType !== 'video') {
        return null;
      }
      const isVideo = rawType === 'video';
      const rawInitiator = searchParams.get('initiator') || searchParams.get('caller') || '';
      const initiator = sanitizeParam(rawInitiator) || 'Caller';

      return {
        action: 'incoming_call',
        roomId,
        callId: callId || `call-${Date.now()}`,
        initiator,
        isVideo,
        callType: isVideo ? 'video' : 'voice'
      };
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Parses command-line arguments array into a structured intent.
 *
 * @param {string[]} args e.g. process.argv
 * @returns {object|null} Parsed intent or null
 */
export function parseLaunchArgs(args) {
  if (!Array.isArray(args) || args.length === 0) return null;

  // 1. Check for protocol URL in any argument
  for (const arg of args) {
    if (typeof arg === 'string' && arg.trim().toLowerCase().startsWith('ollachat://')) {
      const parsedUrl = parseProtocolUrl(arg);
      if (parsedUrl) return parsedUrl;
    }
  }

  // 2. Parse CLI key-value pairs (e.g. --action=open_chat --roomId=...)
  const params = new Map();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (typeof arg !== 'string') continue;

    if (arg.startsWith('--')) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx !== -1) {
        const key = arg.slice(2, eqIdx).trim();
        const val = arg.slice(eqIdx + 1).trim();
        params.set(key, val);
      } else if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
        const key = arg.slice(2).trim();
        const val = args[i + 1].trim();
        params.set(key, val);
        i++;
      }
    }
  }

  const action = params.get('action');
  if (!action) return null;

  if (action === 'open_chat' || action === 'openChat') {
    const roomId = sanitizeParam(params.get('roomId') || params.get('room_id'), SAFE_ID_REGEX);
    if (!roomId) return null;
    return {
      action: 'open_chat',
      roomId
    };
  }

  if (action === 'incoming_call' || action === 'incomingCall') {
    const roomId = sanitizeParam(params.get('roomId') || params.get('room_id'), SAFE_ID_REGEX);
    const callId = sanitizeParam(params.get('callId') || params.get('call_id'), SAFE_ID_REGEX);
    if (!roomId) return null;

    const rawType = (params.get('callType') || params.get('call_type') || params.get('type') || 'voice').toLowerCase();
    if (rawType !== 'voice' && rawType !== 'video') {
      return null;
    }
    const isVideo = rawType === 'video';
    const initiator = sanitizeParam(params.get('initiator') || params.get('caller')) || 'Caller';

    return {
      action: 'incoming_call',
      roomId,
      callId: callId || `call-${Date.now()}`,
      initiator,
      isVideo,
      callType: isVideo ? 'video' : 'voice'
    };
  }

  return null;
}
