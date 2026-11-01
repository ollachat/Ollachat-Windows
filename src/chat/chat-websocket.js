import crypto from 'node:crypto';
import { WebSocket as UndiciWebSocket } from 'undici';

const ResolvedWebSocket = typeof globalThis.WebSocket !== 'undefined' ? globalThis.WebSocket : UndiciWebSocket;

export const CONNECTION_STATE = Object.freeze({
  DISCONNECTED: 'disconnected',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  RECONNECTING: 'reconnecting',
  ERROR: 'error'
});

export const DEFAULT_WS_URL = 'wss://api.ollacore.com/v1/chat/ws';
export const HEARTBEAT_INTERVAL_MS = 30000;
export const HEARTBEAT_TIMEOUT_MS = 10000;
export const CONNECT_TIMEOUT_MS = 15000;
export const MAX_RECONNECT_ATTEMPTS = 5;
export const INITIAL_RECONNECT_DELAY_MS = 1000;
export const MAX_RECONNECT_DELAY_MS = 30000;

/**
 * Classifies WebSocket close codes into structured diagnostic metadata.
 * Non-standard or undocumented codes (e.g. 4411, 4412) are classified as transient/recoverable
 * rather than fatal errors to ensure connection resiliency.
 *
 * @param {number|string} code
 * @returns {{ category: string, isTerminal: boolean, requiresTokenRefresh: boolean, description: string }}
 */
export function classifyCloseCode(code) {
  const numericCode = Number(code) || 1000;
  if (numericCode === 1000) {
    return { category: 'normal', isTerminal: true, requiresTokenRefresh: false, description: 'Normal closure' };
  }
  if (numericCode === 1001) {
    return { category: 'going_away', isTerminal: false, requiresTokenRefresh: false, description: 'Going away / server restart' };
  }
  if (numericCode === 1006) {
    return { category: 'abnormal', isTerminal: false, requiresTokenRefresh: false, description: 'Abnormal closure (no close frame)' };
  }
  if (numericCode === 1008 || numericCode === 4001 || numericCode === 4003) {
    return { category: 'auth_policy', isTerminal: false, requiresTokenRefresh: true, description: 'Authentication or policy violation' };
  }
  if (numericCode === 4411 || numericCode === 4412) {
    return { category: 'undocumented_transient', isTerminal: false, requiresTokenRefresh: true, description: `Undocumented server close code ${numericCode} (transient, recoverable)` };
  }
  if (numericCode >= 4000 && numericCode <= 4999) {
    return { category: 'custom_application', isTerminal: false, requiresTokenRefresh: true, description: `Custom application close code ${numericCode}` };
  }
  if (numericCode >= 1002 && numericCode <= 1015) {
    return { category: 'protocol_transient', isTerminal: false, requiresTokenRefresh: false, description: `Standard protocol close code ${numericCode}` };
  }
  return { category: 'unknown', isTerminal: false, requiresTokenRefresh: false, description: `Unknown close code ${numericCode}` };
}

/**
 * Safely encodes a protocol frame matching the Android ChatWebSocket contract:
 * { v: 1, request_id: string, type: string, room_id?: string, payload: object }
 *
 * @param {object} params
 * @param {number} [params.v=1]
 * @param {string} [params.request_id]
 * @param {string} params.type
 * @param {string|null} [params.room_id=null]
 * @param {object} [params.payload={}]
 * @returns {string} Serialized JSON
 */
export function encodeFrame({ v = 1, request_id, type, room_id = null, payload = {} }) {
  if (!type || typeof type !== 'string') {
    throw new Error('Frame type must be a non-empty string');
  }

  const frame = {
    v: typeof v === 'number' ? v : 1,
    request_id: request_id || crypto.randomUUID(),
    type,
    payload: payload && typeof payload === 'object' ? payload : {}
  };

  if (room_id) {
    frame.room_id = room_id;
  }

  return JSON.stringify(frame);
}

/**
 * Safely checks whether a WebSocket instance is in the OPEN readyState (1).
 * Supports standard WebSocket, Undici WebSocket, ws library, and mock test objects.
 *
 * @param {object|null} socket
 * @returns {boolean}
 */
export function isSocketOpen(socket) {
  if (!socket) return false;
  if (typeof socket.readyState === 'number') {
    return socket.readyState === 1; // 1 = OPEN
  }
  return true;
}

/**
 * Safely decodes a received string into a frame object.
 *
 * @param {string} raw
 * @returns {object}
 */
export function decodeFrame(raw) {
  if (typeof raw !== 'string') {
    throw new Error('Raw frame data must be a string');
  }
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Parsed frame must be an object');
  }
  return parsed;
}

/**
 * Minimal dependency-free EventEmitter for internal ChatWebSocket event dispatch.
 */
export class SimpleEventEmitter {
  constructor() {
    this._listeners = new Map();
  }

  on(event, handler) {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, new Set());
    }
    this._listeners.get(event).add(handler);
    return () => this.off(event, handler);
  }

  off(event, handler) {
    const handlers = this._listeners.get(event);
    if (handlers) {
      handlers.delete(handler);
      if (handlers.size === 0) {
        this._listeners.delete(event);
      }
    }
  }

  emit(event, ...args) {
    const handlers = this._listeners.get(event);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(...args);
        } catch (err) {
          // Prevent listener errors from breaking event pump
        }
      }
    }
  }

  removeAllListeners() {
    this._listeners.clear();
  }
}

/**
 * Real-Time Chat WebSocket Client.
 *
 * Adheres strictly to the Android reference implementation (ChatWebSocket.kt):
 * - Subprotocol authentication: `chatbox, bearer.{sessionToken}`
 * - Frames: { v, request_id, type, room_id, payload }
 * - Bounded exponential backoff on unexpected close
 * - Automatic heartbeat ping/pong maintenance
 * - Sequence tracking and catchup
 */
export class ChatWebSocket extends SimpleEventEmitter {
  /**
   * @param {object} options
   * @param {string} [options.url=DEFAULT_WS_URL]
   * @param {string|Function} options.token Auth token string or async/sync getter function
   * @param {Function} [options.WebSocketClass=ResolvedWebSocket] Injectable WebSocket constructor for tests
   * @param {number} [options.heartbeatIntervalMs=HEARTBEAT_INTERVAL_MS]
   * @param {number} [options.heartbeatTimeoutMs=HEARTBEAT_TIMEOUT_MS]
   * @param {number} [options.connectTimeoutMs=CONNECT_TIMEOUT_MS]
   * @param {number} [options.maxReconnectAttempts=MAX_RECONNECT_ATTEMPTS]
   */
  constructor({
    url = DEFAULT_WS_URL,
    roomId = null,
    token = null,
    getToken = null,
    WebSocketClass = ResolvedWebSocket,
    heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS,
    heartbeatTimeoutMs = HEARTBEAT_TIMEOUT_MS,
    connectTimeoutMs = CONNECT_TIMEOUT_MS,
    maxReconnectAttempts = MAX_RECONNECT_ATTEMPTS,
    overlapOnReconnect = false,
    multiRoom = false
  } = {}) {
    super();

    this.url = url;
    this.roomId = roomId;
    this._token = token;
    this._initialToken = token;
    this._getToken = getToken;
    this.WebSocketClass = WebSocketClass;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.heartbeatTimeoutMs = heartbeatTimeoutMs;
    this.connectTimeoutMs = connectTimeoutMs;
    this.maxReconnectAttempts = maxReconnectAttempts;
    this.overlapOnReconnect = overlapOnReconnect;
    this.multiRoom = multiRoom;

    this.state = CONNECTION_STATE.DISCONNECTED;
    this.roomCursors = new Map(); // roomId -> number (per-room sequence cursor)
    this._roomSockets = new Map(); // roomId -> roomEntry in multiRoom mode
    this._highestSeq = 0;
    this.reconnectAttempts = 0;
    this._socket = null;
    this._heartbeatTimer = null;
    this._pongTimer = null;
    this._connectTimer = null;
    this._reconnectTimer = null;
    this._isManualClose = false;
    this._awaitingPong = false;
    this.lastPongAt = 0;

    this._connectionCounter = 0;
    this._connectionId = 0;
    this._connectEpoch = 0;
    this._lastPingRequestId = null;
    this._lastPingSentAt = 0;
    this._pendingQueue = []; // Durable FIFO message queue for single-room / global frames
    this._requestIdToClientMessageId = new Map(); // requestId -> client_message_id
  }

