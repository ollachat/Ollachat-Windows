import { ApiError } from './api-error.js';

export const DEFAULT_API_BASE = 'https://api.ollacore.com/v1';
export const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Normalizes a ConversationSummary item from GET /directory/conversations.
 * @param {object} raw
 * @returns {object}
 */
export function normalizeConversation(raw) {
  if (!raw || typeof raw !== 'object') return raw;
  const isBlocked = Boolean(raw.is_blocked || raw.isBlocked || raw.blocked || raw.blocked_by_peer || raw.blockedByPeer || raw.peer?.is_blocked || raw.peer?.isBlocked || raw.peer?.blocked);
  const avatarUrl = isBlocked ? null : (raw.avatar_url || raw.avatarUrl || raw.icon_url || raw.icon || null);
  return {
    roomId: raw.room_id || '',
    kind: raw.kind || 'direct',
    name: raw.name || null,
    createdAt: raw.created_at || null,
    mutedUntil: raw.muted_until || null,
    isBlocked,
    blocked: isBlocked,
    avatarUrl,
    avatar_url: avatarUrl,
    icon: avatarUrl,
    icon_url: avatarUrl,
    // Preserve exact backend keys
    room_id: raw.room_id || '',
    created_at: raw.created_at || null,
    muted_until: raw.muted_until || null
  };
}

/**
 * Normalizes a BlockedUser item from GET /directory/blocks.
 * @param {object} raw
 * @returns {object}
 */
export function normalizeBlockItem(raw) {
  if (!raw) return null;
  if (typeof raw === 'string') {
    const cleanId = raw.trim();
    return {
      userId: cleanId,
      displayName: null,
      phone: null,
      since: null,
      user_id: cleanId,
      display_name: null
    };
  }
  if (!raw || typeof raw !== 'object') return raw;
  const rawId = raw.user_id || raw.userId || raw.id || '';
  const cleanId = String(rawId).trim();
  return {
    userId: cleanId,
    displayName: raw.display_name || raw.displayName || null,
    phone: raw.phone || null,
    since: raw.since || null,
    // Preserve exact backend keys
    user_id: cleanId,
    display_name: raw.display_name || raw.displayName || null
  };
}

/**
 * Normalizes an InboxItem from GET /directory/inbox.
 * @param {object} raw
 * @returns {object}
 */
export function normalizeInboxItem(raw, baseUrl = DEFAULT_API_BASE) {
  if (!raw || typeof raw !== 'object') return raw;
  const peerUserId = raw.peer?.user_id || raw.peer?.userId || '';
  const isBlocked = Boolean(raw.is_blocked || raw.isBlocked || raw.blocked || raw.blocked_by_peer || raw.blockedByPeer || raw.peer?.is_blocked || raw.peer?.isBlocked || raw.peer?.blocked);
  const peerAvatarVersion = isBlocked ? null : (raw.peer?.avatar_version || raw.peer?.avatarVersion || null);
  const peerAvatarUrl = isBlocked ? null : (raw.peer?.avatar_url || raw.peer?.avatarUrl || (peerUserId && peerAvatarVersion ? `${baseUrl}/directory/users/${encodeURIComponent(peerUserId)}/avatar?v=${encodeURIComponent(peerAvatarVersion)}` : null));
  const convAvatarUrl = isBlocked ? null : (raw.avatar_url || raw.avatarUrl || (raw.kind === 'direct' ? peerAvatarUrl : null));

  return {
    roomId: raw.room_id || '',
    kind: raw.kind || 'direct',
    name: raw.name || null,
    description: raw.description ?? raw.about ?? null,
    mutedUntil: raw.muted_until || null,
    isBlocked,
    blocked: isBlocked,
    avatarUrl: convAvatarUrl,
    avatar_url: convAvatarUrl,
    peer: raw.peer ? {
      phone: raw.peer.phone || '',
      userId: peerUserId,
      displayName: raw.peer.display_name || null,
      user_id: peerUserId,
      display_name: raw.peer.display_name || null,
      isBlocked,
      blocked: isBlocked,
      avatarVersion: peerAvatarVersion,
      avatar_version: peerAvatarVersion,
      avatarUrl: peerAvatarUrl,
      avatar_url: peerAvatarUrl
    } : null,
    lastMessage: raw.last_message ? {
      id: raw.last_message.id || raw.last_message.message_id || null,
      preview: raw.last_message.preview || null,
      senderId: raw.last_message.sender_id || null,
      createdAt: raw.last_message.created_at || null,
      eventSeq: raw.last_message.event_seq ?? null,
      kind: raw.last_message.kind || 'text',
      sender_id: raw.last_message.sender_id || null,
      created_at: raw.last_message.created_at || null,
      event_seq: raw.last_message.event_seq ?? null
    } : null,
    lastEventSeq: raw.last_message?.event_seq ?? null,
    last_event_seq: raw.last_message?.event_seq ?? null,
    lastMessageTime: raw.last_message?.created_at || null,
    last_message_time: raw.last_message?.created_at || null,
    unreadCount: typeof raw.unread_count === 'number' ? raw.unread_count : 0,
    // Preserve exact backend keys
    room_id: raw.room_id || '',
    last_message: raw.last_message || null,
    unread_count: typeof raw.unread_count === 'number' ? raw.unread_count : 0,
    muted_until: raw.muted_until || null
  };
}

/**
 * Normalizes a MessageResponse from GET /rooms/{id}/messages.
 * @param {object} raw
 * @returns {object}
 */
