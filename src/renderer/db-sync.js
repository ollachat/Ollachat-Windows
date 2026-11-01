/**
 * SQLite local persistent data layer bridge for the Windows renderer.
 * Converts between SQLite schema records and renderer state models,
 * provides typed local-first loading and background persistence helpers,
 * and preserves existing in-memory/localStorage behavior without regressions.
 */

/**
 * Converts a SQLite conversation row into a renderer conversation state object.
 * @param {object} row
 * @returns {object|null}
 */
export function sqliteRowToConversation(row) {
  if (!row || typeof row !== 'object' || !row.room_id) return null;
  const roomId = String(row.room_id);
  const peerUserId = row.peer_user_id ? String(row.peer_user_id) : null;
  const peerPhone = row.peer_phone ? String(row.peer_phone) : '';
  const peerDisplayName = row.peer_display_name ? String(row.peer_display_name) : '';
  const roomName = row.room_name ? String(row.room_name) : null;
  const title = roomName || peerDisplayName || 'Chat';
  const kind = row.kind === 'group' ? 'group' : 'direct';

  const lastMessageId = row.last_message_id ? String(row.last_message_id) : null;
  const lastMessagePreview = row.last_message_preview ? String(row.last_message_preview) : '';
  const lastMessageTime = row.last_message_time || row.updated_at || null;
  const lastEventSeq = Number.isInteger(row.last_event_seq) ? row.last_event_seq : 0;

  let lastMessage = null;
  if (lastMessageId || lastMessagePreview) {
    lastMessage = {
      id: lastMessageId,
      preview: lastMessagePreview,
      createdAt: lastMessageTime,
      created_at: lastMessageTime,
      eventSeq: lastEventSeq,
      event_seq: lastEventSeq,
      kind: 'text'
    };
  }

  const unreadCount = Number.isInteger(row.unread_count) ? Math.max(0, row.unread_count) : 0;

  return {
    roomId,
    room_id: roomId,
    id: roomId,
    kind,
    title,
    roomName,
    room_name: roomName,
    peer: peerUserId ? {
      userId: peerUserId,
      user_id: peerUserId,
      phone: peerPhone,
      displayName: peerDisplayName
    } : null,
    peerUserId,
    peer_user_id: peerUserId,
    peerPhone,
    peer_phone: peerPhone,
    peerDisplayName,
    peer_display_name: peerDisplayName,
    lastMessage,
    preview: lastMessagePreview,
    unreadCount,
    unread_count: unreadCount,
    isArchived: Boolean(row.is_archived),
    is_archived: Boolean(row.is_archived),
    isPinned: Boolean(row.is_pinned),
    is_pinned: Boolean(row.is_pinned),
    pinnedOrder: Number.isInteger(row.pinned_order) ? row.pinned_order : 0,
    pinned_order: Number.isInteger(row.pinned_order) ? row.pinned_order : 0,
    isFavourite: Boolean(row.is_favourite),
    is_favourite: Boolean(row.is_favourite),
    isMarkedUnread: Boolean(row.is_marked_unread),
    is_marked_unread: Boolean(row.is_marked_unread),
    draftText: row.draft_text || null,
    draft_text: row.draft_text || null,
    createdAt: row.created_at || new Date().toISOString(),
    created_at: row.created_at || new Date().toISOString(),
    updatedAt: row.updated_at || new Date().toISOString(),
    updated_at: row.updated_at || new Date().toISOString()
  };
}

/**
 * Converts a renderer conversation object into a SQLite payload for saveConversation.
 * @param {object} conv
 * @returns {object|null}
 */
