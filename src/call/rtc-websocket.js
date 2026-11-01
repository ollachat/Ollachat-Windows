import { WebSocket as UndiciWebSocket } from 'undici';

const ResolvedWebSocket = typeof globalThis.WebSocket !== 'undefined' ? globalThis.WebSocket : UndiciWebSocket;

export const RTC_CONNECTION_STATE = Object.freeze({
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  ERROR: 'error'
});

export const DEFAULT_RTC_WS_URL = 'wss://api.ollacore.com/v1/rtc/ws';

/**
 * Redacts sensitive tokens and credentials from strings/errors for safe logging.
 *
 * @param {string} text
 * @returns {string}
 */
export function redactSensitive(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/bearer\.[A-Za-z0-9_\-.]+/gi, 'bearer.[REDACTED]')
    .replace(/rt_[A-Za-z0-9_\-.]+/gi, 'rt_[REDACTED]')
    .replace(/du_[A-Za-z0-9_\-.]+/gi, 'du_[REDACTED]')
    .replace(/ak_[A-Za-z0-9_\-.]+/gi, 'ak_[REDACTED]');
}

/**
 * Lightweight standalone event emitter for RTC signaling.
 */
export class RtcEventEmitter {
  constructor() {
    this._listeners = new Map();
  }

  on(event, listener) {
    if (typeof listener !== 'function') return () => {};
    if (!this._listeners.has(event)) {
      this._listeners.set(event, new Set());
    }
    this._listeners.get(event).add(listener);
    return () => this.off(event, listener);
  }

  off(event, listener) {
    const set = this._listeners.get(event);
    if (set) {
      set.delete(listener);
      if (set.size === 0) {
        this._listeners.delete(event);
      }
    }
  }

  emit(event, ...args) {
    const set = this._listeners.get(event);
    if (!set) return;
    for (const listener of Array.from(set)) {
      try {
        listener(...args);
      } catch (err) {
        console.error(`[RtcEventEmitter] Error in listener for event "${event}":`, redactSensitive(err?.message || 'Listener error'));
      }
    }
  }

  removeAllListeners() {
    this._listeners.clear();
  }
}

/**
 * OllaCore RTC WebSocket Client for Windows.
 * Faithfully mirrors Android's RtcWebSocket.kt and CallViewModel.kt RTC protocol.
 *
 * Outgoing frame formats:
 * - Offer:     { "cmd": "offer", "sdp": { "type": "offer", "sdp": "<sdp>" } }
 * - Answer:    { "cmd": "answer", "sdp": "<sdp>", "request_id": <int> }
 * - Candidate: { "cmd": "candidate", "candidate": { "candidate": "<c>", "sdpMid": "<m>", "sdpMLineIndex": <i> } }
 * - Leave:     { "cmd": "leave" }
 *
 * Incoming frame formats:
 * - ServerEvent: { "event": "<string>", "reason": "<optional_string>" }
 * - Answer:      { "type": "answer", "sdp": "<sdp>" }
 * - Offer:       { "type": "offer", "sdp": "<sdp>", "request_id": <int> }
 * - Candidate:   { "type": "candidate", "candidate": { ... } }
 */
export class RtcWebSocket extends RtcEventEmitter {
  /**
   * @param {object} [options]
   * @param {string|null} [options.roomId=null]
   * @param {string|null} [options.token=null]
   * @param {string} [options.url=DEFAULT_RTC_WS_URL]
   * @param {Function} [options.WebSocketClass=ResolvedWebSocket]
   */
  constructor({
    roomId = null,
    token = null,
    url = DEFAULT_RTC_WS_URL,
    WebSocketClass = ResolvedWebSocket
  } = {}) {
    super();
    this.roomId = roomId;
    this._token = token;
    this.url = url || DEFAULT_RTC_WS_URL;
    this.WebSocketClass = WebSocketClass;

    this.state = RTC_CONNECTION_STATE.DISCONNECTED;
    this._socket = null;
    this._generation = 0;
  }

