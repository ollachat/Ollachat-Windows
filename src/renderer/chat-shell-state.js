/**
 * Chat Shell State & Formatting Utilities
 * Manages conversation list state, active selection, WebSocket status, search filtering,
 * and display formatting for the OllaChat Windows desktop client.
 */

let _defaultNicknameResolver = null;

/**
 * Sets the default contact nickname resolver function.
 * @param {Function|null} resolver
 */
export function setDefaultNicknameResolver(resolver) {
  _defaultNicknameResolver = typeof resolver === 'function' ? resolver : null;
}

export const REACTION_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];

/**
 * Derives a human-readable title for a conversation item.
 * Supports personal contact nickname overrides for direct contacts.
 * Precedence: Personal Nickname -> Server Name/Title -> Server displayName -> Phone -> User ID -> Fallback.
 * @param {object} item Normalized inbox item
 * @param {Function|Map|object|string} [customNicknameResolver] Optional nickname resolver or override
 * @returns {string}
 */
export function getConversationTitle(item, customNicknameResolver) {
  if (!item || typeof item !== 'object') return 'Conversation';

  const isGroup = item.kind === 'group' || item.isGroup === true;
  const peerUserId = (!isGroup && item.peer && (item.peer.userId || item.peer.id)) ||
                     (!isGroup && (item.userId || item.id || item.peerUserId || item.peer_user_id)) ||
                     null;

  let nickname = null;
  const resolver = typeof customNicknameResolver === 'function'
    ? customNicknameResolver
    : (customNicknameResolver && typeof customNicknameResolver.get === 'function'
      ? (id) => customNicknameResolver.get(id)
      : (customNicknameResolver && typeof customNicknameResolver === 'object'
        ? (id) => customNicknameResolver[id]
        : (typeof customNicknameResolver === 'string' && customNicknameResolver.trim()
          ? () => customNicknameResolver.trim()
          : _defaultNicknameResolver)));

  if (peerUserId && resolver) {
    nickname = resolver(peerUserId);
  }
  if (!nickname && !isGroup && typeof item.nickname === 'string' && item.nickname.trim() !== '') {
    nickname = item.nickname.trim();
  }

  if (nickname && typeof nickname === 'string' && nickname.trim() !== '') {
    return nickname.trim();
  }

  if (item.name && typeof item.name === 'string' && item.name.trim() !== '') {
    return item.name.trim();
  }
  if (item.title && typeof item.title === 'string' && item.title.trim() !== '') {
    return item.title.trim();
  }
  if (item.peer && typeof item.peer === 'object') {
    const dn = item.peer.displayName || item.peer.display_name;
    if (dn && typeof dn === 'string' && dn.trim() !== '') {
      return dn.trim();
    }
    if (item.peer.phone && typeof item.peer.phone === 'string' && item.peer.phone.trim() !== '') {
      return item.peer.phone.trim();
    }
    const pId = item.peer.userId || item.peer.user_id || item.peer.id;
    if (pId && typeof pId === 'string' && pId.trim() !== '') {
      return pId.trim();
    }
  }
  return isGroup ? 'Group Conversation' : 'Direct Conversation';
}

/**
 * Derives subtitle / info line for chat header.
 * @param {object} item Normalized inbox item
 * @returns {string}
 */
export function getConversationSubtitle(item) {
  if (!item || typeof item !== 'object') return '';
  if (item.kind === 'group' || item.isGroup) {
    if (typeof item.participantCount === 'number' && item.participantCount > 0) {
      return `${item.participantCount} members`;
    }
    if (Array.isArray(item.participants) && item.participants.length > 0) {
      return `${item.participants.length} members`;
    }
    return 'Group conversation';
  }
  if (item.peer && typeof item.peer === 'object') {
    if (item.peer.phone && typeof item.peer.phone === 'string') {
      return item.peer.phone;
    }
  }
  if (item.phone && typeof item.phone === 'string') {
    return item.phone;
  }
  return 'Direct chat';
}

/**
 * Resolves the other participant's user/principal ID for a direct conversation.
 * @param {object} item
 * @param {string|null} [currentUserId=null]
 * @returns {string|null}
 */
export function getDirectPeerUserId(item, currentUserId = null) {
  if (!item) return null;
  if (typeof item === 'string') {
    if (item.startsWith('direct:')) return item.slice('direct:'.length);
    if (item.startsWith('dm_')) {
      const parts = item.slice(3).split('_');
      if (parts.length === 2 && currentUserId) {
        if (parts[0].toLowerCase().trim() === String(currentUserId).toLowerCase().trim()) return parts[1];
        if (parts[1].toLowerCase().trim() === String(currentUserId).toLowerCase().trim()) return parts[0];
      }
    }
    return null;
  }
  if (typeof item !== 'object') return null;
  if (item.kind === 'group' || item.isGroup) return null;

  // 1. Direct peer object (supports both camelCase and snake_case backend keys)
  if (item.peer && typeof item.peer === 'object') {
    const pId = item.peer.userId || item.peer.user_id || item.peer.id || item.peer.peerId || item.peer.peer_id || item.peer.principalId || item.peer.principal_id;
    if (pId) return String(pId);
  } else if (item.peer && typeof item.peer === 'string' && item.peer.trim()) {
    return String(item.peer.trim());
  }

  // 2. Direct top-level peer fields
  const directId = item.peerUserId || item.peer_user_id || item.peerId || item.peer_id || item.otherUserId || item.other_user_id;
  if (directId) return String(directId);

  // 3. Participants array in 1-to-1 conversation
  if (Array.isArray(item.participants)) {
    const other = item.participants.find((p) => {
      const pId = typeof p === 'string' ? p : (p.userId || p.user_id || p.principalId || p.principal_id || p.id);
      return pId && (!currentUserId || String(pId).toLowerCase().trim() !== String(currentUserId).toLowerCase().trim());
    });
    if (other) {
      return String(typeof other === 'string' ? other : (other.userId || other.user_id || other.principalId || other.principal_id || other.id));
    }
  }

  // 4. RoomId pattern fallback (e.g. direct:<userId> or dm_<myId>_<otherId>)
  const rId = item.roomId || item.room_id || item.id;
  if (typeof rId === 'string') {
    if (rId.startsWith('direct:')) {
      return rId.slice('direct:'.length);
    }
    if (rId.startsWith('dm_')) {
      const rest = rId.slice(3);
      if (currentUserId) {
        const cId = String(currentUserId).trim().toLowerCase();
        const restLower = rest.toLowerCase();
        if (restLower.startsWith(cId + '_')) {
          return rest.slice(cId.length + 1);
        }
        if (restLower.endsWith('_' + cId)) {
          return rest.slice(0, rest.length - cId.length - 1);
        }
      }
      const parts = rest.split('_');
      if (parts.length === 2 && currentUserId) {
        if (parts[0].toLowerCase().trim() === String(currentUserId).toLowerCase().trim()) return parts[1];
        if (parts[1].toLowerCase().trim() === String(currentUserId).toLowerCase().trim()) return parts[0];
      }
    }
  }

  // 5. item.userId (only if item is not the current user)
  if (item.userId && (!currentUserId || String(item.userId).toLowerCase().trim() !== String(currentUserId).toLowerCase().trim())) {
    return String(item.userId);
  }

  return null;
}

/**
 * Derives real-time WhatsApp-style header status for a conversation.
 * - For groups: member count / group subtitle
 * - For direct chats:
 *   - "typing…" if peer is typing
 *   - "online" if peer is online
 *   - Peer's phone number or fallback subtitle if offline
 * @param {object} item Normalized conversation item
 * @param {{ isTyping?: boolean, isOnline?: boolean }} [options]
 * @returns {string}
 */
export function getConversationHeaderStatus(item, { isTyping = false, isOnline = false } = {}) {
  if (!item || typeof item !== 'object') return '';
  const isGroup = item.kind === 'group' || item.isGroup === true;
  if (isGroup) {
    return getConversationSubtitle(item);
  }

  if (isTyping) {
    return 'typing…';
  }
  if (isOnline) {
    return 'online';
  }
  return getConversationSubtitle(item);
}

/**
 * Generates 1-2 letter avatar initials from a title string.
 * @param {string} title
 * @returns {string}
 */
export function getAvatarInitials(title) {
  if (!title || typeof title !== 'string') return 'OC';
  const clean = title.trim();
  if (clean.length === 0) return 'OC';

  // If title starts with a phone number +
  if (clean.startsWith('+')) {
    const digits = clean.replace(/\D/g, '');
    return digits.length >= 2 ? digits.slice(-2) : '📞';
  }

  const parts = clean.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return clean.slice(0, 2).toUpperCase();
}

/**
 * Generates a deterministic, pleasing HSL background color for an avatar.
 * @param {string} str
 * @returns {string}
 */
export function getAvatarColor(str) {
  if (!str || typeof str !== 'string') return 'hsl(168, 60%, 40%)';
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hues = [168, 200, 220, 260, 290, 330, 25, 45, 145];
  const hue = hues[Math.abs(hash) % hues.length];
  return `hsl(${hue}, 55%, 42%)`;
}

/**
 * Formats an ISO date/timestamp string into a friendly desktop messaging time label.
 * @param {string|number|Date|null} timestamp
 * @param {Date} [now=new Date()]
 * @returns {string}
 */
export function formatConversationTime(timestamp, now = new Date()) {
  if (!timestamp) return '';
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';

  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  if (isToday) {
    let hours = date.getHours();
    const minutes = date.getMinutes().toString().padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12 || 12;
    return `${hours}:${minutes} ${ampm}`;
  }

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday =
    date.getFullYear() === yesterday.getFullYear() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getDate() === yesterday.getDate();

  if (isYesterday) {
    return 'Yesterday';
  }

  const diffDays = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));
  if (diffDays > 0 && diffDays < 7) {
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return days[date.getDay()];
  }

  const day = date.getDate().toString().padStart(2, '0');
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const year = date.getFullYear().toString().slice(-2);
  return `${day}/${month}/${year}`;
}

/**
 * Retrieves preview text for last message.
 * @param {object} item Normalized inbox item
 * @returns {string}
 */
export function getConversationPreview(item) {
  if (!item || !item.lastMessage) return 'No messages yet';
  const kind = item.lastMessage.kind || 'text';
  if (kind === 'call') {
    if (typeof item.lastMessage.preview === 'string' && item.lastMessage.preview.trim() !== '') {
      return item.lastMessage.preview.trim();
    }
    const isVideo = Boolean(
      item.lastMessage.isVideo ||
      item.lastMessage.callType === 'video' ||
      item.lastMessage.body?.call_type === 'video'
    );
    return isVideo ? '📹 Video call' : '📞 Audio call';
  }
  if (typeof item.lastMessage.preview === 'string' && item.lastMessage.preview.trim() !== '') {
    return item.lastMessage.preview.trim();
  }
  if (kind === 'image') return '📷 Photo';
  if (kind === 'video') return '🎥 Video';
  if (kind === 'audio') return '🎵 Voice message';
  if (kind === 'file') return '📎 Attachment';
  return 'Message';
}

/**
 * Filters conversations matching search query.
 * Matches against personal contact nickname, server title/displayName, phone number, and message preview.
 * @param {Array} conversations
 * @param {string} query
 * @param {Function|Map|object} [nicknameResolver]
 * @returns {Array}
 */
export function filterConversations(conversations, query, nicknameResolver) {
  if (!Array.isArray(conversations)) return [];
  if (!query || typeof query !== 'string' || query.trim() === '') {
    return conversations;
  }
  const q = query.trim().toLowerCase();
  return conversations.filter((item) => {
    const title = getConversationTitle(item, nicknameResolver).toLowerCase();
    if (title.includes(q)) return true;
    if (item.name && typeof item.name === 'string' && item.name.toLowerCase().includes(q)) return true;
    if (item.title && typeof item.title === 'string' && item.title.toLowerCase().includes(q)) return true;
    if (item.peer?.displayName && item.peer.displayName.toLowerCase().includes(q)) return true;
    if (item.peer?.phone && item.peer.phone.toLowerCase().includes(q)) return true;
    if (item.lastMessage?.preview && item.lastMessage.preview.toLowerCase().includes(q)) return true;
    return false;
  });
}

/**
 * Formats call duration in seconds to display string (e.g. 00:32, 04:15, 1:02:45).
 * @param {number} totalSec
 * @returns {string}
 */