export function conversationToSqlitePayload(conv) {
  if (!conv || typeof conv !== 'object') return null;
  const roomId = conv.roomId || conv.room_id || conv.id;
  if (!roomId) return null;

  const peer = conv.peer || {};
  const lastMsg = conv.lastMessage || {};

  return {
    roomId: String(roomId),
    room_id: String(roomId),
    kind: conv.kind === 'group' ? 'group' : 'direct',
    roomName: conv.title || conv.roomName || conv.room_name || null,
    peerUserId: peer.userId || peer.user_id || conv.peerUserId || conv.peer_user_id || null,
    peerPhone: peer.phone || conv.peerPhone || conv.peer_phone || null,
    peerDisplayName: peer.displayName || peer.display_name || conv.peerDisplayName || conv.peer_display_name || null,
    lastMessageId: lastMsg.id || conv.lastMessageId || conv.last_message_id || null,
    lastMessagePreview: lastMsg.preview || conv.preview || conv.lastMessagePreview || conv.last_message_preview || null,
    lastMessageTime: lastMsg.createdAt || lastMsg.created_at || conv.lastMessageTime || conv.last_message_time || conv.updatedAt || conv.updated_at || null,
    lastEventSeq: Number.isInteger(lastMsg.eventSeq ?? lastMsg.event_seq ?? conv.lastEventSeq ?? conv.last_event_seq)
      ? (lastMsg.eventSeq ?? lastMsg.event_seq ?? conv.lastEventSeq ?? conv.last_event_seq)
      : 0,
    unreadCount: Number.isInteger(conv.unreadCount ?? conv.unread_count) ? Math.max(0, conv.unreadCount ?? conv.unread_count) : 0,
    isArchived: conv.isArchived || conv.is_archived ? 1 : 0,
    isPinned: conv.isPinned || conv.is_pinned ? 1 : 0,
    pinnedOrder: Number.isInteger(conv.pinnedOrder ?? conv.pinned_order) ? (conv.pinnedOrder ?? conv.pinned_order) : 0,
    isFavourite: conv.isFavourite || conv.is_favourite ? 1 : 0,
    isMarkedUnread: conv.isMarkedUnread || conv.is_marked_unread ? 1 : 0,
    draftText: conv.draftText || conv.draft_text || null,
    createdAt: conv.createdAt || conv.created_at || new Date().toISOString(),
    updatedAt: conv.updatedAt || conv.updated_at || new Date().toISOString()
  };
}

/**
 * Converts a SQLite message row into a renderer message state object.
 * @param {object} row
 * @returns {object|null}
 */
export function sqliteRowToMessage(row) {
  if (!row || typeof row !== 'object' || !row.id) return null;
  let body = {};
  if (row.body_json) {
    if (typeof row.body_json === 'object') {
      body = row.body_json;
    } else {
      try {
        body = JSON.parse(row.body_json);
      } catch {
        body = { text: String(row.body_json) };
      }
    }
  }

  const isDeleted = Boolean(row.is_deleted);
  const isDeletedForMe = Boolean(row.is_deleted_for_me);
  const isStarred = Boolean(row.is_starred);

  // Extract and restore attachment references from body and row
  const rawAttachmentIds = Array.isArray(body.attachment_ids)
    ? body.attachment_ids
    : (Array.isArray(body.attachmentIds)
      ? body.attachmentIds
      : (Array.isArray(row.attachment_ids)
        ? row.attachment_ids
        : (Array.isArray(row.attachmentIds)
          ? row.attachmentIds
          : (body.attachment_id
            ? [body.attachment_id]
            : (body.attachmentId
              ? [body.attachmentId]
              : [])))));

  const normalizedAttachmentIds = rawAttachmentIds.map(item => {
    if (typeof item === 'object' && item !== null) {
      return String(item.id || item.attachment_id || item.attachmentId || '');
    }
    return String(item);
  }).filter(Boolean);

  const attachments = Array.isArray(body.attachments)
    ? body.attachments
    : (Array.isArray(row.attachments)
      ? row.attachments
      : (normalizedAttachmentIds.length > 0
        ? normalizedAttachmentIds.map(id => ({ id }))
        : []));

  const isVoiceNote = Boolean(
    body.is_voice_note ||
    body.isVoiceNote ||
    row.is_voice_note ||
    row.isVoiceNote ||
    ((row.kind === 'audio' || row.kind === 'file') && (body.filename || '').includes('voice_message'))
  );

  return {
    id: String(row.id),
    roomId: String(row.room_id),
    room_id: String(row.room_id),
    senderId: String(row.sender_id || ''),
    sender_id: String(row.sender_id || ''),
    clientMessageId: row.client_message_id ? String(row.client_message_id) : null,
    client_message_id: row.client_message_id ? String(row.client_message_id) : null,
    kind: row.kind || (isDeleted ? 'deleted' : 'text'),
    body: isDeleted ? { text: 'This message was deleted' } : body,
    replyTo: row.reply_to_id ? String(row.reply_to_id) : null,
    reply_to: row.reply_to_id ? String(row.reply_to_id) : null,
    replyToId: row.reply_to_id ? String(row.reply_to_id) : null,
    reply_to_id: row.reply_to_id ? String(row.reply_to_id) : null,
    eventSeq: Number.isInteger(row.event_seq) ? row.event_seq : null,
    event_seq: Number.isInteger(row.event_seq) ? row.event_seq : null,
    status: row.status || 'sent',
    deliveryStatus: row.status || 'sent',
    delivery_status: row.status || 'sent',
    isDeleted,
    is_deleted: isDeleted,
    isStarred,
    is_starred: isStarred,
    isDeletedForMe,
    is_deleted_for_me: isDeletedForMe,
    editedAt: row.edited_at || null,
    edited_at: row.edited_at || null,
    createdAt: row.created_at || new Date().toISOString(),
    created_at: row.created_at || new Date().toISOString(),
    localReceivedAt: row.local_received_at || row.created_at || new Date().toISOString(),
    local_received_at: row.local_received_at || row.created_at || new Date().toISOString(),
    // Preserve attachment references for forwarding, playback, and rendering
    attachment_ids: normalizedAttachmentIds,
    attachmentIds: normalizedAttachmentIds,
    attachments,
    attachment_id: normalizedAttachmentIds[0] || null,
    attachmentId: normalizedAttachmentIds[0] || null,
    is_voice_note: isVoiceNote,
    isVoiceNote,
    reactions: (row.reactions && typeof row.reactions === 'string')
      ? (() => {
          try { return JSON.parse(row.reactions); } catch { return {}; }
        })()
      : (row.reactions && typeof row.reactions === 'object' ? row.reactions : {})
  };
}