  /**
   * Validate that the provided token is a valid room token and reject session tokens.
   *
   * @param {string} token
   * @throws {Error} if token is invalid or a du_ session token
   */
  static validateRoomToken(token) {
    if (!token || typeof token !== 'string' || !token.trim()) {
      throw new Error('Room token is required for RTC signaling');
    }
    const cleanToken = token.trim();
    if (cleanToken.startsWith('du_')) {
      throw new Error('Invalid RTC token: directory session token (du_...) cannot be used for RTC WebSocket. A room-scoped token (rt_...) is required.');
    }
    return cleanToken;
  }

  /**
   * Connect to RTC WebSocket server for a given room.
   *
   * @param {object} params
   * @param {string} params.roomId
   * @param {string} params.token - Room-scoped token (never session token)
   * @param {string} [params.url] - Optional rtc_websocket_url from room-token response
   * @returns {Promise<void>}
   */
  async connect({ roomId, token, url = null } = {}) {
    if (!roomId || typeof roomId !== 'string' || !roomId.trim()) {
      throw new Error('roomId is required for RTC signaling connection');
    }
    const targetRoomId = roomId.trim();
    const validatedToken = RtcWebSocket.validateRoomToken(token || this._token);
    const targetUrl = (url || this.url || DEFAULT_RTC_WS_URL).trim();

    // If already connected or connecting, disconnect previous socket first
    if (this._socket) {
      this.disconnect();
    }

    this.roomId = targetRoomId;
    this._token = validatedToken;
    this.url = targetUrl;
    this._generation++;
    const currentGen = this._generation;

    this._setState(RTC_CONNECTION_STATE.CONNECTING);

    return new Promise((resolve, reject) => {
      let settled = false;
      const subprotocols = ['chatbox', `bearer.${validatedToken}`];

      try {
        const ws = new this.WebSocketClass(targetUrl, subprotocols);
        this._socket = ws;

        ws.onopen = () => {
          if (this._generation !== currentGen || this._socket !== ws) return;
          this._setState(RTC_CONNECTION_STATE.CONNECTED);
          this.emit('connected', { roomId: this.roomId });
          this.emit('event', { type: 'connected', roomId: this.roomId });
          if (!settled) {
            settled = true;
            resolve();
          }
        };

        ws.onmessage = (event) => {
          if (this._generation !== currentGen || this._socket !== ws) return;
          this._handleMessage(event.data);
        };

        ws.onclose = (event) => {
          if (this._generation !== currentGen || this._socket !== ws) return;
          const code = event?.code ?? 1000;
          const reason = event?.reason ?? '';
          this._socket = null;
          this._setState(RTC_CONNECTION_STATE.DISCONNECTED);
          this.emit('disconnected', { code, reason, roomId: this.roomId });
          if (code !== 1000 && reason !== 'Client disconnect' && reason !== 'Normal closure') {
            this.emit('event', { type: 'disconnected', code, reason, roomId: this.roomId });
          }
          if (!settled) {
            settled = true;
            resolve();
          }
        };

        ws.onerror = (error) => {
          if (this._generation !== currentGen || this._socket !== ws) return;
          const rawMessage = error?.message || 'WebSocket connection error';
          const safeMessage = redactSensitive(rawMessage);
          this._setState(RTC_CONNECTION_STATE.ERROR);
          this.emit('error', { error: safeMessage, roomId: this.roomId });
          this.emit('event', { type: 'error', error: safeMessage, roomId: this.roomId });
          if (!settled) {
            settled = true;
            reject(new Error(safeMessage));
          }
        };
      } catch (err) {
        const safeMessage = redactSensitive(err?.message || 'Failed to instantiate WebSocket');
        this._setState(RTC_CONNECTION_STATE.ERROR);
        this.emit('error', { error: safeMessage, roomId: this.roomId });
        this.emit('event', { type: 'error', error: safeMessage, roomId: this.roomId });
        reject(new Error(safeMessage));
      }
    });
  }