export function formatCallDuration(totalSec) {
  if (typeof totalSec !== 'number' || isNaN(totalSec) || totalSec <= 0) return '';
  const sec = Math.round(totalSec);
  const hours = Math.floor(sec / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  const seconds = sec % 60;

  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');

  if (hours > 0) {
    const hh = String(hours);
    return `${hh}:${mm}:${ss}`;
  }
  return `${mm}:${ss}`;
}

/**
 * Formats call duration for WhatsApp-style chat timeline cards (e.g. 12s, 1m 24s, 1h 5m).
 * @param {number} totalSec
 * @returns {string}
 */
export function formatCallTimelineDuration(totalSec) {
  if (typeof totalSec !== 'number' || isNaN(totalSec) || totalSec <= 0) return '0s';
  const sec = Math.round(totalSec);
  const hours = Math.floor(sec / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  const seconds = sec % 60;

  if (hours > 0) {
    let res = `${hours}h`;
    if (minutes > 0) res += ` ${minutes}m`;
    if (seconds > 0) res += ` ${seconds}s`;
    return res;
  }
  if (minutes > 0) {
    let res = `${minutes}m`;
    if (seconds > 0) res += ` ${seconds}s`;
    return res;
  }
  return `${seconds}s`;
}

/**
 * Checks if a message is an in-band call signaling message or legacy call tombstone.
 * Does NOT classify ordinary user-deleted messages or timeline call cards as call signals.
 * @param {object} message
 * @returns {boolean}
 */
export function isCallSignalMessage(message) {
  if (!message || typeof message !== 'object') return false;
  if (message.isCallEntry === true || message.kind === 'call') return false;

  const cid = message.clientMessageId || message.client_message_id || '';
  if (typeof cid === 'string' && cid.startsWith('call_sig_')) {
    return true;
  }

  const body = message.body;
  if (body && typeof body === 'object') {
    if (body.call_signal) return true;
    if (body.call_type && (body.text === '' || body.text === undefined)) return true;
  }

  return false;
}

/**
 * Retrieves persisted call records for a specific room from local storage.
 * @param {string} roomId
 * @param {string|null} [currentUserId=null]
 * @returns {Array<object>}
 */
export function getRoomCallRecords(roomId, currentUserId = null) {
  if (!roomId || typeof localStorage === 'undefined') return [];
  try {
    const key = `ollachat_room_calls_${currentUserId || 'default'}_${roomId}`;
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list : [];
  } catch (_) {
    return [];
  }
}

/**
 * Persists a room call record locally (max 100 per room, FIFO).
 * @param {string} roomId
 * @param {object} record
 * @param {string|null} [currentUserId=null]
 * @returns {object|null}
 */
export function saveRoomCallRecord(roomId, record, currentUserId = null) {
  if (!roomId || !record || typeof record !== 'object') return null;
  const existing = getRoomCallRecords(roomId, currentUserId);
  const callId = record.callId || record.id || '';
  const startedAt = typeof record.startedAt === 'number' ? record.startedAt : Date.now();
  const id = record.id || `call_${startedAt}_${Math.random().toString(36).substring(2, 8)}`;

  const entry = {
    id,
    callId,
    roomId,
    direction: record.direction === 'outgoing' ? 'outgoing' : 'incoming',
    callType: record.callType === 'video' || record.isVideo ? 'video' : 'voice',
    isVideo: Boolean(record.callType === 'video' || record.isVideo),
    status: ['completed', 'missed', 'declined', 'cancelled'].includes(record.status)
      ? record.status
      : 'completed',
    startedAt,
    endedAt: typeof record.endedAt === 'number' ? record.endedAt : (record.endedAt ? new Date(record.endedAt).getTime() : null),
    duration: typeof record.duration === 'number' ? Math.max(0, Math.round(record.duration)) : 0,
    participantId: record.participantId || '',
    participantName: record.participantName || '',
    participantPhone: record.participantPhone || '',
    participantAvatar: record.participantAvatar || ''
  };

  const idx = existing.findIndex((e) => (callId && e.callId === callId) || e.id === id);
  if (idx !== -1) {
    existing[idx] = entry;
  } else {
    existing.push(entry);
  }

  const capped = existing.slice(-100);
  try {
    if (typeof localStorage !== 'undefined') {
      const key = `ollachat_room_calls_${currentUserId || 'default'}_${roomId}`;
      localStorage.setItem(key, JSON.stringify(capped));
    }
  } catch (_) {}

  return entry;
}

/**
 * Clears persisted call records for a specific room.
 * @param {string} roomId
 * @param {string|null} [currentUserId=null]
 */
export function clearRoomCallRecords(roomId, currentUserId = null) {
  if (!roomId || typeof localStorage === 'undefined') return;
  try {
    const key = `ollachat_room_calls_${currentUserId || 'default'}_${roomId}`;
    localStorage.removeItem(key);
  } catch (_) {}
}

/**
 * Transforms a local room call record into a timeline message representation.
 * @param {object} record
 * @param {string|null} [currentUserId=null]
 * @returns {object|null}
 */
export function callRecordToMessage(record, currentUserId = null) {
  if (!record || typeof record !== 'object') return null;
  const isVideo = Boolean(record.callType === 'video' || record.isVideo);
  const startedAt = typeof record.startedAt === 'number' ? record.startedAt : Date.now();
  const isOutgoing = record.direction === 'outgoing';
  const effectiveSenderId = isOutgoing ? (currentUserId || 'self') : (record.participantId || 'peer');
  const isoTime = new Date(startedAt).toISOString();

  return {
    id: record.id || `call_${startedAt}`,
    callId: record.callId || '',
    roomId: record.roomId || '',
    kind: 'call',
    isCallEntry: true,
    direction: isOutgoing ? 'outgoing' : 'incoming',
    callType: isVideo ? 'video' : 'voice',
    isVideo,
    status: ['completed', 'missed', 'declined', 'cancelled'].includes(record.status) ? record.status : 'completed',
    duration: typeof record.duration === 'number' ? record.duration : 0,
    startedAt,
    endedAt: record.endedAt || null,
    participantId: record.participantId || '',
    participantName: record.participantName || '',
    participantPhone: record.participantPhone || '',
    participantAvatar: record.participantAvatar || '',
    createdAt: isoTime,
    created_at: isoTime,
    senderId: effectiveSenderId,
    sender_id: effectiveSenderId,
    body: {
      text: isVideo ? 'Video call' : 'Audio call'
    }
  };
}

/**
 * State Manager for the desktop chat application shell.
 */
export class ChatShellState {
  constructor() {
    this.conversations = [];
    this.searchQuery = '';
    this.selectedRoomId = null;
    this.isLoadingInbox = false;
    this.inboxError = null;
    this.wsState = 'disconnected';
    this.wsDetails = null;
    this.currentUser = null;
    this.activeFilter = 'all';
    this.pinnedRoomIds = new Set();
    this.favouriteRoomIds = new Set();
    this.customLists = [];
    this.archivedRoomIds = new Set();
    this.callHistory = [];
    this.contactInfoOpen = false;
    this.activeContactInfoRoomId = null;
    this._unreadMessageIds = new Map();
    this._markedUnreadRooms = new Set();
    this._unreadEditedMessages = new Map();
    this.contactNicknames = new Map();
    this.presenceByRoom = new Map();
    this.typingByRoom = new Map();
    this.pinnedMessages = new Map();
    this.roomParticipants = new Map();
    this.participantProfiles = new Map();
    this.selectedMessageIds = new Set();
    this.isMessageSelectionMode = false;
    this.blockedUserIds = new Set();
    this.blockedUsersMap = new Map();
    this._loadPreferences();
    setDefaultNicknameResolver((uId) => this.getContactNickname(uId));
  }

  /**
   * Sets authoritative blocked users from server or local database.
   * @param {Array<object>} blocks
   */
  setBlockedUsers(blocks = []) {
    this.blockedUserIds.clear();
    this.blockedUsersMap.clear();
    if (Array.isArray(blocks)) {
      for (const b of blocks) {
        const id = b.userId || b.user_id;
        if (id) {
          const cleanId = String(id).trim();
          this.blockedUserIds.add(cleanId);
          this.blockedUsersMap.set(cleanId, {
            userId: cleanId,
            displayName: b.displayName || b.display_name || null,
            phone: b.phone || null,
            since: b.since || null
          });
        }
      }
    }

    // Purge cached presence and typing across all rooms for all blocked users
    for (const blockedId of this.blockedUserIds) {
      if (this.presenceByRoom && typeof this.presenceByRoom.entries === 'function') {
        for (const [, pMap] of this.presenceByRoom.entries()) {
          if (pMap && typeof pMap.set === 'function') {
            pMap.set(blockedId, false);
          }
        }
      }
      if (this.typingByRoom && typeof this.typingByRoom.entries === 'function') {
        for (const [, tSet] of this.typingByRoom.entries()) {
          if (tSet && typeof tSet.delete === 'function') {
            tSet.delete(blockedId);
          }
        }
      }
    }

    // Invalidate cached avatar info on all conversations with blocked contacts
    if (Array.isArray(this.conversations)) {
      for (const conv of this.conversations) {
        if (!conv) continue;
        const peerId = conv.peerUserId || conv.peer_user_id || conv.peer?.userId || conv.peer?.user_id || (typeof this.getDirectPeerUserId === 'function' ? this.getDirectPeerUserId(conv) : getDirectPeerUserId(conv, this.currentUser?.userId));
        if (peerId && this.isUserBlocked(peerId)) {
          conv.isBlocked = true;
          conv.blocked = true;
          conv.avatarUrl = null;
          conv.avatar_url = null;
          if (conv.peer) {
            conv.peer.isBlocked = true;
            conv.peer.blocked = true;
            conv.peer.avatarUrl = null;
            conv.peer.avatar_url = null;
            conv.peer.avatarVersion = null;
            conv.peer.avatar_version = null;
          }
        }
      }
    }
  }

  /**
   * Checks whether a specific user ID is blocked.
   * @param {string} userId
   * @returns {boolean}
   */
  isUserBlocked(userId) {
    if (!userId) return false;
    return this.blockedUserIds.has(String(userId).trim());
  }

  /**
   * Checks whether a room corresponds to a blocked direct peer.
   * @param {string} roomId
   * @returns {boolean}
   */
  isRoomBlocked(roomId) {
    if (!roomId) return false;
    const conv = this.conversations.find((c) => c && (c.roomId === roomId || c.room_id === roomId || c.id === roomId));
    if (!conv || conv.kind === 'group' || conv.isGroup) return false;
    const peerId = conv.peerUserId || conv.peer_user_id || conv.peer?.userId || conv.peer?.user_id || conv.peer?.id || (typeof this.getDirectPeerUserId === 'function' ? this.getDirectPeerUserId(conv) : getDirectPeerUserId(conv, this.currentUser?.userId));
    return Boolean(peerId && this.isUserBlocked(peerId));
  }

  /**
   * Adds a blocked user to local state.
   * @param {object} user
   */
  addBlockedUser(user = {}) {
    const id = user.userId || user.user_id;
    if (!id) return;
    const cleanId = String(id).trim();
    this.blockedUserIds.add(cleanId);
    this.blockedUsersMap.set(cleanId, {
      userId: cleanId,
      displayName: user.displayName || user.display_name || null,
      phone: user.phone || null,
      since: user.since || new Date().toISOString()
    });

    // Purge cached presence and typing across all rooms for this user
    if (this.presenceByRoom && typeof this.presenceByRoom.entries === 'function') {
      for (const [, pMap] of this.presenceByRoom.entries()) {
        if (pMap && typeof pMap.set === 'function') {
          pMap.set(cleanId, false);
        }
      }
    }
    if (this.typingByRoom && typeof this.typingByRoom.entries === 'function') {
      for (const [, tSet] of this.typingByRoom.entries()) {
        if (tSet && typeof tSet.delete === 'function') {
          tSet.delete(cleanId);
        }
      }
    }

    // Invalidate cached avatar info on conversations with this direct contact
    if (Array.isArray(this.conversations)) {
      for (const conv of this.conversations) {
        if (!conv) continue;
        const peerId = conv.peerUserId || conv.peer_user_id || conv.peer?.userId || conv.peer?.user_id || (typeof this.getDirectPeerUserId === 'function' ? this.getDirectPeerUserId(conv) : getDirectPeerUserId(conv, this.currentUser?.userId));
        if (peerId && String(peerId).trim() === cleanId) {
          conv.isBlocked = true;
          conv.blocked = true;
          conv.avatarUrl = null;
          conv.avatar_url = null;
          if (conv.peer) {
            conv.peer.isBlocked = true;
            conv.peer.blocked = true;
            conv.peer.avatarUrl = null;
            conv.peer.avatar_url = null;
            conv.peer.avatarVersion = null;
            conv.peer.avatar_version = null;
          }
        }
      }
    }
  }

  /**
   * Removes a blocked user from local state.
   * @param {string} userId
   */
  removeBlockedUser(userId) {
    if (!userId) return;
    const cleanId = String(userId).trim();
    this.blockedUserIds.delete(cleanId);
    this.blockedUsersMap.delete(cleanId);

    if (Array.isArray(this.conversations)) {
      for (const conv of this.conversations) {
        if (!conv) continue;
        const peerId = conv.peerUserId || conv.peer_user_id || conv.peer?.userId || conv.peer?.user_id || (typeof this.getDirectPeerUserId === 'function' ? this.getDirectPeerUserId(conv) : getDirectPeerUserId(conv, this.currentUser?.userId));
        if (peerId && String(peerId).trim() === cleanId) {
          conv.isBlocked = false;
          conv.blocked = false;
          if (conv.peer) {
            conv.peer.isBlocked = false;
            conv.peer.blocked = false;
          }
        }
      }
    }
  }

  /**
   * Returns list of blocked user objects.
   * @returns {Array<object>}
   */
  getBlockedUsers() {
    return Array.from(this.blockedUsersMap.values());
  }

  /**
   * Checks if a conversation is actively muted.
   * Expired mutes return false.
   * @param {object|string} convOrRoomId
   * @returns {boolean}
   */
  isConversationMuted(convOrRoomId) {
    if (!convOrRoomId) return false;
    const conv = typeof convOrRoomId === 'string'
      ? this.conversations.find((c) => c.roomId === convOrRoomId)
      : convOrRoomId;
    if (!conv) return false;
    const mutedUntil = conv.mutedUntil || conv.muted_until;
    if (!mutedUntil) return false;
    const expiry = new Date(mutedUntil).getTime();
    if (Number.isNaN(expiry)) return false;
    return expiry > Date.now();
  }

  /**
   * Sets or updates mutedUntil for a conversation in local state.
   * @param {string} roomId
   * @param {string|null} mutedUntil
   */
  setConversationMuted(roomId, mutedUntil) {
    if (!roomId) return;
    const conv = this.conversations.find((c) => c.roomId === roomId);
    if (conv) {
      conv.mutedUntil = mutedUntil || null;
      conv.muted_until = mutedUntil || null;
    }
  }

  /**
   * Toggles message selection in selection mode.
   * Accepts either a message ID string or a message object.
   * @param {string|object} messageOrId
   * @returns {boolean} Whether message is now selected
   */
  toggleMessageSelection(messageOrId) {
    if (!messageOrId) return false;
    let cleanId;
    let altId = null;
    if (typeof messageOrId === 'object') {
      cleanId = messageOrId.id != null ? String(messageOrId.id) : null;
      altId = (messageOrId.clientMessageId || messageOrId.client_message_id) != null
        ? String(messageOrId.clientMessageId || messageOrId.client_message_id)
        : null;
      if (!cleanId) cleanId = altId;
    } else {
      cleanId = String(messageOrId);
    }
    if (!cleanId) return false;

    const isSel = this.selectedMessageIds.has(cleanId) || (altId && this.selectedMessageIds.has(altId));
    if (isSel) {
      this.selectedMessageIds.delete(cleanId);
      if (altId) this.selectedMessageIds.delete(altId);
      if (this.selectedMessageIds.size === 0) {
        this.isMessageSelectionMode = false;
      }
      return false;
    }
    this.selectedMessageIds.add(cleanId);
    this.isMessageSelectionMode = true;
    return true;
  }

  /**
   * Clears all selected messages and exits selection mode.
   */
  clearMessageSelection() {
    this.selectedMessageIds.clear();
    this.isMessageSelectionMode = false;
  }

  /**
   * Enters message selection mode with optional initial message ID.
   * @param {string|object} [initialMessageOrId]
   */
  enterMessageSelectionMode(initialMessageOrId = null) {
    this.isMessageSelectionMode = true;
    this.selectedMessageIds.clear();
    if (initialMessageOrId) {
      this.toggleMessageSelection(initialMessageOrId);
    }
  }

  /**
   * Exits message selection mode.
   */
  exitMessageSelectionMode() {
    this.clearMessageSelection();
  }

  /**
   * Checks if a message is currently selected.
   * Accepts either a message ID string or a message object.
   * @param {string|object} messageOrId
   * @returns {boolean}
   */
  isMessageSelected(messageOrId) {
    if (!messageOrId) return false;
    if (typeof messageOrId === 'object') {
      const id = messageOrId.id != null ? String(messageOrId.id) : null;
      const cid = (messageOrId.clientMessageId || messageOrId.client_message_id) != null
        ? String(messageOrId.clientMessageId || messageOrId.client_message_id)
        : null;
      return Boolean((id && this.selectedMessageIds.has(id)) || (cid && this.selectedMessageIds.has(cid)));
    }
    return this.selectedMessageIds.has(String(messageOrId));
  }

  /**
   * Returns array of currently selected message IDs.
   * @returns {Array<string>}
   */
  getSelectedMessageIds() {
    return Array.from(this.selectedMessageIds);
  }

  /**
   * Alias for currentUser matching userProfile naming convention.
   * @returns {object|null}
   */
  get userProfile() {
    return this.currentUser;
  }

  /**
   * Helper to retrieve current authenticated user ID.
   * @returns {string|null}
   */
  get currentUserId() {
    return this.currentUser?.userId || null;
  }

  /**
   * Alias for conversations matching inbox naming convention.
   * Guaranteed to always return an array (never undefined).
   * @returns {Array}
   */
  get inbox() {
    return Array.isArray(this.conversations) ? this.conversations : [];
  }

  /**
   * Sets current authenticated user profile and loads user preferences.
   * @param {object} user
   */
  setCurrentUser(user) {
    this.currentUser = user ? { ...user } : null;
    this._loadPreferences();
  }

  /**
   * Loads pinned, favourite, custom lists, archived chats, call history, and contact nicknames from local preference storage.
   * @private
   */
  _loadPreferences() {
    try {
      if (typeof localStorage !== 'undefined') {
        const userKey = this.currentUserId || 'default';
        const pinData = localStorage.getItem(`ollachat_pinned_chats_${userKey}`);
        if (pinData) {
          const arr = JSON.parse(pinData);
          if (Array.isArray(arr)) {
            this.pinnedRoomIds = new Set(arr.map(String));
          }
        } else {
          this.pinnedRoomIds = new Set();
        }
        const favData = localStorage.getItem(`ollachat_favourite_chats_${userKey}`);
        if (favData) {
          const arr = JSON.parse(favData);
          if (Array.isArray(arr)) {
            this.favouriteRoomIds = new Set(arr.map(String));
          }
        } else {
          this.favouriteRoomIds = new Set();
        }
        const listsData = localStorage.getItem(`ollachat_custom_lists_${userKey}`);
        if (listsData) {
          const arr = JSON.parse(listsData);
          if (Array.isArray(arr)) {
            this.customLists = arr.filter((item) => item && typeof item === 'object' && item.id && item.name);
          }
        } else {
          this.customLists = [];
        }
        const archiveData = localStorage.getItem(`ollachat_archived_chats_${userKey}`);
        if (archiveData) {
          const arr = JSON.parse(archiveData);
          if (Array.isArray(arr)) {
            this.archivedRoomIds = new Set(arr.map(String));
          }
        } else {
          this.archivedRoomIds = new Set();
        }
        const historyData = localStorage.getItem(`ollachat_call_history_${userKey}`);
        if (historyData) {
          const arr = JSON.parse(historyData);
          if (Array.isArray(arr)) {
            this.callHistory = arr.filter((item) => item && typeof item === 'object');
          }
        } else {
          this.callHistory = [];
        }
        const markedUnreadData = localStorage.getItem(`ollachat_marked_unread_${userKey}`);
        if (markedUnreadData) {
          const arr = JSON.parse(markedUnreadData);
          if (Array.isArray(arr)) {
            this._markedUnreadRooms = new Set(arr.map(String));
          }
        } else {
          this._markedUnreadRooms = new Set();
        }
        const unreadEditsData = localStorage.getItem(`ollachat_unread_edits_${userKey}`);
        if (unreadEditsData) {
          const parsed = JSON.parse(unreadEditsData);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            this._unreadEditedMessages = new Map();
            for (const [rId, msgIds] of Object.entries(parsed)) {
              if (Array.isArray(msgIds) && msgIds.length > 0) {
                this._unreadEditedMessages.set(String(rId), new Set(msgIds.map(String)));
                if (!this._unreadMessageIds) this._unreadMessageIds = new Map();
                if (!this._unreadMessageIds.has(String(rId))) {
                  this._unreadMessageIds.set(String(rId), new Set());
                }
                const set = this._unreadMessageIds.get(String(rId));
                for (const mid of msgIds) {
                  set.add(String(mid));
                }
              }
            }
          } else {
            this._unreadEditedMessages = new Map();
          }
        } else {
          this._unreadEditedMessages = new Map();
        }
        const nicknamesData = localStorage.getItem(`ollachat_contact_nicknames_${userKey}`);
        if (nicknamesData) {
          const parsed = JSON.parse(nicknamesData);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            this.contactNicknames = new Map(
              Object.entries(parsed)
                .filter(([k, v]) => k && typeof v === 'string' && v.trim())
                .map(([k, v]) => [String(k), String(v).trim()])
            );
          } else {
            this.contactNicknames = new Map();
          }
        } else {
          this.contactNicknames = new Map();
        }
        const pinMsgData = localStorage.getItem(`ollachat_pinned_messages_${userKey}`);
        if (pinMsgData) {
          const parsed = JSON.parse(pinMsgData);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            this.pinnedMessages = new Map();
            for (const [roomId, pins] of Object.entries(parsed)) {
              if (Array.isArray(pins)) {
                this.pinnedMessages.set(String(roomId), pins);
              }
            }
          } else {
            this.pinnedMessages = new Map();
          }
        } else {
          this.pinnedMessages = new Map();
        }
        this.pruneExpiredPins();

        const partsData = localStorage.getItem(`ollachat_cached_participants_${userKey}`);
        if (partsData) {
          const parsed = JSON.parse(partsData);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            for (const [rId, pList] of Object.entries(parsed)) {
              if (Array.isArray(pList)) {
                this.setRoomParticipants(rId, pList, false);
              }
            }
          }
        }
      }
    } catch (_) {}
  }

  /**
   * Persists cached room participants to local preference storage.
   * @private
   */
  _persistRoomParticipants() {
    try {
      if (typeof localStorage !== 'undefined') {
        const userKey = this.currentUserId || 'default';
        const obj = {};
        for (const [roomId, pMap] of this.roomParticipants.entries()) {
          obj[roomId] = Array.from(pMap.values());
        }
        localStorage.setItem(`ollachat_cached_participants_${userKey}`, JSON.stringify(obj));
      }
    } catch (_) {}
  }

  /**
   * Persists manually marked unread chat IDs to local preference storage.
   * @private
   */
  _persistMarkedUnread() {
    try {
      if (typeof localStorage !== 'undefined') {
        const userKey = this.currentUserId || 'default';
        localStorage.setItem(`ollachat_marked_unread_${userKey}`, JSON.stringify(Array.from(this._markedUnreadRooms || [])));
      }
    } catch (_) {}
  }

  /**
   * Persists unread edited message IDs to local preference storage.
   * @private
   */
  _persistUnreadEdits() {
    try {
      if (typeof localStorage !== 'undefined') {
        const userKey = this.currentUserId || 'default';
        const obj = {};
        if (this._unreadEditedMessages) {
          for (const [rId, set] of this._unreadEditedMessages.entries()) {
            if (set && set.size > 0) {
              obj[rId] = Array.from(set);
            }
          }
        }
        localStorage.setItem(`ollachat_unread_edits_${userKey}`, JSON.stringify(obj));
      }
    } catch (_) {}
  }

  /**
   * Persists pinned chat IDs to local preference storage.
   * @private
   */
  _persistPinned() {
    try {
      if (typeof localStorage !== 'undefined') {
        const userKey = this.currentUserId || 'default';
        localStorage.setItem(`ollachat_pinned_chats_${userKey}`, JSON.stringify(Array.from(this.pinnedRoomIds)));
      }
    } catch (_) {}
  }

  /**
   * Persists favourite chat IDs to local preference storage.
   * @private
   */
  _persistFavourites() {
    try {
      if (typeof localStorage !== 'undefined') {
        const userKey = this.currentUserId || 'default';
        localStorage.setItem(`ollachat_favourite_chats_${userKey}`, JSON.stringify(Array.from(this.favouriteRoomIds)));
      }
    } catch (_) {}
  }

  /**
   * Persists custom lists to local preference storage.
   * @private
   */
  _persistCustomLists() {
    try {
      if (typeof localStorage !== 'undefined') {
        const userKey = this.currentUserId || 'default';
        localStorage.setItem(`ollachat_custom_lists_${userKey}`, JSON.stringify(this.customLists));
      }
    } catch (_) {}
  }

  /**
   * Persists archived chat IDs to local preference storage.
   * @private
   */
  _persistArchived() {
    try {
      if (typeof localStorage !== 'undefined') {
        const userKey = this.currentUserId || 'default';
        localStorage.setItem(`ollachat_archived_chats_${userKey}`, JSON.stringify(Array.from(this.archivedRoomIds)));
      }
    } catch (_) {}
  }

  /**
   * Persists call history records to local preference storage.
   * @private
   */
  _persistCallHistory() {
    try {
      if (typeof localStorage !== 'undefined') {
        const userKey = this.currentUserId || 'default';
        localStorage.setItem(`ollachat_call_history_${userKey}`, JSON.stringify(this.callHistory.slice(0, 500)));
      }
    } catch (_) {}
  }

  /**
   * Persists personal contact nicknames to local preference storage.
   * Scoped to the current authenticated user.
   * @private
   */
  _persistContactNicknames() {
    try {
      if (typeof localStorage !== 'undefined') {
        const userKey = this.currentUserId || 'default';
        const obj = Object.fromEntries(this.contactNicknames);
        localStorage.setItem(`ollachat_contact_nicknames_${userKey}`, JSON.stringify(obj));
      }
    } catch (_) {}
  }

  /**
   * Persists pinned messages to local preference storage.
   * Scoped to the current authenticated user: ollachat_pinned_messages_${userId}.
   * @private
   */
  _persistPinnedMessages() {
    try {
      if (typeof localStorage !== 'undefined') {
        const userKey = this.currentUserId || 'default';
        const obj = {};
        for (const [roomId, pins] of this.pinnedMessages.entries()) {
          if (Array.isArray(pins) && pins.length > 0) {
            obj[roomId] = pins;
          }
        }
        localStorage.setItem(`ollachat_pinned_messages_${userKey}`, JSON.stringify(obj));
      }
    } catch (_) {}
  }

  /**
   * Prunes any expired pins (where expiresAt <= now).
   * @param {string|null} [roomId=null] If provided, prunes only for that room; otherwise for all rooms
   * @param {number|Date} [now=Date.now()] Reference timestamp
   * @returns {number} Count of pruned pins
   */
  pruneExpiredPins(roomId = null, now = Date.now()) {
    const currentMs = typeof now === 'number' ? now : (now instanceof Date ? now.getTime() : Date.parse(now));
    let prunedCount = 0;
    const targetRooms = roomId ? [String(roomId)] : Array.from(this.pinnedMessages.keys());

    for (const rId of targetRooms) {
      const pins = this.pinnedMessages.get(rId);
      if (Array.isArray(pins)) {
        const valid = pins.filter((p) => {
          if (!p || typeof p !== 'object') return false;
          if (typeof p.expiresAt === 'number' && p.expiresAt <= currentMs) {
            prunedCount++;
            return false;
          }
          return true;
        });
        if (valid.length !== pins.length) {
          if (valid.length > 0) {
            this.pinnedMessages.set(rId, valid);
          } else {
            this.pinnedMessages.delete(rId);
          }
        }
      }
    }

    if (prunedCount > 0) {
      this._persistPinnedMessages();
    }
    return prunedCount;
  }

  /**
   * Returns active, unexpired pinned messages for a conversation.
   * @param {string} roomId
   * @param {number|Date} [now=Date.now()]
   * @returns {Array<object>}
   */
  getPinnedMessages(roomId, now = Date.now()) {
    if (!roomId) return [];
    const rId = String(roomId);
    this.pruneExpiredPins(rId, now);
    const pins = this.pinnedMessages.get(rId);
    return Array.isArray(pins) ? Array.from(pins) : [];
  }

  /**
   * Checks if a message is currently pinned in a conversation.
   * @param {string} messageId
   * @param {string|null} [roomId=null]
   * @param {number|Date} [now=Date.now()]
   * @returns {boolean}
   */
  isMessagePinned(messageId, roomId = null, now = Date.now()) {
    if (!messageId) return false;
    const mId = String(messageId);
    this.pruneExpiredPins(roomId, now);
    if (roomId) {
      const pins = this.pinnedMessages.get(String(roomId));
      return Array.isArray(pins) && pins.some((p) => p && p.messageId === mId);
    }
    for (const pins of this.pinnedMessages.values()) {
      if (Array.isArray(pins) && pins.some((p) => p && p.messageId === mId)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Pins a message in a conversation.
   * Maximum 3 active pinned messages per conversation.
   * @param {string} roomId
   * @param {string} messageId
   * @param {string|number} [durationChoice='24h'] Key ('24h', '7d', '30d', '90d') or duration ms
   * @param {object} [options={}]
   * @returns {{ ok: boolean, pin?: object, error?: string, max?: number, updated?: boolean }}
   */
  pinMessage(roomId, messageId, durationChoice = '24h', options = {}) {
    if (!roomId || !messageId) {
      return { ok: false, error: 'invalid_arguments' };
    }
    const rId = String(roomId);
    const mId = String(messageId);
    const now = options.now
      ? (typeof options.now === 'number' ? options.now : (options.now instanceof Date ? options.now.getTime() : Date.parse(options.now)))
      : Date.now();

    this.pruneExpiredPins(rId, now);
    const existing = this.pinnedMessages.get(rId) ? [...this.pinnedMessages.get(rId)] : [];

    let durationMs;
    let durationKey;
    if (typeof durationChoice === 'number') {
      durationMs = durationChoice;
      durationKey = Object.keys(PIN_DURATION_MAP).find((k) => PIN_DURATION_MAP[k] === durationMs) || 'custom';
    } else {
      durationKey = typeof durationChoice === 'string' && PIN_DURATION_MAP[durationChoice] ? durationChoice : '24h';
      durationMs = PIN_DURATION_MAP[durationKey] || PIN_DURATIONS.HOURS_24;
    }

    const existingIndex = existing.findIndex((p) => p && p.messageId === mId);
    if (existingIndex >= 0) {
      // Update existing pin duration/expiration
      const updatedPin = {
        ...existing[existingIndex],
        pinnedAt: now,
        expiresAt: now + durationMs,
        duration: durationKey,
        pinnedBy: options.pinnedBy || this.currentUserId || 'self',
        preview: options.preview || existing[existingIndex].preview || ''
      };
      existing[existingIndex] = updatedPin;
      this.pinnedMessages.set(rId, existing);
      this._persistPinnedMessages();
      return { ok: true, pin: updatedPin, updated: true };
    }

    // Check limit
    if (existing.length >= MAX_PINS_PER_CHAT) {
      return { ok: false, error: 'limit_reached', max: MAX_PINS_PER_CHAT };
    }

    const newPin = {
      roomId: rId,
      messageId: mId,
      pinnedAt: now,
      expiresAt: now + durationMs,
      duration: durationKey,
      pinnedBy: options.pinnedBy || this.currentUserId || 'self',
      preview: options.preview || ''
    };

    existing.push(newPin);
    this.pinnedMessages.set(rId, existing);
    this._persistPinnedMessages();
    return { ok: true, pin: newPin };
  }

  /**
   * Unpins a message in a conversation.
   * @param {string} roomId
   * @param {string} messageId
   * @returns {boolean}
   */
  unpinMessage(roomId, messageId) {
    if (!roomId || !messageId) return false;
    const rId = String(roomId);
    const mId = String(messageId);
    const existing = this.pinnedMessages.get(rId);
    if (!Array.isArray(existing)) return false;

    const filtered = existing.filter((p) => p && p.messageId !== mId);
    if (filtered.length !== existing.length) {
      if (filtered.length > 0) {
        this.pinnedMessages.set(rId, filtered);
      } else {
        this.pinnedMessages.delete(rId);
      }
      this._persistPinnedMessages();
      return true;
    }
    return false;
  }

  /**
   * Clears all pinned messages for a conversation (e.g. on Clear chat).
   * @param {string} roomId
   * @returns {boolean}
   */
  clearPinnedMessages(roomId) {
    if (!roomId) return false;
    const rId = String(roomId);
    if (this.pinnedMessages.has(rId)) {
      this.pinnedMessages.delete(rId);
      this._persistPinnedMessages();
      return true;
    }
    return false;
  }

  /**
   * Retrieves personal nickname for a contact by userId.
   * @param {string} userId
   * @returns {string|null}
   */
  getContactNickname(userId) {
    if (!userId) return null;
    const val = this.contactNicknames.get(String(userId));
    return val && typeof val === 'string' && val.trim() ? val.trim() : null;
  }

  /**
   * Sets or updates personal nickname for a contact.
   * If nickname is empty, whitespace, or null, the nickname is removed.
   * @param {string} userId
   * @param {string|null} nickname
   * @returns {string|null}
   */
  setContactNickname(userId, nickname) {
    if (!userId) return null;
    const cleanId = String(userId).trim();
    if (!cleanId) return null;
    const cleanNick = typeof nickname === 'string' ? nickname.trim().slice(0, 60) : '';
    if (!cleanNick) {
      this.removeContactNickname(cleanId);
      return null;
    }
    this.contactNicknames.set(cleanId, cleanNick);
    this._persistContactNicknames();
    return cleanNick;
  }

  /**
   * Removes personal nickname for a contact.
   * @param {string} userId
   * @returns {boolean}
   */
  removeContactNickname(userId) {
    if (!userId) return false;
    const cleanId = String(userId).trim();
    const deleted = this.contactNicknames.delete(cleanId);
    if (deleted) {
      this._persistContactNicknames();
    }
    return deleted;
  }

  /**
   * Checks if a contact has a personal nickname set.
   * @param {string} userId
   * @returns {boolean}
   */
  hasContactNickname(userId) {
    return Boolean(this.getContactNickname(userId));
  }

  /**
   * Sets or updates normalized participant objects for a room.
   * @param {string} roomId
   * @param {Array<object>|Map<string, object>} participants
   * @param {boolean} [shouldPersist=true]
   * @returns {Map<string, object>}
   */
  setRoomParticipants(roomId, participants, shouldPersist = true) {
    if (!roomId) return new Map();
    const cleanRoomId = String(roomId).trim();
    const pMap = new Map();
    const list = Array.isArray(participants)
      ? participants
      : (participants instanceof Map ? Array.from(participants.values()) : []);

    for (const p of list) {
      if (!p || typeof p !== 'object') continue;
      const pid = String(p.principalId || p.principal_id || p.userId || p.user_id || '').trim();
      if (!pid) continue;
      const normalized = {
        principalId: pid,
        principal_id: pid,
        displayName: p.displayName || p.display_name || p.name || null,
        display_name: p.displayName || p.display_name || p.name || null,
        phone: p.phone || null,
        role: p.role || 'member'
      };
      pMap.set(pid, normalized);
      pMap.set(pid.toLowerCase(), normalized);
      this.participantProfiles.set(pid, normalized);
      this.participantProfiles.set(pid.toLowerCase(), normalized);
    }

    this.roomParticipants.set(cleanRoomId, pMap);
    if (shouldPersist) {
      this._persistRoomParticipants();
    }
    return pMap;
  }

  /**
   * Returns participants map for a room.
   * @param {string} roomId
   * @returns {Map<string, object>}
   */
  getRoomParticipants(roomId) {
    if (!roomId) return new Map();
    return this.roomParticipants.get(String(roomId).trim()) || new Map();
  }

  /**
   * Resolves human-readable sender name for a message using state context.
   * @param {object} message
   * @param {string|null} [roomId=null]
   * @returns {string}
   */
  resolveSenderDisplayName(message, roomId = null) {
    const effectiveRoomId = roomId || message?.roomId || message?.room_id || this.selectedRoomId;
    const roomParts = effectiveRoomId ? this.getRoomParticipants(effectiveRoomId) : null;
    return resolveGroupSenderName(message, this.currentUserId, {
      roomId: effectiveRoomId,
      roomParticipants: roomParts,
      getContactNicknameFn: (id) => this.getContactNickname(id),
      conversations: this.conversations,
      globalParticipantsCache: this.participantProfiles
    });
  }

  /**
   * Gets conversation title with contact nicknames resolved.
   * @param {object} item
   * @returns {string}
   */
  getConversationTitle(item) {
    return getConversationTitle(item, (id) => this.getContactNickname(id));
  }

  /**
   * Sets active conversation list filter ('all' | 'unread' | 'favourites' | 'groups' | custom list ID).
   * @param {string} filter
   */
  setActiveFilter(filter) {
    const isBuiltIn = ['all', 'unread', 'favourites', 'groups'].includes(filter);
    const isCustom = this.customLists.some((l) => l.id === filter);
    this.activeFilter = (isBuiltIn || isCustom) ? filter : 'all';
  }

  /**
   * Returns current active filter name.
   * @returns {string}
   */
  getActiveFilter() {
    return this.activeFilter || 'all';
  }

  /**
   * Checks whether a room is pinned.
   * @param {string} roomId
   * @returns {boolean}
   */
  isPinned(roomId) {
    if (!roomId) return false;
    return this.pinnedRoomIds.has(String(roomId));
  }

  /**
   * Pins a chat to the top of the conversation list.
   * @param {string} roomId
   * @returns {boolean}
   */
  pinChat(roomId) {
    if (!roomId) return false;
    this.pinnedRoomIds.add(String(roomId));
    this._persistPinned();
    return true;
  }

  /**
   * Unpins a chat.
   * @param {string} roomId
   * @returns {boolean}
   */
  unpinChat(roomId) {
    if (!roomId) return false;
    const deleted = this.pinnedRoomIds.delete(String(roomId));
    this._persistPinned();
    return deleted;
  }

  /**
   * Toggles pinned state for a room.
   * @param {string} roomId
   * @returns {boolean} New pinned state
   */
  togglePinChat(roomId) {
    if (this.isPinned(roomId)) {
      this.unpinChat(roomId);
      return false;
    }
    this.pinChat(roomId);
    return true;
  }

  /**
   * Checks whether a room is marked as favourite.
   * @param {string} roomId
   * @returns {boolean}
   */
  isFavourite(roomId) {
    if (!roomId) return false;
    return this.favouriteRoomIds.has(String(roomId));
  }

  /**
   * Marks a chat as favourite.
   * @param {string} roomId
   * @returns {boolean}
   */
  favouriteChat(roomId) {
    if (!roomId) return false;
    this.favouriteRoomIds.add(String(roomId));
    this._persistFavourites();
    return true;
  }

  /**
   * Unmarks a chat as favourite.
   * @param {string} roomId
   * @returns {boolean}
   */
  unfavouriteChat(roomId) {
    if (!roomId) return false;
    const deleted = this.favouriteRoomIds.delete(String(roomId));
    this._persistFavourites();
    return deleted;
  }

  /**
   * Toggles favourite state for a room.
   * @param {string} roomId
   * @returns {boolean} New favourite state
   */
  toggleFavouriteChat(roomId) {
    if (this.isFavourite(roomId)) {
      this.unfavouriteChat(roomId);
      return false;
    }
    this.favouriteChat(roomId);
    return true;
  }

  /**
   * Computes number of conversations that have unread messages.
   * @returns {number}
   */
  getUnreadConversationsCount() {
    if (!Array.isArray(this.conversations)) return 0;
    return this.conversations.filter((item) => {
      if (this.isArchived(item.roomId)) return false;
      const unread = typeof item.unreadCount === 'number' ? item.unreadCount : (item.unread_count || 0);
      return unread > 0;
    }).length;
  }

  /**
   * Computes number of group conversations in the inbox.
   * @returns {number}
   */
  getGroupsCount() {
    if (!Array.isArray(this.conversations)) return 0;
    return this.conversations.filter((item) => !this.isArchived(item.roomId) && (item.kind === 'group' || item.isGroup)).length;
  }

  /**
   * Computes number of favourite conversations in the inbox.
   * @returns {number}
   */
  getFavouritesCount() {
    if (!Array.isArray(this.conversations)) return 0;
    return this.conversations.filter((item) => !this.isArchived(item.roomId) && this.isFavourite(item.roomId)).length;
  }

  /**
   * Returns copy of custom chat lists.
   * @returns {Array<{id: string, name: string, roomIds: string[]}>}
   */
  getCustomLists() {
    return Array.isArray(this.customLists) ? [...this.customLists] : [];
  }

  /**
   * Retrieves a single custom list by its ID.
   * @param {string} listId
   * @returns {object|null}
   */
  getCustomList(listId) {
    if (!listId) return null;
    return this.customLists.find((l) => l.id === String(listId)) || null;
  }

  /**
   * Creates a new custom chat list with validation and local persistence.
   * @param {string} name List name
   * @param {string[]} [roomIds=[]] Array of conversation/room IDs
   * @returns {{id: string, name: string, roomIds: string[]}}
   */
  createCustomList(name, roomIds = []) {
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      throw new Error('Enter a list name.');
    }
    const trimmed = name.trim();
    if (trimmed.length > 50) {
      throw new Error('List name is too long (maximum 50 characters).');
    }
    const exists = this.customLists.some((l) => l.name.toLowerCase() === trimmed.toLowerCase());
    if (exists) {
      throw new Error('A list with this name already exists.');
    }
    const sanitizedRoomIds = Array.isArray(roomIds)
      ? Array.from(new Set(roomIds.map(String)))
      : [];

    const id = 'list_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
    const newList = { id, name: trimmed, roomIds: sanitizedRoomIds };
    this.customLists.push(newList);
    this._persistCustomLists();
    return newList;
  }

  /**
   * Updates an existing custom list (rename or modify member chats).
   * @param {string} listId
   * @param {{name?: string, roomIds?: string[]}} updates
   * @returns {object}
   */
  updateCustomList(listId, updates = {}) {
    const list = this.getCustomList(listId);
    if (!list) {
      throw new Error('List not found.');
    }
    if (updates.name !== undefined) {
      const trimmed = typeof updates.name === 'string' ? updates.name.trim() : '';
      if (!trimmed) {
        throw new Error('Enter a list name.');
      }
      if (trimmed.length > 50) {
        throw new Error('List name is too long (maximum 50 characters).');
      }
      const duplicate = this.customLists.some(
        (l) => l.id !== String(listId) && l.name.toLowerCase() === trimmed.toLowerCase()
      );
      if (duplicate) {
        throw new Error('A list with this name already exists.');
      }
      list.name = trimmed;
    }
    if (updates.roomIds !== undefined) {
      list.roomIds = Array.isArray(updates.roomIds)
        ? Array.from(new Set(updates.roomIds.map(String)))
        : [];
    }
    this._persistCustomLists();
    return list;
  }

  /**
   * Deletes a custom list and switches back to 'all' if the list was active.
   * @param {string} listId
   * @returns {boolean}
   */
  deleteCustomList(listId) {
    if (!listId) return false;
    const idx = this.customLists.findIndex((l) => l.id === String(listId));
    if (idx !== -1) {
      this.customLists.splice(idx, 1);
      if (this.activeFilter === String(listId)) {
        this.activeFilter = 'all';
      }
      this._persistCustomLists();
      return true;
    }
    return false;
  }

  /**
   * Retrieves all custom lists that contain a specific roomId.
   * @param {string} roomId
   * @returns {Array<object>}
   */
  getCustomListsForRoom(roomId) {
    if (!roomId) return [];
    const rId = String(roomId);
    return this.customLists.filter((l) => Array.isArray(l.roomIds) && l.roomIds.includes(rId));
  }

  /**
   * Toggles inclusion of a roomId in a custom list.
   * @param {string} listId
   * @param {string} roomId
   * @returns {boolean} New inclusion state
   */
  toggleRoomInCustomList(listId, roomId) {
    const list = this.getCustomList(listId);
    if (!list || !roomId) return false;
    const rId = String(roomId);
    const set = new Set(list.roomIds || []);
    let included = false;
    if (set.has(rId)) {
      set.delete(rId);
      included = false;
    } else {
      set.add(rId);
      included = true;
    }
    this.updateCustomList(listId, { roomIds: Array.from(set) });
    return included;
  }

  /**
   * Updates inbox loading indicator.
   * @param {boolean} isLoading
   */
  setInboxLoading(isLoading) {
    this.isLoadingInbox = Boolean(isLoading);
    if (isLoading) {
      this.inboxError = null;
    }
  }

  /**
   * Sets loaded conversations and resets error.
   * Synchronizes unreadCount and unread_count as safe non-negative integers
   * and preserves manually marked unread state.
   * @param {Array} conversations
   */
  setInbox(conversations) {
    const previousConversations = Array.isArray(this.conversations) ? this.conversations : [];
    const previousExitedMap = new Map();
    for (const c of previousConversations) {
      if (c && (c.isExited || c.exited)) {
        previousExitedMap.set(String(c.roomId), c);
      }
    }

    this.conversations = Array.isArray(conversations) ? [...conversations] : [];

    // Protect exited status against server reactivation
    for (const item of this.conversations) {
      if (item && item.roomId && previousExitedMap.has(String(item.roomId))) {
        item.isExited = true;
        item.exited = true;
      }
    }

    // Preserve existing exited groups not returned in active-only server inbox
    for (const [rId, exitedItem] of previousExitedMap.entries()) {
      if (!this.conversations.some((c) => c && String(c.roomId) === rId)) {
        this.conversations.push(exitedItem);
      }
    }

    for (const item of this.conversations) {
      if (!item || typeof item !== 'object') continue;
      const count = typeof item.unreadCount === 'number' ? item.unreadCount : (item.unread_count || 0);
      item.unreadCount = Math.max(0, count);
      item.unread_count = item.unreadCount;
      if (item.roomId && this._markedUnreadRooms && this._markedUnreadRooms.has(String(item.roomId)) && item.unreadCount === 0) {
        item.unreadCount = 1;
        item.unread_count = 1;
      }
      if (item.roomId && this._unreadEditedMessages && this._unreadEditedMessages.has(String(item.roomId))) {
        const editsCount = this._unreadEditedMessages.get(String(item.roomId)).size;
        if (editsCount > 0) {
          item.unreadCount = Math.max(item.unreadCount, editsCount);
          item.unread_count = item.unreadCount;
        }
      }
      // Reconcile room call records with lastMessage preview without incrementing unread count
      if (item.roomId) {
        const roomCalls = getRoomCallRecords(item.roomId, this.currentUser?.userId);
        if (roomCalls.length > 0) {
          const latestCall = roomCalls[roomCalls.length - 1];
          const callTime = typeof latestCall.startedAt === 'number' ? latestCall.startedAt : Date.now();
          const lastMsgTime = item.lastMessage ? (Date.parse(item.lastMessage.createdAt || item.lastMessage.created_at || '') || 0) : 0;
          const isCallSignalTombstone = item.lastMessage && isCallSignalMessage(item.lastMessage);

          if (!item.lastMessage || isCallSignalTombstone || callTime >= lastMsgTime) {
            const isVideo = latestCall.callType === 'video' || latestCall.isVideo;
            item.lastMessage = {
              id: latestCall.id,
              preview: isVideo ? '📹 Video call' : '📞 Audio call',
              senderId: latestCall.direction === 'outgoing' ? (this.currentUser?.userId || 'self') : (latestCall.participantId || null),
              createdAt: new Date(callTime).toISOString(),
              kind: 'call',
              callType: latestCall.callType,
              isVideo
            };
            item.preview = item.lastMessage.preview;
          }
        }
      }
      if (!item.preview || item.lastMessage?.kind === 'call') {
        item.preview = getConversationPreview(item);
      }

      // Check if conversation direct peer is blocked and sanitize avatar/block status
      const peerId = item.peerUserId || item.peer_user_id || item.peer?.userId || item.peer?.user_id || (typeof this.getDirectPeerUserId === 'function' ? this.getDirectPeerUserId(item) : getDirectPeerUserId(item, this.currentUser?.userId));
      const isBlocked = Boolean(
        item.isBlocked || item.blocked || item.blockedByPeer || item.blocked_by_peer ||
        item.peer?.isBlocked || item.peer?.blocked ||
        (peerId && this.isUserBlocked(peerId))
      );
      if (isBlocked) {
        item.isBlocked = true;
        item.blocked = true;
        item.avatarUrl = null;
        item.avatar_url = null;
        if (item.peer) {
          item.peer.isBlocked = true;
          item.peer.blocked = true;
          item.peer.avatarUrl = null;
          item.peer.avatar_url = null;
          item.peer.avatarVersion = null;
          item.peer.avatar_version = null;
        }
      }
    }
    this.isLoadingInbox = false;
    this.inboxError = null;
  }

  /**
   * Sets inbox error state.
   * @param {string|object} error
   */
  setInboxError(error) {
    this.isLoadingInbox = false;
    this.inboxError = typeof error === 'string' ? error : (error?.message || 'Failed to load conversations');
  }

  /**
   * Updates active search filter query.
   * @param {string} query
   */
  setSearchQuery(query) {
    this.searchQuery = typeof query === 'string' ? query : '';
  }

  /**
   * Selects a conversation by roomId.
   * @param {string|null} roomId
   */
  selectConversation(roomId) {
    const nextRoomId = typeof roomId === 'string' && roomId.trim() !== '' ? roomId.trim() : null;
    if (this.selectedRoomId !== nextRoomId) {
      this.clearMessageSelection();
    }
    this.selectedRoomId = nextRoomId;
  }

  /**
   * Retrieves conversation item by roomId.
   * @private
   * @param {string} roomId
   * @returns {object|null}
   */
  _findConversation(roomId) {
    if (!roomId || !Array.isArray(this.conversations)) return null;
    const rId = String(roomId);
    return this.conversations.find((c) => c && String(c.roomId) === rId) || null;
  }

  /**
   * Returns authoritative unread count for a given room.
   * @param {string} roomId
   * @returns {number}
   */
  getRoomUnreadCount(roomId) {
    const item = this._findConversation(roomId);
    if (!item) return 0;
    return typeof item.unreadCount === 'number' ? item.unreadCount : (item.unread_count || 0);
  }

  /**
   * Sets unread count for a given room and synchronizes unread_count.
   * @param {string} roomId
   * @param {number} count
   * @returns {number}
   */
  setRoomUnreadCount(roomId, count) {
    const item = this._findConversation(roomId);
    const safeCount = Math.max(0, parseInt(count, 10) || 0);
    if (item) {
      item.unreadCount = safeCount;
      item.unread_count = safeCount;
    }
    const rId = String(roomId);
    if (safeCount === 0) {
      if (this._unreadMessageIds) this._unreadMessageIds.delete(rId);
      if (this._markedUnreadRooms) {
        this._markedUnreadRooms.delete(rId);
        this._persistMarkedUnread();
      }
      if (this._unreadEditedMessages) {
        this._unreadEditedMessages.delete(rId);
        this._persistUnreadEdits();
      }
    }
    return safeCount;
  }

  /**
   * Marks a conversation as read (unread count = 0), clearing tracking and unread overrides.
   * @param {string} roomId
   */
  markConversationAsRead(roomId) {
    if (!roomId) return;
    const rId = String(roomId);
    const item = this._findConversation(rId);
    if (item) {
      item.unreadCount = 0;
      item.unread_count = 0;
      item.isMarkedUnread = false;
      item.is_marked_unread = false;
    }
    if (this._unreadMessageIds) this._unreadMessageIds.delete(rId);
    if (this._markedUnreadRooms) {
      this._markedUnreadRooms.delete(rId);
      this._persistMarkedUnread();
    }
    if (this._unreadEditedMessages) {
      this._unreadEditedMessages.delete(rId);
      this._persistUnreadEdits();
    }
  }

  /**
   * Toggles or marks a conversation as unread.
   * If currently unread, clears it. If read, sets unread count to 1.
   * @param {string} roomId
   * @returns {number} New unread count
   */
  markConversationAsUnread(roomId) {
    if (!roomId) return 0;
    const rId = String(roomId);
    const item = this._findConversation(rId);
    if (!item) return 0;
    const current = typeof item.unreadCount === 'number' ? item.unreadCount : (item.unread_count || 0);
    if (current > 0) {
      this.markConversationAsRead(rId);
      return 0;
    }
    item.unreadCount = 1;
    item.unread_count = 1;
    if (this._markedUnreadRooms) {
      this._markedUnreadRooms.add(rId);
      this._persistMarkedUnread();
    }
    return 1;
  }

  /**
   * Records an incoming unread message with duplicate suppression.
   * Increments unread count only if this message has not been recorded before.
   * @param {string} roomId
   * @param {object} message
   * @returns {number} Current unread count
   */
  recordIncomingUnreadMessage(roomId, message) {
    if (!roomId || !message) return 0;
    const rId = String(roomId);
    let item = this._findConversation(rId);
    if (!item) {
      return 0;
    }

    if (!this._unreadMessageIds) this._unreadMessageIds = new Map();
    if (!this._unreadMessageIds.has(rId)) {
      this._unreadMessageIds.set(rId, new Set());
    }
    const tracked = this._unreadMessageIds.get(rId);

    const mId = message.id ? String(message.id) : null;
    const cId = (message.clientMessageId || message.client_message_id) ? String(message.clientMessageId || message.client_message_id) : null;
    const seq = (typeof message.eventSeq === 'number' && message.eventSeq > 0)
      ? `seq:${message.eventSeq}`
      : ((typeof message.event_seq === 'number' && message.event_seq > 0) ? `seq:${message.event_seq}` : null);

    // If any known identifier has already been recorded, suppress duplicate increment
    if ((mId && tracked.has(mId)) || (cId && tracked.has(cId)) || (seq && tracked.has(seq))) {
      return typeof item.unreadCount === 'number' ? item.unreadCount : (item.unread_count || 0);
    }

    if (mId) tracked.add(mId);
    if (cId) tracked.add(cId);
    if (seq) tracked.add(seq);

    const current = typeof item.unreadCount === 'number' ? item.unreadCount : (item.unread_count || 0);
    item.unreadCount = current + 1;
    item.unread_count = item.unreadCount;
    return item.unreadCount;
  }

  /**
   * Removes an unread message record (e.g. on message delete) and decrements unread count if tracked.
   * @param {string} roomId
   * @param {string} messageId
   * @returns {number}
   */
  removeUnreadMessage(roomId, messageId) {
    if (!roomId || !messageId) return 0;
    const rId = String(roomId);
    const item = this._findConversation(rId);
    if (!item) return 0;

    const sId = String(messageId);
    let wasTracked = false;
    if (this._unreadMessageIds && this._unreadMessageIds.has(rId)) {
      const tracked = this._unreadMessageIds.get(rId);
      if (tracked.has(sId)) {
        tracked.delete(sId);
        wasTracked = true;
      }
    }
    if (this._unreadEditedMessages && this._unreadEditedMessages.has(rId)) {
      this._unreadEditedMessages.get(rId).delete(sId);
      this._persistUnreadEdits();
    }

    const current = typeof item.unreadCount === 'number' ? item.unreadCount : (item.unread_count || 0);
    if (wasTracked || current > 0) {
      item.unreadCount = Math.max(0, current - 1);
      item.unread_count = item.unreadCount;
    }
    return item.unreadCount;
  }

  /**
   * Records an incoming edited message as an unread event for the conversation.
   * Increments unread count only if this edit/message has not already been counted as unread.
   * Suppresses duplicate edits to the same message while unread.
   * @param {string} roomId
   * @param {object} message
   * @returns {number} Current unread count
   */
  recordIncomingEditedMessage(roomId, message) {
    if (!roomId || !message) return 0;
    const rId = String(roomId);
    let item = this._findConversation(rId);
    if (!item) {
      return 0;
    }

    if (!this._unreadMessageIds) this._unreadMessageIds = new Map();
    if (!this._unreadMessageIds.has(rId)) {
      this._unreadMessageIds.set(rId, new Set());
    }
    const tracked = this._unreadMessageIds.get(rId);

    if (!this._unreadEditedMessages) this._unreadEditedMessages = new Map();
    if (!this._unreadEditedMessages.has(rId)) {
      this._unreadEditedMessages.set(rId, new Set());
    }
    const trackedEdits = this._unreadEditedMessages.get(rId);

    const mId = message.id ? String(message.id) : (message.message_id ? String(message.message_id) : null);
    const cId = (message.clientMessageId || message.client_message_id) ? String(message.clientMessageId || message.client_message_id) : null;
    const seq = (typeof message.eventSeq === 'number' && message.eventSeq > 0)
      ? `seq:${message.eventSeq}`
      : ((typeof message.event_seq === 'number' && message.event_seq > 0) ? `seq:${message.event_seq}` : null);

    // If this message identifier is already tracked as unread, do NOT double-count
    const isAlreadyUnread = (mId && tracked.has(mId)) || (cId && tracked.has(cId));
    if (isAlreadyUnread) {
      if (mId) trackedEdits.add(mId);
      this._persistUnreadEdits();
      return typeof item.unreadCount === 'number' ? item.unreadCount : (item.unread_count || 0);
    }

    if (mId) {
      tracked.add(mId);
      trackedEdits.add(mId);
    }
    if (cId) tracked.add(cId);
    if (seq) tracked.add(seq);

    this._persistUnreadEdits();

    const current = typeof item.unreadCount === 'number' ? item.unreadCount : (item.unread_count || 0);
    item.unreadCount = current + 1;
    item.unread_count = item.unreadCount;
    return item.unreadCount;
  }

  /**
   * Records an unseen incoming message for a specific room while the user is away from bottom.
   * Deduplicates by message key (canonical ID or clientMessageId).
   * @param {string} roomId
   * @param {string} messageId
   * @returns {number} The updated unseen count for the room
   */
  recordUnseenIncomingMessage(roomId, messageId) {
    if (!roomId || !messageId) return 0;
    const rawKey = String(roomId);
    const normKey = rawKey.toLowerCase().trim();
    if (!this.unseenIncomingMessagesByRoom) {
      this.unseenIncomingMessagesByRoom = new Map();
    }
    let set = this.unseenIncomingMessagesByRoom.get(normKey) || this.unseenIncomingMessagesByRoom.get(rawKey);
    if (!set) {
      set = new Set();
      this.unseenIncomingMessagesByRoom.set(normKey, set);
    }
    set.add(String(messageId));
    if (normKey !== rawKey) {
      this.unseenIncomingMessagesByRoom.set(rawKey, set);
    }
    return set.size;
  }

  /**
   * Returns the count of unseen incoming messages for a room.
   * @param {string} roomId
   * @returns {number}
   */
  getUnseenIncomingMessagesCount(roomId) {
    if (!roomId || !this.unseenIncomingMessagesByRoom) return 0;
    const rawKey = String(roomId);
    const normKey = rawKey.toLowerCase().trim();
    return this.unseenIncomingMessagesByRoom.get(normKey)?.size ||
           this.unseenIncomingMessagesByRoom.get(rawKey)?.size || 0;
  }

  /**
   * Clears unseen incoming messages for a room (e.g. when user reaches bottom or sends a message).
   * @param {string} roomId
   */
  clearUnseenIncomingMessages(roomId) {
    if (!roomId || !this.unseenIncomingMessagesByRoom) return;
    const rawKey = String(roomId);
    const normKey = rawKey.toLowerCase().trim();
    this.unseenIncomingMessagesByRoom.get(normKey)?.clear();
    this.unseenIncomingMessagesByRoom.get(rawKey)?.clear();
  }

  /**
   * Deletes a specific message ID from the unseen set (e.g. on message.deleted).
   * @param {string} roomId
   * @param {string} messageId
   * @returns {number} The updated unseen count
   */
  deleteUnseenIncomingMessage(roomId, messageId) {
    if (!roomId || !messageId || !this.unseenIncomingMessagesByRoom) return 0;
    const rawKey = String(roomId);
    const normKey = rawKey.toLowerCase().trim();
    const set = this.unseenIncomingMessagesByRoom.get(normKey) || this.unseenIncomingMessagesByRoom.get(rawKey);
    if (set) {
      set.delete(String(messageId));
      return set.size;
    }
    return 0;
  }

  /**
   * Retrieves currently selected conversation item if any.
   * @returns {object|null}
   */
  getSelectedConversation() {
    if (!this.selectedRoomId) return null;
    return this.conversations.find((c) => c.roomId === this.selectedRoomId) || null;
  }

  /**
   * Retrieves conversations matching current search query and active filter,
   * with pinned conversations floating to the top.
   * Normal Chats view always excludes archived conversations centrally.
   * @returns {Array}
   */
  getFilteredConversations() {
    let list = filterConversations(this.conversations, this.searchQuery, (id) => this.getContactNickname(id));

    // Centrally exclude archived conversations from the normal chat list and all filters
    list = list.filter((item) => !this.isArchived(item.roomId));

    const filter = this.activeFilter || 'all';
    if (filter === 'unread') {
      list = list.filter((item) => {
        const unread = typeof item.unreadCount === 'number' ? item.unreadCount : (item.unread_count || 0);
        return unread > 0;
      });
    } else if (filter === 'favourites') {
      list = list.filter((item) => this.isFavourite(item.roomId));
    } else if (filter === 'groups') {
      list = list.filter((item) => item.kind === 'group' || item.isGroup);
    } else {
      const customList = this.customLists.find((l) => l.id === filter);
      if (customList) {
        const roomSet = new Set(customList.roomIds.map(String));
        list = list.filter((item) => roomSet.has(String(item.roomId)));
      }
    }

    if (this.pinnedRoomIds && this.pinnedRoomIds.size > 0) {
      const pinned = [];
      const unpinned = [];
      for (const item of list) {
        if (this.isPinned(item.roomId)) {
          pinned.push(item);
        } else {
          unpinned.push(item);
        }
      }
      return [...pinned, ...unpinned];
    }

    return list;
  }

  /**
   * Checks whether a conversation is archived.
   * @param {string} roomId
   * @returns {boolean}
   */
  isArchived(roomId) {
    if (!roomId) return false;
    return this.archivedRoomIds.has(String(roomId));
  }

  /**
   * Archives a conversation by adding its roomId to local archived state.
   * Does NOT leave group, delete conversation, or alter unread/pin/favourite state.
   * @param {string} roomId
   * @returns {boolean}
   */
  archiveChat(roomId) {
    if (!roomId) return false;
    this.archivedRoomIds.add(String(roomId));
    this._persistArchived();
    return true;
  }

  /**
   * Unarchives a conversation by removing its roomId from local archived state.
   * Restores normal visibility while preserving all messages, pins, and favourites.
   * @param {string} roomId
   * @returns {boolean}
   */
  unarchiveChat(roomId) {
    if (!roomId) return false;
    const deleted = this.archivedRoomIds.delete(String(roomId));
    this._persistArchived();
    return deleted;
  }

  /**
   * Toggles archived status for a conversation.
   * @param {string} roomId
   * @returns {boolean} New archived state
   */
  toggleArchiveChat(roomId) {
    if (this.isArchived(roomId)) {
      this.unarchiveChat(roomId);
      return false;
    }
    this.archiveChat(roomId);
    return true;
  }

  /**
   * Retrieves all archived conversations matching search query.
   * Pinned conversations float to top within archived view.
   * @param {string} [searchQuery='']
   * @returns {Array}
   */
  getArchivedConversations(searchQuery = '') {
    if (!Array.isArray(this.conversations)) return [];
    let list = this.conversations.filter((c) => this.isArchived(c.roomId));
    if (searchQuery && typeof searchQuery === 'string' && searchQuery.trim() !== '') {
      list = filterConversations(list, searchQuery, (id) => this.getContactNickname(id));
    }
    if (this.pinnedRoomIds && this.pinnedRoomIds.size > 0) {
      const pinned = [];
      const unpinned = [];
      for (const item of list) {
        if (this.isPinned(item.roomId)) {
          pinned.push(item);
        } else {
          unpinned.push(item);
        }
      }
      return [...pinned, ...unpinned];
    }
    return list;
  }

  /**
   * Adds a call record to local call history (max 500 records, FIFO).
   * @param {object} record
   * @returns {object|null}
   */
  addCallRecord(record) {
    if (!record || typeof record !== 'object') return null;
    const entry = {
      id: record.id || ('call_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8)),
      callId: record.callId || '',
      roomId: record.roomId || '',
      participantId: record.participantId || '',
      participantName: record.participantName || '',
      participantPhone: record.participantPhone || '',
      participantAvatar: record.participantAvatar || '',
      direction: record.direction === 'outgoing' ? 'outgoing' : 'incoming',
      callType: record.callType === 'video' ? 'video' : 'voice',
      status: ['completed', 'missed', 'declined', 'cancelled'].includes(record.status) ? record.status : 'completed',
      startedAt: typeof record.startedAt === 'number' ? record.startedAt : Date.now(),
      endedAt: typeof record.endedAt === 'number' ? record.endedAt : (record.endedAt ? new Date(record.endedAt).getTime() : null),
      duration: typeof record.duration === 'number' ? Math.max(0, Math.round(record.duration)) : 0
    };
    this.callHistory.unshift(entry);
    if (this.callHistory.length > 500) {
      this.callHistory = this.callHistory.slice(0, 500);
    }
    this._persistCallHistory();
    return entry;
  }

  /**
   * Persists a call record into room call history.
   * @param {string} roomId
   * @param {object} record
   * @returns {object|null}
   */
  addRoomCallRecord(roomId, record) {
    return saveRoomCallRecord(roomId, record, this.currentUser?.userId);
  }

  /**
   * Retrieves local room call records.
   * @param {string} roomId
   * @returns {Array<object>}
   */
  getRoomCallRecords(roomId) {
    return getRoomCallRecords(roomId, this.currentUser?.userId);
  }

  /**
   * Retrieves call history filtered by search query.
   * @param {string} [searchQuery='']
   * @returns {Array}
   */
  getCallHistory(searchQuery = '') {
    if (!Array.isArray(this.callHistory)) return [];
    if (!searchQuery || typeof searchQuery !== 'string' || searchQuery.trim() === '') {
      return [...this.callHistory];
    }
    const q = searchQuery.trim().toLowerCase();
    return this.callHistory.filter((item) => {
      const name = (item.participantName || '').toLowerCase();
      const phone = (item.participantPhone || '').toLowerCase();
      const pid = (item.participantId || '').toLowerCase();
      const rid = (item.roomId || '').toLowerCase();
      return name.includes(q) || phone.includes(q) || pid.includes(q) || rid.includes(q);
    });
  }

  /**
   * Clears local call history.
   */
  clearCallHistory() {
    this.callHistory = [];
    this._persistCallHistory();
  }

  /**
   * Updates real-time WebSocket state.
   * @param {string} state
   * @param {object} [details=null]
   */
  setWsState(state, details = null) {
    this.wsState = (state || 'disconnected').toLowerCase();
    this.wsDetails = details;
  }

  /**
   * Opens Contact Info panel for the given or currently selected roomId.
   * @param {string} [roomId]
   */
  openContactInfo(roomId = null) {
    const targetRoomId = roomId || this.selectedRoomId;
    if (!targetRoomId) return;
    this.contactInfoOpen = true;
    this.activeContactInfoRoomId = targetRoomId;
  }

  /**
   * Closes Contact Info panel.
   */
  closeContactInfo() {
    this.contactInfoOpen = false;
    this.activeContactInfoRoomId = null;
  }

  /**
   * Checks whether Contact Info panel is open.
   * @returns {boolean}
   */
  isContactInfoOpen() {
    return Boolean(this.contactInfoOpen);
  }

  /**
   * Retrieves active contact info room ID.
   * @returns {string|null}
   */
  getContactInfoRoomId() {
    return this.activeContactInfoRoomId;
  }

  /**
   * Removes a conversation from the client chat list and cleans up associated room IDs.
   * @param {string} roomId
   * @returns {boolean}
   */
  removeConversation(roomId) {
    if (!roomId || !Array.isArray(this.conversations)) return false;
    const initialLength = this.conversations.length;
    this.conversations = this.conversations.filter((c) => c && String(c.roomId) !== String(roomId));
    if (this.selectedRoomId === roomId) {
      this.selectedRoomId = null;
    }
    if (this.activeContactInfoRoomId === roomId) {
      this.closeContactInfo();
    }
    this.unpinChat(roomId);
    this.unfavouriteChat(roomId);
    if (this.archivedRoomIds && typeof this.unarchiveChat === 'function') {
      this.unarchiveChat(roomId);
    }
    if (typeof this.unmarkAsUnread === 'function') {
      this.unmarkAsUnread(roomId);
    }
    if (Array.isArray(this.customLists)) {
      for (const list of this.customLists) {
        if (Array.isArray(list?.roomIds)) {
          list.roomIds = list.roomIds.filter((id) => String(id) !== String(roomId));
        }
      }
    }
    try {
      this._persistCustomLists?.();
    } catch (_) {}
    return this.conversations.length < initialLength;
  }

  /**
   * Updates presence (online/offline) for a principal in a specific room.
   * @param {string} roomId
   * @param {string} principalId
   * @param {boolean} online
   * @returns {boolean}
   */
  setPresence(roomId, principalId, online) {
    if (!roomId || !principalId) return Boolean(online);
    const rId = String(roomId);
    const pId = String(principalId);
    if (!this.presenceByRoom.has(rId)) {
      this.presenceByRoom.set(rId, new Map());
    }

    // Suppress presence if this contact is blocked
    if (this.isUserBlocked(pId) || this.isRoomBlocked(rId)) {
      this.presenceByRoom.get(rId).set(pId, false);
      return false;
    }
    const conv = Array.isArray(this.conversations)
      ? this.conversations.find((c) => c && (c.roomId === rId || c.room_id === rId || c.id === rId))
      : null;
    if (conv && (conv.isBlocked || conv.blocked || conv.blockedByPeer || conv.peer?.isBlocked || conv.peer?.is_blocked)) {
      this.presenceByRoom.get(rId).set(pId, false);
      return false;
    }

    const isOnline = Boolean(online);
    this.presenceByRoom.get(rId).set(pId, isOnline);
    return isOnline;
  }

  /**
   * Checks whether a user is online in a room.
   * @param {string} roomId
   * @param {string} principalId
   * @returns {boolean}
   */
  isUserOnline(roomId, principalId) {
    if (!roomId || !principalId) return false;
    if (this.isUserBlocked(principalId)) return false;
    if (this.isRoomBlocked(roomId)) return false;
    const conv = Array.isArray(this.conversations)
      ? this.conversations.find((c) => c && (c.roomId === String(roomId) || c.room_id === String(roomId) || c.id === String(roomId)))
      : null;
    if (conv && (conv.isBlocked || conv.blocked || conv.blockedByPeer || conv.peer?.isBlocked || conv.peer?.is_blocked)) {
      return false;
    }
    return Boolean(this.presenceByRoom.get(String(roomId))?.get(String(principalId)));
  }

  /**
   * Updates typing status for a principal in a specific room.
   * @param {string} roomId
   * @param {string} principalId
   * @param {boolean} isTyping
   * @returns {boolean}
   */
  setTyping(roomId, principalId, isTyping) {
    if (!roomId || !principalId) return false;
    const rId = String(roomId);
    const pId = String(principalId);
    if (!this.typingByRoom.has(rId)) {
      this.typingByRoom.set(rId, new Set());
    }
    const typingSet = this.typingByRoom.get(rId);
    if (isTyping && !this.isUserBlocked(pId) && !this.isRoomBlocked(rId)) {
      const conv = Array.isArray(this.conversations)
        ? this.conversations.find((c) => c && (c.roomId === rId || c.room_id === rId || c.id === rId))
        : null;
      if (!conv || (!conv.isBlocked && !conv.blocked && !conv.blockedByPeer && !conv.peer?.isBlocked && !conv.peer?.is_blocked)) {
        typingSet.add(pId);
        return true;
      }
    }
    typingSet.delete(pId);
    return false;
  }

  /**
   * Checks whether a user is currently typing in a room.
   * @param {string} roomId
   * @param {string} principalId
   * @returns {boolean}
   */
  isUserTyping(roomId, principalId) {
    if (!roomId || !principalId) return false;
    if (this.isUserBlocked(principalId)) return false;
    if (this.isRoomBlocked(roomId)) return false;
    const conv = Array.isArray(this.conversations)
      ? this.conversations.find((c) => c && (c.roomId === String(roomId) || c.room_id === String(roomId) || c.id === String(roomId)))
      : null;
    if (conv && (conv.isBlocked || conv.blocked || conv.blockedByPeer || conv.peer?.isBlocked || conv.peer?.is_blocked)) {
      return false;
    }
    return Boolean(this.typingByRoom.get(String(roomId))?.has(String(principalId)));
  }

  /**
   * Gets list of principal IDs currently typing in a room.
   * @param {string} roomId
   * @returns {string[]}
   */
  getTypingUsers(roomId) {
    if (!roomId) return [];
    const set = this.typingByRoom.get(String(roomId));
    return set ? Array.from(set) : [];
  }

  /**
   * Clears all typing users in a room.
   * @param {string} roomId
   */
  clearRoomTyping(roomId) {
    if (!roomId) return;
    this.typingByRoom.delete(String(roomId));
  }

  /**
   * Resolves direct peer user ID for a conversation.
   * @param {object} item
   * @returns {string|null}
   */
  getDirectPeerUserId(item) {
    return getDirectPeerUserId(item, this.currentUserId || this.currentUser?.userId || this.currentUser?.user_id);
  }

  /**
   * Computes the header status text for a conversation by roomId.
   * @param {string} roomId
   * @returns {string}
   */
  getConversationHeaderStatusForRoom(roomId) {
    const item = this._findConversation(roomId);
    if (!item) return '';
    const isGroup = item.kind === 'group' || item.isGroup === true;
    if (isGroup) {
      return getConversationHeaderStatus(item);
    }
    const peerId = this.getDirectPeerUserId(item);
    const isTyping = peerId ? this.isUserTyping(roomId, peerId) : false;
    const isOnline = peerId ? this.isUserOnline(roomId, peerId) : false;
    return getConversationHeaderStatus(item, { isTyping, isOnline });
  }

  /**
   * Resets all chat state (called on logout).
   */
  clear() {
    this.conversations = [];
    this.searchQuery = '';
    this.selectedRoomId = null;
    this.isLoadingInbox = false;
    this.inboxError = null;
    this.wsState = 'disconnected';
    this.wsDetails = null;
    this.currentUser = null;
    this.activeFilter = 'all';
    this.pinnedRoomIds = new Set();
    this.favouriteRoomIds = new Set();
    this.customLists = [];
    this.archivedRoomIds = new Set();
    this.callHistory = [];
    this.contactInfoOpen = false;
    this.activeContactInfoRoomId = null;
    this.contactNicknames = new Map();
    this.presenceByRoom = new Map();
    this.typingByRoom = new Map();
    this.pinnedMessages = new Map();
    this.selectedMessageIds = new Set();
    this.isMessageSelectionMode = false;
  }
}

// ═══════════════════════════════════════════════════════════════════
// Phase 4B: Validation & Draft State Helpers
// ═══════════════════════════════════════════════════════════════════

/**
 * Validates and cleans a phone number string.
 * @param {string} phone
 * @returns {{ valid: boolean, cleaned?: string, error?: string }}
 */
export function validatePhone(phone) {
  if (!phone || typeof phone !== 'string') {
    return { valid: false, error: 'Phone number is required' };
  }
  const trimmed = phone.trim();
  if (trimmed.length === 0) {
    return { valid: false, error: 'Phone number cannot be empty' };
  }
  // Strip spaces, dashes, parentheses
  const cleaned = trimmed.replace(/[\s\-()]/g, '');
  const digits = cleaned.replace(/\D/g, '');
  if (digits.length < 4) {
    return { valid: false, error: 'Phone number is too short' };
  }
  if (!/^\+?[0-9]{4,18}$/.test(cleaned)) {
    return { valid: false, error: 'Invalid phone number format' };
  }
  return { valid: true, cleaned };
}

/**
 * Validates a group name.
 * @param {string} name
 * @returns {{ valid: boolean, name?: string, error?: string }}
 */
export function validateGroupName(name) {
  if (!name || typeof name !== 'string') {
    return { valid: false, error: 'Group name is required' };
  }
  const trimmed = name.trim();
  if (trimmed.length === 0) {
    return { valid: false, error: 'Group name cannot be empty' };
  }
  if (trimmed.length < 6) {
    return { valid: false, error: 'Group name must be at least 6 characters' };
  }
  if (trimmed.length > 60) {
    return { valid: false, error: 'Group name cannot exceed 60 characters' };
  }
  return { valid: true, name: trimmed };
}

/**
 * Validates group description. Maximum 512 characters. Trims input. Empty is valid (clears).
 * @param {string|null|undefined} raw
 * @returns {{ valid: boolean, description?: string, error?: string }}
 */
export function validateGroupDescription(raw) {
  if (raw === null || raw === undefined) {
    return { valid: true, description: '' };
  }
  const str = String(raw).trim();
  if (str.length === 0) {
    return { valid: true, description: '' };
  }
  if (str.length > 512) {
    return { valid: false, error: 'Group description cannot exceed 512 characters' };
  }
  return { valid: true, description: str };
}

/**
 * State manager for direct chat creation draft.
 */
export class DirectChatDraft {
  constructor() {
    this.phone = '';
    this.matchedContact = null;
    this.error = null;
    this.isLookingUp = false;
    this.isSubmitting = false;
  }

  setPhone(phone) {
    this.phone = typeof phone === 'string' ? phone : '';
    this.matchedContact = null;
    this.error = null;
  }

  setMatchedContact(contact) {
    if (contact && contact.userId) {
      this.matchedContact = {
        userId: contact.userId,
        phone: contact.phone || '',
        displayName: contact.displayName || null
      };
      this.error = null;
    } else {
      this.matchedContact = null;
    }
  }

  canStart() {
    return Boolean(this.matchedContact?.userId) && !this.isSubmitting && !this.isLookingUp;
  }

  reset() {
    this.phone = '';
    this.matchedContact = null;
    this.error = null;
    this.isLookingUp = false;
    this.isSubmitting = false;
  }
}

/**
 * State manager for group creation draft.
 */
export class GroupCreationDraft {
  constructor() {
    this.name = '';
    this.members = [];
    this.error = null;
    this.isSubmitting = false;
  }

  setName(name) {
    this.name = typeof name === 'string' ? name : '';
    this.error = null;
  }

  /**
   * Adds a matched contact to members list.
   * @param {object} contact
   * @param {string|null} [currentUserId=null]
   * @returns {{ added: boolean, error?: string }}
   */
  addMember(contact, currentUserId = null) {
    if (!contact || !contact.userId) {
      return { added: false, error: 'Invalid contact' };
    }
    if (currentUserId && contact.userId === currentUserId) {
      return { added: false, error: 'You are automatically included as the group creator' };
    }
    if (this.members.some((m) => m.userId === contact.userId)) {
      return { added: false, error: 'Contact is already added to the group' };
    }
    this.members.push({
      userId: contact.userId,
      phone: contact.phone || '',
      displayName: contact.displayName || null
    });
    this.error = null;
    return { added: true };
  }

  /**
   * Removes member by userId.
   * @param {string} userId
   */
  removeMember(userId) {
    this.members = this.members.filter((m) => m.userId !== userId);
  }

  getMemberUserIds() {
    return this.members.map((m) => m.userId);
  }

  canSubmit() {
    const validName = validateGroupName(this.name).valid;
    return validName && this.members.length >= 1 && !this.isSubmitting;
  }

  reset() {
    this.name = '';
    this.members = [];
    this.error = null;
    this.isSubmitting = false;
  }
}

/**
 * Determines whether a participant has administrative privileges in a group.
 * Matches backend roles: 'owner' (group creator) and 'admin' (promoted admin).
 * @param {object|string} participant Participant object or role string
 * @returns {boolean}
 */
export function isParticipantAdmin(participant) {
  if (!participant) return false;
  const role = typeof participant === 'string' ? participant : participant.role;
  if (!role) return false;
  const r = String(role).toLowerCase().trim();
  return r === 'admin' || r === 'owner' || r === 'creator';
}

/**
 * Checks if a participant is the group owner or creator.
 * @param {object|string} participant
 * @returns {boolean}
 */
export function isParticipantOwner(participant) {
  if (!participant) return false;
  const role = typeof participant === 'string' ? participant : participant.role;
  if (!role) return false;
  const r = String(role).toLowerCase().trim();
  return r === 'owner' || r === 'creator';
}

/**
 * Determines whether a participant matches the current user's ID.
 * Performs case-insensitive matching across canonical keys.
 * @param {object} participant
 * @param {string} currentUserId
 * @returns {boolean}
 */
export function isParticipantSelf(participant, currentUserId) {
  if (!participant || !currentUserId) return false;
  const pId = participant.principalId || participant.principal_id || participant.userId || participant.user_id;
  return Boolean(pId && String(pId).toLowerCase().trim() === String(currentUserId).toLowerCase().trim());
}

/**
 * Filters out ineligible room participants for adding to an ongoing call:
 * - Excludes current user (self)
 * - Excludes participants already active in the call
 * @param {Array<object>} participants List of normalized room participants
 * @param {string} currentUserId Current logged in user ID
 * @param {Set<string>|Array<string>} [activeParticipantsSet] Set or Array of active participant IDs
 * @returns {Array<object>}
 */
export function filterEligibleCallParticipants(participants, currentUserId, activeParticipantsSet = new Set()) {
  if (!Array.isArray(participants)) return [];
  const activeSet = activeParticipantsSet instanceof Set
    ? activeParticipantsSet
    : new Set(Array.isArray(activeParticipantsSet) ? activeParticipantsSet : []);
  return participants.filter((p) => {
    const pid = p.principalId || p.principal_id || p.userId || p.user_id;
    if (!pid) return false;
    if (isParticipantSelf(p, currentUserId) || String(pid).toLowerCase().trim() === String(currentUserId).toLowerCase().trim()) return false;
    if (activeSet.has(pid) || activeSet.has(String(pid).toLowerCase().trim())) return false;
    return true;
  });
}

/**
 * Formats a backend group management error message cleanly for display.
 * Surfaces clean explanation when the backend endpoint is not yet deployed on the server.
 * @param {string} action Description of the action (e.g. 'Remove member')
 * @param {object|Error} err The error object
 * @returns {string}
 */
export function formatBackendGroupError(action, err) {
  if (err?.httpStatus === 404 || err?.message?.includes('no such route') || err?.code === 'not_found') {
    return `${action} failed: backend endpoint requires server deployment (no such route 404)`;
  }
  return err?.message || `${action} failed`;
}

// ═══════════════════════════════════════════════════════════════════
// Phase 4C: Message History, Day Grouping & Pure Helpers
// ═══════════════════════════════════════════════════════════════════

export const MESSAGE_STATUS = {
  FAILED: 'failed',
  PENDING: 'pending',
  SENDING: 'sending',
  SENT: 'sent',
  DELIVERED: 'delivered',
  READ: 'read'
};

export const STATUS_RANKS = {
  failed: -1,
  pending: 0,
  sending: 0,
  sent: 1,
  delivered: 2,
  read: 3
};

/**
 * Compares any number of status strings and returns the highest according to STATUS_RANKS.
 * Enforces monotonic ranking: sending (0) < sent (1) < delivered (2) < read (3).
 * @param {...(string|null|undefined)} statuses
 * @returns {string|null}
 */
export function getHighestStatus(...statuses) {
  let highest = null;
  let highestRank = -99;
  for (const s of statuses) {
    if (!s || typeof s !== 'string') continue;
    const lower = s.toLowerCase().trim();
    const rank = STATUS_RANKS[lower] ?? -99;
    if (rank > highestRank) {
      highestRank = rank;
      highest = lower;
    }
  }
  return highest;
}

/**
 * Determines whether the window/document is currently active and visible to the user.
 * Returns false when minimized, hidden in system tray, tab is hidden, or window does not have active focus.
 * @param {Document|null} [doc]
 * @param {object|null} [windowState]
 * @returns {boolean}
 */
export function isWindowActiveAndVisible(doc = (typeof document !== 'undefined' ? document : null), windowState = null) {
  if (windowState) {
    if (windowState.isMinimized === true) return false;
    if (windowState.isVisible === false) return false;
    if (windowState.isFocused === false) return false;
  }
  if (!doc) return true;
  if (doc.hidden) return false;
  if (typeof doc.visibilityState === 'string' && doc.visibilityState !== 'visible') return false;
  if (typeof doc.hasFocus === 'function' && !doc.hasFocus()) return false;
  return true;
}

/**
 * Formats an ISO date/timestamp string into a friendly message time (e.g. 10:42 AM).
 * @param {string|number|Date|null} timestamp
 * @returns {string}
 */
export function formatMessageTime(timestamp) {
  if (!timestamp) return '';
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';

  let hours = date.getHours();
  const minutes = date.getMinutes().toString().padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12 || 12;
  return `${hours}:${minutes} ${ampm}`;
}

export const formatTimestamp = formatMessageTime;

/**
 * Formats full date and time for message info displays.
 * @param {string|number|Date|null} timestamp
 * @returns {string}
 */
export function formatFullDateTime(timestamp) {
  if (!timestamp) return '';
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';
  const time = formatMessageTime(date);
  const day = date.getDate().toString().padStart(2, '0');
  const month = (date.getMonth() + 1).toString().padStart(2, '0');
  const year = date.getFullYear();
  return `${day}/${month}/${year}, ${time}`;
}

/**
 * Formats a message timestamp into a calendar day divider label (Today, Yesterday, etc.).
 * @param {string|number|Date|null} timestamp
 * @param {Date} [now=new Date()]
 * @returns {string}
 */
export function formatDayDivider(timestamp, now = new Date()) {
  if (!timestamp) return '';
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '';

  const isToday =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();

  if (isToday) return 'Today';

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday =
    date.getFullYear() === yesterday.getFullYear() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getDate() === yesterday.getDate();

  if (isYesterday) return 'Yesterday';

  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const weekday = days[date.getDay()];
  const month = months[date.getMonth()];
  const day = date.getDate();

  if (date.getFullYear() === now.getFullYear()) {
    return `${weekday}, ${month} ${day}`;
  }
  return `${month} ${day}, ${date.getFullYear()}`;
}

/**
 * Returns a local date key (YYYY-MM-DD) for grouping.
 * @param {Date} date
 * @returns {string}
 */
export function getLocalDateKey(date) {
  const y = date.getFullYear();
  const m = (date.getMonth() + 1).toString().padStart(2, '0');
  const d = date.getDate().toString().padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Returns a calendar date key (YYYY-MM-DD) from a date, timestamp or ISO string.
 * @param {string|number|Date|null} timestamp
 * @returns {string}
 */
export function getCalendarDateKey(timestamp) {
  if (!timestamp) return 'unknown-date';
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  if (Number.isNaN(date.getTime())) return 'unknown-date';
  return getLocalDateKey(date);
}

/**
 * Formats a message timestamp into a calendar day divider label.
 * @param {string|number|Date|null} timestamp
 * @param {Date} [now=new Date()]
 * @returns {string}
 */
export function formatCalendarDayLabel(timestamp, now = new Date()) {
  return formatDayDivider(timestamp, now);
}

/**
 * Groups messages into chronological sections by their local calendar day.
 * @param {Array} messages
 * @param {Date} [now=new Date()]
 * @returns {Array<{ dateKey: string, label: string, messages: Array }>}
 */
export function groupMessagesByDay(messages, now = new Date()) {
  if (!Array.isArray(messages) || messages.length === 0) return [];

  const dateMap = new Map();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg) continue;
    const ts = msg.createdAt || msg.created_at;
    const date = ts ? new Date(ts) : new Date();
    const isValid = !Number.isNaN(date.getTime());
    const dateKey = isValid ? getLocalDateKey(date) : 'unknown-date';
    const label = isValid ? formatDayDivider(date, now) : 'Date';

    let group = dateMap.get(dateKey);
    if (!group) {
      group = {
        dateKey,
        label,
        entries: [],
        _firstTimestamp: isValid ? date.getTime() : 0
      };
      dateMap.set(dateKey, group);
    } else if (isValid && date.getTime() < group._firstTimestamp) {
      group._firstTimestamp = date.getTime();
    }
    group.entries.push({ msg, index: i });
  }

  // Sort groups chronologically so earlier days appear first
  const sorted = Array.from(dateMap.values()).sort((a, b) => {
    if (a.dateKey !== 'unknown-date' && b.dateKey !== 'unknown-date') {
      return a.dateKey.localeCompare(b.dateKey);
    }
    return a._firstTimestamp - b._firstTimestamp;
  });

  return sorted.map(({ dateKey, label, entries }) => {
    entries.sort((entryA, entryB) => {
      const a = entryA.msg;
      const b = entryB.msg;
      const seqA = a.eventSeq ?? a.event_seq ?? 0;
      const seqB = b.eventSeq ?? b.event_seq ?? 0;
      if (seqA > 0 && seqB > 0 && seqA !== seqB) {
        return seqA - seqB;
      }
      const timeA = Date.parse(a.createdAt || a.created_at || '') || (typeof a.startedAt === 'number' ? a.startedAt : 0);
      const timeB = Date.parse(b.createdAt || b.created_at || '') || (typeof b.startedAt === 'number' ? b.startedAt : 0);
      if (timeA !== timeB) {
        return timeA - timeB;
      }
      const ordA = a.order ?? a.seq ?? 0;
      const ordB = b.order ?? b.seq ?? 0;
      if (ordA !== ordB) {
        return ordA - ordB;
      }
      return entryA.index - entryB.index;
    });

    return {
      dateKey,
      label,
      messages: entries.map((e) => e.msg)
    };
  });
}

/**
 * Calculates the active date label for the element currently at or nearest the top of the visible message area.
 * @param {number} scrollTop Current scrollTop position of the scroll container
 * @param {Array<{ offsetTop: number, offsetHeight?: number, dataset?: { dateLabel?: string, dateKey?: string } }>} elements
 * @param {number} [threshold=30] Top offset threshold in pixels
 * @returns {string}
 */
export function calculateVisibleDateLabel(scrollTop, elements, threshold = 30) {
  if (!Array.isArray(elements) || elements.length === 0) return '';

  const targetY = (typeof scrollTop === 'number' ? scrollTop : 0) + threshold;

  let low = 0;
  let high = elements.length - 1;
  let topItem = elements[0];

  while (low <= high) {
    const mid = (low + high) >> 1;
    const item = elements[mid];
    const top = typeof item?.offsetTop === 'number' ? item.offsetTop : 0;
    if (top <= targetY) {
      topItem = item;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  // Walk backward if item does not have dateLabel
  if (topItem && !topItem.dataset?.dateLabel) {
    const idx = elements.indexOf(topItem);
    for (let i = idx - 1; i >= 0; i--) {
      if (elements[i]?.dataset?.dateLabel) {
        topItem = elements[i];
        break;
      }
    }
  }

  return topItem?.dataset?.dateLabel || elements[0]?.dataset?.dateLabel || '';
}

function extractAttachmentId(message, body) {
  // Check message-level attachment collections
  if (Array.isArray(message?.attachment_ids) && message.attachment_ids.length > 0) {
    const item = message.attachment_ids[0];
    const id = typeof item === 'object' ? (item?.id || item?.attachment_id || item?.attachmentId) : item;
    if (id) return String(id);
  }
  if (Array.isArray(message?.attachmentIds) && message.attachmentIds.length > 0) {
    const item = message.attachmentIds[0];
    const id = typeof item === 'object' ? (item?.id || item?.attachment_id || item?.attachmentId) : item;
    if (id) return String(id);
  }
  if (Array.isArray(message?.attachments) && message.attachments.length > 0) {
    const item = message.attachments[0];
    const id = typeof item === 'object' ? (item?.id || item?.attachment_id || item?.attachmentId) : item;
    if (id) return String(id);
  }

  // Check body-level attachment collections
  if (Array.isArray(body?.attachment_ids) && body.attachment_ids.length > 0) {
    const item = body.attachment_ids[0];
    const id = typeof item === 'object' ? (item?.id || item?.attachment_id || item?.attachmentId) : item;
    if (id) return String(id);
  }
  if (Array.isArray(body?.attachmentIds) && body.attachmentIds.length > 0) {
    const item = body.attachmentIds[0];
    const id = typeof item === 'object' ? (item?.id || item?.attachment_id || item?.attachmentId) : item;
    if (id) return String(id);
  }
  if (Array.isArray(body?.attachments) && body.attachments.length > 0) {
    const item = body.attachments[0];
    const id = typeof item === 'object' ? (item?.id || item?.attachment_id || item?.attachmentId) : item;
    if (id) return String(id);
  }

  // Check scalar fields
  const scalar = body?.attachment_id || body?.attachmentId || body?.attachment || message?.attachment_id || message?.attachmentId || message?.attachment;
  if (scalar) {
    return typeof scalar === 'object' ? String(scalar?.id || scalar?.attachment_id || scalar?.attachmentId || '') : String(scalar);
  }
  return null;
}

function extractMediaUrl(message, body) {
  return body?.url
    || body?.download_url
    || body?.downloadUrl
    || body?.preview_url
    || message?.url
    || message?.download_url
    || message?.downloadUrl
    || message?.attachments?.[0]?.url
    || message?.attachments?.[0]?.download_url
    || message?.attachments?.[0]?.downloadUrl
    || null;
}

/**
 * Collects all attachment IDs referenced by a single message,
 * supporting scalar fields, arrays, and normalized attachment structures.
 * @param {object} msg
 * @returns {Set<string>}
 */
export function collectAttachmentIdsFromMessage(msg) {
  const ids = new Set();
  if (!msg || typeof msg !== 'object') return ids;

  const addId = (val) => {
    if (val === null || val === undefined) return;
    if (typeof val === 'string' || typeof val === 'number') {
      const s = String(val).trim();
      if (s) ids.add(s);
    } else if (typeof val === 'object') {
      const candidate = val.attachmentId || val.attachment_id || val.id || val.attachment;
      if (candidate !== null && candidate !== undefined && (typeof candidate === 'string' || typeof candidate === 'number')) {
        const s = String(candidate).trim();
        if (s) ids.add(s);
      }
    }
  };

  const body = msg.body && typeof msg.body === 'object' ? msg.body : {};

  // Direct scalar fields on message
  addId(msg.attachmentId);
  addId(msg.attachment_id);
  addId(msg.attachment);

  // Direct scalar fields on body
  addId(body.attachmentId);
  addId(body.attachment_id);
  addId(body.attachment);

  // Array collections on message and body
  const arrayCandidates = [
    msg.attachmentIds,
    msg.attachment_ids,
    msg.attachments,
    body.attachmentIds,
    body.attachment_ids,
    body.attachments
  ];

  for (const arr of arrayCandidates) {
    if (Array.isArray(arr)) {
      for (const item of arr) {
        addId(item);
      }
    }
  }

  // Also check if extractAttachmentId extracts an attachmentId
  try {
    const extracted = extractAttachmentId(msg, body);
    if (extracted) {
      addId(extracted);
    }
  } catch (_) {}

  return ids;
}

/**
 * Collects all attachment IDs referenced by an array of messages.
 * @param {Array<object>} messages
 * @returns {Set<string>}
 */
export function collectAttachmentIdsFromMessages(messages) {
  const allIds = new Set();
  if (!Array.isArray(messages)) return allIds;
  for (const msg of messages) {
    const ids = collectAttachmentIdsFromMessage(msg);
    for (const id of ids) {
      allIds.add(id);
    }
  }
  return allIds;
}

/**
 * Determines which attachment IDs belonging to targetRoomId are eligible for cache deletion.
 * An attachment ID is eligible ONLY IF no other loaded room references it.
 * @param {string} targetRoomId
 * @param {Map|object} roomMessagesMap Map or object of roomId -> RoomMessagesState
 * @param {Array<object>} targetMessages Messages in target room
 * @returns {string[]} Array of eligible attachment IDs
 */
export function getEligibleAttachmentIdsForDeletion(targetRoomId, roomMessagesMap, targetMessages) {
  const targetAttachmentIds = collectAttachmentIdsFromMessages(targetMessages);
  if (targetAttachmentIds.size === 0) {
    return [];
  }

  // Collect all attachment IDs used by other loaded rooms
  const otherRoomsAttachmentIds = new Set();
  if (roomMessagesMap) {
    const entries = typeof roomMessagesMap.entries === 'function'
      ? Array.from(roomMessagesMap.entries())
      : Object.entries(roomMessagesMap);

    for (const [rId, otherState] of entries) {
      if (String(rId) === String(targetRoomId)) continue;
      if (otherState && Array.isArray(otherState.messages)) {
        const otherIds = collectAttachmentIdsFromMessages(otherState.messages);
        for (const oid of otherIds) {
          otherRoomsAttachmentIds.add(oid);
        }
      }
    }
  }

  // An attachment ID is eligible for deletion ONLY IF no other room references it
  const eligible = [];
  for (const id of targetAttachmentIds) {
    if (!otherRoomsAttachmentIds.has(id)) {
      eligible.push(id);
    }
  }
  return eligible;
}

/**
 * Checks if a message was forwarded based on Android convention or client metadata.
 * @param {object} message
 * @returns {boolean}
 */
export function isForwardedMessage(message) {
  if (!message || typeof message !== 'object') return false;
  if (message.is_forwarded || message.isForwarded) return true;
  const body = message.body && typeof message.body === 'object' ? message.body : {};
  if (body.is_forwarded || body.isForwarded || body.forwarded) return true;
  const text = typeof body.text === 'string' ? body.text : (typeof message.text === 'string' ? message.text : '');
  if (text.startsWith('[Forwarded] ') || text === '[Forwarded]') return true;
  const caption = typeof body.caption === 'string' ? body.caption : '';
  if (caption.startsWith('[Forwarded] ') || caption === '[Forwarded]') return true;
  return false;
}

/**
 * Strips internal [Forwarded] prefix from message text for clean UI rendering.
 * @param {string} text
 * @returns {string} Clean user-facing text
 */
export function getCleanForwardedText(text) {
  if (typeof text !== 'string') return '';
  if (text.startsWith('[Forwarded] ')) {
    return text.slice(12);
  }
  if (text === '[Forwarded]') {
    return '';
  }
  return text;
}

/**
 * Safely extracts supported text content, or returns safe fallbacks for media/unsupported kinds.
 * Never executes HTML.
 * @param {object} message
 * @returns {{ kind: string, text: string, isFallback: boolean, isForwarded?: boolean, fallbackText?: string, caption?: string, filename?: string, isDeleted?: boolean }}
 */
export function resolveMessageContent(message) {
  if (!message || typeof message !== 'object') {
    return { kind: 'unknown', text: '', isFallback: true, fallbackText: '[Empty message]' };
  }

  const isForwarded = isForwardedMessage(message);

  if (message.isCallEntry || message.kind === 'call') {
    const isVideo = Boolean(message.callType === 'video' || message.isVideo);
    const callType = isVideo ? 'video' : 'voice';
    const direction = message.direction === 'outgoing' ? 'outgoing' : 'incoming';
    const status = ['completed', 'missed', 'declined', 'cancelled'].includes(message.status) ? message.status : 'completed';
    const duration = typeof message.duration === 'number' ? message.duration : 0;
    const title = isVideo ? 'Video call' : 'Audio call';
    return {
      kind: 'call',
      callType,
      isVideo,
      direction,
      status,
      duration,
      text: title,
      title,
      isCallEntry: true,
      isDeleted: false,
      isFallback: false
    };
  }

  if (isCallSignalMessage(message)) {
    return {
      kind: 'call_signal',
      text: '',
      isFallback: true,
      fallbackText: ''
    };
  }

  if (
    message.isDeleted ||
    message.is_deleted ||
    message.kind === 'deleted' ||
    message.body?.is_deleted ||
    message.body?.isDeleted
  ) {
    return {
      kind: 'deleted',
      text: 'This message was deleted',
      isDeleted: true,
      isFallback: false
    };
  }

  const rawKind = (message.kind || '').toLowerCase();
  const body = message.body && typeof message.body === 'object' ? message.body : {};

  if (rawKind === 'system' || message.isSystem) {
    const text = typeof body.text === 'string'
      ? body.text
      : (typeof message.text === 'string'
        ? message.text
        : (typeof message.content === 'string'
          ? message.content
          : (typeof message.body === 'string'
            ? message.body
            : '')));
    return {
      kind: 'system',
      text,
      isSystem: true,
      isDeleted: false,
      isFallback: false
    };
  }
  const isVoiceNote = Boolean(
    body.is_voice_note ||
    body.isVoiceNote ||
    message.is_voice_note ||
    message.isVoiceNote ||
    ((rawKind === 'audio' || rawKind === 'file') && (body.filename || message.filename || '').includes('voice_message'))
  );

  const kind = rawKind || (isVoiceNote ? 'audio' : 'text');

  if (!isVoiceNote && kind === 'text') {
    let text = typeof body.text === 'string'
      ? body.text
      : (typeof message.text === 'string'
        ? message.text
        : (typeof message.content === 'string'
          ? message.content
          : (typeof message.body === 'string'
            ? message.body
            : '')));
    if (isForwarded) {
      text = getCleanForwardedText(text);
    }
    return {
      kind: 'text',
      text,
      isForwarded,
      isFallback: false
    };
  }

  if (kind === 'image') {
    const attachmentId = extractAttachmentId(message, body);
    let caption = typeof body.caption === 'string' ? body.caption : (typeof body.text === 'string' ? body.text : '');
    if (isForwarded) {
      caption = getCleanForwardedText(caption);
    }
    const filename = body.filename || message.attachments?.[0]?.original_name || message.attachments?.[0]?.filename || (caption ? 'Photo' : 'image.jpg');
    const mime = body.mime || message.attachments?.[0]?.mime || 'image/jpeg';
    const byteSize = body.byte_size ?? body.byteSize ?? message.attachments?.[0]?.byteSize ?? message.attachments?.[0]?.byte_size ?? null;
    const url = extractMediaUrl(message, body);

    return {
      kind: 'image',
      text: caption,
      caption,
      filename,
      mime,
      byteSize,
      attachmentId,
      url,
      isForwarded,
      isFallback: true,
      fallbackText: caption ? `📷 Photo: ${caption}` : `📷 Photo (${filename})`
    };
  }

  if (kind === 'video') {
    const attachmentId = extractAttachmentId(message, body);
    let caption = typeof body.caption === 'string' ? body.caption : (typeof body.text === 'string' ? body.text : '');
    if (isForwarded) {
      caption = getCleanForwardedText(caption);
    }
    const filename = body.filename || message.attachments?.[0]?.original_name || message.attachments?.[0]?.filename || 'video.mp4';
    const mime = body.mime || message.attachments?.[0]?.mime || 'video/mp4';
    const byteSize = body.byte_size ?? body.byteSize ?? message.attachments?.[0]?.byteSize ?? message.attachments?.[0]?.byte_size ?? null;
    const url = extractMediaUrl(message, body);

    return {
      kind: 'video',
      text: caption,
      caption,
      filename,
      mime,
      byteSize,
      attachmentId,
      url,
      isForwarded,
      isFallback: true,
      fallbackText: caption ? `🎥 Video: ${caption}` : `🎥 Video (${filename})`
    };
  }

  const detectedMime = (body.mime || message.attachments?.[0]?.mime || '').toLowerCase();
  const detectedExt = ((body.filename || message.attachments?.[0]?.original_name || '').split('.').pop() || '').toLowerCase();
  const isAudioFile = detectedMime.startsWith('audio/') || ['mp3', 'ogg', 'wav', 'flac', 'm4a', 'aac', 'webm'].includes(detectedExt);
  const duration = Number(body.duration ?? body.durationSec ?? body.duration_sec ?? message.duration ?? message.durationSec ?? message.duration_sec ?? 0);

  if (kind === 'audio' || isVoiceNote || (kind === 'file' && isAudioFile)) {
    const attachmentId = extractAttachmentId(message, body);
    let caption = typeof body.caption === 'string' ? body.caption : (typeof body.text === 'string' ? body.text : '');
    if (isForwarded) {
      caption = getCleanForwardedText(caption);
    }
    const filename = body.filename || message.attachments?.[0]?.original_name || message.attachments?.[0]?.filename || (isVoiceNote ? 'voice_message.webm' : 'audio.mp3');
    const mime = detectedMime || 'audio/webm;codecs=opus';
    const byteSize = body.byte_size ?? body.byteSize ?? message.attachments?.[0]?.byteSize ?? message.attachments?.[0]?.byte_size ?? null;
    const url = extractMediaUrl(message, body);

    return {
      kind: 'audio',
      text: caption,
      caption,
      filename,
      mime,
      byteSize,
      attachmentId,
      url,
      isVoiceNote,
      duration,
      isForwarded,
      isFallback: true,
      fallbackText: isVoiceNote ? '🎤 Voice message' : (caption ? `🎵 Audio: ${caption}` : `🎵 Audio (${filename})`)
    };
  }

  const hasDocAttachment = (Array.isArray(message.attachments) && message.attachments.length > 0)
    || (Array.isArray(body.attachments) && body.attachments.length > 0)
    || Boolean(message.attachment_id || message.attachmentId || body.attachment_id || body.attachmentId);

  if (kind === 'file' || kind === 'document' || (kind !== 'image' && kind !== 'video' && kind !== 'audio' && hasDocAttachment)) {
    const attachmentId = extractAttachmentId(message, body);
    const filename = body.filename
      || message.filename
      || body.name
      || message.name
      || message.attachments?.[0]?.original_name
      || message.attachments?.[0]?.filename
      || message.attachments?.[0]?.name
      || (body.text && body.text.includes('.') ? body.text : 'document');
    let caption = (body.text && body.text !== filename) ? body.text : '';
    if (isForwarded) {
      caption = getCleanForwardedText(caption);
    }
    const mime = body.mime || message.attachments?.[0]?.mime || 'application/octet-stream';
    const byteSize = body.byte_size ?? body.byteSize ?? message.attachments?.[0]?.byteSize ?? message.attachments?.[0]?.byte_size ?? null;
    const url = extractMediaUrl(message, body);

    return {
      kind: 'file',
      text: filename,
      caption,
      filename,
      mime,
      byteSize,
      attachmentId,
      url,
      isForwarded,
      isFallback: true,
      fallbackText: `📎 Attachment: ${filename}`
    };
  }

  return {
    kind,
    text: '',
    isFallback: true,
    fallbackText: `[Unsupported message: ${kind}]`
  };
}

/**
 * Determines whether a message is eligible for deletion under "Delete chats only".
 * Under "Delete chats only":
 * - Plain text messages and deleted placeholders are deleted (true).
 * - OllaChat-recorded voice notes are deleted (true).
 * - Images, videos, documents, imported audio files (e.g. mp3/wav/m4a), and any message
 *   with non-voice file attachments are PRESERVED (false).
 *
 * @param {object} message
 * @returns {boolean}
 */
export function isDeletableForChatsOnly(message) {
  if (!message || typeof message !== 'object') return false;

  const rawKind = (message.kind || '').toLowerCase();
  const body = message.body && typeof message.body === 'object' ? message.body : {};

  // Deleted tombstone / placeholder message
  if (message.isDeleted || rawKind === 'deleted' || body.isDeleted) {
    return true;
  }

  // Voice note recorded in OllaChat (check all canonical voice note markers)
  const isVoiceNote = Boolean(
    message.isVoiceNote ||
    message.is_voice_note ||
    body.isVoiceNote ||
    body.is_voice_note ||
    ((rawKind === 'audio' || rawKind === 'file') && (body.filename || message.filename || '').includes('voice_message'))
  );
  if (isVoiceNote) {
    return true;
  }

  const resolved = resolveMessageContent(message);

  if (resolved.kind === 'deleted') {
    return true;
  }

  if (resolved.kind === 'audio' && resolved.isVoiceNote === true) {
    return true;
  }

  // Check if message has any attachment indicator
  const hasAttachments = Boolean(
    resolved.attachmentId ||
    message.attachmentId || message.attachment_id || message.attachment ||
    body.attachmentId || body.attachment_id || body.attachment ||
    (Array.isArray(message.attachments) && message.attachments.length > 0) ||
    (Array.isArray(body.attachments) && body.attachments.length > 0) ||
    (Array.isArray(message.attachmentIds) && message.attachmentIds.length > 0) ||
    (Array.isArray(message.attachment_ids) && message.attachment_ids.length > 0) ||
    (Array.isArray(body.attachmentIds) && body.attachmentIds.length > 0) ||
    (Array.isArray(body.attachment_ids) && body.attachment_ids.length > 0)
  );

  // Plain text without attachments -> deletable
  if (resolved.kind === 'text') {
    return !hasAttachments;
  }

  // If resolved as image, video, file, document, or non-voice audio -> PRESERVE
  if (resolved.kind === 'image' || resolved.kind === 'video' || resolved.kind === 'file' || resolved.kind === 'document' || resolved.kind === 'audio') {
    return false;
  }

  // If has attachments of any kind -> PRESERVE
  if (hasAttachments) {
    return false;
  }

  // Fallback text-like message without attachments -> deletable
  return true;
}

/**
 * Determines whether a message was sent by the current authenticated user.
 * @param {object} message
 * @param {string|null} currentUserId
 * @returns {boolean}
 */
export function isOwnMessage(message, currentUserId) {
  if (!message) return false;
  if (message.isCallEntry || message.kind === 'call') {
    return message.direction === 'outgoing';
  }
  if (!currentUserId || typeof currentUserId !== 'string' || currentUserId.trim() === '') {
    return false;
  }
  // Canonical sender resolution: wire contract uses sender_id; normalized model uses senderId
  const sender = (typeof message.sender_id === 'string' && message.sender_id.trim() !== '')
    ? message.sender_id.trim()
    : (typeof message.senderId === 'string' && message.senderId.trim() !== '' ? message.senderId.trim() : '');
  return Boolean(sender && sender.toLowerCase() === currentUserId.trim().toLowerCase());
}

/**
 * WhatsApp-style message action time limits (client-side policy).
 * - Edit message: allowed only within 15 minutes of the original created_at.
 * - Delete for everyone: allowed only within 48 hours of the original created_at.
 * - Delete for me: no time limit.
 */
export const MESSAGE_ACTION_LIMITS = {
  EDIT_WINDOW_MS: 15 * 60 * 1000,           // 15 minutes (900,000 ms)
  DELETE_FOR_EVERYONE_WINDOW_MS: 48 * 60 * 60 * 1000 // 48 hours (172,800,000 ms)
};

/**
 * Checks whether a message can be edited based on ownership, message kind, deletion status,
 * and the 15-minute time window from original creation time.
 * Invariant: The 15-minute timer must NOT reset after an edit; edited_at must NEVER be used to extend the window.
 *
 * @param {object} message
 * @param {string} currentUserId
 * @param {number|Date|string} [now=Date.now()]
 * @returns {boolean}
 */
export function canEditMessage(message, currentUserId, now = Date.now()) {
  if (!message || typeof message !== 'object') return false;
  if (message.isCallEntry || message.kind === 'call') return false;
  if (!isOwnMessage(message, currentUserId)) return false;
  if (message.isDeleted || message.kind === 'deleted') return false;

  const isText = (message.kind === 'text' || !message.kind) && (message.body && typeof message.body.text === 'string' || typeof message.body === 'string' || typeof message.text === 'string');
  if (!isText) return false;

  const hasAttachments = Boolean(
    message.attachmentId || message.attachment_id || message.attachment ||
    (Array.isArray(message.attachments) && message.attachments.length > 0) ||
    (Array.isArray(message.attachmentIds) && message.attachmentIds.length > 0) ||
    (Array.isArray(message.attachment_ids) && message.attachment_ids.length > 0) ||
    (message.body && (
      message.body.attachmentId || message.body.attachment_id || message.body.attachment ||
      (Array.isArray(message.body.attachments) && message.body.attachments.length > 0) ||
      (Array.isArray(message.body.attachmentIds) && message.body.attachmentIds.length > 0) ||
      (Array.isArray(message.body.attachment_ids) && message.body.attachment_ids.length > 0)
    ))
  );
  if (hasAttachments) return false;
  if (message.isVoiceNote || message.is_voice_note || message.body?.isVoiceNote || message.body?.is_voice_note) return false;

  const rawTs = message.createdAt || message.created_at;
  if (!rawTs) return false;

  const createdMs = typeof rawTs === 'number' ? rawTs : Date.parse(rawTs);
  if (Number.isNaN(createdMs)) return false;

  const currentMs = typeof now === 'number' ? now : (now instanceof Date ? now.getTime() : Date.parse(now));
  if (Number.isNaN(currentMs)) return false;

  // Protect against slight backward client clock skew
  const age = Math.max(0, currentMs - createdMs);
  return age <= MESSAGE_ACTION_LIMITS.EDIT_WINDOW_MS;
}

/**
 * Checks whether a message can be deleted for everyone based on ownership, deletion status,
 * and the 48-hour time window from original creation time.
 *
 * @param {object} message
 * @param {string} currentUserId
 * @param {number|Date|string} [now=Date.now()]
 * @returns {boolean}
 */
export function canDeleteMessageForEveryone(message, currentUserId, now = Date.now()) {
  if (!message || typeof message !== 'object') return false;
  if (message.isCallEntry || message.kind === 'call') return false;
  if (!isOwnMessage(message, currentUserId)) return false;
  if (message.isDeleted || message.kind === 'deleted') return false;

  const rawTs = message.createdAt || message.created_at;
  if (!rawTs) return false;

  const createdMs = typeof rawTs === 'number' ? rawTs : Date.parse(rawTs);
  if (Number.isNaN(createdMs)) return false;

  const currentMs = typeof now === 'number' ? now : (now instanceof Date ? now.getTime() : Date.parse(now));
  if (Number.isNaN(currentMs)) return false;

  // Protect against slight backward client clock skew
  const age = Math.max(0, currentMs - createdMs);
  return age <= MESSAGE_ACTION_LIMITS.DELETE_FOR_EVERYONE_WINDOW_MS;
}

// ═══════════════════════════════════════════════════════════════════
// Local Message Pinning Constants & Helpers
// ═══════════════════════════════════════════════════════════════════

export const PIN_DURATIONS = Object.freeze({
  HOURS_24: 24 * 60 * 60 * 1000,
  DAYS_7: 7 * 24 * 60 * 60 * 1000,
  DAYS_30: 30 * 24 * 60 * 60 * 1000,
  DAYS_90: 90 * 24 * 60 * 60 * 1000
});

export const PIN_DURATION_MAP = Object.freeze({
  '24h': PIN_DURATIONS.HOURS_24,
  '7d': PIN_DURATIONS.DAYS_7,
  '30d': PIN_DURATIONS.DAYS_30,
  '90d': PIN_DURATIONS.DAYS_90
});

export const MAX_PINS_PER_CHAT = 3;

/**
 * Formats absolute expiration timestamp to local display string:
 * e.g. "October 1, 2026 at 6:20 PM".
 * @param {number|Date|string} expiresAt
 * @returns {string}
 */
export function formatPinExpiration(expiresAt) {
  if (!expiresAt) return '';
  const date = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
  if (Number.isNaN(date.getTime())) return '';
  const options = {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  };
  const formatted = new Intl.DateTimeFormat('en-US', options).format(date);
  return formatted.replace(', ', ' at ');
}

/**
 * Formats remaining pin time relative to reference timestamp:
 * e.g. "Expires in 6 days", "Expires in 23 hours", "Expires in 45 minutes", "Expired".
 * @param {number|Date|string} expiresAt
 * @param {number|Date|string} [now=Date.now()]
 * @returns {string}
 */
export function formatPinRemainingTime(expiresAt, now = Date.now()) {
  const currentMs = typeof now === 'number' ? now : (now instanceof Date ? now.getTime() : Date.parse(now));
  const expMs = typeof expiresAt === 'number' ? expiresAt : (expiresAt instanceof Date ? expiresAt.getTime() : Date.parse(expiresAt));
  if (Number.isNaN(expMs) || Number.isNaN(currentMs)) return '';
  const diffMs = expMs - currentMs;
  if (diffMs <= 0) return 'Expired';

  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffHours / 24);

  if (diffDays >= 2) {
    return `Expires in ${diffDays} days`;
  }
  if (diffDays === 1) {
    return 'Expires in 1 day';
  }
  if (diffHours >= 1) {
    return `Expires in ${diffHours} hour${diffHours > 1 ? 's' : ''}`;
  }
  const diffMins = Math.max(1, Math.floor(diffMs / (1000 * 60)));
  return `Expires in ${diffMins} minute${diffMins > 1 ? 's' : ''}`;
}

/**
 * Derives safe snippet preview text for a pinned message.
 * Supports text, images, videos, audio, documents, and reply previews.
 * @param {object} message
 * @returns {string}
 */
export function getMessagePinPreview(message) {
  if (!message || typeof message !== 'object') return 'Message';
  const resolved = resolveMessageContent(message);
  if (resolved.isDeleted) return 'This message was deleted';
  const kind = (message.kind || resolved.kind || '').toLowerCase();
  if (kind === 'image') return '📷 Image';
  if (kind === 'video') return '🎥 Video';
  if (kind === 'audio' || resolved.isVoiceNote) return '🎤 Voice message';
  if (kind === 'document' || kind === 'file') {
    const filename = resolved.filename || message.filename || message.body?.filename;
    return filename ? `📄 ${filename}` : '📄 Document';
  }
  if (resolved.text && typeof resolved.text === 'string') {
    return resolved.text.trim();
  }
  return 'Message';
}

/**
 * Resolves compact, human-readable text preview for a quoted reply message.
 * Formats text, images, videos, audio, voice notes, documents, calls, and deleted/unavailable messages.
 * Never displays raw JSON, IDs, or internal database fields.
 *
 * @param {object|null} originalMessage
 * @returns {string} Human-friendly snippet
 */
export function formatReplyPreview(originalMessage) {
  if (!originalMessage || typeof originalMessage !== 'object') {
    return 'Message unavailable';
  }
  if (
    originalMessage.isDeleted ||
    originalMessage.is_deleted ||
    originalMessage.kind === 'deleted' ||
    originalMessage.body?.is_deleted ||
    originalMessage.body?.isDeleted
  ) {
    return 'This message was deleted';
  }
  const resolved = resolveMessageContent(originalMessage);
  if (resolved.isDeleted) {
    return 'This message was deleted';
  }
  if (originalMessage.isDeletedForMe) {
    return 'Message unavailable';
  }
  if (resolved.kind === 'call' || originalMessage.isCallEntry || originalMessage.kind === 'call') {
    const isVideo = Boolean(resolved.isVideo || originalMessage.isVideo || originalMessage.callType === 'video');
    return isVideo ? '📹 Video call' : '📞 Audio call';
  }
  if (resolved.isVoiceNote || originalMessage.isVoiceNote || originalMessage.is_voice_note) {
    return '🎤 Voice message';
  }
  const kind = (originalMessage.kind || resolved.kind || '').toLowerCase();
  if (kind === 'audio') {
    return '🎵 Audio';
  }
  if (kind === 'image') {
    return resolved.caption ? `📷 Photo: ${resolved.caption}` : '📷 Photo';
  }
  if (kind === 'video') {
    return resolved.caption ? `🎥 Video: ${resolved.caption}` : '🎥 Video';
  }
  if (kind === 'file' || kind === 'document') {
    const rawFilename = resolved.filename || originalMessage.filename || originalMessage.body?.filename;
    const filename = (rawFilename && rawFilename.toLowerCase() !== 'document') ? rawFilename : 'Document';
    return filename ? `📄 ${filename}` : '📄 Document';
  }
  if (resolved.text && typeof resolved.text === 'string') {
    return resolved.text.trim();
  }
  if (typeof originalMessage.text === 'string' && originalMessage.text.trim()) {
    return originalMessage.text.trim();
  }
  if (typeof originalMessage.body === 'string' && originalMessage.body.trim()) {
    return originalMessage.body.trim();
  }
  return 'Message unavailable';
}

/**
 * Checks whether a string represents an internal identifier or UUID (full or truncated)
 * rather than a human-readable display name.
 * @param {string|null|undefined} str
 * @returns {boolean}
 */
export function isInternalIdOrUuid(str) {
  if (!str || typeof str !== 'string') return true;
  const trimmed = str.trim();
  if (!trimmed) return true;
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const hexIdRegex = /^[0-9a-f]{24,64}$/i;
  const localIdRegex = /^local-[a-z0-9-]+$/i;
  // Truncated UUID pattern like "23c7f84b-6..." or "23c7f84b-6"
  const partialUuidRegex = /^[0-9a-f]{8}-[0-9a-f]{1,4}(\.\.\.)?$/i;
  return uuidRegex.test(trimmed) || hexIdRegex.test(trimmed) || localIdRegex.test(trimmed) || partialUuidRegex.test(trimmed);
}

/**
 * Resolves a human-readable display name for a group message sender.
 * Never returns a UUID, principal ID, or raw internal hash.
 * 
 * Resolution precedence:
 * 1. Existing sender display name already present on the message (if not UUID)
 * 2. Group participant profile/display name from room participant map
 * 3. Existing contact/profile lookup (personal nickname, or 1-to-1 conversation peer profile)
 * 4. Existing participant cache across any known rooms
 * 5. Safe human-readable fallback: "Contact"
 * 
 * @param {object} message The message object
 * @param {string|null} currentUserId Current user ID
 * @param {object} [options={}]
 * @returns {string} Human-readable sender display name (e.g. "Malavika", "Ashrita", "Contact", "You")
 */
export function resolveGroupSenderName(message, currentUserId = null, options = {}) {
  if (!message || typeof message !== 'object') return 'Contact';

  // 1. Check if self
  if (currentUserId && isOwnMessage(message, currentUserId)) {
    return 'You';
  }

  const senderId = String(message.senderId || message.sender_id || '').trim();

  // 2. Contact nickname lookup (personal override takes precedence)
  if (senderId && typeof options.getContactNicknameFn === 'function') {
    try {
      const nick = options.getContactNicknameFn(senderId);
      if (nick && typeof nick === 'string' && !isInternalIdOrUuid(nick)) {
        return nick.trim();
      }
    } catch {}
  }

  // 3. Existing sender display name already present on the message
  const candidateName = message.senderName || message.sender_name || message.displayName || message.display_name;
  if (candidateName && typeof candidateName === 'string' && !isInternalIdOrUuid(candidateName)) {
    return candidateName.trim();
  }

  // 4. Room participant profile / display name
  const roomParticipants = options.roomParticipants;
  if (senderId && roomParticipants) {
    let participant = null;
    if (roomParticipants instanceof Map) {
      participant = roomParticipants.get(senderId) || roomParticipants.get(senderId.toLowerCase());
    } else if (Array.isArray(roomParticipants)) {
      participant = roomParticipants.find((p) => {
        const pid = p?.principalId || p?.principal_id || p?.userId || p?.user_id || '';
        return String(pid).toLowerCase().trim() === senderId.toLowerCase();
      });
    }
    if (participant) {
      const pName = participant.displayName || participant.display_name || participant.name || participant.username;
      if (pName && typeof pName === 'string' && !isInternalIdOrUuid(pName)) {
        return pName.trim();
      }
      if (participant.phone && typeof participant.phone === 'string' && participant.phone.trim()) {
        return participant.phone.trim();
      }
    }
  }

  // 5. Existing contact/profile lookup in direct conversations
  if (senderId && Array.isArray(options.conversations)) {
    const peerConv = options.conversations.find((c) => {
      const pid = c?.peer?.userId || c?.peer?.user_id || c?.peerUserId || c?.peer_user_id || c?.peerId;
      return pid && String(pid).toLowerCase().trim() === senderId.toLowerCase();
    });
    if (peerConv) {
      const peerName = peerConv.peer?.displayName || peerConv.peer?.display_name || peerConv.name;
      if (peerName && typeof peerName === 'string' && !isInternalIdOrUuid(peerName)) {
        return peerName.trim();
      }
      if (peerConv.peer?.phone && typeof peerConv.peer.phone === 'string') {
        return peerConv.peer.phone.trim();
      }
    }
  }

  // 6. Global participant cache
  if (senderId && options.globalParticipantsCache instanceof Map) {
    const cached = options.globalParticipantsCache.get(senderId) || options.globalParticipantsCache.get(senderId.toLowerCase());
    if (cached) {
      const cName = cached.displayName || cached.display_name || cached.name || cached.username;
      if (cName && typeof cName === 'string' && !isInternalIdOrUuid(cName)) {
        return cName.trim();
      }
      if (cached.phone && typeof cached.phone === 'string') {
        return cached.phone.trim();
      }
    }
  }

  // 7. If senderId itself is a human name (not UUID or internal ID)
  if (senderId && !isInternalIdOrUuid(senderId)) {
    return senderId;
  }

  // 8. Safe default
  return 'Contact';
}

/**
 * Resolves original sender name for reply preview header.
 *
 * @param {object|null} originalMessage
 * @param {string|null} [currentUserId=null]
 * @param {Function|null} [getContactNameFn=null]
 * @param {object} [options={}]
 * @returns {string}
 */
export function getReplySenderName(originalMessage, currentUserId = null, getContactNameFn = null, options = {}) {
  if (!originalMessage || typeof originalMessage !== 'object') {
    return 'Replying to message';
  }
  if (currentUserId && isOwnMessage(originalMessage, currentUserId)) {
    return 'You';
  }

  // 1. Try resolveGroupSenderName
  const resolved = resolveGroupSenderName(originalMessage, currentUserId, {
    getContactNicknameFn: getContactNameFn,
    ...options
  });
  if (resolved && resolved !== 'Contact') {
    return resolved;
  }

  // 2. Custom name callback
  const senderUserId = originalMessage.senderId || originalMessage.sender_id;
  let customName = null;
  if (typeof getContactNameFn === 'function' && senderUserId) {
    try {
      customName = getContactNameFn(senderUserId, options.roomId || originalMessage.roomId || originalMessage.room_id);
    } catch {}
  }
  if (customName && typeof customName === 'string' && !isInternalIdOrUuid(customName)) {
    return customName.trim();
  }

  // 3. Candidate name on original message
  const candidate = originalMessage.senderName || originalMessage.sender_name;
  if (candidate && typeof candidate === 'string' && !isInternalIdOrUuid(candidate)) {
    return candidate.trim();
  }

  return 'Contact';
}

/**
 * Formats a WhatsApp-style system message text for group membership events.
 *
 * Rules:
 * Member Added:
 * - Current user added someone: "You added Rahul." / "You added Rahul and Priya."
 * - Someone added current user: "Malavika added you."
 * - Someone added someone else: "Malavika added Rahul." / "Malavika added Rahul and Priya."
 * - No actor specified: "Rahul was added." / "You were added to the group."
 *
 * Member Removed:
 * - Current user removed someone: "You removed Rahul."
 * - Someone removed current user: "You were removed from the group by Malavika."
 * - Someone removed someone else: "Malavika removed Rahul."
 * - No actor specified: "Rahul was removed." / "You were removed from the group."
 *
 * Member Left:
 * - Current user left: "You left the group."
 * - Someone else left: "Rahul left the group."
 *
 * @param {object} params
 * @returns {string}
 */
export function formatGroupMembershipSystemText({
  action, // 'add' | 'remove' | 'leave' | 'join_link' | 'role_update' | 'promote'
  actorId = null,
  actorName = null,
  targetUserId = null,
  targetUserIds = null,
  targetName = null,
  role = null,
  method = null,
  currentUserId = null,
  resolveUserNameFn = null,
  prevDescription = undefined,
  newDescription = undefined,
  useYouForSelf = false
} = {}) {
  // Delegate description actions if invoked via membership formatter
  if (['description_add', 'description_added', 'description_change', 'description_changed', 'description_edit', 'description_remove', 'description_removed', 'description_clear', 'description'].includes(action)) {
    return formatGroupDescriptionSystemText({
      action,
      actorId,
      actorName,
      currentUserId,
      resolveUserNameFn,
      prevDescription,
      newDescription,
      useYouForSelf
    });
  }

  const normCurrentUserId = currentUserId ? String(currentUserId).toLowerCase().trim() : null;
  const isActorSelf = Boolean(
    normCurrentUserId && actorId && String(actorId).toLowerCase().trim() === normCurrentUserId
  );

  // Helper to resolve a display name safely
  const resolveName = (uid, fallbackName) => {
    if (fallbackName && !isInternalIdOrUuid(fallbackName)) {
      return fallbackName.trim();
    }
    if (typeof resolveUserNameFn === 'function' && uid) {
      const resolved = resolveUserNameFn(uid);
      if (resolved && !isInternalIdOrUuid(resolved)) {
        return resolved.trim();
      }
    }
    if (fallbackName && typeof fallbackName === 'string' && fallbackName.trim()) {
      return fallbackName.trim();
    }
    return 'A member';
  };

  const getResolvedActorName = () => {
    if (isActorSelf) return 'You';
    return resolveName(actorId, actorName);
  };

  // Helper for multiple target IDs
  const targetIdList = Array.isArray(targetUserIds) && targetUserIds.length > 0
    ? targetUserIds
    : (targetUserId ? [targetUserId] : []);

  const singleTargetId = targetIdList[0] || targetUserId;
  const isTargetSelf = Boolean(
    normCurrentUserId && singleTargetId && String(singleTargetId).toLowerCase().trim() === normCurrentUserId
  );

  // 1. Group link join: "Rahul joined using the group link" / "You joined using the group link"
  const isLinkJoin = action === 'join_link' || method === 'link' || method === 'group_link' || method === 'invite_link';
  if (isLinkJoin) {
    if (isTargetSelf) {
      return 'You joined using the group link';
    }
    const tName = resolveName(singleTargetId, targetName);
    return `${tName} joined using the group link`;
  }

  // 2. Role update / admin promotion: "You are now an admin" / "Rahul is now an admin"
  if (action === 'role_update' || action === 'promote') {
    const normRole = String(role || '').toLowerCase().trim();
    const isAdminOrOwner = normRole === 'admin' || normRole === 'owner' || normRole === 'creator';
    if (!isAdminOrOwner) {
      return null; // Ordinary member changes are not admin promotions
    }
    if (isTargetSelf) {
      return 'You are now an admin';
    }
    const tName = resolveName(singleTargetId, targetName);
    return `${tName} is now an admin`;
  }

  // 3. Member left voluntarily: "Ananya left" / "You left"
  if (action === 'leave' || (action === 'remove' && actorId && singleTargetId && String(actorId).trim() === String(singleTargetId).trim())) {
    if (isActorSelf || isTargetSelf) {
      return 'You left';
    }
    const tName = resolveName(singleTargetId, targetName);
    return `${tName} left`;
  }

  // 4. Member removed: "Rahul removed Ananya" / "You removed Rahul" / "Rahul removed you" / "Ananya was removed"
  if (action === 'remove') {
    if (isTargetSelf) {
      if (actorId && !isActorSelf) {
        const aName = getResolvedActorName();
        return `${aName} removed you`;
      }
      return 'You were removed';
    }

    const tName = resolveName(singleTargetId, targetName);
    if (isActorSelf) {
      return `You removed ${tName}`;
    }
    if (actorId && !isActorSelf) {
      const aName = getResolvedActorName();
      return `${aName} removed ${tName}`;
    }
    return `${tName} was removed`;
  }

  // 5. Member added: "Rahul added Akhil" / "You added Rahul" / "Rahul added you" / "Akhil was added"
  if (action === 'add') {
    if (targetIdList.length > 1) {
      const targetNames = targetIdList.map((id) => {
        if (normCurrentUserId && String(id).toLowerCase().trim() === normCurrentUserId) {
          return 'you';
        }
        return resolveName(id, null);
      });

      let targetsStr = '';
      if (targetNames.length === 2) {
        targetsStr = `${targetNames[0]} and ${targetNames[1]}`;
      } else {
        targetsStr = `${targetNames.slice(0, -1).join(', ')}, and ${targetNames[targetNames.length - 1]}`;
      }

      if (isActorSelf) {
        return `You added ${targetsStr}`;
      }
      if (actorId && !isActorSelf) {
        const aName = getResolvedActorName();
        return `${aName} added ${targetsStr}`;
      }
      return `${targetsStr} were added`;
    }

    if (isTargetSelf) {
      if (actorId && !isActorSelf) {
        const aName = getResolvedActorName();
        return `${aName} added you`;
      }
      return 'You were added';
    }

    const tName = resolveName(singleTargetId, targetName);
    if (isActorSelf) {
      return `You added ${tName}`;
    }
    if (actorId && !isActorSelf) {
      const aName = getResolvedActorName();
      return `${aName} added ${tName}`;
    }
    return `${tName} was added`;
  }

  return null;
}

/**
 * Formats WhatsApp-style system text for group description changes:
 * - Added: "[User Name] added a group description"
 * - Changed: "[User Name] changed the group description"
 * - Removed: "[User Name] removed the group description"
 *
 * @param {object} params
 * @param {string} [params.action] 'add' | 'change' | 'remove' (or aliases)
 * @param {string} [params.actorId]
 * @param {string} [params.actorName]
 * @param {string} [params.currentUserId]
 * @param {function} [params.resolveUserNameFn]
 * @param {string} [params.prevDescription]
 * @param {string} [params.newDescription]
 * @param {boolean} [params.useYouForSelf=false]
 * @returns {string|null}
 */
export function formatGroupDescriptionSystemText({
  action = null,
  actorId = null,
  actorName = null,
  currentUserId = null,
  resolveUserNameFn = null,
  prevDescription = undefined,
  newDescription = undefined,
  useYouForSelf = false
} = {}) {
  let effectiveAction = action ? String(action).toLowerCase().trim() : null;
  if (!effectiveAction && (prevDescription !== undefined || newDescription !== undefined)) {
    const hasPrev = Boolean(prevDescription && typeof prevDescription === 'string' && prevDescription.trim().length > 0);
    const hasNew = Boolean(newDescription && typeof newDescription === 'string' && newDescription.trim().length > 0);
    if (!hasPrev && hasNew) {
      effectiveAction = 'add';
    } else if (hasPrev && !hasNew) {
      effectiveAction = 'remove';
    } else if (hasPrev && hasNew && prevDescription.trim() !== newDescription.trim()) {
      effectiveAction = 'change';
    } else {
      return null;
    }
  }

  if (['add', 'added', 'description_add', 'description_added'].includes(effectiveAction)) {
    effectiveAction = 'add';
  } else if (['change', 'changed', 'edit', 'edited', 'description_change', 'description_changed', 'description_edit'].includes(effectiveAction)) {
    effectiveAction = 'change';
  } else if (['remove', 'removed', 'delete', 'deleted', 'clear', 'cleared', 'description_remove', 'description_removed', 'description_clear'].includes(effectiveAction)) {
    effectiveAction = 'remove';
  } else {
    return null;
  }

  const normCurrentUserId = currentUserId ? String(currentUserId).toLowerCase().trim() : null;
  const isActorSelf = Boolean(
    normCurrentUserId && actorId && String(actorId).toLowerCase().trim() === normCurrentUserId
  );

  let resolvedActor = null;
  if (isActorSelf && useYouForSelf) {
    resolvedActor = 'You';
  } else if (actorName && !isInternalIdOrUuid(actorName)) {
    resolvedActor = String(actorName).trim();
  } else if (typeof resolveUserNameFn === 'function' && actorId) {
    const res = resolveUserNameFn(actorId);
    if (res && !isInternalIdOrUuid(res)) {
      resolvedActor = String(res).trim();
    }
  } else if (isActorSelf) {
    resolvedActor = 'You';
  }

  if (!resolvedActor) {
    resolvedActor = actorName && typeof actorName === 'string' && actorName.trim()
      ? actorName.trim()
      : 'Someone';
  }

  switch (effectiveAction) {
    case 'add':
      return `${resolvedActor} added a group description`;
    case 'change':
      return `${resolvedActor} changed the group description`;
    case 'remove':
      return `${resolvedActor} removed the group description`;
    default:
      return null;
  }
}

/**
 * Derives a clean, human-readable notification preview string for a message.
 * Formats media, system, and text messages safely without raw syntax or IDs.
 *
 * @param {object} message
 * @returns {string}
 */
export function formatMessageNotificationPreview(message) {
  if (!message || typeof message !== 'object') {
    return 'New message';
  }
  const resolved = resolveMessageContent(message);
  if (resolved.isDeleted) {
    return 'This message was deleted';
  }
  if (resolved.kind === 'call') {
    return resolved.isVideo ? '📹 Video call' : '📞 Audio call';
  }
  if (resolved.kind === 'image') {
    const caption = (resolved.caption || resolved.text || message.caption || message.text || '').trim();
    return caption ? `📷 ${caption}` : '📷 Photo';
  }
  if (resolved.kind === 'video') {
    const caption = (resolved.caption || resolved.text || message.caption || message.text || '').trim();
    return caption ? `🎥 ${caption}` : '🎥 Video';
  }
  if (resolved.kind === 'audio') {
    return '🎤 Voice message';
  }
  if (resolved.kind === 'file') {
    const fn = (resolved.filename || message.filename || message.attachments?.[0]?.original_name || '').trim();
    return fn ? `📄 ${fn}` : '📄 Document';
  }
  const text = (resolved.text || '').trim();
  if (text) {
    return text;
  }
  if (resolved.fallbackText && resolved.fallbackText.trim()) {
    return resolved.fallbackText.trim();
  }
  return 'New message';
}

/**
 * Formats notification title and body according to notification settings,
 * conversation type (group vs direct), and message content.
 *
 * @param {object} params
 * @param {object|null} params.conversation The conversation object
 * @param {object} params.message The incoming message/payload object
 * @param {boolean} [params.showPreview=true] Whether message previews are enabled
 * @param {string|null} [params.senderName=null] Pre-resolved sender name (if available)
 * @param {string|null} [params.currentUserId=null] Current user ID
 * @param {object} [params.options={}] Additional lookup options
 * @returns {{ title: string, body: string }}
 */
export function formatNotificationContent({
  conversation = null,
  message = null,
  showPreview = true,
  senderName = null,
  currentUserId = null,
  options = {}
}) {
  const isGroup = Boolean(
    conversation?.kind === 'group' ||
    conversation?.isGroup ||
    conversation?.groupName ||
    conversation?.group_name ||
    conversation?.is_group
  );

  const convTitle = conversation?.title ||
    conversation?.name ||
    conversation?.groupName ||
    conversation?.group_name ||
    conversation?.peerName ||
    null;

  let effectiveSenderName = senderName;
  if (!effectiveSenderName) {
    effectiveSenderName = resolveGroupSenderName(message, currentUserId, options);
  }
  if (!effectiveSenderName || isInternalIdOrUuid(effectiveSenderName)) {
    effectiveSenderName = !isGroup && convTitle ? convTitle : null;
  }

  // 1. Previews disabled:
  if (!showPreview) {
    if (isGroup) {
      return {
        title: convTitle || 'Group Chat',
        body: 'New message'
      };
    }
    return {
      title: effectiveSenderName || convTitle || 'New message',
      body: 'New message'
    };
  }

  // 2. Previews enabled:
  const previewText = formatMessageNotificationPreview(message);

  if (isGroup) {
    const title = convTitle || 'Group Chat';
    const cleanSender = (effectiveSenderName || 'Someone').trim();
    let bodyText = previewText;
    if (cleanSender && !bodyText.toLowerCase().startsWith(`${cleanSender.toLowerCase()}:`)) {
      bodyText = `${cleanSender}: ${bodyText}`;
    }
    return {
      title,
      body: bodyText
    };
  }

  // Direct conversation
  const title = effectiveSenderName || convTitle || 'New message';
  return {
    title,
    body: previewText
  };
}


const PERSISTENT_RECEIPTS_KEY = 'ollachat_persistent_receipts';

/**
 * Loads persisted receipt statuses from localStorage into the target room receipt store.
 * @param {Map<string, Map<string, string>>} targetStore
 */
export function loadPersistentReceiptStore(targetStore) {
  if (!targetStore || !(targetStore instanceof Map)) return;
  try {
    if (typeof localStorage === 'undefined') return;
    const raw = localStorage.getItem(PERSISTENT_RECEIPTS_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return;
    for (const [roomId, receipts] of Object.entries(parsed)) {
      if (!roomId || !receipts || typeof receipts !== 'object') continue;
      if (!targetStore.has(roomId)) {
        targetStore.set(roomId, new Map());
      }
      const roomMap = targetStore.get(roomId);
      for (const [msgId, status] of Object.entries(receipts)) {
        if (msgId && typeof status === 'string') {
          roomMap.set(msgId, status);
        }
      }
    }
  } catch (_) {}
}

/**
 * Persists a message receipt status into localStorage so it survives application restarts.
 * @param {string} roomId
 * @param {string} messageId
 * @param {string} status
 */
export function savePersistentReceipt(roomId, messageId, status) {
  if (!roomId || !messageId || !status) return;
  const statusStr = String(status).toLowerCase();
  if (statusStr !== 'read' && statusStr !== 'delivered') return;
  try {
    if (typeof localStorage === 'undefined') return;
    const raw = localStorage.getItem(PERSISTENT_RECEIPTS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    if (!parsed[roomId]) parsed[roomId] = {};
    const existing = parsed[roomId][messageId];
    const newRank = STATUS_RANKS[statusStr] ?? 0;
    const existingRank = existing ? (STATUS_RANKS[existing] ?? 0) : 0;
    if (newRank >= existingRank) {
      parsed[roomId][messageId] = statusStr;
      localStorage.setItem(PERSISTENT_RECEIPTS_KEY, JSON.stringify(parsed));
    }
  } catch (_) {}
}

/**
 * State manager for a room's loaded message history, sequence tracking, and pagination.
 */
export class RoomMessagesState {
  constructor(currentUserId = null, roomReceiptStore = null) {
    this.roomId = null;
    this.messages = [];
    this.isLoadingInitial = false;
    this.isLoadingOlder = false;
    this.isHistoryLoaded = false;
    this.error = null;
    this.hasMore = false;
    this.oldestSeq = null;
    this.newestSeq = null;
    this.currentUserId = typeof currentUserId === 'string' && currentUserId.trim() !== '' ? currentUserId.trim() : null;
    this.peerLastReadSeq = 0;
    this.messageStatus = new Map(); // messageId -> status string
    this.roomReceiptStore = roomReceiptStore instanceof Map ? roomReceiptStore : new Map(); // roomId -> Map<messageId, status>
    loadPersistentReceiptStore(this.roomReceiptStore);
    this._deletedForMe = new Set();
    this._starred = new Set();
    this._loadDeletedForMe();
    this._loadStarred();
  }

  _loadDeletedForMe() {
    try {
      if (typeof localStorage !== 'undefined') {
        const key = `ollachat_deleted_for_me_${this.currentUserId || 'default'}`;
        const data = localStorage.getItem(key);
        if (data) {
          const list = JSON.parse(data);
          if (Array.isArray(list)) {
            for (const item of list) {
              if (item) this._deletedForMe.add(String(item));
            }
          }
        }
      }
    } catch (_) {}
  }

  _persistDeletedForMe() {
    try {
      if (typeof localStorage !== 'undefined') {
        const key = `ollachat_deleted_for_me_${this.currentUserId || 'default'}`;
        localStorage.setItem(key, JSON.stringify(Array.from(this._deletedForMe)));
      }
    } catch (_) {}
  }

  deleteMessageForMe(messageId, roomId = null) {
    if (!messageId) return false;
    const targetRoom = roomId || this.roomId || '*';
    const sId = String(messageId);
    const msg = this.messages.find((m) => m.id === messageId || m.clientMessageId === messageId || m.client_message_id === messageId);

    this._deletedForMe.add(`${targetRoom}:${sId}`);
    this._deletedForMe.add(`*:${sId}`);
    this._deletedForMe.add(sId);

    if (msg) {
      if (msg.id) {
        const mid = String(msg.id);
        this._deletedForMe.add(`${targetRoom}:${mid}`);
        this._deletedForMe.add(`*:${mid}`);
        this._deletedForMe.add(mid);
      }
      const cid = msg.clientMessageId || msg.client_message_id;
      if (cid) {
        const scid = String(cid);
        this._deletedForMe.add(`${targetRoom}:${scid}`);
        this._deletedForMe.add(`*:${scid}`);
        this._deletedForMe.add(scid);
      }
      this.messages = this.messages.filter((m) => m.id !== messageId && m.clientMessageId !== messageId && m.client_message_id !== messageId && m.id !== msg.id && (!cid || (m.clientMessageId !== cid && m.client_message_id !== cid)));
      this._calculateSeqBounds();
    } else {
      this.messages = this.messages.filter((m) => m.id !== messageId && m.clientMessageId !== messageId && m.client_message_id !== messageId);
      this._calculateSeqBounds();
    }

    this._persistDeletedForMe();

    // Clean up matching pin if exists
    try {
      if (typeof localStorage !== 'undefined') {
        const key = `ollachat_pinned_messages_${this.currentUserId || 'default'}`;
        const data = localStorage.getItem(key);
        if (data) {
          const parsed = JSON.parse(data);
          if (parsed && typeof parsed === 'object') {
            let changed = false;
            for (const [rId, pins] of Object.entries(parsed)) {
              if (Array.isArray(pins)) {
                const filtered = pins.filter((p) => p && p.messageId !== sId && (!msg || (p.messageId !== msg.id && p.messageId !== msg.clientMessageId && p.messageId !== msg.client_message_id)));
                if (filtered.length !== pins.length) {
                  changed = true;
                  if (filtered.length > 0) parsed[rId] = filtered;
                  else delete parsed[rId];
                }
              }
            }
            if (changed) {
              localStorage.setItem(key, JSON.stringify(parsed));
            }
          }
        }
      }
    } catch (_) {}

    return true;
  }

  /**
   * Deletes a message for everyone in this room state.
   * Marks message as deleted and cleans up matching local pins.
   * @param {string} messageId
   * @returns {boolean}
   */
  deleteMessage(messageId) {
    if (!messageId) return false;
    const sId = String(messageId);
    const msg = this.messages.find((m) => m.id === messageId || m.clientMessageId === messageId || m.client_message_id === messageId);
    if (!msg) return false;
    if (msg.isDeleted || msg.is_deleted || msg.kind === 'deleted') return false;

    msg.isDeleted = true;
    msg.is_deleted = true;
    msg.kind = 'deleted';
    msg.body = { text: 'This message was deleted' };
    msg.attachments = [];
    msg.attachmentIds = [];
    msg.attachment_ids = [];

    try {
      if (typeof localStorage !== 'undefined') {
        const key = `ollachat_pinned_messages_${this.currentUserId || 'default'}`;
        const data = localStorage.getItem(key);
        if (data) {
          const parsed = JSON.parse(data);
          if (parsed && typeof parsed === 'object') {
            let changed = false;
            for (const [rId, pins] of Object.entries(parsed)) {
              if (Array.isArray(pins)) {
                const filtered = pins.filter((p) => p && p.messageId !== sId && (!msg || (p.messageId !== msg.id && p.messageId !== msg.clientMessageId && p.messageId !== msg.client_message_id)));
                if (filtered.length !== pins.length) {
                  changed = true;
                  if (filtered.length > 0) parsed[rId] = filtered;
                  else delete parsed[rId];
                }
              }
            }
            if (changed) {
              localStorage.setItem(key, JSON.stringify(parsed));
            }
          }
        }
      }
    } catch (_) {}

    // Clean up star for this deleted message
    this.unstarMessage(sId, this.roomId);
    if (msg.id && msg.id !== sId) this.unstarMessage(msg.id, this.roomId);
    const cid = msg.clientMessageId || msg.client_message_id;
    if (cid && cid !== sId) this.unstarMessage(cid, this.roomId);

    return true;
  }

  /**
   * Deletes multiple messages for everyone in this room state.
   * @param {Array<string>} messageIds
   * @returns {number} Count of successfully deleted messages
   */
  deleteMessages(messageIds) {
    if (!Array.isArray(messageIds)) return 0;
    let count = 0;
    for (const id of messageIds) {
      if (this.deleteMessage(id)) count++;
    }
    return count;
  }

  /**
   * Deletes multiple messages locally for current user only.
   * @param {Array<string>} messageIds
   * @param {string|null} [roomId=null]
   * @returns {number} Count of successfully deleted messages
   */
  deleteMessagesForMe(messageIds, roomId = null) {
    if (!Array.isArray(messageIds)) return 0;
    let count = 0;
    for (const id of messageIds) {
      if (this.deleteMessageForMe(id, roomId)) count++;
    }
    return count;
  }

  /**
   * Clears messages in this room state locally and marks them as deleted for me.
   * When { chatsOnly: true }, selectively removes text messages and voice notes while
   * preserving images, videos, documents, and imported audio files.
   *
   * @param {string|null} roomId
   * @param {{ chatsOnly?: boolean }} [options]
   */
  clearMessages(roomId = null, { chatsOnly = false } = {}) {
    const targetRoom = roomId || this.roomId || '*';
    const toDelete = [];
    const toKeep = [];

    if (chatsOnly) {
      for (const msg of this.messages) {
        if (isDeletableForChatsOnly(msg)) {
          toDelete.push(msg);
        } else {
          toKeep.push(msg);
        }
      }
    } else {
      toDelete.push(...this.messages);
    }

    for (const msg of toDelete) {
      if (msg.id) {
        const mid = String(msg.id);
        this._deletedForMe.add(`${targetRoom}:${mid}`);
        this._deletedForMe.add(`*:${mid}`);
        this._deletedForMe.add(mid);
      }
      const cid = msg.clientMessageId || msg.client_message_id;
      if (cid) {
        const scid = String(cid);
        this._deletedForMe.add(`${targetRoom}:${scid}`);
        this._deletedForMe.add(`*:${scid}`);
        this._deletedForMe.add(scid);
      }
    }

    this.messages = toKeep;
    if (toKeep.length === 0) {
      this.oldestSeq = null;
      this.newestSeq = null;
      this.hasMore = false;
    } else {
      const validSeqs = toKeep
        .map((m) => (typeof m.eventSeq === 'number' ? m.eventSeq : (typeof m.event_seq === 'number' ? m.event_seq : null)))
        .filter((s) => s !== null && !Number.isNaN(s));
      if (validSeqs.length > 0) {
        this.oldestSeq = Math.min(...validSeqs);
        this.newestSeq = Math.max(...validSeqs);
      }
    }
    this._persistDeletedForMe();

    // Clean up pins for this room from local storage
    try {
      if (typeof localStorage !== 'undefined') {
        const key = `ollachat_pinned_messages_${this.currentUserId || 'default'}`;
        const data = localStorage.getItem(key);
        if (data) {
          const parsed = JSON.parse(data);
          if (parsed && typeof parsed === 'object' && targetRoom && parsed[targetRoom]) {
            if (chatsOnly && toKeep.length > 0) {
              const keptIds = new Set();
              for (const m of toKeep) {
                if (m.id) keptIds.add(String(m.id));
                const cid = m.clientMessageId || m.client_message_id;
                if (cid) keptIds.add(String(cid));
              }
              const roomPins = parsed[targetRoom];
              if (Array.isArray(roomPins)) {
                parsed[targetRoom] = roomPins.filter((pin) => {
                  const pid = typeof pin === 'object' ? (pin.id || pin.messageId || pin.message_id) : pin;
                  return pid && keptIds.has(String(pid));
                });
                if (parsed[targetRoom].length === 0) {
                  delete parsed[targetRoom];
                }
              } else {
                const pid = typeof roomPins === 'object' ? (roomPins.id || roomPins.messageId || roomPins.message_id) : roomPins;
                if (!pid || !keptIds.has(String(pid))) {
                  delete parsed[targetRoom];
                }
              }
            } else {
              delete parsed[targetRoom];
            }
            localStorage.setItem(key, JSON.stringify(parsed));
          }
        }
      }
    } catch (_) {}
  }

  /**
   * Checks if a message is pinned according to local user preferences.
   * @param {string} messageId
   * @param {string|null} [roomId=null]
   * @returns {boolean}
   */
  isMessagePinned(messageId, roomId = null) {
    if (!messageId) return false;
    const sId = String(messageId);
    const targetRoom = roomId || this.roomId;
    try {
      if (typeof localStorage !== 'undefined') {
        const key = `ollachat_pinned_messages_${this.currentUserId || 'default'}`;
        const data = localStorage.getItem(key);
        if (data) {
          const parsed = JSON.parse(data);
          const now = Date.now();
          if (parsed && typeof parsed === 'object') {
            const list = targetRoom ? (parsed[targetRoom] || []) : Object.values(parsed).flat();
            return list.some((p) => p && p.messageId === sId && p.expiresAt > now);
          }
        }
      }
    } catch (_) {}
    return false;
  }

  isDeletedForMe(messageId, roomId = null) {
    if (!messageId) return false;
    const sId = String(messageId);
    const targetRoom = roomId || this.roomId;
    if (this._deletedForMe.has(sId)) return true;
    if (this._deletedForMe.has(`*:${sId}`)) return true;
    if (targetRoom && this._deletedForMe.has(`${targetRoom}:${sId}`)) return true;

    try {
      if (typeof localStorage !== 'undefined') {
        const key = `ollachat_deleted_for_me_${this.currentUserId || 'default'}`;
        const data = localStorage.getItem(key);
        if (data) {
          const list = JSON.parse(data);
          if (Array.isArray(list) && (list.includes(sId) || list.includes(`*:${sId}`) || (targetRoom && list.includes(`${targetRoom}:${sId}`)))) {
            this._deletedForMe.add(sId);
            return true;
          }
        }
      }
    } catch (_) {}

    return false;
  }

  isMessageDeletedForMe(messageId, roomId = null) {
    return this.isDeletedForMe(messageId, roomId);
  }

  _loadStarred() {
    try {
      if (typeof localStorage !== 'undefined') {
        const key = `ollachat_starred_${this.currentUserId || 'default'}`;
        const data = localStorage.getItem(key);
        if (data) {
          const list = JSON.parse(data);
          if (Array.isArray(list)) {
            for (const item of list) {
              if (item) this._starred.add(String(item));
            }
          }
        }
      }
    } catch (_) {}
  }

  _persistStarred() {
    try {
      if (typeof localStorage !== 'undefined') {
        const key = `ollachat_starred_${this.currentUserId || 'default'}`;
        localStorage.setItem(key, JSON.stringify(Array.from(this._starred)));
      }
    } catch (_) {}
  }

  starMessage(messageId, roomId = null) {
    if (!messageId) return false;
    const sId = String(messageId);
    const targetRoom = roomId || this.roomId || '*';
    this._starred.add(`${targetRoom}:${sId}`);
    this._starred.add(`*:${sId}`);
    this._starred.add(sId);
    this._persistStarred();
    return true;
  }

  unstarMessage(messageId, roomId = null) {
    if (!messageId) return false;
    const sId = String(messageId);
    const targetRoom = roomId || this.roomId;
    this._starred.delete(`*:${sId}`);
    this._starred.delete(sId);
    if (targetRoom) this._starred.delete(`${targetRoom}:${sId}`);
    if (this.roomId) this._starred.delete(`${this.roomId}:${sId}`);
    for (const key of Array.from(this._starred)) {
      if (key === sId || key.endsWith(`:${sId}`)) {
        this._starred.delete(key);
      }
    }
    this._persistStarred();
    return true;
  }

  isStarred(messageId, roomId = null) {
    if (!messageId) return false;
    const sId = String(messageId);
    const targetRoom = roomId || this.roomId;
    if (this._starred.has(sId)) return true;
    if (this._starred.has(`*:${sId}`)) return true;
    if (targetRoom && this._starred.has(`${targetRoom}:${sId}`)) return true;

    try {
      if (typeof localStorage !== 'undefined') {
        const key = `ollachat_starred_${this.currentUserId || 'default'}`;
        const data = localStorage.getItem(key);
        if (data) {
          const list = JSON.parse(data);
          if (Array.isArray(list) && (list.includes(sId) || list.includes(`*:${sId}`) || (targetRoom && list.includes(`${targetRoom}:${sId}`)))) {
            this._starred.add(sId);
            return true;
          }
        }
      }
    } catch (_) {}

    return false;
  }

  getStarredMessageIds(roomId = null) {
    const targetRoom = roomId || this.roomId;
    const result = [];
    for (const key of this._starred) {
      if (key.includes(':')) {
        const [rId, mId] = key.split(':');
        if ((!targetRoom || rId === targetRoom || rId === '*') && mId) {
          if (!result.includes(mId)) result.push(mId);
        }
      } else {
        if (!result.includes(key)) result.push(key);
      }
    }
    return result;
  }

  setCurrentUserId(userId) {
    this.currentUserId = typeof userId === 'string' && userId.trim() !== '' ? userId.trim() : null;
    this._loadDeletedForMe();
    this._loadStarred();
    if (this.currentUserId && this.messages.length > 0) {
      for (const msg of this.messages) {
        if (!isOwnMessage(msg, this.currentUserId)) {
          const id = msg.id;
          const cid = msg.clientMessageId || msg.client_message_id;
          if (id) {
            this.messageStatus.delete(id);
            if (this.roomId && this.roomReceiptStore.has(this.roomId)) {
              this.roomReceiptStore.get(this.roomId).delete(id);
            }
          }
          if (cid) {
            this.messageStatus.delete(cid);
            if (this.roomId && this.roomReceiptStore.has(this.roomId)) {
              this.roomReceiptStore.get(this.roomId).delete(cid);
            }
          }
        } else {
          // Hydrate own messages into messageStatus and roomReceiptStore
          const id = msg.id;
          const cid = msg.clientMessageId || msg.client_message_id;
          const stId = id ? this.messageStatus.get(id) : null;
          const stCid = cid ? this.messageStatus.get(cid) : null;
          const roomCache = this.roomId && this.roomReceiptStore.has(this.roomId) ? this.roomReceiptStore.get(this.roomId) : null;
          const cachedSt = (roomCache && id ? roomCache.get(id) : null) || (roomCache && cid ? roomCache.get(cid) : null);
          const mSeq = msg.eventSeq ?? msg.event_seq ?? 0;
          const peerReadStatus = (this.peerLastReadSeq > 0 && mSeq > 0 && mSeq <= this.peerLastReadSeq) ? 'read' : null;
          const bestStatus = getHighestStatus(
            peerReadStatus,
            cachedSt,
            stId,
            stCid,
            msg.deliveryStatus,
            msg.delivery_status,
            msg.status
          ) || 'sent';

          if (id) {
            this.messageStatus.set(id, bestStatus);
            if (roomCache) roomCache.set(id, bestStatus);
          }
          if (cid) {
            this.messageStatus.set(cid, bestStatus);
            if (roomCache) roomCache.set(cid, bestStatus);
          }
          msg.status = bestStatus;
          msg.deliveryStatus = bestStatus;
          msg.delivery_status = bestStatus;
        }
      }
    }
  }

  /**
   * Sets the peer's durable read sequence for this room and advances all loaded own messages up to seq to 'read'.
   * @param {number|string} seq
   * @returns {boolean} Whether peer read sequence advanced
   */
  setPeerLastReadSeq(seq) {
    const n = Number.isInteger(seq) ? seq : parseInt(seq, 10);
    if (!Number.isFinite(n) || n <= 0) return false;
    if (n >= this.peerLastReadSeq) {
      this.peerLastReadSeq = n;
      if (this.roomId && this.roomReceiptStore && !this.roomReceiptStore.has(this.roomId)) {
        this.roomReceiptStore.set(this.roomId, new Map());
      }
      if (this.currentUserId) {
        for (const msg of this.messages) {
          if (isOwnMessage(msg, this.currentUserId)) {
            const mSeq = msg.eventSeq ?? msg.event_seq ?? 0;
            if (mSeq > 0 && mSeq <= this.peerLastReadSeq) {
              msg.status = 'read';
              msg.deliveryStatus = 'read';
              msg.delivery_status = 'read';
              if (msg.id) {
                this.messageStatus.set(msg.id, 'read');
                if (this.roomId && this.roomReceiptStore?.has(this.roomId)) {
                  this.roomReceiptStore.get(this.roomId).set(msg.id, 'read');
                }
              }
              const cid = msg.clientMessageId || msg.client_message_id;
              if (cid) {
                this.messageStatus.set(cid, 'read');
                if (this.roomId && this.roomReceiptStore?.has(this.roomId)) {
                  this.roomReceiptStore.get(this.roomId).set(cid, 'read');
                }
              }
            }
          }
        }
      }
      return true;
    }
    return false;
  }

  /**
   * Calculates minimum and maximum valid sequence numbers from messages list.
   * @private
   */
  _calculateSeqBounds() {
    let min = null;
    let max = null;

    for (const msg of this.messages) {
      const seq = typeof msg.eventSeq === 'number' && msg.eventSeq > 0
        ? msg.eventSeq
        : (typeof msg.event_seq === 'number' && msg.event_seq > 0 ? msg.event_seq : null);

      if (seq !== null) {
        if (min === null || seq < min) min = seq;
        if (max === null || seq > max) max = seq;
      }
    }

    this.oldestSeq = min;
    this.newestSeq = max;
  }

  /**
   * Deduplicates messages by ID and clientMessageId while preserving chronological order.
   * @private
   * @param {Array} list
   * @returns {Array}
   */
  _deduplicate(list) {
    if (!Array.isArray(list)) return [];

    const seenIds = new Set();
    const seenClientIds = new Set();
    const result = [];

    for (const msg of list) {
      if (!msg || typeof msg !== 'object') continue;

      const id = msg.id ? String(msg.id) : null;
      const clientId = (msg.clientMessageId || msg.client_message_id)
        ? String(msg.clientMessageId || msg.client_message_id)
        : null;

      // If matching clientId already seen, check if incoming message is canonical and can replace optimistic placeholder
      if (clientId && seenClientIds.has(clientId)) {
        const existingIdx = result.findIndex(
          (m) => (m.clientMessageId && String(m.clientMessageId) === clientId) ||
                 (m.client_message_id && String(m.client_message_id) === clientId)
        );
        if (existingIdx !== -1) {
          const existing = result[existingIdx];
          const existingStatus = getHighestStatus(existing.deliveryStatus, existing.delivery_status, existing.status);
          const incomingStatus = getHighestStatus(msg.deliveryStatus, msg.delivery_status, msg.status);
          const bestStatus = getHighestStatus(existingStatus, incomingStatus);

          const isExistingOptimistic = existing.id && String(existing.id).startsWith('local-');
          const isMsgCanonical = id && !id.startsWith('local-');
          if (isExistingOptimistic && isMsgCanonical) {
            result[existingIdx] = {
              ...existing,
              ...msg,
              status: bestStatus || msg.status || existing.status,
              deliveryStatus: bestStatus || msg.deliveryStatus || existing.deliveryStatus,
              delivery_status: bestStatus || msg.delivery_status || existing.delivery_status
            };
            if (id) seenIds.add(id);
          } else {
            const isExistingDeleted = Boolean(existing.isDeleted || existing.is_deleted || existing.kind === 'deleted');
            const isMsgDeleted = Boolean(msg.isDeleted || msg.is_deleted || msg.kind === 'deleted');
            if (!isExistingDeleted && isMsgDeleted) {
              result[existingIdx] = {
                ...existing,
                ...msg,
                isDeleted: true,
                is_deleted: true,
                kind: 'deleted',
                body: { text: 'This message was deleted' },
                attachments: [],
                attachmentIds: [],
                attachment_ids: []
              };
            } else if (!isExistingDeleted && !isMsgDeleted) {
              const existingEditTs = Date.parse(existing.editedAt || existing.edited_at || '') || 0;
              const incomingEditTs = Date.parse(msg.editedAt || msg.edited_at || '') || 0;
              if (incomingEditTs > existingEditTs) {
                result[existingIdx] = {
                  ...existing,
                  ...msg,
                  body: msg.body || existing.body,
                  editedAt: msg.editedAt || msg.edited_at,
                  edited_at: msg.editedAt || msg.edited_at,
                  isEdited: true,
                  is_edited: true
                };
              }
            }
            if (bestStatus) {
              result[existingIdx].status = bestStatus;
              result[existingIdx].deliveryStatus = bestStatus;
              result[existingIdx].delivery_status = bestStatus;
            }
          }
        }
        continue;
      }

      if (id && seenIds.has(id)) {
        const existingIdx = result.findIndex((m) => m && m.id && String(m.id) === id);
        if (existingIdx !== -1) {
          const existing = result[existingIdx];
          const existingStatus = getHighestStatus(existing.deliveryStatus, existing.delivery_status, existing.status);
          const incomingStatus = getHighestStatus(msg.deliveryStatus, msg.delivery_status, msg.status);
          const bestStatus = getHighestStatus(existingStatus, incomingStatus);
          if (bestStatus) {
            existing.status = bestStatus;
            existing.deliveryStatus = bestStatus;
            existing.delivery_status = bestStatus;
          }

          const isExistingDeleted = Boolean(existing.isDeleted || existing.is_deleted || existing.kind === 'deleted');
          const isMsgDeleted = Boolean(msg.isDeleted || msg.is_deleted || msg.kind === 'deleted');
          if (!isExistingDeleted && isMsgDeleted) {
            result[existingIdx] = {
              ...existing,
              ...msg,
              isDeleted: true,
              is_deleted: true,
              kind: 'deleted',
              body: { text: 'This message was deleted' },
              attachments: [],
              attachmentIds: [],
              attachment_ids: []
            };
          } else if (!isExistingDeleted && !isMsgDeleted) {
            const existingEditTs = Date.parse(existing.editedAt || existing.edited_at || '') || 0;
            const incomingEditTs = Date.parse(msg.editedAt || msg.edited_at || '') || 0;
            if (incomingEditTs > existingEditTs) {
              result[existingIdx] = {
                ...existing,
                ...msg,
                body: msg.body || existing.body,
                editedAt: msg.editedAt || msg.edited_at,
                edited_at: msg.editedAt || msg.edited_at,
                isEdited: true,
                is_edited: true
              };
            }
          }
        }
        continue;
      }

      if (id) seenIds.add(id);
      if (clientId) seenClientIds.add(clientId);

      if (msg.isDeleted || msg.is_deleted || msg.kind === 'deleted') {
        msg.isDeleted = true;
        msg.is_deleted = true;
        msg.kind = 'deleted';
        msg.body = { text: 'This message was deleted' };
        msg.attachments = [];
        msg.attachmentIds = [];
        msg.attachment_ids = [];
      } else if (msg.editedAt || msg.edited_at) {
        msg.isEdited = true;
        msg.is_edited = true;
      }

      result.push(msg);
    }

    // Sort chronologically (oldest -> newest)
    result.sort((a, b) => {
      const seqA = a.eventSeq ?? a.event_seq ?? 0;
      const seqB = b.eventSeq ?? b.event_seq ?? 0;
      if (seqA > 0 && seqB > 0 && seqA !== seqB) {
        return seqA - seqB;
      }
      const timeA = Date.parse(a.createdAt || a.created_at || '') || (typeof a.startedAt === 'number' ? a.startedAt : 0);
      const timeB = Date.parse(b.createdAt || b.created_at || '') || (typeof b.startedAt === 'number' ? b.startedAt : 0);
      return timeA - timeB;
    });

    return result;
  }

  /**
   * Resets state and populates initial message batch.
   * Preserves pending in-flight optimistic messages whose clientMessageId is not yet in server list.
   * @param {string} roomId
   * @param {Array} messages
   * @param {boolean} [hasMore=false]
   */
  setInitialMessages(roomId, messages, hasMore = false) {
    if (Array.isArray(roomId) && messages === undefined) {
      messages = roomId;
      roomId = this.roomId;
    }
    this.roomId = typeof roomId === 'string' ? roomId : (this.roomId || null);

    // Filter out messages deleted for me and call signaling messages
    const filteredMessages = (messages || []).filter((m) => {
      const mid = m?.id;
      const cid = m?.clientMessageId || m?.client_message_id;
      if (this.isDeletedForMe(mid, this.roomId) || this.isDeletedForMe(cid, this.roomId) || m?.isDeletedForMe || m?.is_deleted_for_me) {
        return false;
      }
      if (isCallSignalMessage(m)) {
        return false;
      }
      return true;
    });

    // Load local room call records and transform to timeline messages
    const roomCalls = getRoomCallRecords(this.roomId, this.currentUserId);
    const callMessages = roomCalls
      .map((c) => callRecordToMessage(c, this.currentUserId))
      .filter((c) => c && !this.isDeletedForMe(c.id, this.roomId) && !this.isDeletedForMe(c.callId, this.roomId));

    // Preserve pending optimistic messages not yet confirmed by server
    const serverClientIds = new Set(
      filteredMessages.map((m) => m?.clientMessageId || m?.client_message_id).filter(Boolean)
    );
    const serverIds = new Set(
      filteredMessages.map((m) => m?.id).filter(Boolean)
    );
    const pendingOptimistic = this.messages.filter((m) => {
      if (m?.roomId && this.roomId && m.roomId !== this.roomId) return false;
      if (m?.isCallEntry || m?.kind === 'call') return false;
      const cid = m?.clientMessageId || m?.client_message_id;
      const mid = m?.id;
      if (this.isDeletedForMe(mid, this.roomId) || this.isDeletedForMe(cid, this.roomId)) return false;
      if (cid && serverClientIds.has(cid)) return false;
      if (mid && serverIds.has(mid)) return false;
      const status = cid ? this.messageStatus.get(cid) : (mid ? this.messageStatus.get(mid) : null);
      return status === MESSAGE_STATUS.SENDING || status === MESSAGE_STATUS.PENDING || status === 'pending' || status === 'queued' || (cid && String(cid).startsWith('local-'));
    });

    // Preserve existing known receipt statuses and message objects rather than wiping them completely
    const previousStatuses = new Map(this.messageStatus);
    const existingMsgMap = new Map();
    for (const m of this.messages) {
      if (m && typeof m === 'object') {
        if (m.id) existingMsgMap.set(String(m.id), m);
        const cid = m.clientMessageId || m.client_message_id;
        if (cid) existingMsgMap.set(String(cid), m);
      }
    }

    // Preserve local system messages already in this room
    const existingSystemMessages = this.messages.filter((m) => {
      if (m?.roomId && this.roomId && m.roomId !== this.roomId) return false;
      return m?.kind === 'system' || m?.type === 'system';
    });

    this.messages = this._deduplicate([...filteredMessages, ...callMessages, ...existingSystemMessages, ...pendingOptimistic]);
    this.hasMore = Boolean(hasMore);
    this.isLoadingInitial = false;
    this.isLoadingOlder = false;
    this.error = null;
    this._calculateSeqBounds();
    this.isHistoryLoaded = !hasMore || (this.oldestSeq !== null && this.oldestSeq <= 1);

    // Restore cached receipt statuses for this room if available
    this.messageStatus.clear();
    if (this.roomId && this.roomReceiptStore.has(this.roomId)) {
      const roomCache = this.roomReceiptStore.get(this.roomId);
      for (const [id, st] of roomCache.entries()) {
        this.messageStatus.set(id, st);
      }
    }
    // Re-seed from previousStatuses if higher rank
    for (const [id, st] of previousStatuses.entries()) {
      const cur = this.messageStatus.get(id);
      const higher = getHighestStatus(cur, st);
      if (higher) this.messageStatus.set(id, higher);
    }

    // Pre-scan loaded own messages to seed peerLastReadSeq from any known read messages
    if (this.currentUserId) {
      let maxKnownReadSeq = this.peerLastReadSeq;
      const roomCache = this.roomId && this.roomReceiptStore.has(this.roomId) ? this.roomReceiptStore.get(this.roomId) : null;
      for (const msg of this.messages) {
        if (isOwnMessage(msg, this.currentUserId)) {
          const mSeq = msg.eventSeq ?? msg.event_seq ?? 0;
          if (mSeq > 0) {
            const id = msg.id;
            const cid = msg.clientMessageId || msg.client_message_id;
            const cachedRoomSt = (roomCache && id ? roomCache.get(id) : null) || (roomCache && cid ? roomCache.get(cid) : null);
            const cachedId = id && this.messageStatus.has(id) ? this.messageStatus.get(id) : null;
            const cachedCid = cid && this.messageStatus.has(cid) ? this.messageStatus.get(cid) : null;
            const prevMsg = (id && existingMsgMap.get(String(id))) || (cid && existingMsgMap.get(String(cid)));
            const prevStatus = prevMsg ? getHighestStatus(prevMsg.deliveryStatus, prevMsg.delivery_status, prevMsg.status) : null;
            const msgSt = msg.deliveryStatus || msg.delivery_status || msg.status || null;
            if (msgSt === 'read' || cachedRoomSt === 'read' || cachedId === 'read' || cachedCid === 'read' || prevStatus === 'read') {
              if (mSeq > maxKnownReadSeq) {
                maxKnownReadSeq = mSeq;
              }
            }
          }
        }
      }
      if (maxKnownReadSeq > this.peerLastReadSeq) {
        this.peerLastReadSeq = maxKnownReadSeq;
      }
    }

    // Default own messages without status to 'sent' (matching Android reference seed behavior)
    // and strictly purge/disallow receipt statuses for incoming messages
    if (this.currentUserId) {
      for (const msg of this.messages) {
        const id = msg.id;
        const cid = msg.clientMessageId || msg.client_message_id;
        if (isOwnMessage(msg, this.currentUserId)) {
          const roomCache = this.roomId && this.roomReceiptStore.has(this.roomId) ? this.roomReceiptStore.get(this.roomId) : null;
          const cachedRoomSt = (roomCache && id ? roomCache.get(id) : null) || (roomCache && cid ? roomCache.get(cid) : null);
          const cachedId = id && this.messageStatus.has(id) ? this.messageStatus.get(id) : null;
          const cachedCid = cid && this.messageStatus.has(cid) ? this.messageStatus.get(cid) : null;
          const prevMsg = (id && existingMsgMap.get(String(id))) || (cid && existingMsgMap.get(String(cid)));
          const prevStatus = prevMsg ? getHighestStatus(prevMsg.deliveryStatus, prevMsg.delivery_status, prevMsg.status) : null;
          const msgSt = msg.deliveryStatus || msg.delivery_status || msg.status || null;
          const mSeq = msg.eventSeq ?? msg.event_seq ?? 0;
          const peerReadStatus = (this.peerLastReadSeq > 0 && mSeq > 0 && mSeq <= this.peerLastReadSeq) ? 'read' : null;
          const bestStatus = getHighestStatus(peerReadStatus, cachedRoomSt, cachedId, cachedCid, prevStatus, msgSt) || 'sent';

          if (id) {
            this.messageStatus.set(id, bestStatus);
            if (this.roomId) {
              if (!this.roomReceiptStore.has(this.roomId)) this.roomReceiptStore.set(this.roomId, new Map());
              this.roomReceiptStore.get(this.roomId).set(id, bestStatus);
            }
          }
          if (cid) {
            this.messageStatus.set(cid, bestStatus);
            if (this.roomId) {
              if (!this.roomReceiptStore.has(this.roomId)) this.roomReceiptStore.set(this.roomId, new Map());
              this.roomReceiptStore.get(this.roomId).set(cid, bestStatus);
            }
          }
          msg.status = bestStatus;
          msg.deliveryStatus = bestStatus;
          msg.delivery_status = bestStatus;
        } else {
          // Incoming messages must NEVER have receipt status
          if (id) {
            this.messageStatus.delete(id);
            if (this.roomId && this.roomReceiptStore.has(this.roomId)) {
              this.roomReceiptStore.get(this.roomId).delete(id);
            }
          }
          if (cid) {
            this.messageStatus.delete(cid);
            if (this.roomId && this.roomReceiptStore.has(this.roomId)) {
              this.roomReceiptStore.get(this.roomId).delete(cid);
            }
          }
        }
      }
      if (this.peerLastReadSeq > 0) {
        this.setPeerLastReadSeq(this.peerLastReadSeq);
      }
    }
  }

  /**
   * Resets state and populates initial message batch for current room.
   * @param {Array} messages
   * @param {boolean} [hasMore=false]
   */
  loadMessages(messages, hasMore = false) {
    return this.setInitialMessages(this.roomId, messages, hasMore);
  }

  /**
   * Merges server messages with existing loaded messages.
   * Reconciles optimistic messages and advances sequence bounds.
   * @param {Array} newMessages
   * @param {boolean} [hasMore]
   */
  mergeServerMessages(newMessages, hasMore = null) {
    if (!Array.isArray(newMessages) || newMessages.length === 0) {
      if (hasMore !== null) this.hasMore = Boolean(hasMore);
      return;
    }

    const filteredServerMessages = newMessages.filter((m) => {
      const mid = m?.id;
      const cid = m?.clientMessageId || m?.client_message_id;
      if (this.isDeletedForMe(mid, this.roomId) || this.isDeletedForMe(cid, this.roomId) || m?.isDeletedForMe || m?.is_deleted_for_me) {
        return false;
      }
      if (isCallSignalMessage(m)) {
        return false;
      }
      return true;
    });

    const merged = [...this.messages];
    for (const msg of filteredServerMessages) {
      if (!msg || typeof msg !== 'object') continue;
      const id = msg.id ? String(msg.id) : null;
      const cid = (msg.clientMessageId || msg.client_message_id) ? String(msg.clientMessageId || msg.client_message_id) : null;

      const idx = merged.findIndex((m) => {
        if (id && m.id && String(m.id) === id) return true;
        if (cid && ((m.clientMessageId && String(m.clientMessageId) === cid) || (m.client_message_id && String(m.client_message_id) === cid))) return true;
        return false;
      });

      const attIds = (Array.isArray(msg.attachment_ids) && msg.attachment_ids.length > 0)
        ? msg.attachment_ids
        : (Array.isArray(msg.attachmentIds) && msg.attachmentIds.length > 0
            ? msg.attachmentIds
            : (Array.isArray(msg.attachments) && msg.attachments.length > 0
                ? msg.attachments.map(a => (typeof a === 'object' ? (a?.id || a?.attachment_id || a?.attachmentId) : a)).filter(Boolean)
                : (Array.isArray(msg.body?.attachment_ids) && msg.body.attachment_ids.length > 0
                    ? msg.body.attachment_ids
                    : (Array.isArray(msg.body?.attachmentIds) && msg.body.attachmentIds.length > 0
                        ? msg.body.attachmentIds
                        : (Array.isArray(msg.body?.attachments) && msg.body.attachments.length > 0
                            ? msg.body.attachments.map(a => (typeof a === 'object' ? (a?.id || a?.attachment_id || a?.attachmentId) : a)).filter(Boolean)
                            : (msg.body?.attachment_id ? [msg.body.attachment_id] : (msg.body?.attachmentId ? [msg.body.attachmentId] : [])))))));

      if (idx !== -1) {
        const existing = merged[idx];
        const effectiveCid = existing.clientMessageId || existing.client_message_id || cid;
        const canonicalSender = msg.sender_id || msg.senderId || existing.sender_id || existing.senderId || '';
        const existingAttIds = (Array.isArray(existing.attachment_ids) && existing.attachment_ids.length > 0)
          ? existing.attachment_ids
          : (Array.isArray(existing.attachmentIds) ? existing.attachmentIds : []);
        const finalAttIds = attIds.length > 0 ? attIds : existingAttIds;

        const isExistingDeleted = Boolean(existing.isDeleted || existing.is_deleted || existing.kind === 'deleted');
        const isMsgDeleted = Boolean(msg.isDeleted || msg.is_deleted || msg.kind === 'deleted');
        const shouldBeDeleted = isExistingDeleted || isMsgDeleted;

        let effectiveBody;
        let effectiveKind;
        let effectiveEditedAt;
        let finalAttachments;
        let finalIds;

        if (shouldBeDeleted) {
          effectiveKind = 'deleted';
          effectiveBody = { text: 'This message was deleted' };
          effectiveEditedAt = existing.editedAt || existing.edited_at || msg.editedAt || msg.edited_at || null;
          finalAttachments = [];
          finalIds = [];
        } else {
          // Protect newer authoritative edit from being downgraded by older/stale server message
          const existingEditTs = Date.parse(existing.editedAt || existing.edited_at || '') || 0;
          const incomingEditTs = Date.parse(msg.editedAt || msg.edited_at || '') || 0;
          if (existingEditTs > 0 && (incomingEditTs === 0 || incomingEditTs < existingEditTs)) {
            effectiveBody = existing.body;
            effectiveKind = existing.kind || 'text';
            effectiveEditedAt = existing.editedAt || existing.edited_at;
          } else {
            effectiveBody = msg.body || existing.body;
            effectiveKind = msg.kind || existing.kind || 'text';
            effectiveEditedAt = msg.editedAt || msg.edited_at || existing.editedAt || existing.edited_at || null;
          }
          finalAttachments = attIds.length > 0 ? (msg.attachments || []) : (existing.attachments || []);
          finalIds = finalAttIds;
        }

        const existingStatus = getHighestStatus(
          existing.deliveryStatus,
          existing.delivery_status,
          existing.status
        );
        const incomingStatus = getHighestStatus(
          msg.deliveryStatus,
          msg.delivery_status,
          msg.status
        );
        const mSeq = msg.eventSeq ?? msg.event_seq ?? existing.eventSeq ?? existing.event_seq ?? 0;
        const isOwn = this.currentUserId && isOwnMessage(existing, this.currentUserId);
        const peerReadStatus = (this.peerLastReadSeq > 0 && mSeq > 0 && mSeq <= this.peerLastReadSeq && isOwn) ? 'read' : null;
        const effectiveStatus = getHighestStatus(peerReadStatus, existingStatus, incomingStatus) || existingStatus || incomingStatus || 'sent';

        merged[idx] = {
          ...existing,
          ...msg,
          kind: effectiveKind,
          body: effectiveBody,
          isDeleted: shouldBeDeleted,
          is_deleted: shouldBeDeleted,
          editedAt: effectiveEditedAt,
          edited_at: effectiveEditedAt,
          isEdited: Boolean(effectiveEditedAt),
          is_edited: Boolean(effectiveEditedAt),
          senderId: canonicalSender,
          sender_id: canonicalSender,
          clientMessageId: effectiveCid || null,
          client_message_id: effectiveCid || null,
          attachmentIds: finalIds,
          attachment_ids: finalIds,
          attachments: finalAttachments,
          id: id || existing.id,
          status: effectiveStatus,
          deliveryStatus: effectiveStatus,
          delivery_status: effectiveStatus
        };
      } else {
        const canonicalSender = msg.sender_id || msg.senderId || '';
        if (canonicalSender) {
          msg.senderId = canonicalSender;
          msg.sender_id = canonicalSender;
        }
        if (msg.isDeleted || msg.is_deleted || msg.kind === 'deleted') {
          msg.kind = 'deleted';
          msg.body = { text: 'This message was deleted' };
          msg.isDeleted = true;
          msg.is_deleted = true;
          msg.attachmentIds = [];
          msg.attachment_ids = [];
          msg.attachments = [];
        } else {
          msg.attachmentIds = attIds;
          msg.attachment_ids = attIds;
          if (msg.editedAt || msg.edited_at) {
            msg.isEdited = true;
            msg.is_edited = true;
          }
        }
        merged.push(msg);
      }
    }

    this.messages = this._deduplicate(merged);
    if (hasMore !== null) {
      this.hasMore = Boolean(hasMore);
    }
    this._calculateSeqBounds();

    // Synchronize receipt statuses for own messages & strictly purge for incoming messages
    if (this.currentUserId) {
      let maxKnownReadSeq = this.peerLastReadSeq;
      const roomCache = this.roomId && this.roomReceiptStore ? this.roomReceiptStore.get(this.roomId) : null;
      for (const msg of this.messages) {
        if (isOwnMessage(msg, this.currentUserId)) {
          const mSeq = msg.eventSeq ?? msg.event_seq ?? 0;
          if (mSeq > 0) {
            const id = msg.id;
            const cid = msg.clientMessageId || msg.client_message_id;
            const stId = id ? this.messageStatus.get(id) : null;
            const stCid = cid ? this.messageStatus.get(cid) : null;
            const cachedSt = (roomCache && id ? roomCache.get(id) : null) || (roomCache && cid ? roomCache.get(cid) : null);
            const msgSt = msg.deliveryStatus || msg.delivery_status || msg.status || null;
            if (msgSt === 'read' || cachedSt === 'read' || stId === 'read' || stCid === 'read') {
              if (mSeq > maxKnownReadSeq) {
                maxKnownReadSeq = mSeq;
              }
            }
          }
        }
      }
      if (maxKnownReadSeq > this.peerLastReadSeq) {
        this.peerLastReadSeq = maxKnownReadSeq;
      }

      for (const msg of this.messages) {
        const id = msg.id;
        const cid = msg.clientMessageId || msg.client_message_id;
        if (isOwnMessage(msg, this.currentUserId)) {
          const stId = id ? this.messageStatus.get(id) : null;
          const stCid = cid ? this.messageStatus.get(cid) : null;
          if (this.roomId && this.roomReceiptStore && !this.roomReceiptStore.has(this.roomId)) {
            this.roomReceiptStore.set(this.roomId, new Map());
          }
          const roomCache = this.roomId && this.roomReceiptStore ? this.roomReceiptStore.get(this.roomId) : null;
          const cachedSt = (roomCache && id ? roomCache.get(id) : null) || (roomCache && cid ? roomCache.get(cid) : null);
          const msgSt = msg.deliveryStatus || msg.delivery_status || msg.status || null;
          const mSeq = msg.eventSeq ?? msg.event_seq ?? 0;
          const peerReadStatus = (this.peerLastReadSeq > 0 && mSeq > 0 && mSeq <= this.peerLastReadSeq) ? 'read' : null;
          const candidate = getHighestStatus(peerReadStatus, cachedSt, stId, stCid, msgSt) || 'sent';
          if (id) {
            const currentRank = stId ? (STATUS_RANKS[stId] ?? -99) : -99;
            const newRank = STATUS_RANKS[candidate] ?? -99;
            if (newRank >= currentRank) {
              this.messageStatus.set(id, candidate);
              if (roomCache) roomCache.set(id, candidate);
            }
          }
          if (cid) {
            const currentRank = stCid ? (STATUS_RANKS[stCid] ?? -99) : -99;
            const newRank = STATUS_RANKS[candidate] ?? -99;
            if (newRank >= currentRank) {
              this.messageStatus.set(cid, candidate);
              if (roomCache) roomCache.set(cid, candidate);
            }
          }
          msg.status = candidate;
          msg.deliveryStatus = candidate;
          msg.delivery_status = candidate;
        } else {
          // Strictly purge incoming messages from receipt status
          if (id) {
            this.messageStatus.delete(id);
            if (this.roomId && this.roomReceiptStore.has(this.roomId)) {
              this.roomReceiptStore.get(this.roomId).delete(id);
            }
          }
          if (cid) {
            this.messageStatus.delete(cid);
            if (this.roomId && this.roomReceiptStore.has(this.roomId)) {
              this.roomReceiptStore.get(this.roomId).delete(cid);
            }
          }
        }
      }
      if (this.peerLastReadSeq > 0) {
        this.setPeerLastReadSeq(this.peerLastReadSeq);
      }
    }
  }

  /**
   * Prepends older historical messages before the current list.
   * @param {Array} olderMessages
   * @param {boolean} [hasMore=false]
   */
  prependOlderMessages(olderMessages, hasMore = false) {
    if (!Array.isArray(olderMessages) || olderMessages.length === 0) {
      this.hasMore = Boolean(hasMore);
      this.isLoadingOlder = false;
      return;
    }

    // Keep existing messages prioritized over prepended duplicates
    const existingIds = new Set(this.messages.map((m) => m.id).filter(Boolean));
    const existingClientIds = new Set(
      this.messages.map((m) => m.clientMessageId || m.client_message_id).filter(Boolean)
    );

    const filteredOlder = olderMessages.filter((m) => {
      const mid = m.id;
      const cid = m.clientMessageId || m.client_message_id;
      if (mid && (this.isDeletedForMe(mid, this.roomId) || m.isDeletedForMe || m.is_deleted_for_me)) return false;
      if (cid && (this.isDeletedForMe(cid, this.roomId) || m.isDeletedForMe || m.is_deleted_for_me)) return false;
      if (isCallSignalMessage(m)) return false;
      if (mid && existingIds.has(mid)) return false;
      if (cid && existingClientIds.has(cid)) return false;
      return true;
    });

    // Combine filtered older with current messages and deduplicate
    this.messages = this._deduplicate([...filteredOlder, ...this.messages]);
    this.hasMore = Boolean(hasMore);
    this.isLoadingOlder = false;
    this.error = null;
    this._calculateSeqBounds();

    // Register prepended own messages into receipt tracking monotonically
    if (this.currentUserId && Array.isArray(filteredOlder)) {
      let maxKnownReadSeq = this.peerLastReadSeq;
      const roomCache = this.roomId && this.roomReceiptStore.has(this.roomId) ? this.roomReceiptStore.get(this.roomId) : null;
      for (const msg of filteredOlder) {
        if (isOwnMessage(msg, this.currentUserId)) {
          const mSeq = msg.eventSeq ?? msg.event_seq ?? 0;
          if (mSeq > 0) {
            const msgSt = msg.deliveryStatus || msg.delivery_status || msg.status || null;
            if (msgSt === 'read' && mSeq > maxKnownReadSeq) {
              maxKnownReadSeq = mSeq;
            }
          }
        }
      }
      if (maxKnownReadSeq > this.peerLastReadSeq) {
        this.peerLastReadSeq = maxKnownReadSeq;
      }

      for (const msg of filteredOlder) {
        const id = msg.id;
        const cid = msg.clientMessageId || msg.client_message_id;
        if (isOwnMessage(msg, this.currentUserId)) {
          const stId = id ? this.messageStatus.get(id) : null;
          const stCid = cid ? this.messageStatus.get(cid) : null;
          const cachedSt = (roomCache && id ? roomCache.get(id) : null) || (roomCache && cid ? roomCache.get(cid) : null);
          const msgSt = msg.deliveryStatus || msg.delivery_status || msg.status || null;
          const mSeq = msg.eventSeq ?? msg.event_seq ?? 0;
          const peerReadStatus = (this.peerLastReadSeq > 0 && mSeq > 0 && mSeq <= this.peerLastReadSeq) ? 'read' : null;
          const candidate = getHighestStatus(peerReadStatus, cachedSt, stId, stCid, msgSt) || 'sent';

          if (id) {
            this.messageStatus.set(id, candidate);
            if (roomCache) roomCache.set(id, candidate);
          }
          if (cid) {
            this.messageStatus.set(cid, candidate);
            if (roomCache) roomCache.set(cid, candidate);
          }
          msg.status = candidate;
          msg.deliveryStatus = candidate;
          msg.delivery_status = candidate;
        }
      }
      if (this.peerLastReadSeq > 0) {
        this.setPeerLastReadSeq(this.peerLastReadSeq);
      }
    }
  }

  /**
   * Appends or reconciles an incoming real-time message.
   * @param {object} message
   * @returns {object} The reconciled message
   */
  appendIncomingMessage(message) {
    if (!message || typeof message !== 'object') return null;
    if (isCallSignalMessage(message)) return null;

    const id = message.id;
    const clientId = message.clientMessageId || message.client_message_id;
    if (this.isDeletedForMe(id, this.roomId) || this.isDeletedForMe(clientId, this.roomId) || message?.isDeletedForMe || message?.is_deleted_for_me) {
      return null;
    }
    const incomingSender = message.sender_id || message.senderId || '';
    if (incomingSender) {
      message.senderId = incomingSender;
      message.sender_id = incomingSender;
    }

    // Check if message already exists
    const idStr = id ? String(id) : null;
    const cidStr = clientId ? String(clientId) : null;
    const existingIndex = this.messages.findIndex((m) => {
      if (idStr && m.id && String(m.id) === idStr) return true;
      if (cidStr && ((m.clientMessageId && String(m.clientMessageId) === cidStr) || (m.client_message_id && String(m.client_message_id) === cidStr))) return true;
      return false;
    });

    if (existingIndex !== -1) {
      // Reconcile / update existing message
      const existing = this.messages[existingIndex];
      const existingStatus = getHighestStatus(
        existing?.deliveryStatus,
        existing?.delivery_status,
        existing?.status
      );
      const incomingStatus = getHighestStatus(
        message?.deliveryStatus,
        message?.delivery_status,
        message?.status
      );
      const effectiveStatus = getHighestStatus(existingStatus, incomingStatus) || existingStatus || incomingStatus;

      const merged = { ...existing, ...message };
      if (effectiveStatus) {
        merged.status = effectiveStatus;
        merged.deliveryStatus = effectiveStatus;
        merged.delivery_status = effectiveStatus;
      }
      if (message.body && typeof message.body === 'object') {
        merged.body = { ...(existing.body || {}), ...message.body };
      }
      const effectiveCid = existing.clientMessageId || existing.client_message_id || clientId;
      if (effectiveCid) {
        merged.clientMessageId = effectiveCid;
        merged.client_message_id = effectiveCid;
      }
      if (id) {
        merged.id = id;
      }
      const canonicalSender = message.sender_id || message.senderId || existing.sender_id || existing.senderId || '';
      if (canonicalSender) {
        merged.senderId = canonicalSender;
        merged.sender_id = canonicalSender;
      }
      const attIds = (Array.isArray(message.attachment_ids) && message.attachment_ids.length > 0)
        ? message.attachment_ids
        : (Array.isArray(message.attachmentIds) && message.attachmentIds.length > 0
            ? message.attachmentIds
            : (existing.attachmentIds || existing.attachment_ids || []));
      merged.attachmentIds = attIds;
      merged.attachment_ids = attIds;
      if (Array.isArray(message.attachments) && message.attachments.length > 0) {
        merged.attachments = message.attachments;
      } else if (Array.isArray(existing.attachments) && existing.attachments.length > 0) {
        merged.attachments = existing.attachments;
      }
      this.messages[existingIndex] = merged;
      this._calculateSeqBounds();

      // Synchronize receipt statuses across both id and clientMessageId for own messages
      if (this.currentUserId && isOwnMessage(merged, this.currentUserId)) {
        const stId = id ? this.getStatus(id) : null;
        const stCid = effectiveCid ? this.getStatus(effectiveCid) : null;
        const bestStatus = getHighestStatus(
          stId,
          stCid,
          message?.deliveryStatus,
          message?.delivery_status,
          message?.status,
          existing?.deliveryStatus,
          existing?.delivery_status,
          existing?.status
        );
        if (bestStatus) {
          this._setLinkedStatus(merged.id, bestStatus, this.roomId);
          merged.status = bestStatus;
          merged.deliveryStatus = bestStatus;
          merged.delivery_status = bestStatus;
        }
      } else {
        // Incoming message: purge any receipt status from messageStatus and roomReceiptStore
        if (merged.id) {
          this.messageStatus.delete(merged.id);
          if (this.roomId && this.roomReceiptStore?.has(this.roomId)) {
            this.roomReceiptStore.get(this.roomId).delete(merged.id);
          }
        }
        if (effectiveCid) {
          this.messageStatus.delete(effectiveCid);
          if (this.roomId && this.roomReceiptStore?.has(this.roomId)) {
            this.roomReceiptStore.get(this.roomId).delete(effectiveCid);
          }
        }
      }

      return merged;
    }

    this.messages.push(message);
    this.messages = this._deduplicate(this.messages);
    this._calculateSeqBounds();

    if (this.currentUserId && isOwnMessage(message, this.currentUserId)) {
      const stId = id ? this.getStatus(id) : null;
      const stCid = clientId ? this.getStatus(clientId) : null;
      const bestStatus = getHighestStatus(
        stId,
        stCid,
        message?.deliveryStatus,
        message?.delivery_status,
        message?.status
      );
      if (bestStatus) {
        this._setLinkedStatus(message.id, bestStatus, this.roomId);
      }
    } else {
      if (id) {
        this.messageStatus.delete(id);
        if (this.roomId && this.roomReceiptStore?.has(this.roomId)) {
          this.roomReceiptStore.get(this.roomId).delete(id);
        }
      }
      if (clientId) {
        this.messageStatus.delete(clientId);
        if (this.roomId && this.roomReceiptStore?.has(this.roomId)) {
          this.roomReceiptStore.get(this.roomId).delete(clientId);
        }
      }
    }

    return message;
  }

  /**
   * Adds or reconciles a message in this room state. Alias for appendIncomingMessage.
   * @param {object} message
   * @returns {object}
   */
  addMessage(message) {
    return this.appendIncomingMessage(message);
  }

  /**
   * Finds a loaded message by server ID or clientMessageId.
   * @param {string} messageId
   * @returns {object|null}
   */
  getMessage(messageId) {
    if (!messageId) return null;
    const sId = String(messageId);
    return this.messages.find(
      (m) => (m.id && String(m.id) === sId) ||
             (m.clientMessageId && String(m.clientMessageId) === sId) ||
             (m.client_message_id && String(m.client_message_id) === sId)
    ) || null;
  }

  /**
   * Appends or reconciles a local room call history entry in this room's messages.
   * @param {object} callRecord
   * @returns {object|null}
   */
  addCallMessage(callRecord) {
    if (!callRecord || typeof callRecord !== 'object') return null;
    const msg = callRecordToMessage(callRecord, this.currentUserId);
    if (!msg) return null;
    if (this.isDeletedForMe(msg.id, this.roomId) || this.isDeletedForMe(msg.callId, this.roomId)) {
      return null;
    }
    const existingIndex = this.messages.findIndex((m) => {
      if (msg.id && m.id === msg.id) return true;
      if (msg.callId && (m.callId === msg.callId || m.id === msg.callId)) return true;
      return false;
    });
    if (existingIndex !== -1) {
      this.messages[existingIndex] = { ...this.messages[existingIndex], ...msg };
    } else {
      this.messages.push(msg);
      this.messages = this._deduplicate(this.messages);
    }
    return msg;
  }

  /**
   * Updates fields on an existing message.
   * @param {string} messageId
   * @param {object} updates
   * @returns {boolean} Whether message was found and updated
   */
  updateMessage(messageId, updates) {
    if (!messageId || !updates || typeof updates !== 'object') return false;

    const msg = this.messages.find((m) => m.id === messageId || m.clientMessageId === messageId || m.client_message_id === messageId);
    if (!msg) return false;

    // A deleted message must NEVER have its tombstone body replaced by an edit
    if (msg.isDeleted || msg.is_deleted || msg.kind === 'deleted') {
      return false;
    }

    // If incoming update indicates deletion
    if (updates.isDeleted || updates.is_deleted || updates.kind === 'deleted') {
      return this.deleteMessage(messageId);
    }

    // Monotonic edit protection: do NOT overwrite a newer edit with an older one
    const incomingEditedAt = updates.editedAt || updates.edited_at;
    const currentEditedAt = msg.editedAt || msg.edited_at;
    if (currentEditedAt && incomingEditedAt) {
      const currentTs = Date.parse(currentEditedAt);
      const incomingTs = Date.parse(incomingEditedAt);
      if (!Number.isNaN(currentTs) && !Number.isNaN(incomingTs) && incomingTs < currentTs) {
        return false;
      }
    }

    if (updates.body !== undefined) {
      msg.body = typeof updates.body === 'object' ? { ...(msg.body || {}), ...updates.body } : updates.body;
    }
    if (incomingEditedAt !== undefined) {
      msg.editedAt = incomingEditedAt;
      msg.edited_at = incomingEditedAt;
      msg.isEdited = true;
      msg.is_edited = true;
    }
    if (updates.reactions !== undefined) {
      msg.reactions = updates.reactions;
    }
    if (updates.attachments !== undefined) {
      msg.attachments = updates.attachments;
    }
    return true;
  }

  /**
   * Appends or reconciles a system message in this room's message history.
   * @param {object} systemMsg
   * @returns {object|null}
   */
  addSystemMessage(systemMsg) {
    if (!systemMsg || typeof systemMsg !== 'object') return null;
    const id = systemMsg.id || systemMsg.messageId || systemMsg.clientMessageId;
    if (!id) return null;
    const existingIndex = this.messages.findIndex(
      (m) => (m.id && m.id === id) ||
        (m.clientMessageId && m.clientMessageId === id) ||
        (m.client_message_id && m.client_message_id === id)
    );
    if (existingIndex !== -1) {
      this.messages[existingIndex] = { ...this.messages[existingIndex], ...systemMsg };
      return this.messages[existingIndex];
    } else {
      this.messages.push(systemMsg);
      this.messages = this._deduplicate(this.messages);
      return systemMsg;
    }
  }

  /**
   * Adds an optimistic outgoing message in SENDING status.
   * Prevents duplicating if clientMessageId already exists.
   * @param {object} message
   * @returns {object}
   */
  addOptimisticMessage(message) {
    if (!message || typeof message !== 'object') return null;
    const cid = message.clientMessageId || message.client_message_id || message.id;
    if (!cid) return null;

    // Check if message with same clientMessageId or id already exists
    const cidStr = String(cid);
    const existingIndex = this.messages.findIndex(
      (m) =>
        (m.clientMessageId && String(m.clientMessageId) === cidStr) ||
        (m.client_message_id && String(m.client_message_id) === cidStr) ||
        (m.id && String(m.id) === cidStr)
    );

    if (existingIndex !== -1) {
      return this.messages[existingIndex];
    }

    const initStatus = message.status || message.deliveryStatus || message.delivery_status || MESSAGE_STATUS.SENDING;
    this.messages.push(message);
    this.messageStatus.set(cid, initStatus);
    if (this.roomId) {
      if (!this.roomReceiptStore.has(this.roomId)) this.roomReceiptStore.set(this.roomId, new Map());
      this.roomReceiptStore.get(this.roomId).set(cid, initStatus);
    }
    if (message.id && message.id !== cid) {
      this.messageStatus.set(message.id, initStatus);
      if (this.roomId) this.roomReceiptStore.get(this.roomId).set(message.id, initStatus);
    }
    this._calculateSeqBounds();
    return message;
  }

  /**
   * Returns whether a message is loaded in the current room.
   * @param {string} messageId
   * @returns {boolean}
   */
  hasMessage(messageId) {
    if (!messageId) return false;
    return this.messages.some(
      (m) => m.id === messageId || m.clientMessageId === messageId || m.client_message_id === messageId
    );
  }

  /**
   * Gets the delivery/read status of a message.
   * @param {string} messageId
   * @returns {string|null}
   */
  getStatus(messageId) {
    if (!messageId) return null;
    const roomCache = this.roomId && this.roomReceiptStore.has(this.roomId) ? this.roomReceiptStore.get(this.roomId) : null;
    const msg = this.messages.find(
      (m) => m.id === messageId || m.clientMessageId === messageId || m.client_message_id === messageId
    );
    if (msg) {
      if (this.currentUserId && !isOwnMessage(msg, this.currentUserId)) {
        return null;
      }
      const mSeq = msg.eventSeq ?? msg.event_seq ?? 0;
      const peerReadStatus = (this.peerLastReadSeq > 0 && mSeq > 0 && mSeq <= this.peerLastReadSeq) ? 'read' : null;
      return getHighestStatus(
        peerReadStatus,
        this.messageStatus.get(messageId),
        roomCache ? roomCache.get(messageId) : null,
        this.messageStatus.get(msg.id),
        this.messageStatus.get(msg.clientMessageId),
        this.messageStatus.get(msg.client_message_id),
        roomCache ? roomCache.get(msg.id) : null,
        roomCache ? roomCache.get(msg.clientMessageId) : null,
        roomCache ? roomCache.get(msg.client_message_id) : null,
        msg.deliveryStatus,
        msg.delivery_status,
        msg.status
      );
    }
    return getHighestStatus(
      this.messageStatus.get(messageId),
      roomCache ? roomCache.get(messageId) : null
    );
  }

  /**
   * Updates delivery/read receipt or failure status for a message.
   * Enforces strictly monotonic progression:
   * sending -> sent -> delivered -> read
   * Failure recovery:
   * failed -> sending -> sent -> delivered -> read
   * Rejects downgrades:
   * sent -> sending, delivered -> sent, read -> delivered/sent, sent/delivered/read -> failed.
   *
   * @param {string} messageId
   * @param {string} newStatus
   * @param {string|null} [targetRoomId=null] Optional target room ID for strict room isolation
   * @returns {boolean} Whether status was updated
   */
  updateReceipt(messageId, newStatus, targetRoomId = null) {
    if (!messageId || !newStatus) return false;

    const statusStr = String(newStatus).toLowerCase();
    const newRank = STATUS_RANKS[statusStr];
    if (newRank === undefined) return false;

    const effectiveRoomId = targetRoomId || this.roomId;
    const isCurrentRoom = !targetRoomId || targetRoomId === this.roomId;

    const matchedMsg = this.messages.find(
      (m) => m.id === messageId || m.clientMessageId === messageId || m.client_message_id === messageId
    );
    if (matchedMsg) {
      if (this.currentUserId && !isOwnMessage(matchedMsg, this.currentUserId)) {
        // Incoming messages MUST NEVER receive or store receipt status
        return false;
      }
      const msgSender = matchedMsg.sender_id || matchedMsg.senderId;
      if (this.currentUserId && msgSender && msgSender !== this.currentUserId) {
        return false;
      }
    }

    if (!isCurrentRoom && effectiveRoomId) {
      // Room isolation: update specified room's receipt cache without mutating active view
      if (!this.roomReceiptStore.has(effectiveRoomId)) {
        this.roomReceiptStore.set(effectiveRoomId, new Map());
      }
      const cache = this.roomReceiptStore.get(effectiveRoomId);
      const existingStatus = cache.get(messageId);
      const existingRank = existingStatus ? (STATUS_RANKS[existingStatus] ?? -99) : -99;
      if (statusStr === 'failed') {
        if (existingRank <= 0) {
          cache.set(messageId, 'failed');
          return true;
        }
        return false;
      }
      if (statusStr === 'pending' || statusStr === 'sending') {
        if (existingRank <= 0) {
          cache.set(messageId, statusStr);
          return true;
        }
        return false;
      }
      if (newRank > existingRank) {
        cache.set(messageId, statusStr);
        savePersistentReceipt(effectiveRoomId, messageId, statusStr);
        return true;
      }
      return false;
    }

    const currentStatus = this.getStatus(messageId);
    const currentRank = currentStatus !== null && currentStatus !== undefined ? (STATUS_RANKS[currentStatus] ?? -99) : -99;

    // 1. Transition to 'failed' is allowed only from 'pending'/'sending' (or unset/failed)
    if (statusStr === 'failed') {
      if (currentRank <= 0) {
        this._setLinkedStatus(messageId, 'failed', effectiveRoomId);
        return true;
      }
      return false; // Cannot downgrade sent, delivered, or read to failed
    }

    // 2. Transition to 'pending' is allowed from 'failed', 'sending', unset, or 'pending'
    if (statusStr === 'pending') {
      if (currentRank <= 0) {
        this._setLinkedStatus(messageId, 'pending', effectiveRoomId);
        return true;
      }
      return false;
    }

    // 3. Transition to 'sending' is allowed only from 'failed', 'pending', or unset/sending
    if (statusStr === 'sending') {
      if (currentRank <= 0) {
        this._setLinkedStatus(messageId, 'sending', effectiveRoomId);
        return true;
      }
      return false; // sent/delivered/read cannot become sending
    }

    // 4. Monotonic delivery progression: sent (1) -> delivered (2) -> read (3)
    if (newRank > currentRank) {
      this._setLinkedStatus(messageId, statusStr, effectiveRoomId);
      return true;
    }

    return false;
  }

  /**
   * Helper to set status on both messageId and any linked clientMessageId / serverId.
   * @private
   */
  _setLinkedStatus(messageId, statusStr, effectiveRoomId = null) {
    const matched = this.messages.find(
      (m) => m.id === messageId || m.clientMessageId === messageId || m.client_message_id === messageId
    );
    if (matched) {
      if (this.currentUserId && !isOwnMessage(matched, this.currentUserId)) {
        // Do not store receipt status for incoming messages
        return;
      }
      const msgSender = matched.sender_id || matched.senderId;
      if (this.currentUserId && msgSender && msgSender !== this.currentUserId) {
        return;
      }
    }

    const currentStatus = this.getStatus(messageId);
    const currentRank = currentStatus !== null && currentStatus !== undefined ? (STATUS_RANKS[currentStatus] ?? -99) : -99;
    let candidateStatus = statusStr;
    if (currentRank >= 1) {
      candidateStatus = getHighestStatus(currentStatus, statusStr) || currentStatus;
    }

    this.messageStatus.set(messageId, candidateStatus);
    const roomId = effectiveRoomId || this.roomId;
    if (roomId) {
      if (!this.roomReceiptStore.has(roomId)) {
        this.roomReceiptStore.set(roomId, new Map());
      }
      this.roomReceiptStore.get(roomId).set(messageId, candidateStatus);
      savePersistentReceipt(roomId, messageId, candidateStatus);
    }

    if (matched) {
      matched.status = candidateStatus;
      matched.deliveryStatus = candidateStatus;
      matched.delivery_status = candidateStatus;
      if (matched.id) {
        this.messageStatus.set(matched.id, candidateStatus);
        if (roomId) {
          this.roomReceiptStore.get(roomId).set(matched.id, candidateStatus);
          savePersistentReceipt(roomId, matched.id, candidateStatus);
        }
      }
      const cid = matched.clientMessageId || matched.client_message_id;
      if (cid) {
        this.messageStatus.set(cid, candidateStatus);
        if (roomId) {
          this.roomReceiptStore.get(roomId).set(cid, candidateStatus);
          savePersistentReceipt(roomId, cid, candidateStatus);
        }
      }
    }
  }

  /**
   * Reconciles reactions on a message.
   * @param {string} messageId
   * @param {string} principalId
   * @param {string} emoji
   * @param {boolean} [isAdd=true]
   * @returns {boolean}
   */
  updateReaction(messageId, principalId, emoji, isAdd = true) {
    if (!messageId || !emoji || !principalId) return false;

    const msg = this.messages.find((m) => m.id === messageId || m.clientMessageId === messageId || m.client_message_id === messageId);
    if (!msg) return false;

    if (!msg.reactions || typeof msg.reactions !== 'object') {
      msg.reactions = {};
    }

    const currentList = Array.isArray(msg.reactions[emoji]) ? [...msg.reactions[emoji]] : [];

    if (isAdd) {
      // Check maximum 20 distinct emoji reactions per message
      const distinctEmojis = Object.keys(msg.reactions).filter(
        (k) => Array.isArray(msg.reactions[k]) && msg.reactions[k].length > 0
      );
      if (!msg.reactions[emoji] && distinctEmojis.length >= 20) {
        return false;
      }
      if (!currentList.includes(principalId)) {
        currentList.push(principalId);
      }
    } else {
      const idx = currentList.indexOf(principalId);
      if (idx !== -1) {
        currentList.splice(idx, 1);
      }
    }

    if (currentList.length > 0) {
      msg.reactions[emoji] = currentList;
    } else {
      delete msg.reactions[emoji];
    }

    return true;
  }

  /**
   * Resets all room message state.
   */
  reset() {
    this.roomId = null;
    this.messages = [];
    this.isLoadingInitial = false;
    this.isLoadingOlder = false;
    this.error = null;
    this.hasMore = false;
    this.oldestSeq = null;
    this.newestSeq = null;
    this.messageStatus.clear();
  }

  /**
   * Complete reset including receipt caches (e.g. on logout).
   */
  resetAll() {
    this.reset();
    this.roomReceiptStore.clear();
  }
}

// ═══════════════════════════════════════════════════════════════════
// Phase 4D: Message Sending, Composer Validation & Optimistic Helpers
// ═══════════════════════════════════════════════════════════════════

/**
 * Validates text typed in the message composer.
 * Rejects null/undefined/non-string, empty, and whitespace-only strings.
 * Trims outer whitespace while preserving internal spaces and newlines.
 *
 * @param {any} text
 * @returns {{ valid: boolean, error: string|null, text: string }}
 */
export function validateComposerText(text) {
  if (typeof text !== 'string') {
    return { valid: false, error: 'Input must be a string', text: '' };
  }

  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { valid: false, error: 'Message cannot be empty or whitespace only', text: '' };
  }

  return { valid: true, error: null, text: trimmed };
}

/**
 * Universal, secure UUID v4 generator resilient to environments where crypto.randomUUID
 * is unavailable (e.g. Electron sandboxed renderer under file:// protocol).
 *
 * @returns {string} RFC 4122 v4 UUID string
 */
export function generateUuid() {
  if (typeof crypto !== 'undefined') {
    if (typeof crypto.randomUUID === 'function') {
      try {
        return crypto.randomUUID();
      } catch {}
    }
    if (typeof crypto.getRandomValues === 'function') {
      try {
        const bytes = new Uint8Array(16);
        crypto.getRandomValues(bytes);
        bytes[6] = (bytes[6] & 0x0f) | 0x40; // Version 4
        bytes[8] = (bytes[8] & 0x3f) | 0x80; // Variant 1
        const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      } catch {}
    }
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : ((r & 0x3) | 0x8);
    return v.toString(16);
  });
}

/**
 * Creates an optimistic outgoing message object matching the canonical message model.
 *
 * @param {string} roomId
 * @param {string} currentUserId
 * @param {string} text
 * @param {string} [clientMessageId]
 * @returns {object} Canonical message object
 */
export function createOptimisticMessage(roomId, currentUserId, text, clientMessageId = null) {
  const cid = clientMessageId || `local-${generateUuid()}`;
  const nowIso = new Date().toISOString();

  return {
    id: cid,
    roomId: roomId || '',
    room_id: roomId || '',
    senderId: currentUserId || '',
    sender_id: currentUserId || '',
    kind: 'text',
    body: { text: typeof text === 'string' ? text : '' },
    createdAt: nowIso,
    created_at: nowIso,
    eventSeq: 0,
    event_seq: 0,
    clientMessageId: cid,
    client_message_id: cid,
    status: MESSAGE_STATUS.SENDING,
    reactions: {}
  };
}

/**
 * Resolves the visual tick descriptor for a message status and direction.
 * Invariant: Incoming messages NEVER display ticks.
 * Outgoing sending/pending: single grey tick (✓)
 * Outgoing delivered: double grey ticks (✓✓)
 * Outgoing read: double blue ticks (✓✓, status-read)
 *
 * @param {string|null} status
 * @param {boolean} isOwn
 * @returns {{ hasTick: boolean, symbol: string, statusClass: string, title: string }}
 */
export function getTickDescriptor(status, isOwn) {
  if (!isOwn) {
    return { hasTick: false, symbol: '', statusClass: '', title: '' };
  }
  const s = String(status || 'sent').toLowerCase();
  if (s === 'pending' || s === 'queued') {
    return { hasTick: true, symbol: '🕒', statusClass: 'status-pending', title: 'Pending' };
  }
  if (s === 'sending' || s === 'sent') {
    return { hasTick: true, symbol: '✓', statusClass: 'status-sent', title: s === 'sending' ? 'Sending' : 'Sent' };
  }
  if (s === 'delivered') {
    return { hasTick: true, symbol: '✓✓', statusClass: 'status-delivered', title: 'Delivered' };
  }
  if (s === 'read') {
    return { hasTick: true, symbol: '✓✓', statusClass: 'status-read', title: 'Read' };
  }
  if (s === 'failed') {
    return { hasTick: true, symbol: '⚠️', statusClass: 'status-failed', title: 'Failed to send' };
  }
  return { hasTick: false, symbol: '', statusClass: '', title: '' };
}

/**
 * Formats a byte size into a human-readable string (e.g., "1.2 MB").
 * @param {number} bytes
 * @returns {string}
 */
export function formatFileSize(bytes) {
  if (typeof bytes !== 'number' || bytes <= 0 || Number.isNaN(bytes)) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

/**
 * Creates an optimistic media message object.
 * @param {string} roomId
 * @param {string} currentUserId
 * @param {object} params
 * @param {'image' | 'video' | 'audio' | 'file'} params.kind
 * @param {string} params.filename
 * @param {string} [params.caption]
 * @param {string} [params.mime]
 * @param {number} [params.byteSize]
 * @param {string} [params.attachmentId]
 * @param {string} [params.clientMessageId]
 * @param {number} [params.duration]
 * @param {boolean} [params.isVoiceNote]
 * @returns {object} Canonical message object
 */
export function createOptimisticMediaMessage(roomId, currentUserId, {
  kind,
  filename,
  caption = '',
  mime = '',
  byteSize = 0,
  attachmentId = null,
  clientMessageId = null,
  duration = 0,
  isVoiceNote = false
}) {
  const cid = clientMessageId || `local-${generateUuid()}`;
  const nowIso = new Date().toISOString();

  return {
    id: cid,
    roomId: roomId || '',
    room_id: roomId || '',
    senderId: currentUserId || '',
    sender_id: currentUserId || '',
    kind: kind || 'file',
    body: {
      text: caption || filename,
      caption: caption || '',
      filename: filename || '',
      mime: mime || '',
      byte_size: byteSize || 0,
      duration: duration || 0,
      is_voice_note: Boolean(isVoiceNote)
    },
    duration: duration || 0,
    isVoiceNote: Boolean(isVoiceNote),
    is_voice_note: Boolean(isVoiceNote),
    createdAt: nowIso,
    created_at: nowIso,
    eventSeq: 0,
    event_seq: 0,
    clientMessageId: cid,
    client_message_id: cid,
    status: MESSAGE_STATUS.SENDING,
    attachmentIds: attachmentId ? [attachmentId] : [],
    attachment_ids: attachmentId ? [attachmentId] : [],
    attachments: attachmentId ? [{
      attachmentId,
      attachment_id: attachmentId,
      filename,
      mime,
      byteSize,
      byte_size: byteSize
    }] : [],
    reactions: {}
  };
}

/**
 * Creates an optimistic voice message item.
 */
export function createOptimisticVoiceMessage(roomId, currentUserId, {
  filename = 'voice_message.webm',
  mime = 'audio/webm;codecs=opus',
  byteSize = 0,
  duration = 0,
  attachmentId = null,
  clientMessageId = null
} = {}) {
  return createOptimisticMediaMessage(roomId, currentUserId, {
    kind: 'audio',
    filename,
    caption: '',
    mime,
    byteSize,
    attachmentId,
    clientMessageId,
    duration,
    isVoiceNote: true
  });
}

export { normalizeToE164, validateE164 } from '../api/ollacore-api.js';
export { isEmojiOnly, insertTextAtCursor, filterEmojis, EmojiPicker } from './emoji-picker.js';

/**
 * Checks whether an ID is a canonical server message ID.
 * Returns true if id is a non-empty string or positive number not starting with 'local-'.
 * @param {string|number} id
 * @returns {boolean}
 */
export function isCanonicalServerId(id) {
  if (id === null || id === undefined) return false;
  if (typeof id === 'number' && Number.isFinite(id) && id > 0) return true;
  const s = String(id).trim();
  if (!s || s.startsWith('local-')) return false;
  return true;
}

/**
 * Resolves the canonical server message ID for a given message.
 * Preferred order:
 * A. If the message already has a canonical server ID, use it.
 * B. If the message has clientMessageId and the canonical message exists in room state/history, resolve it from existing state.
 * C. If it cannot be resolved locally, fetch the room's recent messages using the chat API and map client_message_id -> canonical server message id.
 *
 * @param {string} roomId
 * @param {object} message
 * @param {object} [context={}] Optional context for dependency injection
 * @param {RoomMessagesState} [context.targetState]
 * @param {object} [context.chatApi]
 * @returns {Promise<string|null>} Canonical server ID or null if unresolvable
 */
export async function resolveCanonicalMessageId(roomId, message, context = {}) {
  if (!message || typeof message !== 'object') return null;

  // A. If the message already has a canonical server ID, use it.
  if (isCanonicalServerId(message.id)) {
    return String(message.id);
  }

  const clientMsgId = message.clientMessageId || message.client_message_id || (String(message.id || '').startsWith('local-') ? message.id : null);
  const targetRoom = roomId || message.roomId || message.room_id || null;

  // B. If the message has clientMessageId and the canonical message exists in room state/history, resolve from existing state.
  const targetState = context.targetState || null;
  if (clientMsgId && targetState && Array.isArray(targetState.messages)) {
    const localMatch = targetState.messages.find((m) =>
      m &&
      (m.clientMessageId === clientMsgId || m.client_message_id === clientMsgId || m.id === clientMsgId) &&
      isCanonicalServerId(m.id)
    );
    if (localMatch && isCanonicalServerId(localMatch.id)) {
      const canonicalId = String(localMatch.id);
      message.id = canonicalId;
      return canonicalId;
    }
  }

  // C. Fetch room's recent messages using existing chat API and map client_message_id -> canonical server message id.
  const api = context.chatApi || (typeof window !== 'undefined' ? window.ollacoreDesktop?.chatApi : null);
  if (targetRoom && api && typeof api.getMessages === 'function') {
    try {
      const res = await api.getMessages(targetRoom, { limit: 50 });
      const messages = Array.isArray(res?.messages) ? res.messages : (Array.isArray(res) ? res : []);

      if (messages.length > 0) {
        if (targetState && typeof targetState.mergeServerMessages === 'function') {
          targetState.mergeServerMessages(messages);
        }

        if (clientMsgId) {
          const match = messages.find((m) =>
            m &&
            (m.client_message_id === clientMsgId || m.clientMessageId === clientMsgId || m.id === clientMsgId) &&
            isCanonicalServerId(m.id)
          );
          if (match && isCanonicalServerId(match.id)) {
            const canonicalId = String(match.id);
            message.id = canonicalId;
            return canonicalId;
          }
        }
      }
    } catch (err) {
      console.error('[resolveCanonicalMessageId] Error querying getMessages:', err);
    }
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════════
// URL & LINK DETECTION HELPERS
// ═══════════════════════════════════════════════════════════════════

export const URL_CANDIDATE_REGEX = /(?:https?:\/\/|www\.)[^\s<>"'`]+/gi;

/**
 * Strips trailing punctuation from a candidate URL string and validates scheme/host.
 * @param {string} raw
 * @returns {string|null}
 */
export function cleanUrl(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let s = raw.trim();

  // Strip obvious trailing punctuation characters repeatedly
  const trailingPunctRegex = /[.,!?:;"'>]+$/;
  while (trailingPunctRegex.test(s)) {
    s = s.replace(trailingPunctRegex, '');
  }

  // Handle unbalanced trailing closing parenthesis
  while (s.endsWith(')')) {
    const openCount = (s.match(/\(/g) || []).length;
    const closeCount = (s.match(/\)/g) || []).length;
    if (closeCount > openCount) {
      s = s.slice(0, -1);
      s = s.replace(trailingPunctRegex, '');
    } else {
      break;
    }
  }

  // Handle unbalanced trailing closing bracket
  while (s.endsWith(']')) {
    const openCount = (s.match(/\[/g) || []).length;
    const closeCount = (s.match(/\]/g) || []).length;
    if (closeCount > openCount) {
      s = s.slice(0, -1);
      s = s.replace(trailingPunctRegex, '');
    } else {
      break;
    }
  }

  if (/^https?:\/\/$/i.test(s) || /^www\.$/i.test(s) || s.length < 5) {
    return null;
  }

  if (/^www\./i.test(s)) {
    const withoutPrefix = s.slice(4);
    if (!withoutPrefix.includes('.') && !withoutPrefix.includes('/')) {
      return null;
    }
  }

  const targetHref = /^www\./i.test(s) ? 'https://' + s : s;
  try {
    const parsed = new URL(targetHref);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    if (!parsed.hostname || parsed.hostname.length < 3) {
      return null;
    }
  } catch (_) {
    return null;
  }

  return s;
}

/**
 * Extracts unique detected URLs from arbitrary text.
 * @param {string} text
 * @returns {string[]}
 */
export function extractUrls(text) {
  if (!text || typeof text !== 'string') return [];
  const results = [];
  const regex = new RegExp(URL_CANDIDATE_REGEX.source, 'gi');
  let match;
  while ((match = regex.exec(text)) !== null) {
    const cleaned = cleanUrl(match[0]);
    if (cleaned && !results.includes(cleaned)) {
      results.push(cleaned);
    }
  }
  return results;
}

/**
 * Parses message text into an ordered list of text and link tokens.
 * @param {string} text
 * @returns {Array<{ type: 'text'|'link', text: string, url?: string, href?: string }>}
 */
export function parseTextWithUrls(text) {
  if (!text || typeof text !== 'string') return [];
  const tokens = [];
  const regex = new RegExp(URL_CANDIDATE_REGEX.source, 'gi');
  let lastIndex = 0;
  let match;

  while ((match = regex.exec(text)) !== null) {
    const raw = match[0];
    const matchStart = match.index;
    const cleaned = cleanUrl(raw);

    if (!cleaned) {
      continue;
    }

    if (matchStart > lastIndex) {
      tokens.push({ type: 'text', text: text.slice(lastIndex, matchStart) });
    }

    const href = /^www\./i.test(cleaned) ? 'https://' + cleaned : cleaned;
    tokens.push({
      type: 'link',
      text: cleaned,
      url: cleaned,
      href
    });

    lastIndex = matchStart + cleaned.length;
    regex.lastIndex = lastIndex;
  }

  if (lastIndex < text.length) {
    tokens.push({ type: 'text', text: text.slice(lastIndex) });
  }

  return tokens;
}

/**
 * Evaluates WhatsApp-style group capabilities for a conversation and user.
 * @param {object} conversation
 * @param {Array<object>} participants
 * @param {string|null} currentUserId
 * @returns {object}
 */
export function getGroupCapabilities(conversation, participants = [], currentUserId = null) {
  const isGroup = Boolean(
    conversation && (conversation.kind === 'group' || conversation.type === 'group')
  );
  if (!conversation || !isGroup) {
    return {
      isGroup: false,
      title: 'Contact info',
      isExited: false,
      isAdmin: false,
      isOwner: false,
      isCurrentUserAdmin: false,
      isCurrentUserOwner: false,
      isMember: false,
      currentUserRole: 'member',
      canAddPeople: false,
      canRenameGroup: false,
      canEditDescription: false,
      canExitGroup: false,
      canDeleteChat: true,
      canClearChat: true,
      canBlock: true,
      showParticipants: false
    };
  }

  const isExited = Boolean(conversation.isExited || conversation.exited);
  const self = Array.isArray(participants) ? participants.find((p) => isParticipantSelf(p, currentUserId)) : null;
  const rawRole = self?.role || conversation.my_role || conversation.myRole || (isParticipantAdmin(self) ? 'admin' : 'member');
  const currentUserRole = String(rawRole || 'member').toLowerCase().trim();
  const isAdmin = !isExited && Boolean(self && isParticipantAdmin(self));
  const isOwner = !isExited && Boolean(self && isParticipantOwner(self));
  const isMember = !isExited && Boolean(self);

  return {
    isGroup: true,
    title: 'Group info',
    isExited,
    isAdmin,
    isOwner,
    isCurrentUserAdmin: isAdmin,
    isCurrentUserOwner: isOwner,
    isMember,
    currentUserRole,
    canAddPeople: isAdmin,
    canRenameGroup: isOwner,
    canEditDescription: isOwner,
    canExitGroup: isMember || !isExited,
    canDeleteChat: isExited, // Exited groups can be deleted locally from the chat list
    canClearChat: true,
    canBlock: false,
    showParticipants: true
  };
}

/**
 * Evaluates participant management capabilities against a target participant row.
 * @param {object} targetParticipant
 * @param {boolean} isCurrentUserAdmin
 * @param {string|null} currentUserId
 * @returns {object}
 */
export function getParticipantCapabilities(targetParticipant, isCurrentUserAdmin = false, currentUserId = null, allParticipants = []) {
  if (!targetParticipant) {
    return {
      isSelf: false,
      isAdmin: false,
      targetIsAdmin: false,
      targetIsOwner: false,
      isFinalOwner: false,
      roleLabel: 'Member',
      canViewContact: false,
      canPromote: false,
      canDemote: false,
      canRemove: false
    };
  }

  const isSelf = isParticipantSelf(targetParticipant, currentUserId);
  const targetIsAdmin = isParticipantAdmin(targetParticipant);
  const targetRole = String(targetParticipant.role || '').toLowerCase().trim();
  const targetIsOwner = targetRole === 'owner' || targetRole === 'creator';
  const roleLabel = targetIsOwner ? 'Owner' : (targetIsAdmin ? 'Admin' : 'Member');

  let isFinalOwner = false;
  if (targetIsOwner && Array.isArray(allParticipants) && allParticipants.length > 0) {
    const ownerCount = allParticipants.filter((p) => {
      const r = String(p?.role || '').toLowerCase().trim();
      return r === 'owner' || r === 'creator';
    }).length;
    if (ownerCount <= 1) {
      isFinalOwner = true;
    }
  }

  const isEligibleMemberForPromotion = !targetIsAdmin && !targetIsOwner;
  const canPromote = Boolean(isCurrentUserAdmin && !isSelf && isEligibleMemberForPromotion);

  const canDemote = Boolean(
    isCurrentUserAdmin && !isSelf && (
      (targetIsAdmin && !targetIsOwner) ||
      (targetIsOwner && !isFinalOwner)
    )
  );

  const canRemove = Boolean(
    isCurrentUserAdmin && !isSelf && !isFinalOwner && (
      !targetIsOwner || (Array.isArray(allParticipants) && allParticipants.length > 0 ? !isFinalOwner : true)
    )
  );

  return {
    isSelf,
    isAdmin: targetIsAdmin,
    targetIsAdmin,
    targetIsOwner,
    isFinalOwner,
    roleLabel,
    canViewContact: !isSelf,
    canPromote,
    canDemote,
    canRemove
  };
}

/**
 * Safely resolves human-readable display name for a group member.
 * @param {string} memberId
 * @param {object|null} [pObj=null]
 * @param {object} [options={}]
 * @returns {string}
 */
export function resolveMemberDisplayName(memberId, pObj = null, { getContactNicknameFn = null, conversations = [] } = {}) {
  if (!memberId) return 'Member';
  const cleanId = String(memberId).trim();

  const nickFn = typeof getContactNicknameFn === 'function'
    ? getContactNicknameFn
    : (typeof globalThis !== 'undefined' && typeof globalThis.shellState?.getContactNickname === 'function'
        ? (id) => globalThis.shellState.getContactNickname(id)
        : null);

  // 1. Nickname from contacts
  if (typeof nickFn === 'function') {
    const nick = nickFn(cleanId);
    if (nick && nick.trim()) return nick.trim();
  }

  // 2. Display name from participant object
  const pName = pObj?.displayName || pObj?.display_name || pObj?.name;
  if (pName && pName.trim()) return pName.trim();

  // 3. Conversation peer name if 1:1 conversation exists
  if (Array.isArray(conversations)) {
    const peerConv = conversations.find((c) => c.peerUserId === cleanId || c.peer_user_id === cleanId);
    if (peerConv?.title && peerConv.title.trim()) return peerConv.title.trim();
  }

  // 4. Phone number if available
  const phone = pObj?.phone;
  if (phone && phone.trim()) return phone.trim();

  // 5. Safe fallback
  if (cleanId.length > 8) {
    return `Member (${cleanId.slice(0, 8)})`;
  }
  return `Member (${cleanId})`;
}

/**
 * Derives clean 1-2 letter uppercase initials for user avatars.
 * @param {string} name
 * @returns {string}
 */
export function getMemberInitials(name) {
  if (!name) return '?';
  const trimmed = name.trim();
  const parts = trimmed.split(/\s+/);
  if (parts.length >= 2 && parts[0] && parts[1]) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return trimmed.slice(0, 2).toUpperCase();
}

/**
 * Partitions group members into Read, Delivered, and Pending receipt categories.
 * Excludes the message sender from recipients.
 * @param {object} params
 * @returns {{ readList: Array<object>, deliveredList: Array<object>, pendingList: Array<object> }}
 */
export function partitionGroupReceiptMembers({
  message,
  currentUserId,
  participantsMap = null,
  dbReceipts = [],
  getDisplayNameFn = null
} = {}) {
  const senderId = message?.senderId || message?.sender_id || message?.userId || message?.user_id || currentUserId;
  const recipientMap = new Map();

  if (participantsMap) {
    const list = participantsMap instanceof Map ? Array.from(participantsMap.entries()) : Object.entries(participantsMap);
    for (const [key, p] of list) {
      const cleanId = String(p?.principalId || p?.principal_id || p?.userId || p?.user_id || key).trim();
      if (!cleanId) continue;
      if (senderId && (cleanId === String(senderId).trim() || cleanId.toLowerCase() === String(senderId).trim().toLowerCase())) {
        continue;
      }
      const k = cleanId.toLowerCase();
      if (!recipientMap.has(k)) {
        recipientMap.set(k, {
          id: cleanId,
          pObj: p,
          receipt: null
        });
      }
    }
  }

  if (Array.isArray(dbReceipts)) {
    for (const r of dbReceipts) {
      if (!r || !r.recipientId) continue;
      const recId = String(r.recipientId).trim();
      if (senderId && (recId === String(senderId).trim() || recId.toLowerCase() === String(senderId).trim().toLowerCase())) {
        continue;
      }
      const k = recId.toLowerCase();
      if (!recipientMap.has(k)) {
        recipientMap.set(k, {
          id: recId,
          pObj: participantsMap?.get ? (participantsMap.get(recId) || participantsMap.get(k) || null) : null,
          receipt: r
        });
      } else {
        recipientMap.get(k).receipt = r;
      }
    }
  }

  const readList = [];
  const deliveredList = [];
  const pendingList = [];

  for (const item of recipientMap.values()) {
    const status = item.receipt?.status?.toLowerCase();
    const deliveredAt = item.receipt?.deliveredAt;
    const readAt = item.receipt?.readAt;
    const timestamp = item.receipt?.timestamp;
    const displayName = typeof getDisplayNameFn === 'function' ? getDisplayNameFn(item.id, item.pObj) : (item.pObj?.displayName || item.id);

    if (status === 'read') {
      readList.push({
        ...item,
        status: 'read',
        displayName,
        time: readAt || timestamp || null
      });
    } else if (status === 'delivered') {
      deliveredList.push({
        ...item,
        status: 'delivered',
        displayName,
        time: deliveredAt || timestamp || null
      });
    } else {
      pendingList.push({
        ...item,
        status: 'pending',
        displayName,
        time: null
      });
    }
  }

  const sortByName = (a, b) => (a.displayName || a.id).localeCompare(b.displayName || b.id);
  readList.sort(sortByName);
  deliveredList.sort(sortByName);
  pendingList.sort(sortByName);

  return {
    readList,
    deliveredList,
    pendingList
  };
}

/**
 * Identifies the latest unread message in a conversation.
 * 
 * Rules:
 * 1. An unread message is an incoming message (not sent by self) that has not yet been read.
 * 2. If tracked unread message IDs exist (e.g. from real-time events while away),
 *    the newest incoming message matching any tracked identifier is selected.
 * 3. If unreadCount > 0, the last unread incoming message is selected.
 * 4. If conversation was manually marked unread, the latest incoming message is selected.
 * 5. If there are multiple unread messages, it returns the LAST unread message in chronological order
 *    (the latest unread message), NOT the oldest unread message.
 * 6. If no unread messages exist, returns null.
 *
 * @param {Array<object>} messages - Chronologically sorted messages (oldest to newest)
 * @param {object} [options]
 * @param {string} [options.currentUserId]
 * @param {number} [options.unreadCount=0]
 * @param {boolean} [options.isMarkedUnread=false]
 * @param {Set<string>} [options.trackedUnreadSet]
 * @param {Set<string>} [options.trackedEditsSet]
 * @returns {object|null} The latest unread message object, or null if none
 */
export function findLatestUnreadMessage(messages, {
  currentUserId = null,
  unreadCount = 0,
  isMarkedUnread = false,
  trackedUnreadSet = null,
  trackedEditsSet = null,
  targetMessageId = null
} = {}) {
  if (!Array.isArray(messages) || messages.length === 0) return null;

  // 0. If a specific targetMessageId is requested (e.g. from notification click), prefer it
  if (targetMessageId) {
    const match = messages.find(
      (m) => m.id === targetMessageId ||
             m.clientMessageId === targetMessageId ||
             m.client_message_id === targetMessageId ||
             String(m.id) === String(targetMessageId) ||
             (m.clientMessageId && String(m.clientMessageId) === String(targetMessageId))
    );
    if (match) {
      return match;
    }
  }

  const incoming = messages.filter((m) => !isOwnMessage(m, currentUserId));
  if (incoming.length === 0) {
    if (isMarkedUnread && messages.length > 0) {
      return messages[messages.length - 1];
    }
    return null;
  }

  // 1. If we have tracked unread message IDs (from incoming background events),
  // search incoming messages from newest to oldest for the first match (i.e. the latest unread message)
  if ((trackedUnreadSet && trackedUnreadSet.size > 0) || (trackedEditsSet && trackedEditsSet.size > 0)) {
    for (let i = incoming.length - 1; i >= 0; i--) {
      const m = incoming[i];
      const mId = m.id ? String(m.id) : null;
      const cId = (m.clientMessageId || m.client_message_id) ? String(m.clientMessageId || m.client_message_id) : null;
      const seq = (typeof m.eventSeq === 'number' && m.eventSeq > 0)
        ? `seq:${m.eventSeq}`
        : ((typeof m.event_seq === 'number' && m.event_seq > 0) ? `seq:${m.event_seq}` : null);

      if (
        (mId && trackedUnreadSet?.has(mId)) ||
        (cId && trackedUnreadSet?.has(cId)) ||
        (seq && trackedUnreadSet?.has(seq)) ||
        (mId && trackedEditsSet?.has(mId)) ||
        (cId && trackedEditsSet?.has(cId))
      ) {
        return m;
      }
    }
  }

  // 2. Check by unread message status (status !== 'read' && status !== 'READ')
  // Scan from newest to oldest for the latest incoming unread message
  const unreadByStatus = [];
  for (const m of incoming) {
    const s = String(m.status || m.deliveryStatus || m.delivery_status || '').toLowerCase();
    if (s !== 'read') {
      unreadByStatus.push(m);
    }
  }

  if (unreadByStatus.length > 0 && (unreadCount > 0 || isMarkedUnread)) {
    if (unreadCount > 0 && unreadCount < unreadByStatus.length) {
      const slice = unreadByStatus.slice(-unreadCount);
      return slice[slice.length - 1];
    }
    return unreadByStatus[unreadByStatus.length - 1];
  }

  // 3. If unreadCount > 0 or manually marked unread, return the latest incoming message
  if (unreadCount > 0 || isMarkedUnread) {
    return incoming[incoming.length - 1];
  }

  return null;
}

/**
 * Identifies the first (oldest) unread message in a conversation.
 * Useful for positioning unread-messages dividers above the start of unread messages.
 */
export function findFirstUnreadMessage(messages, {
  currentUserId = null,
  unreadCount = 0,
  isMarkedUnread = false,
  trackedUnreadSet = null,
  trackedEditsSet = null,
  targetMessageId = null
} = {}) {
  if (!Array.isArray(messages) || messages.length === 0) return null;

  const incoming = messages.filter((m) => !isOwnMessage(m, currentUserId));
  if (incoming.length === 0) {
    if (isMarkedUnread && messages.length > 0) {
      return messages[messages.length - 1];
    }
    return null;
  }

  // If user replied later and conversation is not explicitly marked unread, only consider incoming messages AFTER the latest own message
  let effectiveIncoming = incoming;
  if (!isMarkedUnread && currentUserId) {
    let lastOwnIndex = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (isOwnMessage(messages[i], currentUserId)) {
        lastOwnIndex = i;
        break;
      }
    }
    if (lastOwnIndex !== -1) {
      effectiveIncoming = messages.slice(lastOwnIndex + 1).filter((m) => !isOwnMessage(m, currentUserId));
    }
  }

  // If a specific targetMessageId is passed, and unread count is 0 or untracked, check if targetMessageId matches an incoming message
  if (targetMessageId && (!trackedUnreadSet || trackedUnreadSet.size === 0) && (!unreadCount || unreadCount <= 1)) {
    const match = effectiveIncoming.find(
      (m) => m.id === targetMessageId ||
             m.clientMessageId === targetMessageId ||
             m.client_message_id === targetMessageId ||
             String(m.id) === String(targetMessageId)
    );
    if (match) return match;
  }

  if ((trackedUnreadSet && trackedUnreadSet.size > 0) || (trackedEditsSet && trackedEditsSet.size > 0)) {
    for (let i = 0; i < effectiveIncoming.length; i++) {
      const m = effectiveIncoming[i];
      const mId = m.id ? String(m.id) : null;
      const cId = (m.clientMessageId || m.client_message_id) ? String(m.clientMessageId || m.client_message_id) : null;
      const seq = (typeof m.eventSeq === 'number' && m.eventSeq > 0)
        ? `seq:${m.eventSeq}`
        : ((typeof m.event_seq === 'number' && m.event_seq > 0) ? `seq:${m.event_seq}` : null);

      if (
        (mId && trackedUnreadSet?.has(mId)) ||
        (cId && trackedUnreadSet?.has(cId)) ||
        (seq && trackedUnreadSet?.has(seq)) ||
        (mId && trackedEditsSet?.has(mId)) ||
        (cId && trackedEditsSet?.has(cId))
      ) {
        return m;
      }
    }
  }

  const unreadByStatus = [];
  for (const m of effectiveIncoming) {
    const s = String(m.status || m.deliveryStatus || m.delivery_status || '').toLowerCase();
    if (s !== 'read') {
      unreadByStatus.push(m);
    }
  }

  if (unreadByStatus.length > 0 && (unreadCount > 0 || isMarkedUnread)) {
    if (unreadCount > 0 && unreadCount < unreadByStatus.length) {
      const slice = unreadByStatus.slice(-unreadCount);
      return slice[0];
    }
    return unreadByStatus[0];
  }

  // When all messages are marked as read and conversation is not explicitly marked unread
  if (unreadByStatus.length === 0 && !isMarkedUnread) {
    return null;
  }

  if (unreadCount > 0 || isMarkedUnread) {
    if (effectiveIncoming.length === 0) return null;
    const count = unreadCount > 0 ? Math.min(unreadCount, effectiveIncoming.length) : 1;
    return effectiveIncoming[effectiveIncoming.length - count];
  }

  return null;
}