/**
 * Converts a renderer message object into a SQLite payload for saveMessage.
 * @param {object} msg
 * @param {string|null} [fallbackRoomId=null]
 * @returns {object|null}
 */
export function messageToSqlitePayload(msg, fallbackRoomId = null) {
  if (!msg || typeof msg !== 'object') return null;
  const roomId = msg.roomId || msg.room_id || fallbackRoomId;
  const id = msg.id || msg.clientMessageId || msg.client_message_id;
  if (!roomId || !id) return null;

  const senderId = msg.senderId || msg.sender_id || 'unknown';
  const clientMessageId = (msg.clientMessageId || msg.client_message_id)
    ? String(msg.clientMessageId || msg.client_message_id)
    : null;
  const replyToId = (msg.replyTo || msg.reply_to || msg.replyToId || msg.reply_to_id)
    ? String(msg.replyTo || msg.reply_to || msg.replyToId || msg.reply_to_id)
    : null;
  const eventSeq = Number.isInteger(msg.eventSeq ?? msg.event_seq) ? (msg.eventSeq ?? msg.event_seq) : 0;
  const now = new Date().toISOString();

  // Extract all attachment references from msg and msg.body
  const rawAttachmentIds = Array.isArray(msg.attachment_ids)
    ? msg.attachment_ids
    : (Array.isArray(msg.attachmentIds)
      ? msg.attachmentIds
      : (Array.isArray(msg.body?.attachment_ids)
        ? msg.body.attachment_ids
        : (Array.isArray(msg.body?.attachmentIds)
          ? msg.body.attachmentIds
          : (msg.attachment_id
            ? [msg.attachment_id]
            : (msg.attachmentId
              ? [msg.attachmentId]
              : (msg.body?.attachment_id
                ? [msg.body.attachment_id]
                : (msg.body?.attachmentId
                  ? [msg.body.attachmentId]
                  : [])))))));

  const normalizedAttachmentIds = rawAttachmentIds.map(item => {
    if (typeof item === 'object' && item !== null) {
      return String(item.id || item.attachment_id || item.attachmentId || '');
    }
    return String(item);
  }).filter(Boolean);

  const rawAttachments = Array.isArray(msg.attachments)
    ? msg.attachments
    : (Array.isArray(msg.body?.attachments)
      ? msg.body.attachments
      : []);

  const bodyObj = (msg.body && typeof msg.body === 'object')
    ? { ...msg.body }
    : (msg.body ? { text: String(msg.body) } : {});

  if (normalizedAttachmentIds.length > 0) {
    bodyObj.attachment_ids = normalizedAttachmentIds;
    bodyObj.attachmentIds = normalizedAttachmentIds;
    if (!bodyObj.attachment_id) bodyObj.attachment_id = normalizedAttachmentIds[0];
    if (!bodyObj.attachmentId) bodyObj.attachmentId = normalizedAttachmentIds[0];
  }

  if (rawAttachments.length > 0) {
    bodyObj.attachments = rawAttachments;
  } else if (normalizedAttachmentIds.length > 0 && !bodyObj.attachments) {
    bodyObj.attachments = normalizedAttachmentIds.map(id => ({ id }));
  }

  // Voice note preservation
  const isVoiceNote = Boolean(
    msg.is_voice_note ||
    msg.isVoiceNote ||
    bodyObj.is_voice_note ||
    bodyObj.isVoiceNote ||
    ((msg.kind === 'audio' || msg.kind === 'file') && (bodyObj.filename || '').includes('voice_message'))
  );
  if (isVoiceNote) {
    bodyObj.is_voice_note = true;
    bodyObj.isVoiceNote = true;
    if (msg.duration !== undefined && bodyObj.duration === undefined) {
      bodyObj.duration = msg.duration;
    }
  }

  const STATUS_RANKS = { failed: -1, pending: 0, sending: 0, sent: 1, delivered: 2, read: 3 };
  const rawCandidate = msg.deliveryStatus || msg.delivery_status || msg.status || 'sent';
  let resolvedStatus = rawCandidate;
  let bestRank = STATUS_RANKS[rawCandidate] ?? -99;
  for (const s of [msg.deliveryStatus, msg.delivery_status, msg.status]) {
    if (s && typeof s === 'string') {
      const rank = STATUS_RANKS[s] ?? -99;
      if (rank > bestRank) {
        bestRank = rank;
        resolvedStatus = s;
      }
    }
  }

  return {
    id: String(id),
    roomId: String(roomId),
    room_id: String(roomId),
    senderId: String(senderId),
    sender_id: String(senderId),
    clientMessageId,
    client_message_id: clientMessageId,
    kind: msg.kind || 'text',
    body: bodyObj,
    bodyJson: JSON.stringify(bodyObj),
    replyToId,
    eventSeq,
    status: resolvedStatus,
    deliveryStatus: resolvedStatus,
    delivery_status: resolvedStatus,
    isDeleted: msg.isDeleted || msg.is_deleted ? 1 : 0,
    isStarred: msg.isStarred || msg.is_starred ? 1 : 0,
    isDeletedForMe: msg.isDeletedForMe || msg.is_deleted_for_me ? 1 : 0,
    editedAt: msg.editedAt || msg.edited_at || null,
    createdAt: msg.createdAt || msg.created_at || now,
    localReceivedAt: msg.localReceivedAt || msg.local_received_at || now,
    attachment_ids: normalizedAttachmentIds,
    attachmentIds: normalizedAttachmentIds,
    attachments: bodyObj.attachments || [],
    attachment_id: normalizedAttachmentIds[0] || null,
    attachmentId: normalizedAttachmentIds[0] || null,
    is_voice_note: isVoiceNote,
    isVoiceNote,
    reactions: msg.reactions || null
  };
}