  /**
   * Tracks highest sequence across all rooms or set manually.
   */
  get highestSeq() {
    let max = this._highestSeq || 0;
    for (const seq of this.roomCursors.values()) {
      if (typeof seq === 'number' && seq > max) max = seq;
    }
    return max;
  }

  set highestSeq(val) {
    this._highestSeq = typeof val === 'number' ? val : 0;
  }

  /**
   * Retrieves the sequence cursor for a room.
   * Returns undefined if uninitialized, or number if initialized.
   * @param {string} roomId
   * @returns {number|undefined}
   */
  getRoomCursor(roomId) {
    if (!roomId) return undefined;
    return this.roomCursors.get(roomId);
  }

  /**
   * Sets the sequence cursor for a room.
   * @param {string} roomId
   * @param {number} seq
   */
  setRoomCursor(roomId, seq) {
    if (!roomId) return;
    const numSeq = typeof seq === 'number' ? seq : parseInt(seq, 10) || 0;
    this.roomCursors.set(roomId, numSeq);
    if (numSeq > this._highestSeq) {
      this._highestSeq = numSeq;
    }
  }

  /**
   * Checks whether a room cursor has been initialized.
   * @param {string} roomId
   * @returns {boolean}
   */
  hasRoomCursor(roomId) {
    if (!roomId) return false;
    return this.roomCursors.has(roomId);
  }

  /**
   * Resolves the current session or room token.
   * When forceRefresh is true, requests a fresh token from _getToken.
   * @param {boolean} [forceRefresh=false]
   * @private
   */
  async _resolveToken(forceRefresh = false) {
    if (!forceRefresh && this._token) {
      return this._token;
    }
    if (typeof this._getToken === 'function') {
      const freshToken = await this._getToken(this.roomId);
      if (freshToken) {
        this._token = freshToken;
        return freshToken;
      }
    }
    if (this._token) {
      return this._token;
    }
    if (this._initialToken) {
      this._token = this._initialToken;
      return this._token;
    }
    return null;
  }

  /**
   * Updates the internal connection state and notifies listeners.
   * @param {string} newState
   * @param {object|null} [details=null]
   * @param {string|null} [roomId=undefined]
   * @private
   */
  _setState(newState, details = null, roomId = undefined) {
    const isRoomSpecific = Boolean(roomId);
    if (!isRoomSpecific && this.state === newState) return;
    if (!isRoomSpecific) {
      this.state = newState;
    }
    const effectiveRoomId = roomId !== undefined ? roomId : (this.multiRoom ? null : (this.roomId || null));
    this.emit('stateChange', { state: newState, details, roomId: effectiveRoomId });
  }

  /**
   * Helper to detach socket event handlers and cleanly close/terminate.
   * @param {object} socket
   * @private
   */
  _cleanupSocket(socket, code = 1000, reason = 'Client disconnect') {
    if (!socket) return;
    try {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      if (typeof socket.terminate === 'function') {
        socket.terminate();
      } else if (typeof socket.close === 'function') {
        socket.close(code, reason);
      }
    } catch {}
  }

  /**
   * Safe logger omitting tokens, headers, and private contents.
   * @param {string} message
   * @private
   */
  _logSafe(message) {
    const connStr = this._connectionId ? `#${this._connectionId}` : '';
    console.log(`[ChatWebSocket${connStr}] ${message}`);
  }