export function normalizeMessage(raw) {
  if (!raw || typeof raw !== 'object') return raw;
  const rawBody = raw.body && typeof raw.body === 'object'
    ? raw.body
    : (typeof raw.body === 'string' ? { text: raw.body } : {});
  const rawAttIds = Array.isArray(raw.attachment_ids)
    ? raw.attachment_ids
    : (Array.isArray(raw.attachmentIds) ? raw.attachmentIds : []);
  const bodyAttIds = Array.isArray(rawBody.attachment_ids)
    ? rawBody.attachment_ids
    : (Array.isArray(rawBody.attachmentIds) ? rawBody.attachmentIds : []);
  const fromAtts = Array.isArray(raw.attachments)
    ? raw.attachments.map(a => a?.id || a?.attachment_id || a?.attachmentId).filter(Boolean)
    : (Array.isArray(rawBody.attachments)
      ? rawBody.attachments.map(a => a?.id || a?.attachment_id || a?.attachmentId).filter(Boolean)
      : []);
  const scalarAttId = raw.attachment_id || raw.attachmentId || rawBody.attachment_id || rawBody.attachmentId;
  const combinedAttIds = rawAttIds.length > 0
    ? rawAttIds
    : (bodyAttIds.length > 0 ? bodyAttIds : (fromAtts.length > 0 ? fromAtts : (scalarAttId ? [String(scalarAttId)] : [])));

  const attachmentsList = Array.isArray(raw.attachments) && raw.attachments.length > 0
    ? raw.attachments
    : (Array.isArray(rawBody.attachments) ? rawBody.attachments : []);

  const isDeleted = Boolean(
    raw.is_deleted ||
    raw.isDeleted ||
    raw.kind === 'deleted' ||
    rawBody?.is_deleted ||
    rawBody?.isDeleted
  );

  const effectiveKind = isDeleted ? 'deleted' : (raw.kind || 'text');
  const effectiveBody = isDeleted
    ? { text: 'This message was deleted' }
    : (raw.body && typeof raw.body === 'object'
        ? raw.body
        : (typeof raw.body === 'string' ? { text: raw.body } : {}));

  const finalAttachments = isDeleted ? [] : attachmentsList.map(att => ({
    id: att.id || att.attachment_id || att.attachmentId || '',
    attachmentId: att.id || att.attachment_id || att.attachmentId || '',
    attachment_id: att.id || att.attachment_id || att.attachmentId || '',
    mime: att.mime || null,
    filename: att.filename || att.original_name || null,
    original_name: att.original_name || att.filename || null,
    byteSize: att.byte_size ?? att.byteSize ?? null,
    byte_size: att.byte_size ?? att.byteSize ?? null,
    status: att.status || null,
    hasThumbnail: Boolean(att.has_thumbnail ?? att.hasThumbnail ?? false),
    has_thumbnail: Boolean(att.has_thumbnail ?? att.hasThumbnail ?? false)
  }));
  const finalAttIds = isDeleted ? [] : combinedAttIds;

  return {
    id: raw.id || '',
    roomId: raw.room_id || raw.roomId || '',
    senderId: raw.sender_id || raw.senderId || '',
    kind: effectiveKind,
    body: effectiveBody,
    createdAt: raw.created_at || raw.createdAt || '',
    eventSeq: raw.event_seq ?? raw.eventSeq ?? 0,
    clientMessageId: raw.client_message_id || raw.clientMessageId || null,
    replyTo: raw.reply_to || raw.replyTo || null,
    editedAt: raw.edited_at || raw.editedAt || null,
    isDeleted,
    is_deleted: isDeleted,
    reactions: raw.reactions && typeof raw.reactions === 'object' ? raw.reactions : {},
    attachmentIds: finalAttIds,
    attachment_ids: finalAttIds,
    attachments: finalAttachments,
    status: raw.status || raw.delivery_status || raw.deliveryStatus || null,
    deliveryStatus: raw.delivery_status || raw.deliveryStatus || raw.status || null,
    delivery_status: raw.delivery_status || raw.deliveryStatus || raw.status || null,
    // Preserve exact backend keys
    room_id: raw.room_id || raw.roomId || '',
    sender_id: raw.sender_id || raw.senderId || '',
    created_at: raw.created_at || raw.createdAt || '',
    event_seq: raw.event_seq ?? raw.eventSeq ?? 0,
    client_message_id: raw.client_message_id || raw.clientMessageId || null,
    reply_to: raw.reply_to || raw.replyTo || null,
    edited_at: raw.edited_at || raw.editedAt || null
  };
}

/**
 * Normalizes a Participant item from GET /rooms/{id}/participants.
 * @param {object} raw
 * @returns {object}
 */
export function normalizeParticipant(raw) {
  if (!raw || typeof raw !== 'object') return raw;
  return {
    principalId: raw.principal_id || '',
    role: raw.role || 'member',
    displayName: raw.display_name || null,
    phone: raw.phone || null,
    // Preserve exact backend keys
    principal_id: raw.principal_id || '',
    display_name: raw.display_name || null
  };
}

/**
 * Normalizes a Group Member item from GET /directory/conversations/{roomId}/members.
 * @param {object} raw
 * @returns {object}
 */
export function normalizeGroupMember(raw, baseUrl = DEFAULT_API_BASE) {
  if (!raw || typeof raw !== 'object') return raw;
  const userId = String(raw.user_id || raw.userId || raw.principal_id || raw.principalId || raw.id || '');
  const role = String(raw.role || 'member').toLowerCase().trim();
  const displayName = raw.display_name || raw.displayName || raw.name || null;
  const phone = raw.phone || null;
  const avatarVersion = raw.avatar_version || raw.avatarVersion || null;
  const avatarUrl = raw.avatar_url || raw.avatarUrl || (userId && avatarVersion ? `${baseUrl}/directory/users/${encodeURIComponent(userId)}/avatar?v=${encodeURIComponent(avatarVersion)}` : null);
  return {
    userId,
    user_id: userId,
    principalId: userId,
    principal_id: userId,
    role,
    displayName,
    display_name: displayName,
    phone,
    avatarUrl,
    avatar_url: avatarUrl,
    avatarVersion,
    avatar_version: avatarVersion,
    about: raw.about || null,
    joinedAt: raw.joined_at || raw.joinedAt || null
  };
}

/**
 * In-memory cache for scoped room tokens.
 * Persists only during process execution (never written to disk).
 */
export class RoomTokenCache {
  constructor() {
    this._cache = new Map();
  }

  /**
   * Stores a room token response.
   * @param {string} roomId
   * @param {object} tokenData RoomTokenResponse
   */
  set(roomId, tokenData) {
    if (!roomId || !tokenData?.access_token) return;

    let expiresAtMs = 0;
    if (tokenData.expires_at) {
      const parsed = Date.parse(tokenData.expires_at);
      if (!Number.isNaN(parsed)) {
        expiresAtMs = parsed;
      }
    }

    this._cache.set(roomId, {
      accessToken: tokenData.access_token,
      expiresAt: tokenData.expires_at || null,
      expiresAtMs,
      chatWebsocketUrl: tokenData.chat_websocket_url || null,
      rtcWebsocketUrl: tokenData.rtc_websocket_url || null,
      iceServers: Array.isArray(tokenData.ice_servers) ? tokenData.ice_servers : []
    });
  }

  /**
   * Retrieves a non-expired room token.
   * Gives a 10-second margin before expiry.
   * @param {string} roomId
   * @returns {string|null} The valid accessToken or null
   */
  get(roomId) {
    const entry = this._cache.get(roomId);
    if (!entry) return null;

    if (entry.expiresAtMs > 0) {
      const marginMs = 10000;
      if (Date.now() >= entry.expiresAtMs - marginMs) {
        this._cache.delete(roomId);
        return null;
      }
    }

    return entry.accessToken;
  }

  /**
   * Returns complete cached entry if valid.
   * @param {string} roomId
   * @returns {object|null}
   */
  getEntry(roomId) {
    const entry = this._cache.get(roomId);
    if (!entry) return null;

    if (entry.expiresAtMs > 0 && Date.now() >= entry.expiresAtMs - 10000) {
      this._cache.delete(roomId);
      return null;
    }

    return entry;
  }

  /**
   * Evicts a room token from cache.
   * @param {string} roomId
   */
  evict(roomId) {
    this._cache.delete(roomId);
  }

  /**
   * Clears all cached room tokens.
   */
  clear() {
    this._cache.clear();
  }
}