/**
 * Safely loads conversations from SQLite persistent storage.
 * @param {object} [options]
 * @returns {Promise<Array<object>>}
 */
export async function loadConversationsFromDb(options = {}) {
  const db = window?.ollacoreDesktop?.db;
  if (!db?.getConversations) return [];
  try {
    const rows = await db.getConversations(options);
    if (!Array.isArray(rows)) return [];
    return rows.map(sqliteRowToConversation).filter(Boolean);
  } catch (err) {
    console.warn('[DbSync] Failed to load conversations from SQLite:', err);
    return [];
  }
}

/**
 * Persists a single conversation to SQLite in the background.
 * @param {object} conv
 * @returns {Promise<boolean>}
 */
export async function persistConversationToDb(conv) {
  const db = window?.ollacoreDesktop?.db;
  if (!db?.saveConversation) return false;
  const payload = conversationToSqlitePayload(conv);
  if (!payload) return false;
  try {
    await db.saveConversation(payload);
    return true;
  } catch (err) {
    console.warn('[DbSync] Failed to persist conversation to SQLite:', err);
    return false;
  }
}

/**
 * Persists an array of conversations to SQLite in the background.
 * @param {Array<object>} conversations
 * @returns {Promise<number>} Number of successfully persisted conversations
 */
export async function persistConversationsToDb(conversations) {
  if (!Array.isArray(conversations) || conversations.length === 0) return 0;
  const db = window?.ollacoreDesktop?.db;
  if (!db?.saveConversation) return 0;

  let count = 0;
  for (const conv of conversations) {
    const payload = conversationToSqlitePayload(conv);
    if (payload) {
      try {
        await db.saveConversation(payload);
        count++;
      } catch (err) {
        console.warn('[DbSync] Error persisting conversation in batch:', err);
      }
    }
  }
  return count;
}