  /**
   * Connects an individual conversation channel in multiRoom mode or explicitly.
   * Maintains socket in this._roomSockets map without disconnecting other active channels.
   *
   * @param {string} roomId
   * @param {object} [options={}]
   * @param {string} [options.token]
   * @param {string} [options.url]
   * @param {boolean} [options.forceTokenRefresh=false]
   * @returns {Promise<object|null>}
   */
  async connectRoom(roomId, { token = null, url = null, forceTokenRefresh = false } = {}) {
    if (!roomId || typeof roomId !== 'string' || !roomId.trim()) {
      return null;
    }
    const cleanRoomId = roomId.trim();
    if (!this.roomId) {
      this.roomId = cleanRoomId;
    }

    const existing = this._roomSockets.get(cleanRoomId);
    if (existing && existing.socket && (existing.state === CONNECTION_STATE.CONNECTED || existing.state === CONNECTION_STATE.CONNECTING) && !forceTokenRefresh) {
      return existing;
    }

    let resolvedToken = token;
    if (!resolvedToken || forceTokenRefresh) {
      if (typeof this._getToken === 'function') {
        resolvedToken = await this._getToken(cleanRoomId);
      }
    }
    if (!resolvedToken && this._token) {
      resolvedToken = this._token;
    }

    if (!resolvedToken || typeof resolvedToken !== 'string' || !resolvedToken.trim()) {
      const errMsg = `No valid authentication token available for room ${cleanRoomId}`;
      this.emit('error', new Error(errMsg));
      if (existing && !existing.isManualClose && (existing.state === CONNECTION_STATE.RECONNECTING || existing.state === CONNECTION_STATE.CONNECTING)) {
        this._handleRoomUnexpectedClose(existing, 1006, errMsg);
      }
      return null;
    }

    const cleanToken = resolvedToken.trim();
    if (cleanToken.startsWith('du_')) {
      const errMsg = 'Cannot connect ChatWebSocket with Directory session token; room access token required';
      this.emit('error', new Error(errMsg));
      return null;
    }

    const wsUrl = url || this.url;

    const preservedQueue = (existing && Array.isArray(existing.pendingQueue)) ? existing.pendingQueue : [];
    if (existing) {
      this._cleanupRoomEntry(existing);
    }

    const roomEntry = {
      roomId: cleanRoomId,
      token: cleanToken,
      url: wsUrl,
      socket: null,
      state: CONNECTION_STATE.CONNECTING,
      reconnectAttempts: 0,
      reconnectTimer: null,
      heartbeatTimer: null,
      pongTimer: null,
      connectTimer: null,
      awaitingPong: false,
      lastPingRequestId: null,
      isManualClose: false,
      pendingQueue: preservedQueue
    };

    this._roomSockets.set(cleanRoomId, roomEntry);
    this._updateAggregateState();

    try {
      const protocols = ['chatbox', `bearer.${cleanToken}`];
      const socket = new this.WebSocketClass(wsUrl, protocols);
      roomEntry.socket = socket;

      if (this.connectTimeoutMs > 0) {
        roomEntry.connectTimer = setTimeout(() => {
          if (roomEntry.socket === socket && (roomEntry.state === CONNECTION_STATE.CONNECTING || roomEntry.state === CONNECTION_STATE.RECONNECTING)) {
            this._cleanupSocket(socket);
            this._handleRoomUnexpectedClose(roomEntry, 1006, 'Connection handshake timed out');
          }
        }, this.connectTimeoutMs);
      }

      socket.onopen = () => {
        if (roomEntry.socket !== socket) return;
        clearTimeout(roomEntry.connectTimer);
        roomEntry.connectTimer = null;
        clearTimeout(roomEntry.reconnectTimer);
        roomEntry.reconnectTimer = null;
        roomEntry.reconnectAttempts = 0;
        roomEntry.awaitingPong = false;
        roomEntry.state = CONNECTION_STATE.CONNECTED;

        this.emit('stateChange', { state: CONNECTION_STATE.CONNECTED, details: null, roomId: cleanRoomId });
        this._updateAggregateState();
        this.emit('connected', { roomId: cleanRoomId });

        // Flush any durable frames queued while connecting/reconnecting
        this._flushPendingQueue(cleanRoomId);

        // Room catchup if cursor exists
        const cursor = this.getRoomCursor(cleanRoomId);
        if (typeof cursor === 'number' && cursor > 0) {
          try {
            this.catchup(cursor, 200, cleanRoomId, this.overlapOnReconnect);
          } catch (err) {
            this._logSafe(`Catchup error on room ${cleanRoomId}: ${err?.message}`);
          }
        }

        this._startRoomHeartbeat(roomEntry);
      };

      socket.onmessage = (event) => {
        if (roomEntry.socket !== socket) return;
        try {
          const rawData = typeof event.data === 'string' ? event.data : event.data?.toString() || '';
          const frame = decodeFrame(rawData);
          if (!frame.room_id && !frame.roomId) {
            frame.room_id = cleanRoomId;
          }
          this._handleIncomingFrame(frame);
        } catch (err) {
          this.emit('error', { code: 'parse_error', message: err.message, roomId: cleanRoomId });
        }
      };

      socket.onerror = (err) => {
        if (roomEntry.socket !== socket) return;
        this.emit('error', { code: 'socket_error', message: err?.message || 'WebSocket error', roomId: cleanRoomId });
      };

      socket.onclose = (event) => {
        if (roomEntry.socket !== socket) return;
        clearTimeout(roomEntry.connectTimer);
        this._stopRoomHeartbeat(roomEntry);
        const code = event?.code || 1000;
        const reason = event?.reason || '';
        this._cleanupSocket(socket, code, reason);
        roomEntry.socket = null;

        if (roomEntry.isManualClose) {
          roomEntry.state = CONNECTION_STATE.DISCONNECTED;
          this.emit('stateChange', { state: CONNECTION_STATE.DISCONNECTED, details: { code, reason }, roomId: cleanRoomId });
          this._roomSockets.delete(cleanRoomId);
          this._updateAggregateState();
          this.emit('disconnected', { code, reason, roomId: cleanRoomId });
        } else {
          this._handleRoomUnexpectedClose(roomEntry, code, reason);
        }
      };
    } catch (err) {
      roomEntry.state = CONNECTION_STATE.ERROR;
      this.emit('stateChange', { state: CONNECTION_STATE.ERROR, details: { message: err.message }, roomId: cleanRoomId });
      this._updateAggregateState();
      this.emit('error', { code: 'instantiation_error', message: err.message, roomId: cleanRoomId });
    }

    return roomEntry;
  }

  _updateAggregateState() {
    if (!this.multiRoom) return;
    if (this._roomSockets.size === 0) {
      this._setState(CONNECTION_STATE.DISCONNECTED, null, null);
      return;
    }
    let anyConnected = false;
    let anyConnecting = false;
    let anyReconnecting = false;
    for (const entry of this._roomSockets.values()) {
      if (entry.state === CONNECTION_STATE.CONNECTED) anyConnected = true;
      else if (entry.state === CONNECTION_STATE.CONNECTING) anyConnecting = true;
      else if (entry.state === CONNECTION_STATE.RECONNECTING) anyReconnecting = true;
    }
    if (anyConnected) {
      this._setState(CONNECTION_STATE.CONNECTED, null, null);
    } else if (anyConnecting) {
      this._setState(CONNECTION_STATE.CONNECTING, null, null);
    } else if (anyReconnecting) {
      this._setState(CONNECTION_STATE.RECONNECTING, null, null);
    } else {
      this._setState(CONNECTION_STATE.DISCONNECTED, null, null);
    }
  }

  _startRoomHeartbeat(entry) {
    this._stopRoomHeartbeat(entry);
    entry.heartbeatTimer = setInterval(() => {
      if (!entry.socket || entry.state !== CONNECTION_STATE.CONNECTED || !this._isSocketOpen(entry.socket)) return;
      try {
        const pingId = crypto.randomUUID();
        entry.lastPingRequestId = pingId;
        entry.awaitingPong = true;
        const frame = encodeFrame({ v: 1, request_id: pingId, type: 'ping', room_id: entry.roomId });
        entry.socket.send(frame);

        entry.pongTimer = setTimeout(() => {
          if (entry.awaitingPong && entry.socket) {
            this._cleanupSocket(entry.socket);
            this._handleRoomUnexpectedClose(entry, 1006, 'Pong timeout');
          }
        }, this.heartbeatTimeoutMs);
      } catch {}
    }, this.heartbeatIntervalMs);
  }

  _stopRoomHeartbeat(entry) {
    if (entry.heartbeatTimer) {
      clearInterval(entry.heartbeatTimer);
      entry.heartbeatTimer = null;
    }
    if (entry.pongTimer) {
      clearTimeout(entry.pongTimer);
      entry.pongTimer = null;
    }
    entry.awaitingPong = false;
  }