  /**
   * Internal message dispatcher parsing frames matching Android's RtcWebSocket.kt.
   *
   * @param {string|Buffer} rawData
   */
  _handleMessage(rawData) {
    let text = rawData;
    if (typeof text !== 'string') {
      try {
        text = text.toString('utf8');
      } catch {
        this.emit('error', { error: 'Failed to decode frame as utf8', roomId: this.roomId });
        return;
      }
    }

    let frame;
    try {
      frame = JSON.parse(text);
    } catch {
      this.emit('error', { error: 'Failed to parse frame JSON', roomId: this.roomId });
      return;
    }

    if (!frame || typeof frame !== 'object') {
      return;
    }

    const currentRoomId = this.roomId;

    // 1. Remote termination or server error event
    const eventName = frame.event || frame.type || frame.cmd || frame.action;
    const isEnded = eventName === 'ended' || eventName === 'call_ended' || eventName === 'leave' || eventName === 'peer_left' || eventName === 'participant_left' || eventName === 'call.ended' || eventName === 'hangup';
    const isError = eventName === 'error' || eventName === 'server_error';

    if (isEnded) {
      const reason = typeof frame.reason === 'string' ? frame.reason : null;
      this._setState(RTC_CONNECTION_STATE.DISCONNECTED);
      this.emit('call_ended', { event: eventName, reason, roomId: currentRoomId });
      this.emit('event', { type: 'call_ended', event: eventName, reason, roomId: currentRoomId });
      return;
    }

    if (isError) {
      this._setState(RTC_CONNECTION_STATE.ERROR);
      const errMessage = redactSensitive(frame.reason || frame.error || frame.message || 'Server error');
      this.emit('error', { error: errMessage, roomId: currentRoomId });
      this.emit('event', { type: 'error', error: errMessage, roomId: currentRoomId });
      return;
    }

    if (Object.prototype.hasOwnProperty.call(frame, 'event')) {
      const reason = typeof frame.reason === 'string' ? frame.reason : null;
      this.emit('server_event', { event: frame.event, reason, roomId: currentRoomId });
      this.emit('event', { type: 'server_event', event: frame.event, reason, roomId: currentRoomId });
      return;
    }

    // 2. Incoming Answer: { type: "answer", sdp: string }
    if (frame.type === 'answer') {
      const sdp = typeof frame.sdp === 'string' ? frame.sdp : '';
      this.emit('answer', { sdp, roomId: currentRoomId });
      this.emit('event', { type: 'answer', sdp, roomId: currentRoomId });
      return;
    }

    // 3. Incoming Offer: { type: "offer", sdp: string, request_id?: number, call_type?: string, is_video?: boolean }
    if (frame.type === 'offer' || frame.cmd === 'offer') {
      const sdp = typeof frame.sdp === 'string' ? frame.sdp : (frame.sdp?.sdp || '');
      const requestId = typeof frame.request_id === 'number'
        ? frame.request_id
        : (parseInt(frame.request_id, 10) || 0);
      const callType = frame.call_type || frame.callType || null;
      const isVideo = typeof frame.is_video === 'boolean'
        ? frame.is_video
        : (typeof frame.isVideo === 'boolean' ? frame.isVideo : (callType === 'video' ? true : null));
      this.emit('offer', { sdp, requestId, callType, isVideo, roomId: currentRoomId });
      this.emit('event', { type: 'offer', sdp, requestId, callType, isVideo, roomId: currentRoomId });
      return;
    }

    // 4. Incoming Candidate: { type: "candidate", candidate: object }
    if (frame.type === 'candidate' || frame.cmd === 'candidate' || frame.candidate) {
      const candidate = frame.candidate || frame;
      this.emit('candidate', { candidate, roomId: currentRoomId });
      this.emit('event', { type: 'candidate', candidate, roomId: currentRoomId });
    }
  }