/**
 * Safely loads messages for a specific room from SQLite persistent storage.
 * @param {string} roomId
 * @param {object} [options]
 * @returns {Promise<Array<object>>}
 */
export async function loadMessagesFromDb(roomId, options = {}) {
  if (!roomId) return [];
  const db = window?.ollacoreDesktop?.db;
  if (!db?.getMessages) return [];
  try {
    const rows = await db.getMessages({ roomId, ...options });
    if (!Array.isArray(rows)) return [];
    return rows.map(sqliteRowToMessage).filter(Boolean);
  } catch (err) {
    console.warn('[DbSync] Failed to load messages from SQLite for room:', roomId, err);
    return [];
  }
}

/**
 * Safely loads a single message by ID or clientMessageId from SQLite persistent storage.
 * @param {string} messageId
 * @param {string|null} [roomId=null]
 * @returns {Promise<object|null>}
 */
export async function loadMessageByIdFromDb(messageId, roomId = null) {
  if (!messageId) return null;
  const db = window?.ollacoreDesktop?.db;
  if (!db?.getMessageById) return null;
  try {
    const row = await db.getMessageById({
      id: String(messageId),
      roomId: roomId ? String(roomId) : undefined
    });
    return row ? sqliteRowToMessage(row) : null;
  } catch (err) {
    console.warn('[DbSync] Failed to load message by ID from SQLite:', messageId, err);
    return null;
  }
}

/**
 * Persists a single message to SQLite in the background.
 * @param {object} msg
 * @param {string|null} [roomId=null]
 * @returns {Promise<boolean>}
 */
export async function persistMessageToDb(msg, roomId = null) {
  const db = window?.ollacoreDesktop?.db;
  if (!db?.saveMessage) return false;
  const payload = messageToSqlitePayload(msg, roomId);
  if (!payload) return false;
  try {
    await db.saveMessage(payload);
    return true;
  } catch (err) {
    console.warn('[DbSync] Failed to persist message to SQLite:', err);
    return false;
  }
}

/**
 * Persists an array of messages to SQLite in the background.
 * @param {Array<object>} messages
 * @param {string|null} [roomId=null]
 * @returns {Promise<number>} Number of successfully persisted messages
 */
export async function persistMessagesToDb(messages, roomId = null) {
  if (!Array.isArray(messages) || messages.length === 0) return 0;
  const db = window?.ollacoreDesktop?.db;
  if (!db?.saveMessage) return 0;

  let count = 0;
  for (const msg of messages) {
    const payload = messageToSqlitePayload(msg, roomId);
    if (payload) {
      try {
        await db.saveMessage(payload);
        count++;
      } catch (err) {
        console.warn('[DbSync] Error persisting message in batch:', err);
      }
    }
  }
  return count;
}

/**
 * Persists message delivery/read status to SQLite in the background.
 * @param {string} id
 * @param {string} status
 * @param {string|null} [recipientId=null]
 * @param {number|null} [eventSeq=null]
 * @param {string|null} [roomId=null]
 * @returns {Promise<boolean>}
 */
export async function persistMessageStatusToDb(id, status, recipientId = null, eventSeq = null, roomId = null) {
  if (!id || !status) return false;
  const db = window?.ollacoreDesktop?.db;
  if (!db?.updateMessageStatus) return false;
  try {
    const res = await db.updateMessageStatus({ id, status, recipientId, eventSeq, roomId });
    if (res?.ok === true) {
      return true;
    }
    console.warn(`[DbSync] SQLite message status update returned unsuccessful for message "${id}" (${status})`);
    return false;
  } catch (err) {
    console.warn(`[DbSync] Failed to persist message status in SQLite for message "${id}" to "${status}":`, err?.message || err);
    return false;
  }
}