  _handleRoomUnexpectedClose(entry, code, reason) {
    this._stopRoomHeartbeat(entry);
    const codeMeta = classifyCloseCode(code);
    this._logSafe(`Room ${entry.roomId} socket closed unexpectedly (code: ${code}, reason: ${reason || 'none'}, category: ${codeMeta.category})`);

    entry.state = CONNECTION_STATE.RECONNECTING;
    this.emit('stateChange', {
      state: CONNECTION_STATE.RECONNECTING,
      details: { code, reason, attempt: entry.reconnectAttempts + 1, codeMeta },
      roomId: entry.roomId
    });
    this._updateAggregateState();

    if (entry.reconnectAttempts >= this.maxReconnectAttempts) {
      entry.state = CONNECTION_STATE.ERROR;
      this.emit('stateChange', {
        state: CONNECTION_STATE.ERROR,
        details: { message: `Max reconnect attempts exceeded for room ${entry.roomId}`, code, reason },
        roomId: entry.roomId
      });
      this._updateAggregateState();
      this.emit('error', { code: 'max_reconnect_exceeded', message: `Max reconnect attempts exceeded for room ${entry.roomId}`, roomId: entry.roomId });
      return;
    }

    entry.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, entry.reconnectAttempts - 1), 30000);
    clearTimeout(entry.reconnectTimer);
    entry.reconnectTimer = setTimeout(async () => {
      if (entry.isManualClose) return;
      try {
        const res = await this.connectRoom(entry.roomId, {
          token: null,
          url: entry.url,
          forceTokenRefresh: true
        });
        if (!res || !res.socket) {
          this._handleRoomUnexpectedClose(entry, 1006, 'Reconnect attempt failed');
        }
      } catch (err) {
        this._handleRoomUnexpectedClose(entry, 1006, err?.message || 'Reconnect error');
      }
    }, delay);
  }

  _cleanupRoomEntry(entry) {
    this._stopRoomHeartbeat(entry);
    clearTimeout(entry.connectTimer);
    entry.connectTimer = null;
    clearTimeout(entry.reconnectTimer);
    entry.reconnectTimer = null;
    if (entry.socket) {
      const s = entry.socket;
      entry.socket = null;
      this._cleanupSocket(s, 1000, 'Room socket cleanup');
    }
  }

  /**
   * Retrieves the list of active room IDs in multi-room mode.
   * @returns {string[]}
   */
  getActiveRooms() {
    if (!this.multiRoom) return this.roomId ? [this.roomId] : [];
    return Array.from(this._roomSockets.keys());
  }

  /**
   * Retrieves connection state for a specific room.
   * @param {string} roomId
   * @returns {string}
   */
  getRoomState(roomId) {
    if (!this.multiRoom) return this.roomId === roomId ? this.state : CONNECTION_STATE.DISCONNECTED;
    return this._roomSockets.get(roomId)?.state || CONNECTION_STATE.DISCONNECTED;
  }

  /**
   * Connects to the chat WebSocket server.
   * Prevents duplicate active connections.
   *
   * @param {object} [options={}]
   * @param {string} [options.roomId]
   * @param {string} [options.token]
   * @param {string} [options.url]
   * @param {boolean} [options.forceTokenRefresh=false]
   */
  async connect({ roomId = null, token = null, url = null, forceTokenRefresh = false } = {}) {
    if (this.multiRoom) {
      if (roomId) {
        return this.connectRoom(roomId, { token, url, forceTokenRefresh });
      }
      if (this._roomSockets.size === 0) {
        this._setState(CONNECTION_STATE.CONNECTED);
      }
      return;
    }

    // If switching to a different room, disconnect active connection first
    if (roomId && this.roomId && this.roomId !== roomId) {
      this.disconnect();
    }

    if (roomId) this.roomId = roomId;
    if (token) {
      this._token = token;
      this._initialToken = token;
    }
    if (url) this.url = url;

    // Prevent duplicate connection attempts to the same room when already connecting or connected
    if ((this.state === CONNECTION_STATE.CONNECTED || this.state === CONNECTION_STATE.CONNECTING) && !forceTokenRefresh) {
      return;
    }

    // Cancel any pending reconnect or handshake timers from previous attempts
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
    clearTimeout(this._connectTimer);
    this._connectTimer = null;

    const epoch = ++this._connectEpoch;

    const resolvedToken = await this._resolveToken(forceTokenRefresh);
    if (epoch !== this._connectEpoch) {
      // Superseded by a newer connection request
      return;
    }

    if (!resolvedToken || typeof resolvedToken !== 'string' || !resolvedToken.trim()) {
      const errMsg = 'No valid authentication token available';
      this._setState(CONNECTION_STATE.ERROR, { message: errMsg });
      this.emit('error', new Error(errMsg));
      return;
    }

    const cleanToken = resolvedToken.trim();

    // Security invariant: du_ directory tokens are NOT valid on room-scoped Chat WebSocket
    if (cleanToken.startsWith('du_')) {
      const errMsg = 'Cannot connect ChatWebSocket with Directory session token; room access token required';
      this._setState(CONNECTION_STATE.ERROR, { message: errMsg });
      this.emit('error', new Error(errMsg));
      return;
    }

    this._isManualClose = false;
    this._setState(CONNECTION_STATE.CONNECTING);

    this._stopHeartbeat();
    if (this._socket) {
      const oldSocket = this._socket;
      this._socket = null;
      this._cleanupSocket(oldSocket);
    }

    try {
      this._connectionId = ++this._connectionCounter;
      this._logSafe(`Socket #${this._connectionId} creating for room ${this.roomId || 'global'}`);

      // Subprotocol authentication matching ChatWebSocket.kt:
      // Sec-WebSocket-Protocol: chatbox, bearer.{roomToken}
      const protocols = ['chatbox', `bearer.${cleanToken}`];
      const socket = new this.WebSocketClass(this.url, protocols);
      this._socket = socket;

      // Connection timeout: abort if handshake does not complete within connectTimeoutMs
      if (this.connectTimeoutMs > 0) {
        this._connectTimer = setTimeout(() => {
          if (this._socket === socket && (this.state === CONNECTION_STATE.CONNECTING || this.state === CONNECTION_STATE.RECONNECTING)) {
            this._logSafe(`Socket #${this._connectionId} connection handshake timed out`);
            this._cleanupSocket(socket);
            this.emit('error', { code: 'connection_timeout', message: 'Connection handshake timed out' });
            this._handleUnexpectedClose(1006, 'Connection handshake timed out');
          }
        }, this.connectTimeoutMs);
      }

      socket.onopen = () => {
        if (this._socket !== socket) return;
        clearTimeout(this._connectTimer);
        this._connectTimer = null;
        clearTimeout(this._reconnectTimer);
        this._reconnectTimer = null;

        this.reconnectAttempts = 0;
        this._awaitingPong = false;
        this._lastPingRequestId = null;
        this._setState(CONNECTION_STATE.CONNECTED);
        this.emit('connected');
        this._logSafe(`Socket #${this._connectionId} open and active`);

        // Flush any durable frames queued while connecting/reconnecting
        this._flushPendingQueue();

        // Catchup missing events if we previously established room cursors
        try {
          if (this.roomCursors.size > 0) {
            for (const [rId, cursor] of this.roomCursors.entries()) {
              if (typeof cursor === 'number' && cursor > 0) {
                this.catchup(cursor, 200, rId, this.overlapOnReconnect);
              }
            }
          } else if (this._highestSeq > 0) {
            this.catchup(this._highestSeq, 200, null, this.overlapOnReconnect);
          }
        } catch (err) {
          this._logSafe(`Catchup error on connect: ${err?.message}`);
        }

        this._startHeartbeat();
      };

      socket.onmessage = (event) => {
        if (this._socket !== socket) return;
        try {
          const rawData = typeof event.data === 'string' ? event.data : event.data?.toString() || '';
          const frame = decodeFrame(rawData);
          this._handleIncomingFrame(frame);
        } catch (err) {
          this.emit('error', { code: 'parse_error', message: err.message });
        }
      };

      socket.onerror = (err) => {
        if (this._socket !== socket) return;
        const errorMsg = err?.message || 'WebSocket error';
        this._logSafe(`Socket #${this._connectionId} error: ${errorMsg}`);
        this.emit('error', { code: 'socket_error', message: errorMsg });
      };

      socket.onclose = (event) => {
        if (this._socket !== socket) return;
        clearTimeout(this._connectTimer);
        this._connectTimer = null;
        this._stopHeartbeat();
        const code = event?.code || 1000;
        const reason = event?.reason || '';

        this._cleanupSocket(socket, code, reason);
        this._socket = null;
        this._logSafe(`Socket #${this._connectionId} closed (code: ${code}, reason: ${reason || 'none'})`);

        if (this._isManualClose) {
          this._setState(CONNECTION_STATE.DISCONNECTED, { code, reason });
          this.emit('disconnected', { code, reason });
        } else {
          this._handleUnexpectedClose(code, reason);
        }
      };
    } catch (err) {
      clearTimeout(this._connectTimer);
      this._connectTimer = null;
      this._setState(CONNECTION_STATE.ERROR, { message: err.message });
      this.emit('error', { code: 'connection_failed', message: err.message });
      this._handleUnexpectedClose(1006, err.message);
    }
  }

  /**
   * Handles incoming frame dispatch matching the Android WebSocketEvent categories.
   * @private
   */
  _handleIncomingFrame(frame) {
    const { type, payload = {}, room_id = null, request_id = null } = frame;
    const eventSeq = (typeof frame.event_seq === 'number' && frame.event_seq > 0)
      ? frame.event_seq
      : (typeof frame.event_id === 'number' && frame.event_id > 0)
        ? frame.event_id
        : (typeof payload.event_seq === 'number' && payload.event_seq > 0 ? payload.event_seq : 0);

    // Sequence tracking & duplicate discarding per room strictly applies to new message creation events
    const isSequenceTracked = type === 'message.created' && eventSeq > 0;
    const effectiveRoomId = room_id || frame.roomId || payload.room_id || payload.roomId;

    if (isSequenceTracked && effectiveRoomId) {
      if (!this.roomCursors.has(effectiveRoomId)) {
        // Uninitialized cursor: initialize to first event sequence without treating as gap
        this.setRoomCursor(effectiveRoomId, eventSeq);
      } else {
        const currentCursor = this.getRoomCursor(effectiveRoomId);
        if (eventSeq <= currentCursor) {
          // Duplicate event: safely discard
          this.emit('duplicate', { roomId: effectiveRoomId, eventSeq, currentCursor, frame });
          return;
        } else if (eventSeq > currentCursor + 1) {
          // Sequence gap: emit gap and resync signals
          const expectedSeq = currentCursor + 1;
          this.emit('gap', { roomId: effectiveRoomId, expectedSeq, receivedSeq: eventSeq });
          this.emit('resync', { roomId: effectiveRoomId, expectedSeq, receivedSeq: eventSeq });
          this.setRoomCursor(effectiveRoomId, eventSeq);
        } else {
          // In-order event: advance cursor
          this.setRoomCursor(effectiveRoomId, eventSeq);
        }
      }
    } else if (isSequenceTracked && eventSeq > this._highestSeq) {
      this._highestSeq = eventSeq;
    }

    const mappedCid = request_id ? this._requestIdToClientMessageId?.get(request_id) : null;
    if (mappedCid) {
      if (!frame.client_message_id && !frame.clientMessageId) {
        frame.client_message_id = mappedCid;
      }
      if (payload && typeof payload === 'object' && !payload.client_message_id && !payload.clientMessageId) {
        payload.client_message_id = mappedCid;
      }
    }

    // Always emit the generic frame for non-duplicate events
    this.emit('frame', frame);

    if (type === 'ack' || type === 'message.created' || type === 'error' || type === 'pong') {
      console.log('[CHECKPOINT 13] Incoming frame received from server:', { type, requestId: request_id, roomId: room_id });
    }

    switch (type) {
      case 'ack': {
        let isPongAck = (payload?.type === 'pong') || Boolean(this._lastPingRequestId && request_id === this._lastPingRequestId);
        if (!isPongAck && this.multiRoom && request_id) {
          for (const entry of this._roomSockets.values()) {
            if (entry.lastPingRequestId === request_id) {
              isPongAck = true;
              break;
            }
          }
        }
        if (isPongAck) {
          this._handlePongReceived(request_id, room_id);
        }
        this.emit('ack', { requestId: request_id || '' });
        break;
      }

      case 'error': {
        const errorObj = frame.error || payload;
        this.emit('serverError', {
          code: errorObj.code || 'unknown',
          message: errorObj.message || 'Unknown server error',
          requestId: request_id || null
        });
        break;
      }

      case 'message.created':
        this.emit('message.created', this._normalizeMessage(payload, room_id || frame.roomId));
        break;

      case 'message.updated':
        this.emit('message.updated', this._normalizeMessage(payload, room_id || frame.roomId));
        break;

      case 'message.deleted':
        this.emit('message.deleted', {
          roomId: room_id || frame.roomId || '',
          messageId: payload.id || payload.message_id || frame.message_id || frame.id || ''
        });
        break;

      case 'presence.changed':
        this.emit('presence.changed', {
          roomId: room_id || frame.roomId || '',
          principalId: payload.principal_id || '',
          online: Boolean(payload.online)
        });
        break;

      case 'typing.started':
        this.emit('typing.started', {
          roomId: room_id || frame.roomId || '',
          principalId: payload.principal_id || ''
        });
        break;

      case 'typing.stopped':
        this.emit('typing.stopped', {
          roomId: room_id || frame.roomId || '',
          principalId: payload.principal_id || ''
        });
        break;

      case 'receipt.delivered':
        this.emit('receipt.delivered', {
          roomId: room_id || frame.roomId || payload.room_id || payload.roomId || '',
          principalId: payload.principal_id || payload.principalId || frame.principal_id || frame.principalId || '',
          messageId: payload.message_id || payload.messageId || payload.id || frame.message_id || frame.messageId || frame.id || ''
        });
        break;

      case 'receipt.read':
        this.emit('receipt.read', {
          roomId: room_id || frame.roomId || payload.room_id || payload.roomId || '',
          principalId: payload.principal_id || payload.principalId || frame.principal_id || frame.principalId || '',
          messageId: payload.message_id || payload.messageId || payload.id || frame.message_id || frame.messageId || frame.id || ''
        });
        break;

      case 'reaction.added':
        this.emit('reaction.added', {
          roomId: room_id || '',
          messageId: payload.message_id || '',
          principalId: payload.principal_id || '',
          emoji: payload.emoji || ''
        });
        break;

      case 'reaction.removed':
        this.emit('reaction.removed', {
          roomId: room_id || '',
          messageId: payload.message_id || '',
          principalId: payload.principal_id || '',
          emoji: payload.emoji || ''
        });
        break;

      case 'member.added':
        this.emit('member.added', {
          roomId: room_id || '',
          principalId: payload.principal_id || ''
        });
        break;

      case 'member.removed':
        this.emit('member.removed', {
          roomId: room_id || '',
          principalId: payload.principal_id || ''
        });
        break;

      case 'call.started': {
        const p = payload || {};
        const isVideo = Boolean(
          p.call_type === 'video' ||
          p.callType === 'video' ||
          p.is_video === true ||
          p.isVideo === true ||
          p.kind === 'video' ||
          frame?.call_type === 'video' ||
          frame?.callType === 'video' ||
          frame?.is_video === true ||
          frame?.isVideo === true ||
          frame?.kind === 'video'
        );
        const callType = isVideo ? 'video' : 'voice';
        this.emit('call.started', {
          roomId: room_id || '',
          callId: p.call_id || p.callId || frame?.call_id || frame?.callId || '',
          initiator: p.initiator || frame?.initiator || '',
          callType,
          isVideo
        });
        break;
      }

      case 'call.ended':
      case 'call.participant_left':
      case 'call.peer_left':
      case 'call.left':
        this.emit('call.ended', {
          roomId: room_id || '',
          callId: payload?.call_id || '',
          initiator: payload?.initiator || '',
          reason: payload?.reason || ''
        });
        break;

      case 'attachment.ready':
        this.emit('attachment.ready', {
          roomId: room_id || '',
          attachmentId: payload.attachment_id || '',
          mime: payload.mime || ''
        });
        break;

      case 'attachment.failed':
        this.emit('attachment.failed', {
          roomId: room_id || '',
          attachmentId: payload.attachment_id || ''
        });
        break;

      case 'resync':
        this.emit('resync', { roomId: room_id || '' });
        break;

      case 'pong':
        this._handlePongReceived(request_id, room_id);
        break;

      case 'ping':
        try {
          this.send('ack', { type: 'pong' }, room_id);
        } catch {}
        this.emit('ping', { requestId: request_id });
        break;

      default:
        // Forward unmapped event types transparently
        this.emit(type, { roomId: room_id, payload, requestId: request_id });
        break;
    }
  }

  /**
   * Normalizes WsMessage data to match Android's data model.
   * @private
   */
  _normalizeMessage(payload, roomId) {
    const rawBody = payload.body && typeof payload.body === 'object' ? payload.body : {};
    const rawAttIds = Array.isArray(payload.attachment_ids)
      ? payload.attachment_ids
      : (Array.isArray(payload.attachmentIds) ? payload.attachmentIds : []);
    const bodyAttIds = Array.isArray(rawBody.attachment_ids)
      ? rawBody.attachment_ids
      : (Array.isArray(rawBody.attachmentIds) ? rawBody.attachmentIds : []);
    const fromAttachments = Array.isArray(payload.attachments)
      ? payload.attachments.map(a => a?.id || a?.attachment_id || a?.attachmentId).filter(Boolean)
      : (Array.isArray(rawBody.attachments)
        ? rawBody.attachments.map(a => a?.id || a?.attachment_id || a?.attachmentId).filter(Boolean)
        : []);
    const scalarAttId = payload.attachment_id || payload.attachmentId || rawBody.attachment_id || rawBody.attachmentId;
    const combinedAttIds = rawAttIds.length > 0
      ? rawAttIds
      : (bodyAttIds.length > 0 ? bodyAttIds : (fromAttachments.length > 0 ? fromAttachments : (scalarAttId ? [String(scalarAttId)] : [])));

    const attachmentsList = Array.isArray(payload.attachments) && payload.attachments.length > 0
      ? payload.attachments
      : (Array.isArray(rawBody.attachments) ? rawBody.attachments : []);

    const isDeleted = Boolean(
      payload.is_deleted ||
      payload.isDeleted ||
      payload.kind === 'deleted' ||
      rawBody?.is_deleted ||
      rawBody?.isDeleted
    );

    const effectiveKind = isDeleted ? 'deleted' : (payload.kind || 'text');
    const effectiveBody = isDeleted ? { text: 'This message was deleted' } : (payload.body || {});
    const finalAttachments = isDeleted ? [] : attachmentsList;
    const finalAttIds = isDeleted ? [] : combinedAttIds;

    return {
      id: payload.id || '',
      roomId: roomId || payload.room_id || payload.roomId || '',
      room_id: roomId || payload.room_id || payload.roomId || '',
      senderId: payload.sender_id || payload.senderId || '',
      sender_id: payload.sender_id || payload.senderId || '',
      kind: effectiveKind,
      body: effectiveBody,
      createdAt: payload.created_at || payload.createdAt || '',
      created_at: payload.created_at || payload.createdAt || '',
      eventSeq: payload.event_seq ?? payload.eventSeq ?? 0,
      clientMessageId: payload.client_message_id || payload.clientMessageId || null,
      client_message_id: payload.client_message_id || payload.clientMessageId || null,
      replyTo: payload.reply_to || payload.replyTo || null,
      editedAt: payload.edited_at || payload.editedAt || null,
      edited_at: payload.edited_at || payload.editedAt || null,
      isDeleted,
      is_deleted: isDeleted,
      attachments: finalAttachments,
      attachmentIds: finalAttIds,
      attachment_ids: finalAttIds
    };
  }

  /**
   * Processes a verified pong frame (either type: 'pong' or type: 'ack' with payload.type: 'pong').
   * Clears the missed-pong deadline timer and updates the last pong timestamp.
   * @param {string|null} [requestId=null]
   * @param {string|null} [roomId=null]
   * @private
   */
  _handlePongReceived(requestId = null, roomId = null) {
    this._awaitingPong = false;
    this._lastPingRequestId = null;
    if (this._pongTimer) {
      clearTimeout(this._pongTimer);
      this._pongTimer = null;
    }
    if (this.multiRoom) {
      for (const entry of this._roomSockets.values()) {
        if ((requestId && entry.lastPingRequestId === requestId) || (roomId && entry.roomId === roomId)) {
          entry.awaitingPong = false;
          entry.lastPingRequestId = null;
          if (entry.pongTimer) {
            clearTimeout(entry.pongTimer);
            entry.pongTimer = null;
          }
        }
      }
    }
    const latency = this._lastPingSentAt ? (Date.now() - this._lastPingSentAt) : 0;
    this.lastPongAt = Date.now();
    this._logSafe(`Heartbeat pong received (req: ${requestId || 'untracked'}, latency: ${latency}ms)`);
    this.emit('pong', { requestId, latency, roomId });
  }

  /**
   * Schedules bounded exponential backoff reconnection.
   * @private
   */
  _handleUnexpectedClose(code, reason) {
    if (this._isManualClose) return;

    this._stopHeartbeat();
    clearTimeout(this._connectTimer);
    this._connectTimer = null;
    this._token = null;

    const codeMeta = classifyCloseCode(code);
    this._logSafe(`Connection closed unexpectedly (code: ${code}, reason: ${reason || 'none'}, category: ${codeMeta.category})`);

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this._setState(CONNECTION_STATE.ERROR, {
        message: `Connection lost. Max reconnect attempts (${this.maxReconnectAttempts}) exceeded.`,
        code,
        reason
      });
      this.emit('error', { code: 'max_reconnect_exceeded', message: 'Maximum reconnection attempts reached' });
      return;
    }

    this._setState(CONNECTION_STATE.RECONNECTING, { code, reason, attempt: this.reconnectAttempts + 1, codeMeta });

    const delay = Math.min(
      INITIAL_RECONNECT_DELAY_MS * Math.pow(2, this.reconnectAttempts),
      MAX_RECONNECT_DELAY_MS
    );
    this.reconnectAttempts++;

    this._logSafe(`Scheduling reconnect attempt ${this.reconnectAttempts} in ${delay}ms`);

    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(async () => {
      if (this._isManualClose) return;
      try {
        // Clear cached token so reconnect resolves a fresh unexpired room token via _getToken
        this._token = null;
        await this.connect({ forceTokenRefresh: true });
      } catch (err) {
        this._handleUnexpectedClose(1006, err?.message || 'Reconnect error');
      }
    }, delay);
  }

  /**
   * Starts ping/pong periodic heartbeat with missed-pong deadline detection.
   * @private
   */
  _startHeartbeat() {
    this._stopHeartbeat();
    if (this.heartbeatIntervalMs <= 0) return;

    this._heartbeatTimer = setInterval(() => {
      if (this.state === CONNECTION_STATE.CONNECTED && this._socket && this._isSocketOpen(this._socket)) {
        try {
          const pingReqId = this.ping();
          this._logSafe(`Heartbeat ping sent (req: ${pingReqId})`);

          // Set pong timeout deadline if not already pending
          if (this.heartbeatTimeoutMs > 0 && !this._pongTimer) {
            this._pongTimer = setTimeout(() => {
              this._pongTimer = null;
              if (this.state === CONNECTION_STATE.CONNECTED && this._socket) {
                console.warn(`[ChatWebSocket#${this._connectionId}] Pong response deadline exceeded (${this.heartbeatTimeoutMs}ms)`);
                const deadSocket = this._socket;
                this._socket = null;
                this._stopHeartbeat();
                this._cleanupSocket(deadSocket, 1006, 'Heartbeat deadline exceeded');
                this.emit('error', { code: 'heartbeat_timeout', message: 'Heartbeat pong response timeout' });
                this._handleUnexpectedClose(1006, 'Heartbeat deadline exceeded');
              }
            }, this.heartbeatTimeoutMs);
          }
        } catch {
          // Socket write error will trigger onerror/onclose
        }
      }
    }, this.heartbeatIntervalMs);
  }

  /**
   * Stops heartbeat and pong deadline timers.
   * @private
   */
  _stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
    if (this._pongTimer) {
      clearTimeout(this._pongTimer);
      this._pongTimer = null;
    }
    this._awaitingPong = false;
    this._lastPingRequestId = null;
  }

  /**
   * Internal helper to verify if a socket is currently open.
   * @param {object|null} socket
   * @returns {boolean}
   * @private
   */
  _isSocketOpen(socket) {
    return isSocketOpen(socket);
  }

  /**
   * Returns a copy of the pending message queue for a room or the client.
   * @param {string|null} [roomId=null]
   * @returns {Array}
   */
  getPendingQueue(roomId = null) {
    if (this.multiRoom) {
      const cleanRoomId = roomId ? String(roomId).trim() : (this.roomId ? String(this.roomId).trim() : null);
      if (!cleanRoomId) return [];
      const entry = this._roomSockets.get(cleanRoomId);
      return entry && Array.isArray(entry.pendingQueue) ? [...entry.pendingQueue] : [];
    }
    return Array.isArray(this._pendingQueue) ? [...this._pendingQueue] : [];
  }

  /**
   * Flushes queued durable frames in strict FIFO order once the socket reaches OPEN state.
   *
   * @param {string|null} [roomId=null]
   * @private
   */
  _flushPendingQueue(roomId = null) {
    if (this.multiRoom) {
      const cleanRoomId = roomId ? String(roomId).trim() : (this.roomId ? String(this.roomId).trim() : null);
      if (!cleanRoomId) return;
      const entry = this._roomSockets.get(cleanRoomId);
      if (!entry || !entry.socket || !this._isSocketOpen(entry.socket) || !Array.isArray(entry.pendingQueue) || entry.pendingQueue.length === 0) {
        return;
      }
      const queue = entry.pendingQueue.splice(0, entry.pendingQueue.length);
      for (const item of queue) {
        try {
          if (entry.socket && this._isSocketOpen(entry.socket)) {
            entry.socket.send(item.rawFrame);
          } else {
            // Socket closed during draining: restore item and remainder safely
            entry.pendingQueue.unshift(item);
            break;
          }
        } catch (err) {
          this._logSafe(`Failed to flush queued frame for room ${cleanRoomId}: ${err?.message}`);
        }
      }
      return;
    }

    if (!this._socket || !this._isSocketOpen(this._socket) || !Array.isArray(this._pendingQueue) || this._pendingQueue.length === 0) {
      return;
    }
    const queue = this._pendingQueue.splice(0, this._pendingQueue.length);
    for (const item of queue) {
      try {
        if (this._socket && this._isSocketOpen(this._socket)) {
          this._socket.send(item.rawFrame);
        } else {
          this._pendingQueue.unshift(item);
          break;
        }
      } catch (err) {
        this._logSafe(`Failed to flush queued frame: ${err?.message}`);
      }
    }
  }

  /**
   * Core send frame method.
   * Returns generated `request_id` for tracking ACK or error responses.
   *
   * Guarantees:
   * - Only transmits over socket instances currently in WebSocket.OPEN (readyState === 1).
   * - If socket is currently CONNECTING or RECONNECTING, buffers the frame in FIFO queue.
   * - Dispatches queued frames as soon as the connection handshake reaches OPEN.
   * - Never throws uncaught InvalidStateError: Sent before connected.
   *
   * @param {string} type
   * @param {object} [payload={}]
   * @param {string|null} [roomId=null]
   * @returns {string} The request_id
   */
  send(type, payload = {}, roomId = null, customRequestId = null) {
    const effectiveRoomId = roomId || this.roomId;
    const requestId = (customRequestId && typeof customRequestId === 'string') ? customRequestId : crypto.randomUUID();
    const clientMsgId = payload?.client_message_id || payload?.clientMessageId;
    if (clientMsgId && this._requestIdToClientMessageId) {
      this._requestIdToClientMessageId.set(requestId, clientMsgId);
    }
    if (this.multiRoom) {
      let entry = null;
      if (effectiveRoomId && this._roomSockets.has(effectiveRoomId)) {
        entry = this._roomSockets.get(effectiveRoomId);
      }

      let targetSocket = null;
      if (entry && entry.socket && this._isSocketOpen(entry.socket) && entry.state === CONNECTION_STATE.CONNECTED) {
        targetSocket = entry.socket;
      } else if (!entry) {
        for (const candidate of this._roomSockets.values()) {
          if (candidate.socket && this._isSocketOpen(candidate.socket) && candidate.state === CONNECTION_STATE.CONNECTED) {
            targetSocket = candidate.socket;
            break;
          }
        }
        if (!targetSocket && this._socket && this._isSocketOpen(this._socket) && this.state === CONNECTION_STATE.CONNECTED) {
          targetSocket = this._socket;
        }
      }

      const frame = encodeFrame({
        v: 1,
        request_id: requestId,
        type,
        room_id: effectiveRoomId || undefined,
        payload
      });
      console.log('[CHECKPOINT 11] Frame encoded:', { type, roomId: effectiveRoomId, requestId, hasTargetSocket: Boolean(targetSocket) });

      if (targetSocket) {
        try {
          targetSocket.send(frame);
          console.log('[CHECKPOINT 12] Frame transmitted via targetSocket for room:', effectiveRoomId, 'requestId:', requestId);
          return requestId;
        } catch (err) {
          if (entry && (entry.state === CONNECTION_STATE.CONNECTING || entry.state === CONNECTION_STATE.RECONNECTING)) {
            if (!Array.isArray(entry.pendingQueue)) entry.pendingQueue = [];
            entry.pendingQueue.push({ requestId, rawFrame: frame, type, payload, roomId: effectiveRoomId });
            return requestId;
          }
          throw err;
        }
      }

      // If no open target socket, check if room is currently connecting or reconnecting
      if (entry && (entry.state === CONNECTION_STATE.CONNECTING || entry.state === CONNECTION_STATE.RECONNECTING || (entry.socket && typeof entry.socket.readyState === 'number' && entry.socket.readyState === 0))) {
        if (!Array.isArray(entry.pendingQueue)) entry.pendingQueue = [];
        entry.pendingQueue.push({ requestId, rawFrame: frame, type, payload, roomId: effectiveRoomId });
        return requestId;
      }

      throw new Error('Cannot send frame: WebSocket is not connected');
    }

    // Single-room mode
    const frame = encodeFrame({
      v: 1,
      request_id: requestId,
      type,
      room_id: roomId || this.roomId || undefined,
      payload
    });

    if (this._socket && this._isSocketOpen(this._socket) && this.state === CONNECTION_STATE.CONNECTED) {
      try {
        this._socket.send(frame);
        return requestId;
      } catch (err) {
        if (this.state === CONNECTION_STATE.CONNECTING || this.state === CONNECTION_STATE.RECONNECTING) {
          if (!Array.isArray(this._pendingQueue)) this._pendingQueue = [];
          this._pendingQueue.push({ requestId, rawFrame: frame, type, payload, roomId: roomId || this.roomId });
          return requestId;
        }
        throw err;
      }
    }

    if (this.state === CONNECTION_STATE.CONNECTING || this.state === CONNECTION_STATE.RECONNECTING || (this._socket && typeof this._socket.readyState === 'number' && this._socket.readyState === 0)) {
      if (!Array.isArray(this._pendingQueue)) this._pendingQueue = [];
      this._pendingQueue.push({ requestId, rawFrame: frame, type, payload, roomId: roomId || this.roomId });
      return requestId;
    }

    throw new Error('Cannot send frame: WebSocket is not connected');
  }

  // ── Protocol-Specific Outgoing Helpers (from ChatWebSocket.kt) ──

  sendMessage(roomId, clientMessageId, body, kind = 'text', replyTo = null, attachmentIds = [], customRequestId = null) {
    let effectiveReplyTo = replyTo;
    let effectiveAttachmentIds = attachmentIds;
    if (Array.isArray(replyTo)) {
      effectiveAttachmentIds = replyTo;
      effectiveReplyTo = null;
    }
    const payload = {
      client_message_id: clientMessageId,
      kind,
      body: body && typeof body === 'object' ? body : { text: String(body || '') },
      reply_to: effectiveReplyTo !== undefined ? effectiveReplyTo : null,
      attachment_ids: Array.isArray(effectiveAttachmentIds) ? effectiveAttachmentIds : []
    };
    return this.send('message.send', payload, roomId, customRequestId);
  }

  editMessage(roomId, messageId, body) {
    return this.send('message.edit', { message_id: messageId, body }, roomId);
  }

  deleteMessage(roomId, messageId) {
    return this.send('message.delete', { message_id: messageId }, roomId);
  }

  addReaction(roomId, messageId, emoji) {
    return this.send('reaction.add', { message_id: messageId, emoji }, roomId);
  }

  removeReaction(roomId, messageId, emoji) {
    return this.send('reaction.remove', { message_id: messageId, emoji }, roomId);
  }

  markDelivered(roomId, messageId) {
    return this.send('receipt.delivered', { message_id: messageId }, roomId);
  }

  markRead(roomId, messageId) {
    return this.send('receipt.read', { message_id: messageId }, roomId);
  }

  typingStarted(roomId) {
    return this.send('typing.started', {}, roomId);
  }

  typingStopped(roomId) {
    return this.send('typing.stopped', {}, roomId);
  }

  catchup(afterSeq, limit = 200, roomId = null, overlap = false) {
    const seq = typeof afterSeq === 'number' ? afterSeq : parseInt(afterSeq, 10) || 0;
    const calculatedSeq = overlap ? Math.max(0, seq - 1) : seq;
    const payload = {
      after_seq: calculatedSeq,
      limit: typeof limit === 'number' ? limit : 200
    };
    return this.send('catchup', payload, roomId || null);
  }

  ping() {
    const requestId = this.send('ping', {});
    this._lastPingRequestId = requestId;
    this._lastPingSentAt = Date.now();
    this._awaitingPong = true;
    return requestId;
  }

  /**
   * Immediately attempts reconnection across all managed room sockets or the main socket,
   * bypassing any pending exponential backoff delays.
   *
   * @param {object} [options={}]
   * @param {boolean} [options.forceTokenRefresh=true]
   * @param {boolean} [options.resetBackoff=true]
   */
  reconnectAll({ forceTokenRefresh = true, resetBackoff = true } = {}) {
    if (this.multiRoom) {
      for (const [roomId, entry] of this._roomSockets.entries()) {
        if (entry.isManualClose) continue;
        clearTimeout(entry.reconnectTimer);
        entry.reconnectTimer = null;
        clearTimeout(entry.connectTimer);
        entry.connectTimer = null;
        if (resetBackoff) {
          entry.reconnectAttempts = 0;
        }
        if (entry.state !== CONNECTION_STATE.CONNECTED) {
          entry.state = CONNECTION_STATE.CONNECTING;
          this.emit('stateChange', { state: CONNECTION_STATE.CONNECTING, roomId });
          this.connectRoom(roomId, { url: entry.url, forceTokenRefresh }).catch((err) => {
            this._handleRoomUnexpectedClose(entry, 1006, err?.message || 'Reconnect error');
          });
        }
      }
      this._updateAggregateState();
    } else {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
      clearTimeout(this._connectTimer);
      this._connectTimer = null;
      if (resetBackoff) {
        this.reconnectAttempts = 0;
      }
      if (this.state !== CONNECTION_STATE.CONNECTED) {
        this.connect({ forceTokenRefresh }).catch(() => {});
      }
    }
  }

  /**
   * Disconnects cleanly with code 1000 and stops all reconnection attempts.
   * If roomId is specified in multiRoom mode, closes only that room channel.
   * If no roomId is specified, closes all sockets and stops all reconnection attempts.
   *
   * @param {string|null} [roomId=null]
   */
  disconnect(roomId = null) {
    if (this.multiRoom) {
      if (roomId) {
        const cleanId = String(roomId).trim();
        const entry = this._roomSockets.get(cleanId);
        if (entry) {
          entry.isManualClose = true;
          entry.pendingQueue = [];
          this._cleanupRoomEntry(entry);
          this._roomSockets.delete(cleanId);
          this._updateAggregateState();
        }
        return;
      }
      for (const entry of this._roomSockets.values()) {
        entry.isManualClose = true;
        entry.pendingQueue = [];
        this._cleanupRoomEntry(entry);
      }
      this._roomSockets.clear();
      this._setState(CONNECTION_STATE.DISCONNECTED);
      return;
    }

    this._isManualClose = true;
    this._pendingQueue = [];
    this._stopHeartbeat();
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
    clearTimeout(this._connectTimer);
    this._connectTimer = null;
    this.reconnectAttempts = 0;

    if (this._socket) {
      const oldSocket = this._socket;
      this._socket = null;
      this._cleanupSocket(oldSocket);
    }

    this._setState(CONNECTION_STATE.DISCONNECTED);
  }
}