  /**
   * Send WebRTC Offer frame with call type metadata.
   * Frame shape: { "cmd": "offer", "sdp": { "type": "offer", "sdp": sdp }, "call_type": string, "is_video": boolean }
   *
   * @param {string} sdp
   * @param {object} [options]
   * @param {boolean} [options.isVideo=false]
   * @param {string} [options.callType="voice"]
   */
  sendOffer(sdp, { isVideo = false, callType = null } = {}) {
    if (typeof sdp !== 'string') {
      throw new Error('SDP must be a string');
    }
    const resolvedCallType = callType || (isVideo ? 'video' : 'voice');
    const resolvedIsVideo = Boolean(isVideo || resolvedCallType === 'video');
    const frame = {
      cmd: 'offer',
      sdp: {
        type: 'offer',
        sdp
      },
      call_type: resolvedCallType,
      is_video: resolvedIsVideo
    };
    this._sendJson(frame);
  }

  /**
   * Send WebRTC Answer frame.
   * Frame shape: { "cmd": "answer", "sdp": sdp, "request_id": requestId }
   *
   * @param {string} sdp
   * @param {number} requestId
   */
  sendAnswer(sdp, requestId = 0) {
    const sdpObj = typeof sdp === 'object' && sdp !== null ? sdp : {
      type: 'answer',
      sdp: String(sdp)
    };
    const frame = {
      cmd: 'answer',
      sdp: sdpObj,
      request_id: typeof requestId === 'number' ? requestId : (parseInt(requestId, 10) || 0)
    };
    this._sendJson(frame);
  }

  /**
   * Alias for sendLeave matching VoiceCallManager convention.
   */
  leave() {
    this.sendLeave();
  }

  /**
   * Send ICE Candidate frame.
   * Frame shape: { "cmd": "candidate", "candidate": { "candidate": c, "sdpMid": mid, "sdpMLineIndex": idx } }
   *
   * @param {string} candidate
   * @param {string} [sdpMid=""]
   * @param {number} [sdpMLineIndex=0]
   */
  sendCandidate(candidate, sdpMid = '', sdpMLineIndex = 0) {
    if (typeof candidate !== 'string') {
      throw new Error('candidate must be a string');
    }
    const frame = {
      cmd: 'candidate',
      candidate: {
        candidate,
        sdpMid: typeof sdpMid === 'string' ? sdpMid : '',
        sdpMLineIndex: typeof sdpMLineIndex === 'number' ? sdpMLineIndex : (parseInt(sdpMLineIndex, 10) || 0)
      }
    };
    this._sendJson(frame);
  }

  /**
   * Send Leave frame.
   * Frame shape: { "cmd": "leave" }
   */
  sendLeave() {
    const frame = {
      cmd: 'leave'
    };
    this._sendJson(frame);
  }

  /**
   * Disconnect client from RTC signaling.
   * Sends WebSocket close frame with code 1000 ("Client disconnect").
   */
  disconnect() {
    this._generation++;
    if (this._socket) {
      try {
        // Ready states: CONNECTING = 0, OPEN = 1
        if (this._socket.readyState === 0 || this._socket.readyState === 1) {
          this._socket.close(1000, 'Client disconnect');
        }
      } catch {
        // Ignore close error on teardown
      }
      this._socket = null;
    }
    this._setState(RTC_CONNECTION_STATE.DISCONNECTED);
    this.emit('disconnected', { code: 1000, reason: 'Client disconnect', roomId: this.roomId });
  }

  /**
   * Safely serializes and transmits a JSON frame to the WebSocket.
   *
   * @private
   * @param {object} frame
   */
  _sendJson(frame) {
    if (!this._socket || this.state !== RTC_CONNECTION_STATE.CONNECTED || (typeof this._socket.readyState === 'number' && this._socket.readyState !== 1)) {
      throw new Error(`Cannot send RTC frame: socket is not connected (current state: ${this.state})`);
    }
    const jsonStr = JSON.stringify(frame);
    this._socket.send(jsonStr);
  }

  /**
   * Updates state and emits 'state_change' event.
   *
   * @private
   * @param {string} newState
   */
  _setState(newState) {
    if (this.state === newState) return;
    this.state = newState;
    this.emit('state_change', { state: newState, roomId: this.roomId });
  }
}