/**
 * Persists an edited message to SQLite in the background.
 * @param {string} id
 * @param {any} newBody
 * @param {string|null} [editedAt=null]
 * @returns {Promise<boolean>}
 */
export async function persistMessageEditToDb(id, newBody, editedAt = null) {
  if (!id || !newBody) return false;
  const db = window?.ollacoreDesktop?.db;
  if (!db?.updateMessageEdit) return false;
  try {
    await db.updateMessageEdit({
      id,
      newBody: typeof newBody === 'object' ? newBody : { text: String(newBody) },
      editedAt: editedAt || new Date().toISOString()
    });
    return true;
  } catch (err) {
    console.warn('[DbSync] Failed to update message edit in SQLite:', err);
    return false;
  }
}

/**
 * Marks a message as deleted for everyone (tombstone) in SQLite in the background.
 * @param {string} id
 * @returns {Promise<boolean>}
 */
export async function persistMessageDeletedToDb(id) {
  if (!id) return false;
  const db = window?.ollacoreDesktop?.db;
  if (!db?.markMessageDeleted) return false;
  try {
    await db.markMessageDeleted({ id });
    return true;
  } catch (err) {
    console.warn('[DbSync] Failed to mark message deleted in SQLite:', err);
    return false;
  }
}

/**
 * Marks a message as deleted for me in SQLite in the background.
 * @param {string} id
 * @returns {Promise<boolean>}
 */
export async function persistMessageDeletedForMeToDb(id) {
  if (!id) return false;
  const db = window?.ollacoreDesktop?.db;
  if (!db?.markMessageDeletedForMe) return false;
  try {
    await db.markMessageDeletedForMe({ id });
    return true;
  } catch (err) {
    console.warn('[DbSync] Failed to mark message deleted for me in SQLite:', err);
    return false;
  }
}

/**
 * Persists custom filter lists to SQLite.
 * @param {Array<object>} lists
 * @returns {Promise<boolean>}
 */
export async function persistCustomListsToDb(lists) {
  const db = window?.ollacoreDesktop?.db;
  if (!db?.saveCustomLists) return false;
  try {
    await db.saveCustomLists(lists);
    return true;
  } catch (err) {
    console.warn('[DbSync] Failed to persist custom lists to SQLite:', err);
    return false;
  }
}

/**
 * Persists an item to the SQLite pending outbox table.
 * @param {object} item
 * @returns {Promise<boolean>}
 */
export async function persistOutboxItemToDb(item) {
  const db = window?.ollacoreDesktop?.db;
  if (!db?.savePendingOutbox) return false;
  try {
    await db.savePendingOutbox(item);
    return true;
  } catch (err) {
    console.warn('[DbSync] Failed to persist outbox item to SQLite:', err);
    return false;
  }
}

/**
 * Removes a delivered item from the SQLite pending outbox table.
 * @param {string} clientMessageId
 * @returns {Promise<boolean>}
 */
export async function clearOutboxItemFromDb(clientMessageId) {
  if (!clientMessageId) return false;
  const db = window?.ollacoreDesktop?.db;
  if (!db?.clearPendingOutboxItem) return false;
  try {
    await db.clearPendingOutboxItem({ clientMessageId });
    return true;
  } catch (err) {
    console.warn('[DbSync] Failed to clear outbox item from SQLite:', err);
    return false;
  }
}

/**
 * Persists an individual reaction update to SQLite.
 * @param {string} roomId
 * @param {string} messageId
 * @param {string} userId
 * @param {string} emoji
 * @param {boolean} isAdd
 * @returns {Promise<object|null>}
 */
export async function persistReactionToDb(roomId, messageId, userId, emoji, isAdd = true) {
  const db = window?.ollacoreDesktop?.db;
  if (!db?.updateMessageReaction) return null;
  try {
    return await db.updateMessageReaction({
      roomId: String(roomId),
      messageId: String(messageId),
      userId: String(userId),
      emoji: String(emoji),
      isAdd: Boolean(isAdd)
    });
  } catch (err) {
    console.warn('[DbSync] Failed to persist reaction to SQLite:', err);
    return null;
  }
}

export {
  collectLocalStorageMigrationData,
  runLocalStorageMigration,
  hydrateMigratedStateFromDb
} from './localstorage-migrator.js';

export {
  OutboxManager,
  outboxManager
} from './outbox-manager.js';