/**
 * Ollacore Conversations / Rooms REST API Client.
 * Implements Directory Plane and Room Plane contracts from OllacoreApi.kt.
 */
export class ChatApi {
  /**
   * @param {object} [options={}]
   * @param {string} [options.baseUrl=DEFAULT_API_BASE]
   * @param {number} [options.timeoutMs=DEFAULT_TIMEOUT_MS]
   * @param {Function} [options.fetchFn=globalThis.fetch]
   */
  constructor({
    baseUrl = DEFAULT_API_BASE,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchFn = globalThis.fetch
  } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.timeoutMs = timeoutMs;
    this.fetchFn = fetchFn;
    this.roomTokenCache = new RoomTokenCache();
  }

  /**
   * Internal HTTP request execution helper with error mapping.
   * @private
   */
  async _request(endpoint, {
    method = 'GET',
    token = null,
    body = null,
    headers = {}
  } = {}) {
    const url = `${this.baseUrl}${endpoint}`;
    const reqHeaders = {
      Accept: 'application/json',
      ...headers
    };

    if (token) {
      reqHeaders.Authorization = `Bearer ${token.trim()}`;
    }

    const fetchOptions = {
      method,
      headers: reqHeaders
    };

    if (body !== null && body !== undefined) {
      reqHeaders['Content-Type'] = 'application/json; charset=utf-8';
      fetchOptions.body = typeof body === 'string' ? body : JSON.stringify(body);
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
    fetchOptions.signal = controller.signal;

    let response;
    try {
      response = await this.fetchFn(url, fetchOptions);
    } catch (err) {
      if (err.name === 'AbortError') {
        throw new ApiError('Request timed out', 'timeout');
      }
      throw new ApiError(err.message || 'Network request failed', 'network_error');
    } finally {
      clearTimeout(timeoutId);
    }

    const responseText = await response.text();
    let responseData = null;

    if (responseText && responseText.trim().length > 0) {
      try {
        responseData = JSON.parse(responseText);
      } catch {
        // If non-JSON text returned
        if (!response.ok) {
          throw new ApiError(`HTTP ${response.status}: ${responseText.slice(0, 100)}`, 'api_error', response.status);
        }
      }
    }

    if (!response.ok) {
      const errObj = responseData?.error && typeof responseData.error === 'object' ? responseData.error : responseData;
      const message = errObj?.message || `HTTP ${response.status}`;
      const code = errObj?.code || 'api_error';
      throw new ApiError(message, code, response.status);
    }

    return responseData;
  }

  // ═════════════════════════════════════════════════════════════════
  // DIRECTORY PLANE (Authenticated with sessionToken)
  // ═════════════════════════════════════════════════════════════════

  /**
   * Lists conversations summary for current user.
   * GET /directory/conversations
   * @param {string} sessionToken
   * @returns {Promise<{ conversations: Array }>}
   */
  async listConversations(sessionToken) {
    if (!sessionToken) throw new ApiError('Session token required', 'unauthorized', 401);
    const data = await this._request('/directory/conversations', {
      method: 'GET',
      token: sessionToken
    });

    const items = Array.isArray(data?.conversations) ? data.conversations : [];
    return {
      conversations: items.map(normalizeConversation)
    };
  }

  /**
   * Retrieves inbox with recent conversations, last messages, and unread counts.
   * GET /directory/inbox?limit={limit}
   * @param {string} sessionToken
   * @param {object} [options={}]
   * @param {number} [options.limit=30]
   * @returns {Promise<{ conversations: Array }>}
   */
  async getInbox(sessionToken, { limit = 30 } = {}) {
    if (!sessionToken) throw new ApiError('Session token required', 'unauthorized', 401);
    const data = await this._request(`/directory/inbox?limit=${encodeURIComponent(limit)}`, {
      method: 'GET',
      token: sessionToken
    });

    const items = Array.isArray(data?.conversations) ? data.conversations : [];
    return {
      conversations: items.map(i => normalizeInboxItem(i, this.baseUrl))
    };
  }

  /**
   * Opens or creates a direct 1-to-1 conversation with a peer.
   * POST /directory/conversations/direct
   * @param {string} sessionToken
   * @param {string} peerUserId
   * @returns {Promise<{ roomId: string, kind: string, name: string|null }>}
   */
  async openDirectConversation(sessionToken, peerUserId) {
    if (!sessionToken) throw new ApiError('Session token required', 'unauthorized', 401);
    if (!peerUserId || typeof peerUserId !== 'string') {
      throw new ApiError('Valid peerUserId required', 'bad_request', 400);
    }

    const data = await this._request('/directory/conversations/direct', {
      method: 'POST',
      token: sessionToken,
      body: { peer_user_id: peerUserId.trim() }
    });

    return {
      roomId: data?.room_id || '',
      room_id: data?.room_id || '',
      kind: data?.kind || 'direct',
      name: data?.name || null
    };
  }

  /**
   * Creates a new group conversation.
   * POST /directory/conversations/group
   * @param {string} sessionToken
   * @param {object} params
   * @param {string[]} params.memberUserIds
   * @param {string} params.name
   * @returns {Promise<{ roomId: string, kind: string, name: string }>}
   */
  async createGroupConversation(sessionToken, { memberUserIds = [], name }) {
    if (!sessionToken) throw new ApiError('Session token required', 'unauthorized', 401);
    if (!name || typeof name !== 'string' || !name.trim()) {
      throw new ApiError('Group name is required', 'bad_request', 400);
    }
    if (!Array.isArray(memberUserIds)) {
      throw new ApiError('memberUserIds must be an array', 'bad_request', 400);
    }

    const data = await this._request('/directory/conversations/group', {
      method: 'POST',
      token: sessionToken,
      body: {
        member_user_ids: memberUserIds,
        name: name.trim()
      }
    });

    return {
      roomId: data?.room_id || '',
      room_id: data?.room_id || '',
      kind: data?.kind || 'group',
      name: data?.name || name.trim()
    };
  }

  /**
   * Acquires a scoped room token for WebSocket and Room REST APIs.
   * GET /directory/conversations/{roomId}/token?device_id={deviceId}
   * Caches token in memory automatically.
   *
   * @param {string} sessionToken
   * @param {string} roomId
   * @param {string} deviceId Ephemeral Windows device ID
   * @returns {Promise<object>} RoomTokenResponse
   */
  async getRoomToken(sessionToken, roomId, deviceId) {
    if (!sessionToken) throw new ApiError('Session token required', 'unauthorized', 401);
    if (!roomId) throw new ApiError('roomId is required', 'bad_request', 400);
    if (!deviceId) throw new ApiError('deviceId is required', 'bad_request', 400);

    const data = await this._request(
      `/directory/conversations/${encodeURIComponent(roomId)}/token?device_id=${encodeURIComponent(deviceId)}`,
      {
        method: 'GET',
        token: sessionToken
      }
    );

    if (data?.access_token) {
      this.roomTokenCache.set(roomId, data);
    }

    return data;
  }

  /**
   * Resolves a room token: returns cached token if still valid, or fetches a new one.
   * @param {string} sessionToken
   * @param {string} roomId
   * @param {string} deviceId
   * @returns {Promise<string>} Valid room access token
   */
  async resolveRoomToken(sessionToken, roomId, deviceId) {
    const cached = this.roomTokenCache.get(roomId);
    if (cached) return cached;

    const res = await this.getRoomToken(sessionToken, roomId, deviceId);
    if (!res?.access_token) {
      throw new ApiError('Failed to obtain room token', 'room_token_failed');
    }
    return res.access_token;
  }

  /**
   * Fetches group conversation members using Directory API.
   * GET /directory/conversations/{roomId}/members
   * @param {string} sessionToken User directory session token
   * @param {string} roomId
   * @returns {Promise<{ members: Array<object>, participants: Array<object> }>}
   */
  async getGroupMembers(sessionToken, roomId) {
    if (!sessionToken) throw new ApiError('Session token required', 'unauthorized', 401);
    if (!roomId) throw new ApiError('roomId is required', 'bad_request', 400);

    const data = await this._request(`/directory/conversations/${encodeURIComponent(roomId)}/members`, {
      method: 'GET',
      token: sessionToken
    });

    const rawList = Array.isArray(data)
      ? data
      : (Array.isArray(data?.members)
        ? data.members
        : (Array.isArray(data?.participants) ? data.participants : []));

    const members = rawList.map(m => normalizeGroupMember(m, this.baseUrl));
    return {
      members,
      participants: members
    };
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
    if (!sessionToken) throw new ApiError('Session token required', 'unauthorized', 401);
    return this._request('/directory/me/avatar/init', {
      method: 'POST',
      token: sessionToken,
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
   * @returns {Promise<object>} Updated UserProfile
   */
  async completeAvatarUpload(sessionToken, uploadId) {
    if (!sessionToken) throw new ApiError('Session token required', 'unauthorized', 401);
    return this._request('/directory/me/avatar/complete', {
      method: 'POST',
      token: sessionToken,
      body: { upload_id: uploadId }
    });
  }

  /**
   * Deletes the user's avatar.
   * DELETE /directory/me/avatar
   *
   * @param {string} sessionToken Bearer session token
   * @returns {Promise<object>} Updated UserProfile
   */
  async deleteAvatar(sessionToken) {
    if (!sessionToken) throw new ApiError('Session token required', 'unauthorized', 401);
    return this._request('/directory/me/avatar', {
      method: 'DELETE',
      token: sessionToken
    });
  }

  /**
   * Adds one or more members to a group conversation.
   * POST /directory/conversations/{roomId}/members
   * @param {string} sessionToken User directory session token
   * @param {string} roomId
   * @param {string[]|string} userIds Array of user IDs or single user ID
   * @returns {Promise<object>}
   */
  async addGroupMembers(sessionToken, roomId, userIds) {
    if (!sessionToken) throw new ApiError('Session token required', 'unauthorized', 401);
    if (!roomId) throw new ApiError('roomId is required', 'bad_request', 400);

    const idList = Array.isArray(userIds)
      ? userIds.map(String).map(s => s.trim()).filter(Boolean)
      : (userIds ? [String(userIds).trim()].filter(Boolean) : []);

    if (idList.length === 0) {
      throw new ApiError('At least one user ID is required to add members', 'bad_request', 400);
    }

    const data = await this._request(`/directory/conversations/${encodeURIComponent(roomId)}/members`, {
      method: 'POST',
      token: sessionToken,
      body: {
        member_user_ids: idList,
        user_ids: idList,
        user_id: idList[0]
      }
    });

    return data || { success: true };
  }

  /**
   * Updates a group member's role between 'owner' and 'member'.
   * PUT /directory/conversations/{roomId}/members/{userId}
   * @param {string} sessionToken User directory session token
   * @param {string} roomId
   * @param {string} userId
   * @param {'owner'|'member'} role
   * @returns {Promise<object>}
   */
  async updateMemberRole(sessionToken, roomId, userId, role) {
    if (!sessionToken) throw new ApiError('Session token required', 'unauthorized', 401);
    if (!roomId) throw new ApiError('roomId is required', 'bad_request', 400);
    if (!userId) throw new ApiError('userId is required', 'bad_request', 400);

    const rawRole = String(role || '').toLowerCase().trim();
    const normalizedRole = (rawRole === 'owner' || rawRole === 'admin' || rawRole === 'creator')
      ? 'owner'
      : (rawRole === 'member' ? 'member' : null);

    if (!normalizedRole) {
      throw new ApiError("Role must be 'owner' or 'member'", 'bad_request', 400);
    }

    const data = await this._request(`/directory/conversations/${encodeURIComponent(roomId)}/members/${encodeURIComponent(userId)}`, {
      method: 'PUT',
      token: sessionToken,
      body: { role: normalizedRole }
    });

    return data || { success: true };
  }

  /**
   * Removes a member from a group conversation.
   * DELETE /directory/conversations/{roomId}/members/{userId}
   * @param {string} sessionToken User directory session token
   * @param {string} roomId
   * @param {string} userId
   * @returns {Promise<object>}
   */
  async removeGroupMember(sessionToken, roomId, userId) {
    if (!sessionToken) throw new ApiError('Session token required', 'unauthorized', 401);
    if (!roomId) throw new ApiError('roomId is required', 'bad_request', 400);
    if (!userId) throw new ApiError('userId is required', 'bad_request', 400);

    const data = await this._request(`/directory/conversations/${encodeURIComponent(roomId)}/members/${encodeURIComponent(userId)}`, {
      method: 'DELETE',
      token: sessionToken
    });

    return data || { success: true };
  }

  /**
   * Current user leaves a group conversation.
   * POST /directory/conversations/{roomId}/leave
   * @param {string} sessionToken User directory session token
   * @param {string} roomId
   * @returns {Promise<object>}
   */
  async leaveGroupConversation(sessionToken, roomId) {
    if (!sessionToken) throw new ApiError('Session token required', 'unauthorized', 401);
    if (!roomId) throw new ApiError('roomId is required', 'bad_request', 400);

    const data = await this._request(`/directory/conversations/${encodeURIComponent(roomId)}/leave`, {
      method: 'POST',
      token: sessionToken
    });

    return data || { success: true };
  }

  /**
   * Updates group conversation metadata (name, description, icon).
   * PATCH /directory/conversations/{roomId}
   * @param {string} sessionToken User directory session token
   * @param {string} roomId The group conversation room ID
   * @param {object} [updates={}]
   * @param {string|null} [updates.name]
   * @param {string|null} [updates.description]
   * @param {string|null} [updates.icon]
   * @param {string|null} [updates.iconUrl]
   * @param {string|null} [updates.icon_url]
   * @returns {Promise<object>}
   */
  async updateGroup(sessionToken, roomId, { name = null, description = null, icon = null, iconUrl = null, icon_url = null } = {}) {
    if (!sessionToken) throw new ApiError('Session token required', 'unauthorized', 401);
    if (!roomId) throw new ApiError('roomId is required', 'bad_request', 400);

    const body = {};
    if (name !== null && name !== undefined) body.name = name;
    if (description !== null && description !== undefined) body.description = description;
    const finalIcon = icon !== null && icon !== undefined ? icon : (iconUrl !== null && iconUrl !== undefined ? iconUrl : (icon_url !== null && icon_url !== undefined ? icon_url : null));
    if (finalIcon !== null && finalIcon !== undefined) {
      body.icon = finalIcon;
    }

    const cleanRoomId = String(roomId).trim();
    const data = await this._request(`/directory/conversations/${encodeURIComponent(cleanRoomId)}`, {
      method: 'PATCH',
      token: sessionToken,
      body
    });

    if (data && typeof data === 'object') {
      const iconVal = data.icon || data.icon_url || data.avatar_url || data.avatarUrl || null;
      if (iconVal && !data.avatar_url) data.avatar_url = iconVal;
      if (iconVal && !data.avatarUrl) data.avatarUrl = iconVal;
      if (iconVal && !data.icon_url) data.icon_url = iconVal;
      return { success: true, ...data };
    }

    return { success: true };
  }

  /**
   * Alias for updateGroup on Directory Plane.
   */
  async updateGroupMetadata(sessionToken, roomId, updates) {
    return this.updateGroup(sessionToken, roomId, updates);
  }

  /**
   * Looks up registered contact users by phone numbers.
   * POST /directory/contacts/lookup
   * @param {string} sessionToken
   * @param {string[]} phones
   * @returns {Promise<{ contacts: Array }>}
   */
  async lookupContacts(sessionToken, phones = []) {
    if (!sessionToken) throw new ApiError('Session token required', 'unauthorized', 401);
    const data = await this._request('/directory/contacts/lookup', {
      method: 'POST',
      token: sessionToken,
      body: { phones: Array.isArray(phones) ? phones : [] }
    });

    const contacts = Array.isArray(data?.contacts) ? data.contacts : [];
    return {
      contacts: contacts.map(c => ({
        userId: c.user_id || c.userId || '',
        phone: c.phone || '',
        displayName: c.display_name ?? c.displayName ?? null,
        isRegistered: Boolean(c.user_id || c.userId || c.is_registered || c.isRegistered),
        is_registered: Boolean(c.user_id || c.userId || c.is_registered || c.isRegistered),
        user_id: c.user_id || c.userId || '',
        display_name: c.display_name ?? c.displayName ?? null
      }))
    };
  }

  // ═════════════════════════════════════════════════════════════════
  // ROOM PLANE (Authenticated with roomToken)
  // ═════════════════════════════════════════════════════════════════

  /**
   * Fetches historical messages with sequence cursor pagination.
   * GET /rooms/{roomId}/messages?limit={limit}&after_seq={afterSeq}&before_seq={beforeSeq}
   *
   * @param {string} roomToken
   * @param {string} roomId
   * @param {object} [options={}]
   * @param {number} [options.limit=50]
   * @param {number|null} [options.afterSeq=null] Cursor for newer messages
   * @param {number|null} [options.beforeSeq=null] Cursor for older messages
   * @returns {Promise<{ messages: Array, hasMore: boolean, has_more: boolean }>}
   */
  async listMessages(roomToken, roomId, { limit = 50, afterSeq = null, beforeSeq = null } = {}) {
    if (!roomToken) throw new ApiError('Room token required', 'unauthorized', 401);
    if (!roomId) throw new ApiError('roomId is required', 'bad_request', 400);

    const query = new URLSearchParams();
    if (typeof limit === 'number') query.set('limit', String(limit));
    if (afterSeq !== null && afterSeq !== undefined) query.set('after_seq', String(afterSeq));
    if (beforeSeq !== null && beforeSeq !== undefined) query.set('before_seq', String(beforeSeq));

    const qs = query.toString();
    const endpoint = `/rooms/${encodeURIComponent(roomId)}/messages${qs ? `?${qs}` : ''}`;

    const data = await this._request(endpoint, {
      method: 'GET',
      token: roomToken
    });

    const messages = Array.isArray(data?.messages) ? data.messages : [];
    let hasMore;
    if (typeof data?.has_more === 'boolean') {
      hasMore = data.has_more;
    } else if (typeof data?.hasMore === 'boolean') {
      hasMore = data.hasMore;
    } else {
      let minSeq = null;
      for (const m of messages) {
        const s = m?.eventSeq ?? m?.event_seq;
        if (typeof s === 'number' && (minSeq === null || s < minSeq)) {
          minSeq = s;
        }
      }
      hasMore = messages.length >= limit && (minSeq === null || minSeq > 1);
    }

    return {
      messages: messages.map(normalizeMessage),
      hasMore,
      has_more: hasMore
    };
  }

  /**
   * Retrieves participant list and roles for a room.
   * GET /rooms/{roomId}/participants
   * @param {string} roomToken
   * @param {string} roomId
   * @returns {Promise<{ participants: Array }>}
   */
  async getParticipants(roomToken, roomId) {
    if (!roomToken) throw new ApiError('Room token required', 'unauthorized', 401);
    if (!roomId) throw new ApiError('roomId is required', 'bad_request', 400);

    const data = await this._request(`/rooms/${encodeURIComponent(roomId)}/participants`, {
      method: 'GET',
      token: roomToken
    });

    const participants = Array.isArray(data?.participants) ? data.participants : [];
    return {
      participants: participants.map(normalizeParticipant)
    };
  }

  /**
   * Retrieves unread count and last read sequence for a room.
   * GET /rooms/{roomId}/unread
   * @param {string} roomToken
   * @param {string} roomId
   * @returns {Promise<{ unreadCount: number, lastReadSeq: number }>}
   */
  async getUnread(roomToken, roomId) {
    if (!roomToken) throw new ApiError('Room token required', 'unauthorized', 401);
    if (!roomId) throw new ApiError('roomId is required', 'bad_request', 400);

    const data = await this._request(`/rooms/${encodeURIComponent(roomId)}/unread`, {
      method: 'GET',
      token: roomToken
    });

    return {
      unreadCount: data?.unread_count ?? data?.unreadCount ?? 0,
      lastReadSeq: data?.last_read_seq ?? data?.lastReadSeq ?? 0,
      unread_count: data?.unread_count ?? data?.unreadCount ?? 0,
      last_read_seq: data?.last_read_seq ?? data?.lastReadSeq ?? 0
    };
  }

  /**
   * REST fallback: marks a message as delivered.
   * POST /rooms/{roomId}/messages/{messageId}/delivered
   * @param {string} roomToken
   * @param {string} roomId
   * @param {string} messageId
   * @returns {Promise<object>}
   */
  async markDelivered(roomToken, roomId, messageId) {
    if (!roomToken) throw new ApiError('Room token required', 'unauthorized', 401);
    if (!roomId) throw new ApiError('roomId is required', 'bad_request', 400);
    if (!messageId) throw new ApiError('messageId is required', 'bad_request', 400);

    return this._request(`/rooms/${encodeURIComponent(roomId)}/messages/${encodeURIComponent(messageId)}/delivered`, {
      method: 'POST',
      token: roomToken,
      body: {}
    });
  }

  /**
   * REST fallback: marks a message as read.
   * POST /rooms/{roomId}/messages/{messageId}/read
   * @param {string} roomToken
   * @param {string} roomId
   * @param {string} messageId
   * @returns {Promise<object>}
   */
  async markRead(roomToken, roomId, messageId) {
    if (!roomToken) throw new ApiError('Room token required', 'unauthorized', 401);
    if (!roomId) throw new ApiError('roomId is required', 'bad_request', 400);
    if (!messageId) throw new ApiError('messageId is required', 'bad_request', 400);

    return this._request(`/rooms/${encodeURIComponent(roomId)}/messages/${encodeURIComponent(messageId)}/read`, {
      method: 'POST',
      token: roomToken,
      body: {}
    });
  }

  /**
   * Searches messages within a specific room.
   * GET /rooms/{roomId}/messages/search?q={query}&limit={limit}
   * @param {string} roomToken
   * @param {string} roomId
   * @param {string} query
   * @param {object} [options={}]
   * @param {number} [options.limit=20]
   * @returns {Promise<{ messages: Array, hasMore: boolean }>}
   */
  async searchMessages(roomToken, roomId, query, { limit = 20 } = {}) {
    if (!roomToken) throw new ApiError('Room token required', 'unauthorized', 401);
    if (!roomId) throw new ApiError('roomId is required', 'bad_request', 400);
    if (typeof query !== 'string' || !query.trim()) {
      return { messages: [], hasMore: false, has_more: false };
    }

    const endpoint = `/rooms/${encodeURIComponent(roomId)}/messages/search?q=${encodeURIComponent(query.trim())}&limit=${encodeURIComponent(limit)}`;
    const data = await this._request(endpoint, {
      method: 'GET',
      token: roomToken
    });

    const messages = Array.isArray(data?.messages) ? data.messages : [];
    const hasMore = Boolean(data?.has_more ?? data?.hasMore ?? false);

    return {
      messages: messages.map(normalizeMessage),
      hasMore,
      has_more: hasMore
    };
  }

  // ═════════════════════════════════════════════════════════════════
  // CONFIRMED ROOM WRITES & GROUP MANAGEMENT (OllacoreApi.kt)
  // ═════════════════════════════════════════════════════════════════

  /**
   * REST send message fallback matching OllacoreApi.kt:175.
   * POST /rooms/{roomId}/messages
   */
  async sendMessage(roomToken, roomId, {
    clientMessageId,
    body,
    kind = 'text',
    replyTo = null,
    attachmentIds = []
  }) {
    if (!roomToken) throw new ApiError('Room token required', 'unauthorized', 401);
    if (!roomId) throw new ApiError('roomId is required', 'bad_request', 400);

    const payload = {
      client_message_id: clientMessageId,
      kind,
      body: body && typeof body === 'object' ? body : {},
      attachment_ids: Array.isArray(attachmentIds) ? attachmentIds : []
    };
    if (replyTo) payload.reply_to = replyTo;

    const data = await this._request(`/rooms/${encodeURIComponent(roomId)}/messages`, {
      method: 'POST',
      token: roomToken,
      body: payload
    });

    return normalizeMessage(data);
  }

  /**
   * REST edit message matching OllacoreApi.kt:186.
   * PATCH /rooms/{roomId}/messages/{messageId}
   */
  async editMessage(roomToken, roomId, messageId, body) {
    if (!roomToken) throw new ApiError('Room token required', 'unauthorized', 401);
    if (!roomId || !messageId) throw new ApiError('roomId and messageId are required', 'bad_request', 400);

    const data = await this._request(`/rooms/${encodeURIComponent(roomId)}/messages/${encodeURIComponent(messageId)}`, {
      method: 'PATCH',
      token: roomToken,
      body: { body: body && typeof body === 'object' ? body : {} }
    });

    return normalizeMessage(data);
  }

  /**
   * REST delete message matching OllacoreApi.kt:197.
   * DELETE /rooms/{roomId}/messages/{messageId}
   */
  async deleteMessage(roomToken, roomId, messageId) {
    if (!roomToken) throw new ApiError('Room token required', 'unauthorized', 401);
    if (!roomId || !messageId) throw new ApiError('roomId and messageId are required', 'bad_request', 400);

    await this._request(`/rooms/${encodeURIComponent(roomId)}/messages/${encodeURIComponent(messageId)}`, {
      method: 'DELETE',
      token: roomToken
    });

    return { success: true };
  }

  /**
   * Adds reaction to message matching OllacoreApi.kt:206.
   * POST /rooms/{roomId}/messages/{messageId}/reactions
   */
  async addReaction(roomToken, roomId, messageId, emoji) {
    if (!roomToken) throw new ApiError('Room token required', 'unauthorized', 401);
    if (!roomId || !messageId) throw new ApiError('roomId and messageId are required', 'bad_request', 400);
    if (!emoji || typeof emoji !== 'string') throw new ApiError('emoji is required', 'bad_request', 400);

    const data = await this._request(`/rooms/${encodeURIComponent(roomId)}/messages/${encodeURIComponent(messageId)}/reactions`, {
      method: 'POST',
      token: roomToken,
      body: { emoji }
    });

    return data;
  }

  /**
   * Removes reaction from message matching OllacoreApi.kt:217.
   * DELETE /rooms/{roomId}/messages/{messageId}/reactions
   */
  async removeReaction(roomToken, roomId, messageId, emoji) {
    if (!roomToken) throw new ApiError('Room token required', 'unauthorized', 401);
    if (!roomId || !messageId) throw new ApiError('roomId and messageId are required', 'bad_request', 400);
    if (!emoji || typeof emoji !== 'string') throw new ApiError('emoji is required', 'bad_request', 400);

    const data = await this._request(`/rooms/${encodeURIComponent(roomId)}/messages/${encodeURIComponent(messageId)}/reactions`, {
      method: 'DELETE',
      token: roomToken,
      body: { emoji }
    });

    return data || { success: true };
  }

  /**
   * Adds member to group (OllacoreApi.kt:268).
   * POST /rooms/{roomId}/members
   */
  async addMember(roomToken, roomId, userId) {
    if (!roomToken) throw new ApiError('Room token required', 'unauthorized', 401);
    await this._request(`/rooms/${encodeURIComponent(roomId)}/members`, {
      method: 'POST',
      token: roomToken,
      body: { user_id: userId }
    });
    return { success: true };
  }

  /**
   * Removes member from group (OllacoreApi.kt:279).
   * DELETE /rooms/{roomId}/members/{principalId}
   */
  async removeMember(roomToken, roomId, principalId) {
    if (!roomToken) throw new ApiError('Room token required', 'unauthorized', 401);
    await this._request(`/rooms/${encodeURIComponent(roomId)}/members/${encodeURIComponent(principalId)}`, {
      method: 'DELETE',
      token: roomToken
    });
    return { success: true };
  }

  /**
   * Leaves group (OllacoreApi.kt:289).
   * DELETE /rooms/{roomId}/members/me
   */
  async leaveGroup(roomToken, roomId) {
    if (!roomToken) throw new ApiError('Room token required', 'unauthorized', 401);
    await this._request(`/rooms/${encodeURIComponent(roomId)}/members/me`, {
      method: 'DELETE',
      token: roomToken
    });
    return { success: true };
  }

  /**
   * Sets member role (OllacoreApi.kt:310).
   * POST /rooms/{roomId}/members/{principalId}/role
   */
  async setMemberRole(roomToken, roomId, principalId, role) {
    if (!roomToken) throw new ApiError('Room token required', 'unauthorized', 401);
    await this._request(`/rooms/${encodeURIComponent(roomId)}/members/${encodeURIComponent(principalId)}/role`, {
      method: 'POST',
      token: roomToken,
      body: { role }
    });
    return { success: true };
  }

  /**
   * Creates invite link/code (OllacoreApi.kt:321).
   * POST /rooms/{roomId}/invites
   */
  async createInvite(roomToken, roomId) {
    if (!roomToken) throw new ApiError('Room token required', 'unauthorized', 401);
    const data = await this._request(`/rooms/${encodeURIComponent(roomId)}/invites`, {
      method: 'POST',
      token: roomToken,
      body: {}
    });
    return data;
  }

  // ═════════════════════════════════════════════════════════════════
  // ATTACHMENTS & MEDIA (OllacoreApi.kt:330-365)
  // ═════════════════════════════════════════════════════════════════

  /**
   * Initializes a single PUT attachment upload.
   * POST /rooms/{roomId}/attachments/init
   * @param {string} roomToken
   * @param {string} roomId
   * @param {object} params
   * @param {string} params.filename
   * @param {string} params.mime
   * @param {number} params.byteSize
   * @returns {Promise<{ attachmentId: string, uploadUrl: string, expiresAt: string, attachment_id: string, upload_url: string, expires_at: string }>}
   */
  async initAttachment(roomToken, roomId, { filename, mime, byteSize }) {
    if (!roomToken) throw new ApiError('Room token required', 'unauthorized', 401);
    if (!roomId) throw new ApiError('roomId is required', 'bad_request', 400);
    if (!filename) throw new ApiError('filename is required', 'bad_request', 400);

    const data = await this._request(`/rooms/${encodeURIComponent(roomId)}/attachments/init`, {
      method: 'POST',
      token: roomToken,
      body: {
        original_name: filename,
        filename,
        declared_mime: mime || 'application/octet-stream',
        mime: mime || 'application/octet-stream',
        byte_size: byteSize || 0
      }
    });

    return {
      attachmentId: data?.attachment_id || '',
      uploadUrl: data?.upload_url || '',
      expiresAt: data?.expires_at || data?.upload_expires_at || null,
      requiredHeaders: Array.isArray(data?.required_headers) ? data.required_headers : [],
      attachment_id: data?.attachment_id || '',
      upload_url: data?.upload_url || '',
      upload_expires_at: data?.upload_expires_at || null,
      expires_at: data?.expires_at || data?.upload_expires_at || null,
      required_headers: Array.isArray(data?.required_headers) ? data.required_headers : []
    };
  }

  /**
   * Marks a single PUT attachment upload as complete.
   * POST /rooms/{roomId}/attachments/{attachmentId}/complete
   * @param {string} roomToken
   * @param {string} roomId
   * @param {string} attachmentId
   * @returns {Promise<object>}
   */
  async completeAttachment(roomToken, roomId, attachmentId) {
    if (!roomToken) throw new ApiError('Room token required', 'unauthorized', 401);
    if (!roomId || !attachmentId) throw new ApiError('roomId and attachmentId are required', 'bad_request', 400);

    const data = await this._request(`/rooms/${encodeURIComponent(roomId)}/attachments/${encodeURIComponent(attachmentId)}/complete`, {
      method: 'POST',
      token: roomToken,
      body: {}
    });

    return data || { success: true };
  }

  /**
   * Resolves a presigned download URL for an attachment.
   * GET /rooms/{roomId}/attachments/{attachmentId}/download
   * @param {string} roomToken
   * @param {string} roomId
   * @param {string} attachmentId
   * @returns {Promise<{ downloadUrl: string, expiresAt: string, download_url: string, expires_at: string }>}
   */
  async downloadAttachment(roomToken, roomId, attachmentId) {
    if (!roomToken) throw new ApiError('Room token required', 'unauthorized', 401);
    if (!roomId || !attachmentId) throw new ApiError('roomId and attachmentId are required', 'bad_request', 400);

    const data = await this._request(`/rooms/${encodeURIComponent(roomId)}/attachments/${encodeURIComponent(attachmentId)}/download`, {
      method: 'GET',
      token: roomToken
    });

    return {
      downloadUrl: data?.download_url || '',
      expiresAt: data?.expires_at || null,
      download_url: data?.download_url || '',
      expires_at: data?.expires_at || null
    };
  }

  /**
   * Initializes a multipart attachment upload for files > 10MB.
   * POST /rooms/{roomId}/attachments/init-multipart
   * @param {string} roomToken
   * @param {string} roomId
   * @param {object} params
   * @param {string} params.filename
   * @param {string} params.mime
   * @param {number} params.byteSize
   * @param {number} [params.partSize=8388608]
   * @returns {Promise<object>}
   */
  async initMultipartUpload(roomToken, roomId, { filename, mime, byteSize, partSize = 8388608 }) {
    if (!roomToken) throw new ApiError('Room token required', 'unauthorized', 401);
    if (!roomId) throw new ApiError('roomId is required', 'bad_request', 400);
    if (!filename) throw new ApiError('filename is required', 'bad_request', 400);

    const data = await this._request(`/rooms/${encodeURIComponent(roomId)}/attachments/init-multipart`, {
      method: 'POST',
      token: roomToken,
      body: {
        original_name: filename,
        declared_mime: mime || 'application/octet-stream',
        byte_size: byteSize,
        part_size: partSize
      }
    });

    return {
      attachmentId: data?.attachment_id || '',
      uploadId: data?.upload_id || '',
      partSize: data?.part_size || partSize,
      partUrls: Array.isArray(data?.part_urls) ? data.part_urls : [],
      expiresAt: data?.expires_at || null,
      attachment_id: data?.attachment_id || '',
      upload_id: data?.upload_id || '',
      part_size: data?.part_size || partSize,
      part_urls: Array.isArray(data?.part_urls) ? data.part_urls : [],
      expires_at: data?.expires_at || null
    };
  }

  /**
   * Completes a multipart attachment upload.
   * POST /rooms/{roomId}/attachments/{attachmentId}/complete-multipart
   * @param {string} roomToken
   * @param {string} roomId
   * @param {string} attachmentId
   * @param {Array<{ partNumber: number, etag: string }>} parts
   * @returns {Promise<object>}
   */
  async completeMultipartUpload(roomToken, roomId, attachmentId, parts = []) {
    if (!roomToken) throw new ApiError('Room token required', 'unauthorized', 401);
    if (!roomId || !attachmentId) throw new ApiError('roomId and attachmentId are required', 'bad_request', 400);

    const formattedParts = parts.map(p => ({
      part_number: p.partNumber ?? p.part_number,
      etag: p.etag ?? p.eTag ?? ''
    }));

    const data = await this._request(`/rooms/${encodeURIComponent(roomId)}/attachments/${encodeURIComponent(attachmentId)}/complete-multipart`, {
      method: 'POST',
      token: roomToken,
      body: { parts: formattedParts }
    });

    return data || { success: true };
  }

  // ═════════════════════════════════════════════════════════════════
  // DIRECTORY PLANE: BLOCKS & CONVERSATION MUTE
  // ═════════════════════════════════════════════════════════════════

  /**
   * Blocks a contact by user ID.
   * Conforms to POST /directory/blocks with fallback to PUT /directory/blocks/{userId}
   * @param {string} sessionToken Bearer session token
   * @param {string} userId The target user ID to block
   * @returns {Promise<{ blocked: boolean, userId: string, user_id: string, since: string|null }>}
   */
  async blockUser(sessionToken, userId) {
    if (!sessionToken) throw new ApiError('Session token required', 'unauthorized', 401);
    if (!userId || typeof userId !== 'string' || !userId.trim()) {
      throw new ApiError('Valid userId required', 'bad_request', 400);
    }
    const cleanId = userId.trim();
    let data;
    try {
      data = await this._request(`/directory/blocks/${encodeURIComponent(cleanId)}`, {
        method: 'PUT',
        token: sessionToken
      });
    } catch (err) {
      if (err?.status === 404 || err?.status === 405) {
        data = await this._request('/directory/blocks', {
          method: 'POST',
          token: sessionToken,
          body: { user_id: cleanId, userId: cleanId }
        });
      } else {
        throw err;
      }
    }
    return {
      blocked: data?.blocked !== false,
      userId: data?.user_id || data?.userId || cleanId,
      user_id: data?.user_id || data?.userId || cleanId,
      since: data?.since || new Date().toISOString()
    };
  }

  /**
   * Unblocks a contact by user ID.
   * DELETE /directory/blocks/{userId} with fallback to DELETE /directory/blocks
   * @param {string} sessionToken Bearer session token
   * @param {string} userId The target user ID to unblock
   * @returns {Promise<{ blocked: boolean, userId: string, user_id: string }>}
   */
  async unblockUser(sessionToken, userId) {
    if (!sessionToken) throw new ApiError('Session token required', 'unauthorized', 401);
    if (!userId || typeof userId !== 'string' || !userId.trim()) {
      throw new ApiError('Valid userId required', 'bad_request', 400);
    }
    const cleanId = userId.trim();
    let data;
    try {
      data = await this._request(`/directory/blocks/${encodeURIComponent(cleanId)}`, {
        method: 'DELETE',
        token: sessionToken
      });
    } catch (err) {
      if (err?.status === 404 || err?.status === 405) {
        data = await this._request('/directory/blocks', {
          method: 'DELETE',
          token: sessionToken,
          body: { user_id: cleanId, userId: cleanId }
        });
      } else {
        throw err;
      }
    }
    return {
      blocked: Boolean(data?.blocked),
      userId: data?.user_id || data?.userId || cleanId,
      user_id: data?.user_id || data?.userId || cleanId
    };
  }

  /**
   * Lists all blocked contacts for the authenticated user.
   * GET /directory/blocks (supports data.blocks, data.user_ids, and data.blocked_users)
   * @param {string} sessionToken Bearer session token
   * @returns {Promise<{ blocks: Array<object>, user_ids: string[] }>}
   */
  async listBlockedUsers(sessionToken) {
    if (!sessionToken) throw new ApiError('Session token required', 'unauthorized', 401);
    const data = await this._request('/directory/blocks', {
      method: 'GET',
      token: sessionToken
    });
    const rawItems = Array.isArray(data?.blocks)
      ? data.blocks
      : (Array.isArray(data?.user_ids)
        ? data.user_ids
        : (Array.isArray(data?.blocked_users)
          ? data.blocked_users
          : (Array.isArray(data) ? data : [])));
    const items = rawItems.map(normalizeBlockItem).filter(Boolean);
    return {
      blocks: items,
      user_ids: items.map((b) => b.userId)
    };
  }

  /**
   * Mutes notification alerts for a conversation for a specified duration.
   * PUT /directory/conversations/{roomId}/mute
   * @param {string} sessionToken Bearer session token
   * @param {string} roomId The conversation room ID
   * @param {'8h'|'1w'|'always'} duration Duration choice: '8h', '1w', or 'always'
   * @returns {Promise<{ roomId: string, room_id: string, mutedUntil: string|null, muted_until: string|null }>}
   */
  async muteConversation(sessionToken, roomId, duration) {
    if (!sessionToken) throw new ApiError('Session token required', 'unauthorized', 401);
    if (!roomId || typeof roomId !== 'string' || !roomId.trim()) {
      throw new ApiError('Valid roomId required', 'bad_request', 400);
    }
    const validDurations = new Set(['8h', '1w', 'always']);
    const durStr = String(duration || '').trim().toLowerCase();
    if (!validDurations.has(durStr)) {
      throw new ApiError('Duration must be one of: 8h, 1w, always', 'bad_request', 400);
    }
    const cleanRoomId = roomId.trim();
    const data = await this._request(`/directory/conversations/${encodeURIComponent(cleanRoomId)}/mute`, {
      method: 'PUT',
      token: sessionToken,
      body: { duration: durStr }
    });
    return {
      roomId: data?.room_id || cleanRoomId,
      room_id: data?.room_id || cleanRoomId,
      mutedUntil: data?.muted_until || null,
      muted_until: data?.muted_until || null
    };
  }

  /**
   * Unmutes notification alerts for a conversation.
   * DELETE /directory/conversations/{roomId}/mute
   * @param {string} sessionToken Bearer session token
   * @param {string} roomId The conversation room ID
   * @returns {Promise<{ roomId: string, room_id: string, mutedUntil: null, muted_until: null }>}
   */
  async unmuteConversation(sessionToken, roomId) {
    if (!sessionToken) throw new ApiError('Session token required', 'unauthorized', 401);
    if (!roomId || typeof roomId !== 'string' || !roomId.trim()) {
      throw new ApiError('Valid roomId required', 'bad_request', 400);
    }
    const cleanRoomId = roomId.trim();
    const data = await this._request(`/directory/conversations/${encodeURIComponent(cleanRoomId)}/mute`, {
      method: 'DELETE',
      token: sessionToken
    });
    return {
      roomId: data?.room_id || cleanRoomId,
      room_id: data?.room_id || cleanRoomId,
      mutedUntil: null,
      muted_until: null
    };
  }
}

