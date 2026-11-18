import { DatabaseManager } from './database-manager.js';

// Allowed characters for IDs
const SAFE_ID_REGEX = /^[a-zA-Z0-9_\-.:@+]+$/;

// Allowed message status values
const ALLOWED_STATUSES = new Set(['pending', 'sending', 'sent', 'delivered', 'read', 'failed']);

// Allowed call directions, types, and statuses
const ALLOWED_DIRECTIONS = new Set(['incoming', 'outgoing']);
const ALLOWED_CALL_TYPES = new Set(['voice', 'video']);
const ALLOWED_CALL_STATUSES = new Set(['answered', 'missed', 'declined', 'cancelled']);

// Allowed upload session statuses
export const ALLOWED_UPLOAD_STATUSES = new Set(['pending', 'uploading', 'paused', 'completed', 'failed', 'cancelled']);

/**
 * Validates a safe string identifier.
 * @param {string} val
 * @param {string} fieldName
 * @param {number} [maxLen=128]
 * @returns {string}
 */
export function validateIdentifier(val, fieldName, maxLen = 128) {
  if (typeof val !== 'string' || !val.trim()) {
    throw new Error(`Invalid ${fieldName}: must be a non-empty string.`);
  }
  const trimmed = val.trim();
  if (trimmed.length > maxLen) {
    throw new Error(`Invalid ${fieldName}: exceeds maximum length of ${maxLen}.`);
  }
  if (!SAFE_ID_REGEX.test(trimmed)) {
    throw new Error(`Invalid ${fieldName}: contains illegal characters.`);
  }
  return trimmed;
}

/**
 * Normalizes phone number into canonical format (+ prefix if original had +, followed by digits).
 * Strips whitespace, dashes, parentheses, dots.
 * @param {string} phone
 * @returns {string}
 */
export function normalizePhone(phone) {
  if (!phone || typeof phone !== 'string') return '';
  const trimmed = phone.trim();
  if (!trimmed) return '';
  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length < 4 || digits.length > 25) return '';
  return hasPlus ? `+${digits}` : digits;
}

/**
 * Validates and clamps a pagination limit.
 * @param {any} limit
 * @param {number} [defaultVal=50]
 * @param {number} [maxVal=100]
 * @returns {number}
 */
export function validateLimit(limit, defaultVal = 50, maxVal = 100) {
  if (limit === undefined || limit === null) return defaultVal;
  const num = parseInt(limit, 10);
  if (Number.isNaN(num) || num < 1) return defaultVal;
  return Math.min(num, maxVal);
}

/**
 * Validates and parses an offset.
 * @param {any} offset
 * @returns {number}
 */
export function validateOffset(offset) {
  if (offset === undefined || offset === null) return 0;
  const num = parseInt(offset, 10);
  if (Number.isNaN(num) || num < 0) return 0;
  return num;
}

/**
 * Serializes payload to JSON string safely.
 * @param {any} payload
 * @returns {string}
 */
export function serializeJson(payload) {
  if (payload === null || payload === undefined) return '{}';
  if (typeof payload === 'string') {
    try {
      JSON.parse(payload);
      return payload;
    } catch {
      return JSON.stringify({ text: payload });
    }
  }
  try {
    return JSON.stringify(payload);
  } catch (err) {
    throw new Error(`Failed to serialize JSON payload: ${err.message}`);
  }
}

/**
 * DatabaseService wraps DatabaseManager and enforces strict input validation,
 * session authentication, and typed domain operations for IPC handlers.
 */
export class DatabaseService {
  /**
   * @param {object} params
   * @param {string} [params.storageDir] Storage directory for SQLite
   * @param {DatabaseManager} [params.databaseManager] Custom or existing DatabaseManager instance
   * @param {import('../session-store.js').SessionStore} params.sessionStore Active session store
   */
  constructor({ storageDir, databaseManager, sessionStore }) {
    if (!sessionStore) {
      throw new Error('DatabaseService requires a valid sessionStore');
    }
    this.sessionStore = sessionStore;
    if (databaseManager) {
      this.databaseManager = databaseManager;
    } else if (storageDir) {
      this.databaseManager = new DatabaseManager(storageDir);
    } else {
      throw new Error('DatabaseService requires either storageDir or databaseManager');
    }
  }

  /**
   * Resolves the active authenticated user ID from SessionStore and ensures
   * the corresponding SQLite database is open. Rejects if not authenticated.
   * @returns {Promise<string>}
   */
  async _getAuthorizedUser() {
    const session = this.sessionStore.getSession ? this.sessionStore.getSession() : this.sessionStore.currentSession;
    const userId = session?.userId;
    if (!userId || typeof userId !== 'string' || !userId.trim()) {
      const err = new Error('Unauthorized: No active authenticated session.');
      err.code = 'UNAUTHORIZED';
      throw err;
    }
    const cleanUserId = userId.trim();
    if (!this.databaseManager.isOpen || this.databaseManager.getCurrentUserId() !== cleanUserId) {
      await this.databaseManager.openUserDatabase(cleanUserId);
    }
    await this._ensureStagedReceiptsTable();
    return cleanUserId;
  }

  /**
   * Lazily ensures the staged_receipts table exists to stage receipts arriving before their parent message row.
   * Preserves foreign key integrity without requiring a database schema version bump.
   * @private
   */
  async _ensureStagedReceiptsTable() {
    await this.databaseManager.exec(`
      CREATE TABLE IF NOT EXISTS staged_receipts (
        message_id TEXT NOT NULL,
        recipient_id TEXT NOT NULL,
        status TEXT NOT NULL,
        receipt_timestamp TEXT NOT NULL,
        delivered_at TEXT,
        read_at TEXT,
        PRIMARY KEY (message_id, recipient_id)
      );
      CREATE INDEX IF NOT EXISTS idx_staged_receipts_msg ON staged_receipts(message_id);
    `);
    const stagedCols = await this.databaseManager.all("PRAGMA table_info('staged_receipts');").catch(() => []);
    if (Array.isArray(stagedCols) && stagedCols.length > 0) {
      if (!stagedCols.some((c) => c.name === 'delivered_at')) {
        await this.databaseManager.exec('ALTER TABLE staged_receipts ADD COLUMN delivered_at TEXT;').catch(() => {});
      }
      if (!stagedCols.some((c) => c.name === 'read_at')) {
        await this.databaseManager.exec('ALTER TABLE staged_receipts ADD COLUMN read_at TEXT;').catch(() => {});
      }
    }

    // Ensure reactions tables and column exist
    await this.databaseManager.exec(`
      CREATE TABLE IF NOT EXISTS message_reactions (
        message_id TEXT NOT NULL,
        room_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        emoji TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (message_id, user_id, emoji),
        FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_reactions_message ON message_reactions(message_id);
      CREATE INDEX IF NOT EXISTS idx_reactions_room ON message_reactions(room_id);

      CREATE TABLE IF NOT EXISTS staged_reactions (
        message_id TEXT NOT NULL,
        room_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        emoji TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (message_id, user_id, emoji)
      );
      CREATE INDEX IF NOT EXISTS idx_staged_reactions_msg ON staged_reactions(message_id);
    `);

    const msgCols = await this.databaseManager.all("PRAGMA table_info('messages');").catch(() => []);
    if (Array.isArray(msgCols) && msgCols.length > 0 && !msgCols.some((c) => c.name === 'reactions')) {
      await this.databaseManager.exec('ALTER TABLE messages ADD COLUMN reactions TEXT;').catch(() => {});
    }
  }

  /**
   * Retrieves conversation summaries for the active authenticated user.
   * @param {object} [options]
   * @param {number} [options.limit]
   * @param {number} [options.offset]
   * @returns {Promise<Array<object>>}
   */
  async getConversations(options = {}) {
    await this._getAuthorizedUser();
    const limit = validateLimit(options.limit, 50, 200);
    const offset = validateOffset(options.offset);

    const rows = await this.databaseManager.all(
      `SELECT * FROM conversations
       ORDER BY is_pinned DESC, pinned_order ASC, updated_at DESC
       LIMIT ? OFFSET ?;`,
      [limit, offset]
    );
    return rows;
  }

  /**
   * Upserts a conversation record.
   * Preserves local flags (pinned, favourite, unread, etc.) if omitted in partial updates.
   * @param {object} conv
   * @returns {Promise<{ ok: boolean, roomId: string }>}
   */
  async saveConversation(conv) {
    await this._getAuthorizedUser();
    if (!conv || typeof conv !== 'object') {
      throw new Error('Invalid conversation payload: must be an object.');
    }
    const roomId = validateIdentifier(conv.roomId || conv.room_id, 'roomId');

    const existing = await this.databaseManager.get(
      'SELECT * FROM conversations WHERE room_id = ?;',
      [roomId]
    );

    const kind = conv.kind === 'group' ? 'group' : (existing?.kind || 'direct');
    const roomName = (typeof conv.roomName === 'string' ? conv.roomName : (conv.room_name || conv.title)) ?? existing?.room_name ?? null;
    const peerUserId = (typeof conv.peerUserId === 'string' ? conv.peerUserId : (conv.peer_user_id || conv.peer?.userId || conv.peer?.user_id)) ?? existing?.peer_user_id ?? null;
    const peerPhone = (typeof conv.peerPhone === 'string' ? conv.peerPhone : (conv.peer_phone || conv.peer?.phone)) ?? existing?.peer_phone ?? null;
    const peerDisplayName = (typeof conv.peerDisplayName === 'string' ? conv.peerDisplayName : (conv.peer_display_name || conv.peer?.displayName || conv.peer?.display_name)) ?? existing?.peer_display_name ?? null;
    const lastMessageId = (typeof conv.lastMessageId === 'string' ? conv.lastMessageId : (conv.last_message_id || conv.lastMessage?.id)) ?? existing?.last_message_id ?? null;
    const lastMessagePreview = (typeof conv.lastMessagePreview === 'string' ? conv.lastMessagePreview : (conv.last_message_preview || conv.lastMessage?.preview || conv.preview)) ?? existing?.last_message_preview ?? null;
    const lastMessageTime = (typeof conv.lastMessageTime === 'string' ? conv.lastMessageTime : (conv.last_message_time || conv.lastMessage?.createdAt || conv.lastMessage?.created_at)) ?? existing?.last_message_time ?? null;
    const lastEventSeq = Math.max(
      Number.isInteger(conv.lastEventSeq ?? conv.last_event_seq ?? conv.lastMessage?.eventSeq ?? conv.lastMessage?.event_seq)
        ? (conv.lastEventSeq ?? conv.last_event_seq ?? conv.lastMessage?.eventSeq ?? conv.lastMessage?.event_seq)
        : 0,
      existing?.last_event_seq ?? 0
    );
    const unreadCount = Number.isInteger(conv.unreadCount ?? conv.unread_count)
      ? Math.max(0, conv.unreadCount ?? conv.unread_count)
      : (existing?.unread_count ?? 0);
    const isArchived = (conv.isArchived !== undefined || conv.is_archived !== undefined)
      ? (conv.isArchived || conv.is_archived ? 1 : 0)
      : (existing?.is_archived ?? 0);
    const isPinned = (conv.isPinned !== undefined || conv.is_pinned !== undefined)
      ? (conv.isPinned || conv.is_pinned ? 1 : 0)
      : (existing?.is_pinned ?? 0);
    const pinnedOrder = Number.isInteger(conv.pinnedOrder ?? conv.pinned_order)
      ? (conv.pinnedOrder ?? conv.pinned_order)
      : (existing?.pinned_order ?? 0);
    const isFavourite = (conv.isFavourite !== undefined || conv.is_favourite !== undefined)
      ? (conv.isFavourite || conv.is_favourite ? 1 : 0)
      : (existing?.is_favourite ?? 0);
    const isMarkedUnread = (conv.isMarkedUnread !== undefined || conv.is_marked_unread !== undefined)
      ? (conv.isMarkedUnread || conv.is_marked_unread ? 1 : 0)
      : (existing?.is_marked_unread ?? 0);
    const isExited = (conv.isExited !== undefined || conv.is_exited !== undefined || conv.exited !== undefined)
      ? (conv.isExited || conv.is_exited || conv.exited ? 1 : 0)
      : (existing?.is_exited ?? 0);
    const draftText = typeof (conv.draftText ?? conv.draft_text) === 'string'
      ? (conv.draftText ?? conv.draft_text)
      : (existing?.draft_text ?? null);
    const mutedUntil = (conv.mutedUntil !== undefined || conv.muted_until !== undefined)
      ? (conv.mutedUntil || conv.muted_until || null)
      : (existing?.muted_until ?? null);
    const now = new Date().toISOString();
    const createdAt = conv.createdAt || conv.created_at || existing?.created_at || now;
    const updatedAt = conv.updatedAt || conv.updated_at || now;

    await this.databaseManager.run(
      `INSERT INTO conversations (
        room_id, kind, room_name, peer_user_id, peer_phone, peer_display_name,
        last_message_id, last_message_preview, last_message_time, last_event_seq,
        unread_count, is_archived, is_pinned, pinned_order, is_favourite,
        is_marked_unread, is_exited, draft_text, muted_until, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(room_id) DO UPDATE SET
        kind = excluded.kind,
        room_name = coalesce(excluded.room_name, conversations.room_name),
        peer_user_id = coalesce(excluded.peer_user_id, conversations.peer_user_id),
        peer_phone = coalesce(excluded.peer_phone, conversations.peer_phone),
        peer_display_name = coalesce(excluded.peer_display_name, conversations.peer_display_name),
        last_message_id = coalesce(excluded.last_message_id, conversations.last_message_id),
        last_message_preview = coalesce(excluded.last_message_preview, conversations.last_message_preview),
        last_message_time = coalesce(excluded.last_message_time, conversations.last_message_time),
        last_event_seq = max(excluded.last_event_seq, conversations.last_event_seq),
        unread_count = excluded.unread_count,
        is_archived = excluded.is_archived,
        is_pinned = excluded.is_pinned,
        pinned_order = excluded.pinned_order,
        is_favourite = excluded.is_favourite,
        is_marked_unread = excluded.is_marked_unread,
        is_exited = coalesce(excluded.is_exited, conversations.is_exited),
        draft_text = excluded.draft_text,
        muted_until = excluded.muted_until,
        updated_at = excluded.updated_at;`,
      [
        roomId, kind, roomName, peerUserId, peerPhone, peerDisplayName,
        lastMessageId, lastMessagePreview, lastMessageTime, lastEventSeq,
        unreadCount, isArchived, isPinned, pinnedOrder, isFavourite,
        isMarkedUnread, isExited, draftText, mutedUntil, createdAt, updatedAt
      ]
    );

    return { ok: true, roomId };
  }

  /**
   * Deletes a conversation record and its associated data locally from SQLite.
   * @param {string} roomId
   * @returns {Promise<{ ok: boolean, roomId: string }>}
   */
  async deleteConversation(roomId) {
    await this._getAuthorizedUser();
    const validatedRoomId = validateIdentifier(roomId, 'roomId');
    await this.databaseManager.run('DELETE FROM conversations WHERE room_id = ?;', [validatedRoomId]);
    return { ok: true, roomId: validatedRoomId };
  }

  /**
   * Retrieves messages for a specific room with pagination.
   * @param {object} options
   * @param {string} options.roomId
   * @param {number} [options.limit=50]
   * @param {string} [options.beforeTime]
   * @param {number} [options.beforeSeq]
   * @returns {Promise<Array<object>>}
   */
  async getMessages(options = {}) {
    await this._getAuthorizedUser();
    const roomId = validateIdentifier(options.roomId || options.room_id, 'roomId');
    const limit = validateLimit(options.limit, 50, 100);

    let sql = `
      SELECT m.*,
        CASE
          WHEN m.status = 'read' THEN 'read'
          WHEN EXISTS (SELECT 1 FROM message_receipts mr WHERE (mr.message_id = m.id OR (m.client_message_id IS NOT NULL AND mr.message_id = m.client_message_id)) AND mr.status = 'read') THEN 'read'
          WHEN EXISTS (SELECT 1 FROM staged_receipts sr WHERE (sr.message_id = m.id OR (m.client_message_id IS NOT NULL AND sr.message_id = m.client_message_id)) AND sr.status = 'read') THEN 'read'
          WHEN EXISTS (
            SELECT 1 FROM app_metadata am
            WHERE am.key = ('peer_read_seq:' || m.room_id)
              AND m.event_seq > 0
              AND CAST(am.value AS INTEGER) >= m.event_seq
          ) THEN 'read'
          WHEN m.status = 'delivered' THEN 'delivered'
          WHEN EXISTS (SELECT 1 FROM message_receipts mr WHERE (mr.message_id = m.id OR (m.client_message_id IS NOT NULL AND mr.message_id = m.client_message_id)) AND mr.status = 'delivered') THEN 'delivered'
          WHEN EXISTS (SELECT 1 FROM staged_receipts sr WHERE (sr.message_id = m.id OR (m.client_message_id IS NOT NULL AND sr.message_id = m.client_message_id)) AND sr.status = 'delivered') THEN 'delivered'
          ELSE m.status
        END AS status
      FROM messages m
      WHERE m.room_id = ?
    `;
    const params = [roomId];

    if (options.excludeDeletedForMe) {
      sql += ' AND m.is_deleted_for_me = 0';
    }
    const beforeTime = options.beforeTime ?? options.before_time;
    if (beforeTime) {
      sql += ' AND m.created_at < ?';
      params.push(String(beforeTime));
    }
    const beforeSeq = options.beforeSeq ?? options.before_seq;
    if (Number.isInteger(beforeSeq) && beforeSeq > 0) {
      sql += ' AND m.event_seq < ?';
      params.push(beforeSeq);
    }

    sql += ' ORDER BY m.created_at DESC, m.event_seq DESC LIMIT ?;';
    params.push(limit);

    const rows = await this.databaseManager.all(sql, params);
    for (const r of rows) {
      if (r) {
        r.deliveryStatus = r.status;
        r.delivery_status = r.status;
        if (r.reactions && typeof r.reactions === 'string') {
          try {
            r.reactions = JSON.parse(r.reactions);
          } catch {
            r.reactions = null;
          }
        }
      }
    }
    // Return in chronological order
    return rows.reverse();
  }

  /**
   * Retrieves a single message by ID or clientMessageId with optional room filter.
   * @param {object|string} params
   * @returns {Promise<object|null>}
   */
  async getMessageById(params = {}) {
    await this._getAuthorizedUser();
    const rawId = typeof params === 'string' ? params : (params?.id || params?.messageId || params?.message_id || params?.clientMessageId || params?.client_message_id);
    const id = validateIdentifier(String(rawId), 'messageId');
    const roomId = (typeof params === 'object' && (params?.roomId || params?.room_id))
      ? validateIdentifier(String(params.roomId || params.room_id), 'roomId')
      : null;

    let sql = `
      SELECT m.*,
        CASE
          WHEN m.status = 'read' THEN 'read'
          WHEN EXISTS (SELECT 1 FROM message_receipts mr WHERE (mr.message_id = m.id OR (m.client_message_id IS NOT NULL AND mr.message_id = m.client_message_id)) AND mr.status = 'read') THEN 'read'
          WHEN EXISTS (SELECT 1 FROM staged_receipts sr WHERE (sr.message_id = m.id OR (m.client_message_id IS NOT NULL AND sr.message_id = m.client_message_id)) AND sr.status = 'read') THEN 'read'
          WHEN EXISTS (
            SELECT 1 FROM app_metadata am
            WHERE am.key = ('peer_read_seq:' || m.room_id)
              AND m.event_seq > 0
              AND CAST(am.value AS INTEGER) >= m.event_seq
          ) THEN 'read'
          WHEN m.status = 'delivered' THEN 'delivered'
          WHEN EXISTS (SELECT 1 FROM message_receipts mr WHERE (mr.message_id = m.id OR (m.client_message_id IS NOT NULL AND mr.message_id = m.client_message_id)) AND mr.status = 'delivered') THEN 'delivered'
          WHEN EXISTS (SELECT 1 FROM staged_receipts sr WHERE (sr.message_id = m.id OR (m.client_message_id IS NOT NULL AND sr.message_id = m.client_message_id)) AND sr.status = 'delivered') THEN 'delivered'
          ELSE m.status
        END AS status
      FROM messages m
      WHERE (m.id = ? OR m.client_message_id = ?)
    `;
    const queryParams = [id, id];
    if (roomId) {
      sql += ' AND m.room_id = ?';
      queryParams.push(roomId);
    }
    sql += ' LIMIT 1;';
    const row = await this.databaseManager.get(sql, queryParams);
    if (row) {
      row.deliveryStatus = row.status;
      row.delivery_status = row.status;
      if (row.reactions && typeof row.reactions === 'string') {
        try {
          row.reactions = JSON.parse(row.reactions);
        } catch {
          row.reactions = null;
        }
      }
    }
    return row || null;
  }

  /**
   * Saves or updates a message in the local SQLite database.
   * Handles optimistic message reconciliation seamlessly.
   * @param {object} msg
   * @returns {Promise<{ ok: boolean, id: string }>}
   */
  async saveMessage(msg) {
    const cleanUserId = await this._getAuthorizedUser();
    if (!msg || typeof msg !== 'object') {
      throw new Error('Invalid message payload: must be an object.');
    }
    const id = validateIdentifier(String(msg.id || msg.messageId || msg.message_id || msg.clientMessageId || msg.client_message_id), 'id');
    const roomId = validateIdentifier(String(msg.roomId || msg.room_id), 'roomId');
    const senderId = validateIdentifier(String(msg.senderId || msg.sender_id || 'unknown'), 'senderId');
    const clientMessageId = (msg.clientMessageId || msg.client_message_id)
      ? validateIdentifier(String(msg.clientMessageId || msg.client_message_id), 'clientMessageId')
      : null;
    const kind = typeof msg.kind === 'string' ? msg.kind : 'text';
    let bodyData = msg.bodyJson || msg.body_json || msg.body || {};
    if (typeof bodyData === 'string') {
      try {
        bodyData = JSON.parse(bodyData);
      } catch {
        bodyData = { text: bodyData };
      }
    } else if (typeof bodyData === 'object' && bodyData !== null) {
      bodyData = { ...bodyData };
    } else {
      bodyData = {};
    }

    const rawAids = Array.isArray(msg.attachment_ids)
      ? msg.attachment_ids
      : (Array.isArray(msg.attachmentIds) ? msg.attachmentIds : null);
    if (rawAids && (!bodyData.attachment_ids || bodyData.attachment_ids.length === 0)) {
      bodyData.attachment_ids = rawAids.map(x => (typeof x === 'object' && x !== null) ? (x?.id || x?.attachment_id || x?.attachmentId) : x).filter(Boolean);
      bodyData.attachmentIds = bodyData.attachment_ids;
      if (!bodyData.attachment_id && bodyData.attachment_ids.length > 0) {
        bodyData.attachment_id = bodyData.attachment_ids[0];
      }
    }
    if (Array.isArray(msg.attachments) && (!bodyData.attachments || bodyData.attachments.length === 0)) {
      bodyData.attachments = msg.attachments;
    }
    const bodyJson = serializeJson(bodyData);
    const replyToId = (msg.replyToId || msg.reply_to_id || msg.replyTo || msg.reply_to)
      ? validateIdentifier(String(msg.replyToId || msg.reply_to_id || msg.replyTo || msg.reply_to), 'replyToId')
      : null;
    const eventSeq = Number.isInteger(msg.eventSeq ?? msg.event_seq) ? (msg.eventSeq ?? msg.event_seq) : 0;
    const rawStatus = msg.status || msg.deliveryStatus || msg.delivery_status;
    let status = ALLOWED_STATUSES.has(rawStatus) ? rawStatus : 'sent';
    const isDeleted = msg.isDeleted || msg.is_deleted ? 1 : 0;
    const isStarred = msg.isStarred || msg.is_starred ? 1 : 0;
    const isDeletedForMe = msg.isDeletedForMe || msg.is_deleted_for_me ? 1 : 0;
    const editedAt = msg.editedAt || msg.edited_at || null;
    const now = new Date().toISOString();
    const createdAt = msg.createdAt || msg.created_at || now;
    const localReceivedAt = msg.localReceivedAt || msg.local_received_at || now;

    const STATUS_RANK = { sending: 0, failed: 0, sent: 1, delivered: 2, read: 3 };

    // Ensure conversation exists, message is saved, receipts are transferred, and staged receipts are reconciled atomically
    await this.databaseManager.transaction(async () => {
      // Ensure conversation exists so foreign key is satisfied
      await this.databaseManager.run(
        `INSERT INTO conversations (room_id, created_at, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(room_id) DO NOTHING;`,
        [roomId, createdAt, createdAt]
      );

      // Reconcile optimistic record: if temporary message exists by clientMessageId, preserve higher status and transfer receipts
      let receiptsToTransfer = [];
      let optimisticToDeleteId = null;

      if (clientMessageId && clientMessageId !== id) {
        const existingOptimistic = await this.databaseManager.get(
          'SELECT id, status FROM messages WHERE (client_message_id = ? OR id = ?) AND id != ? LIMIT 1;',
          [clientMessageId, clientMessageId, id]
        );
        if (existingOptimistic) {
          optimisticToDeleteId = existingOptimistic.id;
          const existingRank = STATUS_RANK[existingOptimistic.status] ?? 0;
          const incomingRank = STATUS_RANK[status] ?? 0;

          const existingReceipt = await this.databaseManager.get(
            'SELECT status FROM message_receipts WHERE message_id = ? ORDER BY CASE status WHEN "read" THEN 3 WHEN "delivered" THEN 2 ELSE 1 END DESC LIMIT 1;',
            [existingOptimistic.id]
          );
          const receiptRank = STATUS_RANK[existingReceipt?.status] ?? 0;
          const highestKnownRank = Math.max(existingRank, receiptRank, incomingRank);

          if (highestKnownRank > incomingRank) {
            if (highestKnownRank === 3) status = 'read';
            else if (highestKnownRank === 2) status = 'delivered';
            else if (highestKnownRank === 1) status = 'sent';
          }

          receiptsToTransfer = await this.databaseManager.all(
            'SELECT recipient_id, status, receipt_timestamp, delivered_at, read_at FROM message_receipts WHERE message_id = ?;',
            [existingOptimistic.id]
          );

          // Disassociate client_message_id from old optimistic row so canonical insert does not violate UNIQUE constraint
          await this.databaseManager.run(
            'UPDATE messages SET client_message_id = NULL WHERE id = ?;',
            [existingOptimistic.id]
          );
        }
      }

      // Reconcile any staged receipts that arrived early for this message ID or clientMessageId
      const stagedMatches = await this.databaseManager.all(
        'SELECT recipient_id, status, receipt_timestamp, delivered_at, read_at FROM staged_receipts WHERE message_id = ? OR (message_id = ? AND ? IS NOT NULL);',
        [id, clientMessageId, clientMessageId]
      );
      if (stagedMatches && stagedMatches.length > 0) {
        for (const sr of stagedMatches) {
          const sRank = STATUS_RANK[sr.status] ?? 0;
          const curRank = STATUS_RANK[status] ?? 0;
          if (sRank > curRank) {
            if (sRank === 3) status = 'read';
            else if (sRank === 2) status = 'delivered';
            else if (sRank === 1) status = 'sent';
          }
        }
      }

      // Also check if canonical message already exists in database with higher status or receipts
      const existingCanonical = await this.databaseManager.get(
        'SELECT id, status FROM messages WHERE id = ? LIMIT 1;',
        [id]
      );
      if (existingCanonical) {
        const canRank = STATUS_RANK[existingCanonical.status] ?? 0;
        const curRank = STATUS_RANK[status] ?? 0;
        if (canRank > curRank) {
          if (canRank === 3) status = 'read';
          else if (canRank === 2) status = 'delivered';
          else if (canRank === 1) status = 'sent';
        }
      }
      const existingCanonicalReceipt = await this.databaseManager.get(
        'SELECT status FROM message_receipts WHERE message_id = ? OR (message_id = ? AND ? IS NOT NULL) ORDER BY CASE status WHEN "read" THEN 3 WHEN "delivered" THEN 2 ELSE 1 END DESC LIMIT 1;',
        [id, clientMessageId, clientMessageId]
      );
      if (existingCanonicalReceipt) {
        const recRank = STATUS_RANK[existingCanonicalReceipt.status] ?? 0;
        const curRank = STATUS_RANK[status] ?? 0;
        if (recRank > curRank) {
          if (recRank === 3) status = 'read';
          else if (recRank === 2) status = 'delivered';
          else if (recRank === 1) status = 'sent';
        }
      }

      if (status !== 'read' && eventSeq > 0) {
        const peerCursorRow = await this.databaseManager.get(
          'SELECT value FROM app_metadata WHERE key = ?;',
          [`peer_read_seq:${roomId}`]
        );
        const peerSeq = peerCursorRow?.value ? parseInt(peerCursorRow.value, 10) : 0;
        if (peerSeq >= eventSeq) {
          status = 'read';
        }
      }

      if (status === 'read' && eventSeq > 0 && senderId === cleanUserId) {
        const nowIso = new Date().toISOString();
        await this.databaseManager.run(
          `INSERT INTO app_metadata (key, value, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET
             value = CASE
               WHEN CAST(excluded.value AS INTEGER) > CAST(app_metadata.value AS INTEGER) THEN excluded.value
               ELSE app_metadata.value
             END,
             updated_at = excluded.updated_at;`,
          [`peer_read_seq:${roomId}`, String(eventSeq), nowIso]
        );
      }

      // Look up conversation peer_user_id for correct recipient fallback
      let fallbackRecipientId = null;
      const convRow = await this.databaseManager.get(
        'SELECT peer_user_id FROM conversations WHERE room_id = ? LIMIT 1;',
        [roomId]
      );
      if (convRow?.peer_user_id) {
        fallbackRecipientId = convRow.peer_user_id;
      }

      const initialReactions = (msg.reactions && typeof msg.reactions === 'object') ? JSON.stringify(msg.reactions) : null;
      await this.databaseManager.run(
        `INSERT INTO messages (
          id, room_id, sender_id, client_message_id, kind, body_json,
          reply_to_id, event_seq, status, is_deleted, is_starred,
          is_deleted_for_me, edited_at, created_at, local_received_at, reactions
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          client_message_id = coalesce(excluded.client_message_id, messages.client_message_id),
          reply_to_id = coalesce(excluded.reply_to_id, messages.reply_to_id),
          kind = CASE
            WHEN max(excluded.is_deleted, messages.is_deleted) = 1 THEN 'deleted'
            ELSE coalesce(excluded.kind, messages.kind)
          END,
          sender_id = coalesce(excluded.sender_id, messages.sender_id),
          event_seq = max(excluded.event_seq, messages.event_seq),
          status = CASE
            WHEN excluded.status = 'read' THEN 'read'
            WHEN messages.status = 'read' THEN 'read'
            WHEN EXISTS (SELECT 1 FROM message_receipts mr WHERE (mr.message_id = messages.id OR (messages.client_message_id IS NOT NULL AND mr.message_id = messages.client_message_id)) AND mr.status = 'read') THEN 'read'
            WHEN EXISTS (SELECT 1 FROM staged_receipts sr WHERE (sr.message_id = messages.id OR (messages.client_message_id IS NOT NULL AND sr.message_id = messages.client_message_id)) AND sr.status = 'read') THEN 'read'
            WHEN EXISTS (
              SELECT 1 FROM app_metadata am
              WHERE am.key = ('peer_read_seq:' || messages.room_id)
                AND messages.event_seq > 0
                AND CAST(am.value AS INTEGER) >= messages.event_seq
            ) THEN 'read'
            WHEN messages.status = 'delivered' AND excluded.status != 'read' THEN 'delivered'
            WHEN EXISTS (SELECT 1 FROM message_receipts mr WHERE (mr.message_id = messages.id OR (messages.client_message_id IS NOT NULL AND mr.message_id = messages.client_message_id)) AND mr.status = 'delivered') AND excluded.status != 'read' THEN 'delivered'
            WHEN EXISTS (SELECT 1 FROM staged_receipts sr WHERE (sr.message_id = messages.id OR (messages.client_message_id IS NOT NULL AND sr.message_id = messages.client_message_id)) AND sr.status = 'delivered') AND excluded.status != 'read' THEN 'delivered'
            WHEN messages.status IN ('sent', 'delivered', 'read') AND excluded.status IN ('failed', 'sending') THEN messages.status
            ELSE coalesce(excluded.status, messages.status, 'sent')
          END,
          body_json = CASE
            WHEN max(excluded.is_deleted, messages.is_deleted) = 1 THEN '{"text":"This message was deleted"}'
            WHEN messages.is_deleted = 0 AND messages.edited_at IS NOT NULL AND (excluded.edited_at IS NULL OR excluded.edited_at < messages.edited_at) THEN messages.body_json
            ELSE excluded.body_json
          END,
          is_deleted = max(excluded.is_deleted, messages.is_deleted),
          is_starred = CASE
            WHEN max(excluded.is_deleted, messages.is_deleted) = 1 THEN 0
            ELSE max(excluded.is_starred, messages.is_starred)
          END,
          is_deleted_for_me = max(excluded.is_deleted_for_me, messages.is_deleted_for_me),
          edited_at = CASE
            WHEN max(excluded.is_deleted, messages.is_deleted) = 1 THEN coalesce(messages.edited_at, excluded.edited_at)
            WHEN messages.edited_at IS NOT NULL AND (excluded.edited_at IS NULL OR excluded.edited_at < messages.edited_at) THEN messages.edited_at
            ELSE coalesce(excluded.edited_at, messages.edited_at)
          END,
          reactions = coalesce(excluded.reactions, messages.reactions);`,
        [
          id, roomId, senderId, clientMessageId, kind, bodyJson,
          replyToId, eventSeq, status, isDeleted, isStarred,
          isDeletedForMe, editedAt, createdAt, localReceivedAt, initialReactions
        ]
      );

      // Persist individual reactions from msg.reactions if present
      if (msg.reactions && typeof msg.reactions === 'object') {
        for (const [emojiStr, userList] of Object.entries(msg.reactions)) {
          if (Array.isArray(userList)) {
            for (const uId of userList) {
              if (uId) {
                await this.databaseManager.run(
                  `INSERT INTO message_reactions (message_id, room_id, user_id, emoji, created_at)
                   VALUES (?, ?, ?, ?, ?)
                   ON CONFLICT(message_id, user_id, emoji) DO NOTHING;`,
                  [id, roomId, String(uId), emojiStr, now]
                );
              }
            }
          }
        }
      }

      // Reconcile any staged reactions for this message
      const stagedReacts = await this.databaseManager.all(
        'SELECT user_id, emoji, created_at FROM staged_reactions WHERE message_id = ? OR (message_id = ? AND ? IS NOT NULL);',
        [id, clientMessageId, clientMessageId]
      );
      if (stagedReacts && stagedReacts.length > 0) {
        for (const sr of stagedReacts) {
          await this.databaseManager.run(
            `INSERT INTO message_reactions (message_id, room_id, user_id, emoji, created_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(message_id, user_id, emoji) DO NOTHING;`,
            [id, roomId, sr.user_id, sr.emoji, sr.created_at || now]
          );
        }
        await this.databaseManager.run(
          'DELETE FROM staged_reactions WHERE message_id = ? OR (message_id = ? AND ? IS NOT NULL);',
          [id, clientMessageId, clientMessageId]
        );
      }

      if (receiptsToTransfer.length > 0) {
        for (const r of receiptsToTransfer) {
          const recId = (r.recipient_id && r.recipient_id !== 'peer') ? r.recipient_id : (fallbackRecipientId || r.recipient_id || 'peer');
          await this.databaseManager.run(
            `INSERT INTO message_receipts (message_id, recipient_id, status, receipt_timestamp, delivered_at, read_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(message_id, recipient_id) DO UPDATE SET
               status = CASE
                 WHEN message_receipts.status = 'read' THEN 'read'
                 WHEN message_receipts.status = 'delivered' AND excluded.status != 'read' THEN 'delivered'
                 WHEN message_receipts.status IN ('sent', 'delivered', 'read') AND excluded.status IN ('failed', 'sending') THEN message_receipts.status
                 ELSE excluded.status
               END,
               receipt_timestamp = excluded.receipt_timestamp,
               delivered_at = COALESCE(excluded.delivered_at, message_receipts.delivered_at),
               read_at = COALESCE(excluded.read_at, message_receipts.read_at);`,
            [id, recId, r.status, r.receipt_timestamp, r.delivered_at || (r.status === 'delivered' ? r.receipt_timestamp : null), r.read_at || (r.status === 'read' ? r.receipt_timestamp : null)]
          );
        }
      }

      // Transfer staged receipts into message_receipts now that parent message exists
      if (stagedMatches && stagedMatches.length > 0) {
        for (const sr of stagedMatches) {
          const recId = (sr.recipient_id && sr.recipient_id !== 'peer') ? sr.recipient_id : (fallbackRecipientId || sr.recipient_id || 'peer');
          await this.databaseManager.run(
            `INSERT INTO message_receipts (message_id, recipient_id, status, receipt_timestamp, delivered_at, read_at)
             VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(message_id, recipient_id) DO UPDATE SET
               status = CASE
                 WHEN message_receipts.status = 'read' THEN 'read'
                 WHEN message_receipts.status = 'delivered' AND excluded.status != 'read' THEN 'delivered'
                 WHEN message_receipts.status IN ('sent', 'delivered', 'read') AND excluded.status IN ('failed', 'sending') THEN message_receipts.status
                 ELSE excluded.status
               END,
               receipt_timestamp = excluded.receipt_timestamp,
               delivered_at = COALESCE(excluded.delivered_at, message_receipts.delivered_at),
               read_at = COALESCE(excluded.read_at, message_receipts.read_at);`,
            [id, recId, sr.status, sr.receipt_timestamp, sr.delivered_at || (sr.status === 'delivered' ? sr.receipt_timestamp : null), sr.read_at || (sr.status === 'read' ? sr.receipt_timestamp : null)]
          );
        }
        await this.databaseManager.run(
          'DELETE FROM staged_receipts WHERE message_id = ? OR (message_id = ? AND ? IS NOT NULL);',
          [id, clientMessageId, clientMessageId]
        );
      }

      if (optimisticToDeleteId) {
        await this.databaseManager.run(
          'DELETE FROM messages WHERE id = ?;',
          [optimisticToDeleteId]
        );
      }
    });

    return { ok: true, id };
  }

  /**
   * Updates message delivery/read status.
   * Monotonically protects higher status (sent -> delivered -> read).
   * @param {object} params
   * @param {string} params.id
   * @param {string} params.status
   * @param {string} [params.recipientId]
   * @param {string} [params.timestamp]
   * @returns {Promise<{ ok: boolean, changes: number }>}
   */
  async updateMessageStatus(params = {}) {
    await this._getAuthorizedUser();
    const id = validateIdentifier(params.id, 'id');
    if (!ALLOWED_STATUSES.has(params.status)) {
      throw new Error(`Invalid message status "${params.status}".`);
    }

    return await this.databaseManager.transaction(async () => {
      const existing = await this.databaseManager.get(
        'SELECT id, room_id, client_message_id, event_seq, status FROM messages WHERE id = ? OR client_message_id = ? LIMIT 1;',
        [id, id]
      );
      const STATUS_RANK = { sending: 0, failed: 0, sent: 1, delivered: 2, read: 3 };
      const currentRank = STATUS_RANK[existing?.status] ?? 0;
      const newRank = STATUS_RANK[params.status] ?? 0;

      const targetId = existing?.id || id;
      const clientMsgId = existing?.client_message_id || (id !== targetId ? id : null);
      const existingReceipt = await this.databaseManager.get(
        'SELECT status FROM message_receipts WHERE message_id = ? OR (message_id = ? AND ? IS NOT NULL) ORDER BY CASE status WHEN "read" THEN 3 WHEN "delivered" THEN 2 ELSE 1 END DESC LIMIT 1;',
        [targetId, clientMsgId, clientMsgId]
      );
      const existingStagedReceipt = await this.databaseManager.get(
        'SELECT status FROM staged_receipts WHERE message_id = ? OR (message_id = ? AND ? IS NOT NULL) ORDER BY CASE status WHEN "read" THEN 3 WHEN "delivered" THEN 2 ELSE 1 END DESC LIMIT 1;',
        [targetId, clientMsgId, clientMsgId]
      );
      const receiptRank = Math.max(
        STATUS_RANK[existingReceipt?.status] ?? 0,
        STATUS_RANK[existingStagedReceipt?.status] ?? 0
      );
      const effectiveRank = Math.max(currentRank, receiptRank);

      let recipientId = params.recipientId;
      if (recipientId) {
        recipientId = validateIdentifier(recipientId, 'recipientId');
      } else if (existing?.room_id) {
        const conv = await this.databaseManager.get(
          'SELECT peer_user_id FROM conversations WHERE room_id = ? LIMIT 1;',
          [existing.room_id]
        );
        if (conv?.peer_user_id) {
          recipientId = conv.peer_user_id;
        }
      }
      if (!recipientId) {
        recipientId = 'peer';
      }

      // Check recipient-specific rank when recipientId is provided
      let effectiveMemberRank = 0;
      if (params.recipientId) {
        const memberReceipt = await this.databaseManager.get(
          'SELECT status FROM message_receipts WHERE (message_id = ? OR (message_id = ? AND ? IS NOT NULL)) AND recipient_id = ? LIMIT 1;',
          [targetId, clientMsgId, clientMsgId, recipientId]
        );
        const memberStaged = await this.databaseManager.get(
          'SELECT status FROM staged_receipts WHERE (message_id = ? OR (message_id = ? AND ? IS NOT NULL)) AND recipient_id = ? LIMIT 1;',
          [targetId, clientMsgId, clientMsgId, recipientId]
        );
        effectiveMemberRank = Math.max(
          STATUS_RANK[memberReceipt?.status] ?? 0,
          STATUS_RANK[memberStaged?.status] ?? 0
        );
      } else {
        effectiveMemberRank = effectiveRank;
      }

      // Monotonic progression: do not downgrade read/delivered to sent, sending, or failed
      if (effectiveMemberRank > 0 && newRank < effectiveMemberRank) {
        if (params.status === 'delivered') {
          const timestamp = params.timestamp || new Date().toISOString();
          const deliveredAt = params.deliveredAt || timestamp;
          if (existing) {
            await this.databaseManager.run(
              `UPDATE message_receipts
               SET delivered_at = COALESCE(delivered_at, ?)
               WHERE (message_id = ? OR (message_id = ? AND ? IS NOT NULL))
                 AND recipient_id = ?
                 AND delivered_at IS NULL;`,
              [deliveredAt, targetId, clientMsgId, clientMsgId, recipientId]
            );
          } else {
            await this.databaseManager.run(
              `UPDATE staged_receipts
               SET delivered_at = COALESCE(delivered_at, ?)
               WHERE (message_id = ? OR (message_id = ? AND ? IS NOT NULL))
                 AND recipient_id = ?
                 AND delivered_at IS NULL;`,
              [deliveredAt, targetId, clientMsgId, clientMsgId, recipientId]
            );
          }
        }
        return { ok: true, changes: 0 };
      }
      if (newRank <= 1 && effectiveRank > newRank) {
        return { ok: true, changes: 0 };
      }

      const targetRoomId = existing?.room_id || (params.roomId ? String(params.roomId) : null);
      const effectiveSeq = Number.isInteger(params.eventSeq) && params.eventSeq > 0
        ? params.eventSeq
        : (Number.isInteger(existing?.event_seq) && existing.event_seq > 0 ? existing.event_seq : 0);

      if (params.status === 'read' && targetRoomId && effectiveSeq > 0) {
        const nowIso = new Date().toISOString();
        await this.databaseManager.run(
          `INSERT INTO app_metadata (key, value, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET
             value = CASE
               WHEN CAST(excluded.value AS INTEGER) > CAST(app_metadata.value AS INTEGER) THEN excluded.value
               ELSE app_metadata.value
             END,
             updated_at = excluded.updated_at;`,
          [`peer_read_seq:${targetRoomId}`, String(effectiveSeq), nowIso]
        );

        // Update all prior messages in this room up to effectiveSeq to 'read'
        await this.databaseManager.run(
          `UPDATE messages
           SET status = 'read'
           WHERE room_id = ? AND event_seq > 0 AND event_seq <= ? AND status != 'read';`,
          [targetRoomId, effectiveSeq]
        );
      }

      const timestamp = params.timestamp || new Date().toISOString();
      const deliveredAt = params.status === 'delivered' ? timestamp : (params.deliveredAt || null);
      const readAt = params.status === 'read' ? timestamp : (params.readAt || null);

      if (!existing) {
        // Message row does not yet exist in SQLite (e.g. receipt arrived before canonical message ACK/persistence).
        // Durable, transaction-safe staging mechanism: stage receipt so foreign key constraints are not violated.
        await this.databaseManager.run(
          `INSERT INTO staged_receipts (message_id, recipient_id, status, receipt_timestamp, delivered_at, read_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(message_id, recipient_id) DO UPDATE SET
             status = CASE
               WHEN staged_receipts.status = 'read' THEN 'read'
               WHEN staged_receipts.status = 'delivered' AND excluded.status != 'read' THEN 'delivered'
               WHEN staged_receipts.status IN ('sent', 'delivered', 'read') AND excluded.status IN ('failed', 'sending') THEN staged_receipts.status
               ELSE excluded.status
             END,
             receipt_timestamp = excluded.receipt_timestamp,
             delivered_at = COALESCE(excluded.delivered_at, staged_receipts.delivered_at),
             read_at = COALESCE(excluded.read_at, staged_receipts.read_at);`,
          [targetId, recipientId, params.status, timestamp, deliveredAt, readAt]
        );
        return { ok: true, changes: 1, staged: true };
      }

      const res = await this.databaseManager.run(
        `UPDATE messages SET status = CASE
           WHEN status = 'read' THEN 'read'
           WHEN status = 'delivered' AND ? != 'read' THEN 'delivered'
           WHEN status IN ('sent', 'delivered', 'read') AND ? IN ('failed', 'sending') THEN status
           ELSE ?
         END
         WHERE id = ? OR client_message_id = ?;`,
        [params.status, params.status, params.status, targetId, id]
      );
      const changes = res.changes;

      await this.databaseManager.run(
        `INSERT INTO message_receipts (message_id, recipient_id, status, receipt_timestamp, delivered_at, read_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(message_id, recipient_id) DO UPDATE SET
           status = CASE
             WHEN message_receipts.status = 'read' THEN 'read'
             WHEN message_receipts.status = 'delivered' AND excluded.status != 'read' THEN 'delivered'
             WHEN message_receipts.status IN ('sent', 'delivered', 'read') AND excluded.status IN ('failed', 'sending') THEN message_receipts.status
             ELSE excluded.status
           END,
           receipt_timestamp = excluded.receipt_timestamp,
           delivered_at = COALESCE(excluded.delivered_at, message_receipts.delivered_at),
           read_at = COALESCE(excluded.read_at, message_receipts.read_at);`,
        [targetId, recipientId, params.status, timestamp, deliveredAt, readAt]
      );

      // Clean up any staged receipt row now that canonical row is safely updated
      await this.databaseManager.run(
        'DELETE FROM staged_receipts WHERE message_id = ? OR (message_id = ? AND ? IS NOT NULL) OR (message_id = ? AND ? IS NOT NULL);',
        [targetId, clientMsgId, clientMsgId, id, id]
      );

      return { ok: true, changes };
    });
  }

  /**
   * Retrieves per-recipient receipt records for a message.
   * Supports group messages with individual member statuses and timestamps.
   * @param {object|string} params
   * @returns {Promise<{ receipts: Array<object> }>}
   */
  async getMessageReceipts(params = {}) {
    await this._getAuthorizedUser();
    const rawId = typeof params === 'string'
      ? params
      : (params?.messageId || params?.message_id || params?.id || params?.clientMessageId || params?.client_message_id);
    if (!rawId) return { receipts: [] };
    const id = validateIdentifier(String(rawId), 'messageId');

    const msg = await this.databaseManager.get(
      'SELECT id, client_message_id FROM messages WHERE id = ? OR client_message_id = ? LIMIT 1;',
      [id, id]
    ).catch(() => null);

    const canonicalId = msg?.id || id;
    const clientMsgId = msg?.client_message_id || (id !== canonicalId ? id : null);

    const rows = await this.databaseManager.all(
      `SELECT recipient_id, status, receipt_timestamp, delivered_at, read_at
       FROM message_receipts
       WHERE message_id = ? OR (message_id = ? AND ? IS NOT NULL);`,
      [canonicalId, clientMsgId, clientMsgId]
    ).catch(() => []);

    const stagedRows = await this.databaseManager.all(
      `SELECT recipient_id, status, receipt_timestamp, delivered_at, read_at
       FROM staged_receipts
       WHERE message_id = ? OR (message_id = ? AND ? IS NOT NULL);`,
      [canonicalId, clientMsgId, clientMsgId]
    ).catch(() => []);

    const combined = new Map();
    const STATUS_RANK = { pending: 0, sending: 0, sent: 1, delivered: 2, read: 3, failed: -1 };

    for (const r of [...(stagedRows || []), ...(rows || [])]) {
      if (!r || !r.recipient_id) continue;
      const recId = String(r.recipient_id).trim();
      const existing = combined.get(recId);

      const deliveredAt = r.delivered_at || (r.status === 'delivered' ? r.receipt_timestamp : null);
      const readAt = r.read_at || (r.status === 'read' ? r.receipt_timestamp : null);

      if (!existing) {
        combined.set(recId, {
          recipientId: recId,
          status: r.status,
          timestamp: r.receipt_timestamp,
          deliveredAt,
          readAt
        });
      } else {
        const curRank = STATUS_RANK[existing.status] ?? 0;
        const newRank = STATUS_RANK[r.status] ?? 0;
        if (newRank > curRank) {
          existing.status = r.status;
          existing.timestamp = r.receipt_timestamp;
        }
        if (deliveredAt && !existing.deliveredAt) existing.deliveredAt = deliveredAt;
        if (readAt && !existing.readAt) existing.readAt = readAt;
      }
    }

    return {
      receipts: Array.from(combined.values())
    };
  }

  /**
   * Updates message edited content.
   * @param {object} params
   * @param {string} params.id
   * @param {any} [params.body]
   * @param {any} [params.newBody]
   * Updates message content and edited_at timestamp for an edited message.
   * Supports either (id, body, editedAt) or ({ id, body, editedAt }).
   * @param {object|string} paramsOrId
   * @param {object} [positionalBody]
   * @param {string} [positionalEditedAt]
   * @returns {Promise<{ ok: boolean, changes: number }>}
   */
  async updateMessageEdit(paramsOrId, positionalBody = null, positionalEditedAt = null) {
    await this._getAuthorizedUser();
    let id;
    let body;
    let editedAt;

    if (typeof paramsOrId === 'string') {
      id = paramsOrId;
      body = positionalBody;
      editedAt = positionalEditedAt;
    } else if (paramsOrId && typeof paramsOrId === 'object') {
      id = paramsOrId.id;
      body = paramsOrId.body || paramsOrId.newBody || paramsOrId.body_json;
      editedAt = paramsOrId.editedAt || paramsOrId.edited_at;
    }

    const validId = validateIdentifier(id, 'id');
    const bodyJson = serializeJson(body || {});
    const finalEditedAt = editedAt || new Date().toISOString();

    const res = await this.databaseManager.run(
      'UPDATE messages SET body_json = ?, edited_at = ? WHERE (id = ? OR client_message_id = ?) AND is_deleted = 0 AND (edited_at IS NULL OR edited_at <= ?);',
      [bodyJson, finalEditedAt, validId, validId, finalEditedAt]
    );
    return { ok: true, changes: res.changes };
  }

  /**
   * Marks a message as deleted for everyone (tombstone).
   * Supports either (id) or ({ id }).
   * @param {object|string} paramsOrId
   * @returns {Promise<{ ok: boolean, changes: number }>}
   */
  async markMessageDeleted(paramsOrId) {
    await this._getAuthorizedUser();
    const id = typeof paramsOrId === 'string' ? paramsOrId : paramsOrId?.id;
    const validId = validateIdentifier(id, 'id');
    const tombstone = JSON.stringify({ text: 'This message was deleted' });

    const res = await this.databaseManager.run(
      'UPDATE messages SET is_deleted = 1, kind = "deleted", is_starred = 0, body_json = ? WHERE id = ? OR client_message_id = ?;',
      [tombstone, validId, validId]
    );
    return { ok: true, changes: res.changes };
  }

  /**
   * Marks a message as deleted locally for the current user only.
   * Supports either (id) or ({ id }).
   * @param {object|string} paramsOrId
   * @returns {Promise<{ ok: boolean, changes: number }>}
   */
  async markMessageDeletedForMe(paramsOrId) {
    await this._getAuthorizedUser();
    const id = typeof paramsOrId === 'string' ? paramsOrId : paramsOrId?.id;
    const validId = validateIdentifier(id, 'id');
    const res = await this.databaseManager.run(
      'UPDATE messages SET is_deleted_for_me = 1, is_starred = 0 WHERE id = ? OR client_message_id = ?;',
      [validId, validId]
    );
    return { ok: true, changes: res.changes };
  }

  /**
   * Updates the starred status of a message in SQLite.
   * @param {object|string} paramsOrId
   * @param {boolean} [maybeIsStarred]
   * @returns {Promise<{ ok: boolean, changes: number }>}
   */
  async updateMessageStarred(paramsOrId, maybeIsStarred) {
    await this._getAuthorizedUser();
    let id;
    let isStarred = true;
    let roomId = null;

    if (typeof paramsOrId === 'string') {
      id = paramsOrId;
      if (typeof maybeIsStarred === 'boolean') isStarred = maybeIsStarred;
    } else if (paramsOrId && typeof paramsOrId === 'object') {
      id = paramsOrId.messageId || paramsOrId.id || paramsOrId.clientMessageId || paramsOrId.client_message_id;
      if (paramsOrId.isStarred !== undefined) {
        isStarred = Boolean(paramsOrId.isStarred);
      } else if (paramsOrId.is_starred !== undefined) {
        isStarred = Boolean(paramsOrId.is_starred);
      }
      roomId = paramsOrId.roomId || paramsOrId.room_id || null;
    }

    const validId = validateIdentifier(id, 'id');
    const starredVal = isStarred ? 1 : 0;

    let sql = 'UPDATE messages SET is_starred = ? WHERE (id = ? OR client_message_id = ?)';
    const params = [starredVal, validId, validId];
    if (roomId) {
      sql += ' AND room_id = ?';
      params.push(validateIdentifier(roomId, 'roomId'));
    }
    sql += ';';

    const res = await this.databaseManager.run(sql, params);
    return { ok: true, changes: res.changes };
  }

  /**
   * Retrieves starred messages from SQLite for a specific room or across all rooms.
   * Excludes messages deleted for everyone or deleted for the current user.
   * @param {object} [options={}]
   * @returns {Promise<Array<object>>}
   */
  async getStarredMessages(options = {}) {
    await this._getAuthorizedUser();
    const roomId = (options.roomId || options.room_id)
      ? validateIdentifier(String(options.roomId || options.room_id), 'roomId')
      : null;
    const limit = validateLimit(options.limit, 100, 500);

    let sql = `
      SELECT m.*
      FROM messages m
      WHERE m.is_starred = 1
        AND m.is_deleted = 0
        AND m.is_deleted_for_me = 0
    `;
    const params = [];
    if (roomId) {
      sql += ' AND m.room_id = ?';
      params.push(roomId);
    }

    sql += ' ORDER BY m.created_at DESC LIMIT ?;';
    params.push(limit);

    const rows = await this.databaseManager.all(sql, params);
    for (const r of rows) {
      if (r) {
        r.deliveryStatus = r.status;
        r.delivery_status = r.status;
        if (r.reactions && typeof r.reactions === 'string') {
          try {
            r.reactions = JSON.parse(r.reactions);
          } catch {
            r.reactions = null;
          }
        }
      }
    }
    return rows;
  }

  /**
   * Persists adding or removing a reaction in SQLite.
   * Updates message_reactions normalized table and syncs reactions JSON on messages table.
   * @param {object} params
   * @param {string} params.roomId
   * @param {string} params.messageId
   * @param {string} params.userId
   * @param {string} params.emoji
   * @param {boolean} [params.isAdd=true]
   * @returns {Promise<{ ok: boolean, reactions: object }>}
   */
  async updateMessageReaction({ roomId, messageId, userId, emoji, isAdd = true }) {
    await this._getAuthorizedUser();
    const validMessageId = validateIdentifier(messageId, 'messageId');
    const validUserId = validateIdentifier(userId, 'userId');
    if (!emoji || typeof emoji !== 'string' || !emoji.trim()) {
      throw new Error('Invalid emoji: must be a non-empty string');
    }
    const cleanEmoji = emoji.trim();
    const now = new Date().toISOString();

    // Ensure parent message row exists or resolve canonical id
    const parent = await this.databaseManager.get(
      'SELECT id, room_id, reactions FROM messages WHERE id = ? OR client_message_id = ? LIMIT 1;',
      [validMessageId, validMessageId]
    );

    const canonicalId = parent?.id || validMessageId;
    const effectiveRoomId = roomId || parent?.room_id || 'unknown';

    if (isAdd) {
      if (parent) {
        await this.databaseManager.run(
          `INSERT INTO message_reactions (message_id, room_id, user_id, emoji, created_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(message_id, user_id, emoji) DO NOTHING;`,
          [canonicalId, effectiveRoomId, validUserId, cleanEmoji, now]
        );
      } else {
        await this.databaseManager.run(
          `INSERT INTO staged_reactions (message_id, room_id, user_id, emoji, created_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(message_id, user_id, emoji) DO NOTHING;`,
          [canonicalId, effectiveRoomId, validUserId, cleanEmoji, now]
        );
      }
    } else {
      await this.databaseManager.run(
        'DELETE FROM message_reactions WHERE (message_id = ? OR message_id = ?) AND user_id = ? AND emoji = ?;',
        [canonicalId, validMessageId, validUserId, cleanEmoji]
      );
      await this.databaseManager.run(
        'DELETE FROM staged_reactions WHERE (message_id = ? OR message_id = ?) AND user_id = ? AND emoji = ?;',
        [canonicalId, validMessageId, validUserId, cleanEmoji]
      );
    }

    // Reconstruct reactions map for the message
    const rows = await this.databaseManager.all(
      `SELECT user_id, emoji FROM message_reactions WHERE message_id = ?
       UNION
       SELECT user_id, emoji FROM staged_reactions WHERE message_id = ?;`,
      [canonicalId, canonicalId]
    );

    const reactionsMap = {};
    for (const r of rows) {
      if (!reactionsMap[r.emoji]) reactionsMap[r.emoji] = [];
      if (!reactionsMap[r.emoji].includes(r.user_id)) {
        reactionsMap[r.emoji].push(r.user_id);
      }
    }

    const reactionsJson = JSON.stringify(reactionsMap);
    if (parent) {
      await this.databaseManager.run(
        'UPDATE messages SET reactions = ? WHERE id = ?;',
        [reactionsJson, canonicalId]
      );
    }

    return { ok: true, messageId: canonicalId, reactions: reactionsMap };
  }

  /**
   * Retrieves reactions for a message.
   * @param {string|object} params
   * @returns {Promise<{ reactions: object }>}
   */
  async getMessageReactions(params) {
    await this._getAuthorizedUser();
    const rawId = typeof params === 'string' ? params : (params?.messageId || params?.id);
    const validId = validateIdentifier(rawId, 'messageId');

    const rows = await this.databaseManager.all(
      `SELECT user_id, emoji FROM message_reactions WHERE message_id = ?
       UNION
       SELECT user_id, emoji FROM staged_reactions WHERE message_id = ?;`,
      [validId, validId]
    );

    const reactionsMap = {};
    for (const r of rows) {
      if (!reactionsMap[r.emoji]) reactionsMap[r.emoji] = [];
      if (!reactionsMap[r.emoji].includes(r.user_id)) {
        reactionsMap[r.emoji].push(r.user_id);
      }
    }
    return { reactions: reactionsMap };
  }

  /**
   * Saves a WebRTC call record.
   * @param {object} record
   * @returns {Promise<{ ok: boolean, id: string }>}
   */
  async saveCallRecord(record = {}) {
    await this._getAuthorizedUser();
    const id = validateIdentifier(record.id, 'id');
    const callId = validateIdentifier(record.callId || record.call_id, 'callId');
    const roomId = validateIdentifier(record.roomId || record.room_id, 'roomId');
    const peerUserId = validateIdentifier(record.peerUserId || record.peer_user_id, 'peerUserId');

    if (!ALLOWED_DIRECTIONS.has(record.direction)) {
      throw new Error(`Invalid call direction "${record.direction}".`);
    }
    const callType = record.callType || record.call_type;
    if (!ALLOWED_CALL_TYPES.has(callType)) {
      throw new Error(`Invalid call type "${callType}".`);
    }
    if (!ALLOWED_CALL_STATUSES.has(record.status)) {
      throw new Error(`Invalid call status "${record.status}".`);
    }
    const durationSeconds = Math.max(0, parseInt(record.durationSeconds ?? record.duration_seconds ?? 0, 10) || 0);
    const startedAt = record.startedAt || record.started_at || new Date().toISOString();

    // Ensure conversation exists
    await this.databaseManager.run(
      `INSERT INTO conversations (room_id, created_at, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(room_id) DO NOTHING;`,
      [roomId, startedAt, startedAt]
    );

    await this.databaseManager.run(
      `INSERT OR REPLACE INTO call_records (
        id, call_id, room_id, peer_user_id, direction, call_type, status, duration_seconds, started_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
      [id, callId, roomId, peerUserId, record.direction, callType, record.status, durationSeconds, startedAt]
    );

    return { ok: true, id };
  }

  /**
   * Retrieves call records with optional room filter.
   * @param {object} [options]
   * @param {string} [options.roomId]
   * @param {number} [options.limit=50]
   * @param {number} [options.offset=0]
   * @returns {Promise<Array<object>>}
   */
  async getCallRecords(options = {}) {
    await this._getAuthorizedUser();
    const limit = validateLimit(options.limit, 50, 100);
    const offset = validateOffset(options.offset);

    if (options.roomId || options.room_id) {
      const roomId = validateIdentifier(options.roomId || options.room_id, 'roomId');
      return await this.databaseManager.all(
        'SELECT * FROM call_records WHERE room_id = ? ORDER BY started_at DESC LIMIT ? OFFSET ?;',
        [roomId, limit, offset]
      );
    }

    return await this.databaseManager.all(
      'SELECT * FROM call_records ORDER BY started_at DESC LIMIT ? OFFSET ?;',
      [limit, offset]
    );
  }

  /**
   * Retrieves pending outbox items for synchronization.
   * @param {object} [options]
   * @param {number} [options.limit=50]
   * @returns {Promise<Array<object>>}
   */
  async getPendingOutbox(options = {}) {
    await this._getAuthorizedUser();
    const limit = validateLimit(options.limit, 50, 100);
    return await this.databaseManager.all(
      'SELECT * FROM pending_outbox ORDER BY created_at ASC LIMIT ?;',
      [limit]
    );
  }

  /**
   * Persists or updates an item in the pending outbox.
   * Ensures parent conversation row exists to satisfy foreign key.
   * @param {object} record
   * @returns {Promise<{ ok: boolean, clientMessageId: string }>}
   */
  async savePendingOutbox(record = {}) {
    await this._getAuthorizedUser();
    if (!record || typeof record !== 'object') {
      throw new Error('Invalid pending outbox record: must be an object.');
    }
    const clientMessageId = validateIdentifier(
      record.clientMessageId || record.client_message_id,
      'clientMessageId'
    );
    const roomId = validateIdentifier(
      record.roomId || record.room_id,
      'roomId'
    );
    const retryCount = Number.isInteger(record.retryCount ?? record.retry_count)
      ? Math.max(0, record.retryCount ?? record.retry_count)
      : 0;
    const now = new Date().toISOString();
    const createdAt = record.createdAt || record.created_at || now;
    const lastAttemptAt = record.lastAttemptAt || record.last_attempt_at || null;
    const payloadJson = serializeJson(record.payloadJson || record.payload_json || record.payload || {});

    // Ensure conversation exists so foreign key is satisfied
    await this.databaseManager.run(
      `INSERT INTO conversations (room_id, created_at, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(room_id) DO NOTHING;`,
      [roomId, createdAt, createdAt]
    );

    await this.databaseManager.run(
      `INSERT INTO pending_outbox (
        client_message_id, room_id, payload_json, retry_count, last_attempt_at, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(client_message_id) DO UPDATE SET
        room_id = excluded.room_id,
        payload_json = excluded.payload_json,
        retry_count = excluded.retry_count,
        last_attempt_at = excluded.last_attempt_at;`,
      [clientMessageId, roomId, payloadJson, retryCount, lastAttemptAt, createdAt]
    );

    return { ok: true, clientMessageId };
  }

  /**
   * Updates attempt count and last attempt timestamp for an outbox item.
   * @param {object} params
   * @param {string} params.clientMessageId
   * @param {number} [params.retryCount]
   * @param {string} [params.lastAttemptAt]
   * @returns {Promise<{ ok: boolean, changes: number }>}
   */
  async updatePendingOutboxAttempt(params = {}) {
    await this._getAuthorizedUser();
    const clientMessageId = validateIdentifier(
      params.clientMessageId || params.client_message_id,
      'clientMessageId'
    );
    const retryCount = Number.isInteger(params.retryCount ?? params.retry_count)
      ? Math.max(0, params.retryCount ?? params.retry_count)
      : 0;
    const lastAttemptAt = params.lastAttemptAt || params.last_attempt_at || new Date().toISOString();

    const res = await this.databaseManager.run(
      'UPDATE pending_outbox SET retry_count = ?, last_attempt_at = ? WHERE client_message_id = ?;',
      [retryCount, lastAttemptAt, clientMessageId]
    );
    return { ok: true, changes: res.changes };
  }

  /**
   * Removes an item from the pending outbox once acknowledged by server.
   * @param {object} params
   * @param {string} params.clientMessageId
   * @returns {Promise<{ ok: boolean, changes: number }>}
   */
  async clearPendingOutboxItem(params = {}) {
    await this._getAuthorizedUser();
    const clientMessageId = validateIdentifier(params.clientMessageId || params.client_message_id, 'clientMessageId');
    const res = await this.databaseManager.run(
      'DELETE FROM pending_outbox WHERE client_message_id = ?;',
      [clientMessageId]
    );
    return { ok: true, changes: res.changes };
  }

  /**
   * Retrieves an application metadata record by key.
   * @param {object|string} params
   * @returns {Promise<{ key: string, value: string, updated_at: string }|null>}
   */
  async getMetadata(params = {}) {
    const cleanUserId = await this._getAuthorizedUser();
    const key = validateIdentifier(typeof params === 'string' ? params : params?.key, 'metadataKey');
    let row = await this.databaseManager.get('SELECT key, value, updated_at FROM app_metadata WHERE key = ?;', [key]);
    if (!row && key.startsWith('peer_read_seq:')) {
      const roomId = key.slice('peer_read_seq:'.length);
      if (roomId) {
        const fallback = await this.databaseManager.get(
          `SELECT MAX(seq) as max_seq FROM (
            SELECT MAX(event_seq) as seq FROM messages WHERE room_id = ? AND sender_id = ? AND status = 'read' AND event_seq > 0
            UNION ALL
            SELECT MAX(m.event_seq) as seq FROM messages m JOIN message_receipts mr ON mr.message_id = m.id WHERE m.room_id = ? AND m.sender_id = ? AND mr.status = 'read' AND m.event_seq > 0
          );`,
          [roomId, cleanUserId, roomId, cleanUserId]
        );
        const maxSeq = fallback?.max_seq ? parseInt(fallback.max_seq, 10) : 0;
        if (maxSeq > 0) {
          const nowIso = new Date().toISOString();
          await this.databaseManager.run(
            `INSERT INTO app_metadata (key, value, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET
               value = CASE WHEN CAST(excluded.value AS INTEGER) > CAST(app_metadata.value AS INTEGER) THEN excluded.value ELSE app_metadata.value END,
               updated_at = excluded.updated_at;`,
            [key, String(maxSeq), nowIso]
          );
          row = { key, value: String(maxSeq), updated_at: nowIso };
        }
      }
    }
    return row || null;
  }

  /**
   * Sets or updates an application metadata record.
   * @param {object} params
   * @param {string} params.key
   * @param {any} params.value
   * @returns {Promise<{ ok: boolean, key: string }>}
   */
  async setMetadata(params = {}, maybeValue = undefined) {
    await this._getAuthorizedUser();
    let key;
    let val;
    if (typeof params === 'string') {
      key = params;
      val = maybeValue;
    } else {
      key = params?.key;
      val = params?.value;
    }
    const cleanKey = validateIdentifier(key, 'metadataKey');
    const value = typeof val === 'string' ? val : JSON.stringify(val);
    const now = new Date().toISOString();
    await this.databaseManager.run(
      `INSERT INTO app_metadata (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;`,
      [cleanKey, value, now]
    );
    return { ok: true, key: cleanKey };
  }

  /**
   * Retrieves all custom filter lists and their member room IDs.
   * @returns {Promise<Array<{ id: string, name: string, roomIds: Array<string>, createdAt: string }>>}
   */
  async getCustomLists() {
    await this._getAuthorizedUser();
    const lists = await this.databaseManager.all('SELECT id, name, created_at FROM custom_lists ORDER BY created_at ASC;');
    const results = [];
    for (const list of lists) {
      const members = await this.databaseManager.all(
        'SELECT room_id FROM custom_list_members WHERE list_id = ? ORDER BY room_id ASC;',
        [list.id]
      );
      results.push({
        id: list.id,
        name: list.name,
        roomIds: members.map((m) => m.room_id),
        createdAt: list.created_at
      });
    }
    return results;
  }

  /**
   * Replaces custom lists and their room memberships transactionally.
   * @param {object|Array} payload
   * @returns {Promise<{ ok: boolean, count: number }>}
   */
  async saveCustomLists(payload = {}) {
    await this._getAuthorizedUser();
    const rawLists = Array.isArray(payload) ? payload : (payload.lists || []);
    const now = new Date().toISOString();

    await this.databaseManager.transaction(async () => {
      await this.databaseManager.run('DELETE FROM custom_lists;');
      for (const item of rawLists) {
        if (!item || typeof item !== 'object') continue;
        const id = validateIdentifier(item.id, 'customListId');
        const name = typeof item.name === 'string' ? item.name.trim() : 'List';
        const createdAt = item.createdAt || now;
        await this.databaseManager.run(
          'INSERT INTO custom_lists (id, name, created_at) VALUES (?, ?, ?);',
          [id, name, createdAt]
        );
        const roomIds = Array.isArray(item.roomIds) ? item.roomIds : [];
        for (const roomId of roomIds) {
          if (!roomId || typeof roomId !== 'string') continue;
          try {
            const cleanRoomId = validateIdentifier(roomId, 'roomId');
            await this.databaseManager.run(
              `INSERT INTO conversations (room_id, created_at, updated_at) VALUES (?, ?, ?)
               ON CONFLICT(room_id) DO NOTHING;`,
              [cleanRoomId, now, now]
            );
            await this.databaseManager.run(
              `INSERT INTO custom_list_members (list_id, room_id) VALUES (?, ?)
               ON CONFLICT(list_id, room_id) DO NOTHING;`,
              [id, cleanRoomId]
            );
          } catch (_) {}
        }
      }
    });
    return { ok: true, count: rawLists.length };
  }

  /**
   * Persists or updates an upload session in SQLite.
   * Ensures parent conversation row exists to satisfy foreign key.
   * Never stores authentication or session tokens.
   * @param {object} session
   * @returns {Promise<{ ok: boolean, id: string }>}
   */
  async saveUploadSession(session = {}) {
    await this._getAuthorizedUser();
    if (!session || typeof session !== 'object') {
      throw new Error('Invalid upload session: must be an object.');
    }
    const id = validateIdentifier(session.id, 'uploadSessionId');
    const roomId = validateIdentifier(session.roomId || session.room_id, 'roomId');
    const filePath = typeof (session.filePath || session.file_path) === 'string'
      ? (session.filePath || session.file_path).trim()
      : '';
    const filename = typeof session.filename === 'string' ? session.filename.trim() : 'file';
    const mimeType = typeof (session.mimeType || session.mime_type || session.mime) === 'string'
      ? (session.mimeType || session.mime_type || session.mime).trim()
      : 'application/octet-stream';
    const byteSize = Number(session.byteSize ?? session.byte_size ?? 0);
    const isMultipart = (session.isMultipart ?? session.is_multipart) ? 1 : 0;
    const attachmentId = (session.attachmentId || session.attachment_id || null);
    const uploadId = (session.uploadId || session.upload_id || null);
    const partSize = Number(session.partSize ?? session.part_size ?? 8388608);
    const totalParts = Number(session.totalParts ?? session.total_parts ?? 1);

    const rawPartUrls = session.partUrls ?? session.part_urls ?? session.partUrlsJson ?? session.part_urls_json;
    const partUrlsJson = typeof rawPartUrls === 'string' ? rawPartUrls : JSON.stringify(Array.isArray(rawPartUrls) ? rawPartUrls : []);

    const rawCompletedParts = session.completedParts ?? session.completed_parts ?? session.completedPartsJson ?? session.completed_parts_json;
    const completedPartsJson = typeof rawCompletedParts === 'string' ? rawCompletedParts : JSON.stringify(Array.isArray(rawCompletedParts) ? rawCompletedParts : []);

    const rawStatus = (session.status || 'pending').toLowerCase();
    const status = ALLOWED_UPLOAD_STATUSES.has(rawStatus) ? rawStatus : 'pending';
    const errorMessage = session.errorMessage || session.error_message || null;
    const expiresAt = session.expiresAt || session.expires_at || null;
    const now = new Date().toISOString();
    const createdAt = session.createdAt || session.created_at || now;
    const updatedAt = session.updatedAt || session.updated_at || now;

    // Ensure conversation exists to satisfy foreign key
    await this.databaseManager.run(
      `INSERT INTO conversations (room_id, created_at, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(room_id) DO NOTHING;`,
      [roomId, createdAt, createdAt]
    );

    await this.databaseManager.run(
      `INSERT INTO upload_sessions (
        id, room_id, file_path, filename, mime_type, byte_size,
        is_multipart, attachment_id, upload_id, part_size, total_parts,
        part_urls_json, completed_parts_json, status, error_message,
        expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        file_path = excluded.file_path,
        filename = excluded.filename,
        mime_type = excluded.mime_type,
        byte_size = excluded.byte_size,
        is_multipart = excluded.is_multipart,
        attachment_id = COALESCE(excluded.attachment_id, upload_sessions.attachment_id),
        upload_id = COALESCE(excluded.upload_id, upload_sessions.upload_id),
        part_size = excluded.part_size,
        total_parts = excluded.total_parts,
        part_urls_json = COALESCE(excluded.part_urls_json, upload_sessions.part_urls_json),
        completed_parts_json = COALESCE(excluded.completed_parts_json, upload_sessions.completed_parts_json),
        status = excluded.status,
        error_message = excluded.error_message,
        expires_at = COALESCE(excluded.expires_at, upload_sessions.expires_at),
        updated_at = excluded.updated_at;`,
      [
        id, roomId, filePath, filename, mimeType, byteSize,
        isMultipart, attachmentId, uploadId, partSize, totalParts,
        partUrlsJson, completedPartsJson, status, errorMessage,
        expiresAt, createdAt, updatedAt
      ]
    );

    return { ok: true, id };
  }

  /**
   * Updates progress, completed parts, or status of an existing upload session.
   * @param {object} params
   * @returns {Promise<{ ok: boolean, changes: number }>}
   */
  async updateUploadSession(params = {}) {
    await this._getAuthorizedUser();
    const id = validateIdentifier(params.id, 'uploadSessionId');
    const updates = [];
    const values = [];

    if (params.status !== undefined) {
      const st = String(params.status).toLowerCase();
      if (!ALLOWED_UPLOAD_STATUSES.has(st)) {
        throw new Error(`Invalid upload session status: ${st}`);
      }
      updates.push('status = ?');
      values.push(st);
    }
    if (params.completedParts !== undefined || params.completed_parts !== undefined || params.completedPartsJson !== undefined) {
      const raw = params.completedParts ?? params.completed_parts ?? params.completedPartsJson;
      const json = typeof raw === 'string' ? raw : JSON.stringify(Array.isArray(raw) ? raw : []);
      updates.push('completed_parts_json = ?');
      values.push(json);
    }
    if (params.attachmentId !== undefined || params.attachment_id !== undefined) {
      updates.push('attachment_id = ?');
      values.push(params.attachmentId || params.attachment_id);
    }
    if (params.uploadId !== undefined || params.upload_id !== undefined) {
      updates.push('upload_id = ?');
      values.push(params.uploadId || params.upload_id);
    }
    if (params.errorMessage !== undefined || params.error_message !== undefined) {
      updates.push('error_message = ?');
      values.push(params.errorMessage || params.error_message);
    }
    if (params.expiresAt !== undefined || params.expires_at !== undefined) {
      updates.push('expires_at = ?');
      values.push(params.expiresAt || params.expires_at);
    }

    const updatedAt = params.updatedAt || params.updated_at || new Date().toISOString();
    updates.push('updated_at = ?');
    values.push(updatedAt);

    values.push(id);
    const sql = `UPDATE upload_sessions SET ${updates.join(', ')} WHERE id = ?;`;
    const res = await this.databaseManager.run(sql, values);
    return { ok: true, changes: res.changes };
  }

  /**
   * Retrieves an upload session by ID.
   * @param {object|string} params
   * @returns {Promise<object|null>}
   */
  async getUploadSession(params) {
    await this._getAuthorizedUser();
    const id = validateIdentifier(typeof params === 'string' ? params : params?.id, 'uploadSessionId');
    const row = await this.databaseManager.get('SELECT * FROM upload_sessions WHERE id = ?;', [id]);
    if (!row) return null;
    return this._mapUploadSessionRow(row);
  }

  /**
   * Retrieves recoverable or pending upload sessions.
   * @param {object} [options]
   * @param {string} [options.roomId]
   * @param {number} [options.limit=50]
   * @returns {Promise<Array<object>>}
   */
  async getPendingUploadSessions(options = {}) {
    await this._getAuthorizedUser();
    const limit = validateLimit(options.limit, 50, 100);
    let sql = 'SELECT * FROM upload_sessions WHERE status IN (\'pending\', \'uploading\', \'paused\', \'failed\')';
    const params = [];
    if (options.roomId || options.room_id) {
      const cleanRoomId = validateIdentifier(options.roomId || options.room_id, 'roomId');
      sql += ' AND room_id = ?';
      params.push(cleanRoomId);
    }
    sql += ' ORDER BY updated_at DESC LIMIT ?;';
    params.push(limit);

    const rows = await this.databaseManager.all(sql, params);
    return rows.map((r) => this._mapUploadSessionRow(r));
  }

  /**
   * Deletes an upload session by ID.
   * @param {object|string} params
   * @returns {Promise<{ ok: boolean, changes: number }>}
   */
  async deleteUploadSession(params) {
    await this._getAuthorizedUser();
    const id = validateIdentifier(typeof params === 'string' ? params : params?.id, 'uploadSessionId');
    const res = await this.databaseManager.run('DELETE FROM upload_sessions WHERE id = ?;', [id]);
    return { ok: true, changes: res.changes };
  }

  /**
   * Cleans stale upload sessions (older than maxAgeMs or expired).
   * @param {object} [options]
   * @param {number} [options.maxAgeMs=86400000] 24 hours default
   * @returns {Promise<{ ok: boolean, deleted: number }>}
   */
  async cleanStaleUploadSessions(options = {}) {
    await this._getAuthorizedUser();
    const maxAgeMs = typeof options.maxAgeMs === 'number' && options.maxAgeMs > 0
      ? options.maxAgeMs
      : 24 * 60 * 60 * 1000;
    const cutoffIso = new Date(Date.now() - maxAgeMs).toISOString();
    const nowIso = new Date().toISOString();

    const res = await this.databaseManager.run(
      `DELETE FROM upload_sessions
       WHERE status IN ('completed', 'cancelled')
          OR updated_at < ?
          OR (expires_at IS NOT NULL AND expires_at < ?);`,
      [cutoffIso, nowIso]
    );
    return { ok: true, deleted: res.changes };
  }

  /**
   * Retrieves cached contact records by phone numbers.
   * @param {string[]|string} phones
   * @returns {Promise<Array<object>>}
   */
  async getCachedContacts(phones = []) {
    await this._getAuthorizedUser();
    const list = Array.isArray(phones) ? phones : [phones];
    const cleanPhones = list
      .map((p) => normalizePhone(p))
      .filter((p) => Boolean(p) && SAFE_ID_REGEX.test(p));

    if (cleanPhones.length === 0) return [];

    const placeholders = cleanPhones.map(() => '?').join(', ');
    const rows = await this.databaseManager.all(
      `SELECT * FROM contact_cache WHERE phone IN (${placeholders});`,
      cleanPhones
    );

    return rows.map((r) => this._mapContactCacheRow(r));
  }

  /**
   * Retrieves a single cached contact by user ID.
   * @param {string} userId
   * @returns {Promise<object|null>}
   */
  async getCachedContactByUserId(userId) {
    await this._getAuthorizedUser();
    const cleanUserId = validateIdentifier(userId, 'userId');
    const row = await this.databaseManager.get(
      'SELECT * FROM contact_cache WHERE user_id = ?;',
      [cleanUserId]
    );
    return row ? this._mapContactCacheRow(row) : null;
  }

  /**
   * Saves or updates cached contact records in SQLite transactionally.
   * @param {Array<object>|object} contacts
   * @returns {Promise<{ ok: boolean, count: number }>}
   */
  async saveCachedContacts(contacts = []) {
    await this._getAuthorizedUser();
    const list = Array.isArray(contacts) ? contacts : [contacts];
    if (list.length === 0) return { ok: true, count: 0 };

    const now = new Date().toISOString();
    let savedCount = 0;

    await this.databaseManager.transaction(async () => {
      for (const item of list) {
        if (!item || typeof item !== 'object') continue;
        const rawPhone = item.phone || item.cleaned || '';
        const phone = normalizePhone(rawPhone);
        if (!phone || !SAFE_ID_REGEX.test(phone)) continue;

        const userId = (item.userId ?? item.user_id) ? String(item.userId ?? item.user_id).trim() : null;
        const displayName = typeof item.displayName === 'string' ? item.displayName : (item.display_name ?? null);
        const isRegistered = (item.isRegistered !== undefined || item.is_registered !== undefined)
          ? (item.isRegistered || item.is_registered ? 1 : 0)
          : (userId ? 1 : 0);
        const cachedAt = item.cachedAt || item.cached_at || now;
        const updatedAt = item.updatedAt || item.updated_at || now;

        await this.databaseManager.run(
          `INSERT INTO contact_cache (phone, user_id, display_name, is_registered, cached_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(phone) DO UPDATE SET
             user_id = excluded.user_id,
             display_name = coalesce(excluded.display_name, contact_cache.display_name),
             is_registered = excluded.is_registered,
             updated_at = excluded.updated_at;`,
          [phone, userId, displayName, isRegistered, cachedAt, updatedAt]
        );
        savedCount++;
      }
    });

    return { ok: true, count: savedCount };
  }

  /**
   * Fallback lookup from conversations table for offline peer recovery.
   * @param {string[]|string} phones
   * @returns {Promise<Array<object>>}
   */
  async getContactFallbackFromConversations(phones = []) {
    await this._getAuthorizedUser();
    const list = Array.isArray(phones) ? phones : [phones];
    const cleanPhones = list
      .map((p) => normalizePhone(p))
      .filter((p) => Boolean(p) && SAFE_ID_REGEX.test(p));

    if (cleanPhones.length === 0) return [];

    const placeholders = cleanPhones.map(() => '?').join(', ');
    const rows = await this.databaseManager.all(
      `SELECT peer_phone, peer_user_id, peer_display_name, updated_at
       FROM conversations
       WHERE peer_phone IN (${placeholders}) AND peer_user_id IS NOT NULL;`,
      cleanPhones
    );

    return rows.map((r) => ({
      phone: normalizePhone(r.peer_phone),
      userId: r.peer_user_id,
      user_id: r.peer_user_id,
      displayName: r.peer_display_name,
      display_name: r.peer_display_name,
      isRegistered: true,
      is_registered: true,
      cachedAt: r.updated_at,
      cached_at: r.updated_at,
      updatedAt: r.updated_at,
      updated_at: r.updated_at
    }));
  }

  /**
   * Reconciles conversation peer display name when directory contact updates.
   * Preserves user-defined custom nicknames (stored in app_metadata).
   * @param {string} userId
   * @param {string} displayName
   * @returns {Promise<{ ok: boolean, updatedRooms: number }>}
   */
  async reconcileConversationPeerDisplayName(userId, displayName) {
    await this._getAuthorizedUser();
    if (!userId || typeof userId !== 'string' || !displayName || typeof displayName !== 'string') {
      return { ok: false, updatedRooms: 0 };
    }
    const cleanUserId = validateIdentifier(userId, 'userId');
    const cleanName = displayName.trim().slice(0, 100);
    const now = new Date().toISOString();

    const res = await this.databaseManager.run(
      `UPDATE conversations
       SET peer_display_name = ?, updated_at = ?
       WHERE peer_user_id = ?;`,
      [cleanName, now, cleanUserId]
    );

    return { ok: true, updatedRooms: res.changes };
  }

  /**
   * Prunes stale contact cache entries older than maxAgeMs.
   * @param {number} [maxAgeMs=2592000000] 30 days
   * @returns {Promise<{ ok: boolean, deleted: number }>}
   */
  async pruneStaleContactCache(maxAgeMs = 30 * 24 * 60 * 60 * 1000) {
    await this._getAuthorizedUser();
    const cutoffIso = new Date(Date.now() - Math.max(1000, maxAgeMs)).toISOString();
    const res = await this.databaseManager.run(
      'DELETE FROM contact_cache WHERE updated_at < ?;',
      [cutoffIso]
    );
    return { ok: true, deleted: res.changes };
  }

  _mapContactCacheRow(row) {
    if (!row) return null;
    return {
      phone: row.phone,
      userId: row.user_id || '',
      user_id: row.user_id || '',
      displayName: row.display_name || null,
      display_name: row.display_name || null,
      isRegistered: Boolean(row.is_registered),
      is_registered: Boolean(row.is_registered),
      cachedAt: row.cached_at,
      cached_at: row.cached_at,
      updatedAt: row.updated_at,
      updated_at: row.updated_at
    };
  }

  _mapUploadSessionRow(row) {
    if (!row) return null;
    let partUrls = [];
    let completedParts = [];
    try {
      partUrls = JSON.parse(row.part_urls_json || '[]');
    } catch {}
    try {
      completedParts = JSON.parse(row.completed_parts_json || '[]');
    } catch {}

    return {
      id: row.id,
      roomId: row.room_id,
      room_id: row.room_id,
      filePath: row.file_path,
      file_path: row.file_path,
      filename: row.filename,
      mimeType: row.mime_type,
      mime_type: row.mime_type,
      byteSize: row.byte_size,
      byte_size: row.byte_size,
      isMultipart: Boolean(row.is_multipart),
      is_multipart: row.is_multipart,
      attachmentId: row.attachment_id,
      attachment_id: row.attachment_id,
      uploadId: row.upload_id,
      upload_id: row.upload_id,
      partSize: row.part_size,
      part_size: row.part_size,
      totalParts: row.total_parts,
      total_parts: row.total_parts,
      partUrls,
      part_urls: partUrls,
      completedParts,
      completed_parts: completedParts,
      status: row.status,
      errorMessage: row.error_message,
      error_message: row.error_message,
      expiresAt: row.expires_at,
      expires_at: row.expires_at,
      createdAt: row.created_at,
      created_at: row.created_at,
      updatedAt: row.updated_at,
      updated_at: row.updated_at
    };
  }

  /**
   * Idempotent, transactional localStorage -> SQLite migrator.
   * Safely migrates pinned chats, favourites, custom lists, unread state,
   * call records, and message metadata into SQLite.
   * @param {object} payload
   * @param {number} [payload.version=1]
   * @param {object} [payload.data]
   * @returns {Promise<{ ok: boolean, version: number, alreadyMigrated?: boolean, migrated?: boolean, counts?: object }>}
   */
  async migrateLocalStorage(payload = {}) {
    await this._getAuthorizedUser();
    const requestedVersion = Number.isInteger(payload.version) ? payload.version : 1;

    // 1. Idempotency check: see if migration was already executed
    const existingVerRow = await this.databaseManager.get(
      'SELECT value FROM app_metadata WHERE key = ?;',
      ['localstorage_migration_version']
    );
    const existingVer = existingVerRow?.value ? parseInt(existingVerRow.value, 10) : 0;
    if (existingVer >= requestedVersion) {
      return { ok: true, alreadyMigrated: true, version: existingVer };
    }

    const data = payload.data || {};
    const now = new Date().toISOString();
    const counts = {
      pinned: 0,
      favourites: 0,
      customLists: 0,
      archived: 0,
      markedUnread: 0,
      callHistory: 0,
      deletedForMe: 0,
      starred: 0
    };

    // 2. Transactional migration
    await this.databaseManager.transaction(async () => {
      // A. Pinned chats
      if (Array.isArray(data.pinnedRoomIds)) {
        for (let i = 0; i < data.pinnedRoomIds.length; i++) {
          const roomId = data.pinnedRoomIds[i];
          if (!roomId || typeof roomId !== 'string') continue;
          try {
            const cleanId = validateIdentifier(roomId, 'pinnedRoomId');
            await this.databaseManager.run(
              `INSERT INTO conversations (room_id, is_pinned, pinned_order, created_at, updated_at)
               VALUES (?, 1, ?, ?, ?)
               ON CONFLICT(room_id) DO UPDATE SET
                 is_pinned = 1,
                 pinned_order = coalesce(conversations.pinned_order, excluded.pinned_order);`,
              [cleanId, i, now, now]
            );
            counts.pinned++;
          } catch (_) {}
        }
      }

      // B. Favourites
      if (Array.isArray(data.favouriteRoomIds)) {
        for (const roomId of data.favouriteRoomIds) {
          if (!roomId || typeof roomId !== 'string') continue;
          try {
            const cleanId = validateIdentifier(roomId, 'favouriteRoomId');
            await this.databaseManager.run(
              `INSERT INTO conversations (room_id, is_favourite, created_at, updated_at)
               VALUES (?, 1, ?, ?)
               ON CONFLICT(room_id) DO UPDATE SET is_favourite = 1;`,
              [cleanId, now, now]
            );
            counts.favourites++;
          } catch (_) {}
        }
      }

      // C. Archived chats
      if (Array.isArray(data.archivedRoomIds)) {
        for (const roomId of data.archivedRoomIds) {
          if (!roomId || typeof roomId !== 'string') continue;
          try {
            const cleanId = validateIdentifier(roomId, 'archivedRoomId');
            await this.databaseManager.run(
              `INSERT INTO conversations (room_id, is_archived, created_at, updated_at)
               VALUES (?, 1, ?, ?)
               ON CONFLICT(room_id) DO UPDATE SET is_archived = 1;`,
              [cleanId, now, now]
            );
            counts.archived++;
          } catch (_) {}
        }
      }

      // D. Marked unread
      if (Array.isArray(data.markedUnreadRoomIds)) {
        for (const roomId of data.markedUnreadRoomIds) {
          if (!roomId || typeof roomId !== 'string') continue;
          try {
            const cleanId = validateIdentifier(roomId, 'markedUnreadRoomId');
            await this.databaseManager.run(
              `INSERT INTO conversations (room_id, is_marked_unread, created_at, updated_at)
               VALUES (?, 1, ?, ?)
               ON CONFLICT(room_id) DO UPDATE SET is_marked_unread = 1;`,
              [cleanId, now, now]
            );
            counts.markedUnread++;
          } catch (_) {}
        }
      }

      // E. Custom lists
      if (Array.isArray(data.customLists) && data.customLists.length > 0) {
        for (const list of data.customLists) {
          if (!list || typeof list !== 'object') continue;
          try {
            const listId = validateIdentifier(list.id, 'customListId');
            const listName = typeof list.name === 'string' ? list.name.trim() : 'List';
            await this.databaseManager.run(
              `INSERT INTO custom_lists (id, name, created_at)
               VALUES (?, ?, ?)
               ON CONFLICT(id) DO UPDATE SET name = excluded.name;`,
              [listId, listName, now]
            );
            if (Array.isArray(list.roomIds)) {
              for (const rId of list.roomIds) {
                if (!rId || typeof rId !== 'string') continue;
                try {
                  const cleanRId = validateIdentifier(rId, 'roomId');
                  await this.databaseManager.run(
                    `INSERT INTO conversations (room_id, created_at, updated_at)
                     VALUES (?, ?, ?)
                     ON CONFLICT(room_id) DO NOTHING;`,
                    [cleanRId, now, now]
                  );
                  await this.databaseManager.run(
                    `INSERT INTO custom_list_members (list_id, room_id)
                     VALUES (?, ?)
                     ON CONFLICT(list_id, room_id) DO NOTHING;`,
                    [listId, cleanRId]
                  );
                } catch (_) {}
              }
            }
            counts.customLists++;
          } catch (_) {}
        }
      }

      // F. Call history
      if (Array.isArray(data.callHistory) && data.callHistory.length > 0) {
        for (const call of data.callHistory) {
          if (!call || typeof call !== 'object') continue;
          try {
            const startedAtMs = typeof call.startedAt === 'number' ? call.startedAt : Date.now();
            const startedAtIso = new Date(startedAtMs).toISOString();
            const id = validateIdentifier(call.id || `call_${startedAtMs}_${Math.random().toString(36).slice(2, 6)}`, 'callId');
            const callId = validateIdentifier(call.callId || id, 'callId');
            const roomId = validateIdentifier(call.roomId || call.room_id || 'unknown_room', 'roomId');
            const peerUserId = validateIdentifier(call.participantId || call.peer_user_id || 'unknown_peer', 'peerUserId');
            const direction = ALLOWED_DIRECTIONS.has(call.direction) ? call.direction : 'incoming';
            const callType = (call.callType === 'video' || call.isVideo) ? 'video' : 'voice';
            const status = ALLOWED_CALL_STATUSES.has(call.status) ? call.status : 'answered';
            const duration = typeof call.duration === 'number' ? Math.max(0, Math.round(call.duration)) : 0;

            await this.databaseManager.run(
              `INSERT INTO conversations (room_id, created_at, updated_at)
               VALUES (?, ?, ?)
               ON CONFLICT(room_id) DO NOTHING;`,
              [roomId, startedAtIso, startedAtIso]
            );

            await this.databaseManager.run(
              `INSERT INTO call_records (
                id, call_id, room_id, peer_user_id, direction, call_type,
                status, duration_seconds, started_at
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(id) DO NOTHING;`,
              [id, callId, roomId, peerUserId, direction, callType, status, duration, startedAtIso]
            );
            counts.callHistory++;
          } catch (_) {}
        }
      }

      // G. Deleted for me
      if (Array.isArray(data.deletedForMeMessageIds) && data.deletedForMeMessageIds.length > 0) {
        for (const mid of data.deletedForMeMessageIds) {
          if (!mid || typeof mid !== 'string') continue;
          try {
            const parts = mid.split(':');
            const actualId = parts.length > 1 ? parts[1] : parts[0];
            const cleanId = validateIdentifier(actualId, 'messageId');
            const res = await this.databaseManager.run(
              'UPDATE messages SET is_deleted_for_me = 1 WHERE id = ? OR client_message_id = ?;',
              [cleanId, cleanId]
            );
            if (res.changes > 0) counts.deletedForMe += res.changes;
          } catch (_) {}
        }
      }

      // H. Starred messages
      if (Array.isArray(data.starredMessageIds) && data.starredMessageIds.length > 0) {
        for (const mid of data.starredMessageIds) {
          if (!mid || typeof mid !== 'string') continue;
          try {
            const parts = mid.split(':');
            const actualId = parts.length > 1 ? parts[1] : parts[0];
            const cleanId = validateIdentifier(actualId, 'messageId');
            const res = await this.databaseManager.run(
              'UPDATE messages SET is_starred = 1 WHERE id = ? OR client_message_id = ?;',
              [cleanId, cleanId]
            );
            if (res.changes > 0) counts.starred += res.changes;
          } catch (_) {}
        }
      }

      // I. App Metadata items
      if (data.contactNicknames && typeof data.contactNicknames === 'object') {
        await this.databaseManager.run(
          `INSERT INTO app_metadata (key, value, updated_at) VALUES ('contact_nicknames', ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;`,
          [JSON.stringify(data.contactNicknames), now]
        );
      }
      if (data.pinnedMessages && typeof data.pinnedMessages === 'object') {
        await this.databaseManager.run(
          `INSERT INTO app_metadata (key, value, updated_at) VALUES ('pinned_messages', ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;`,
          [JSON.stringify(data.pinnedMessages), now]
        );
      }
      if (data.unreadEdits && typeof data.unreadEdits === 'object') {
        await this.databaseManager.run(
          `INSERT INTO app_metadata (key, value, updated_at) VALUES ('unread_edits', ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;`,
          [JSON.stringify(data.unreadEdits), now]
        );
      }

      // J. Set migration version marker
      await this.databaseManager.run(
        `INSERT INTO app_metadata (key, value, updated_at) VALUES ('localstorage_migration_version', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;`,
        [String(requestedVersion), now]
      );
    });

    // 3. Verification step
    const verRow = await this.databaseManager.get(
      'SELECT value FROM app_metadata WHERE key = ?;',
      ['localstorage_migration_version']
    );
    if (!verRow || parseInt(verRow.value, 10) !== requestedVersion) {
      throw new Error('Migration verification failed: metadata version mismatch');
    }

    return {
      ok: true,
      version: requestedVersion,
      migrated: true,
      counts
    };
  }

  /**
   * Retrieves all locally cached blocked users.
   * @returns {Promise<Array<object>>}
   */
  async getBlockedUsers() {
    await this._getAuthorizedUser();
    const rows = await this.databaseManager.all('SELECT * FROM blocked_users ORDER BY updated_at DESC;');
    return (rows || []).map((r) => ({
      userId: r.user_id,
      user_id: r.user_id,
      displayName: r.display_name,
      display_name: r.display_name,
      phone: r.phone,
      since: r.since,
      updatedAt: r.updated_at,
      updated_at: r.updated_at
    }));
  }

  /**
   * Closes the underlying database connection if open.
   */
  async close() {
    if (this.databaseManager) {
      await this.databaseManager.close();
    }
  }

  /**
   * Replaces or upserts multiple blocked users.
   * @param {Array<object>} users
   * @returns {Promise<{ ok: boolean, count: number }>}
   */
  async saveBlockedUsers(users = []) {
    await this._getAuthorizedUser();
    if (!Array.isArray(users)) return { ok: true, count: 0 };
    const now = new Date().toISOString();
    await this.databaseManager.transaction(async () => {
      await this.databaseManager.run('DELETE FROM blocked_users;');
      for (const u of users) {
        const userId = u.userId || u.user_id;
        if (!userId) continue;
        const displayName = u.displayName || u.display_name || null;
        const phone = u.phone || null;
        const since = u.since || now;
        await this.databaseManager.run(
          `INSERT INTO blocked_users (user_id, display_name, phone, since, updated_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(user_id) DO UPDATE SET
             display_name = coalesce(excluded.display_name, blocked_users.display_name),
             phone = coalesce(excluded.phone, blocked_users.phone),
             since = coalesce(excluded.since, blocked_users.since),
             updated_at = excluded.updated_at;`,
          [userId, displayName, phone, since, now]
        );
      }
    });
    return { ok: true, count: users.length };
  }

  /**
   * Adds or updates a single blocked user locally.
   * @param {object} user
   * @returns {Promise<{ ok: boolean }>}
   */
  async addBlockedUser(user = {}) {
    await this._getAuthorizedUser();
    const userId = user.userId || user.user_id;
    if (!userId) return { ok: false };
    const now = new Date().toISOString();
    const displayName = user.displayName || user.display_name || null;
    const phone = user.phone || null;
    const since = user.since || now;
    await this.databaseManager.run(
      `INSERT INTO blocked_users (user_id, display_name, phone, since, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         display_name = coalesce(excluded.display_name, blocked_users.display_name),
         phone = coalesce(excluded.phone, blocked_users.phone),
         since = coalesce(excluded.since, blocked_users.since),
         updated_at = excluded.updated_at;`,
      [userId, displayName, phone, since, now]
    );
    return { ok: true };
  }

  /**
   * Removes a blocked user locally.
   * @param {string} userId
   * @returns {Promise<{ ok: boolean }>}
   */
  async removeBlockedUser(userId) {
    await this._getAuthorizedUser();
    if (!userId) return { ok: false };
    await this.databaseManager.run('DELETE FROM blocked_users WHERE user_id = ?;', [userId]);
    return { ok: true };
  }

  /**
   * Registers strictly-typed IPC handlers with Electron ipcMain.
   * @param {import('electron').IpcMain} ipcMain
   */
  registerIpcHandlers(ipcMain) {
    const wrap = (fn) => async (_event, payload) => {
      try {
        const data = await fn(payload);
        return { ok: true, data };
      } catch (err) {
        return {
          ok: false,
          error: {
            message: err.message || 'Database request failed',
            code: err.code || 'DB_ERROR'
          }
        };
      }
    };

    ipcMain.handle('db:get-conversations', wrap((payload) => this.getConversations(payload)));
    ipcMain.handle('db:save-conversation', wrap((payload) => this.saveConversation(payload)));
    ipcMain.handle('db:delete-conversation', wrap((payload) => this.deleteConversation(payload)));
    ipcMain.handle('db:get-messages', wrap((payload) => this.getMessages(payload)));
    ipcMain.handle('db:get-message-by-id', wrap((payload) => this.getMessageById(payload)));
    ipcMain.handle('db:save-message', wrap((payload) => this.saveMessage(payload)));
    ipcMain.handle('db:update-message-status', wrap((payload) => this.updateMessageStatus(payload)));
    ipcMain.handle('db:update-message-starred', wrap((payload) => this.updateMessageStarred(payload)));
    ipcMain.handle('db:get-starred-messages', wrap((payload) => this.getStarredMessages(payload)));
    ipcMain.handle('db:get-message-receipts', wrap((payload) => this.getMessageReceipts(payload)));
    ipcMain.handle('db:update-message-reaction', wrap((payload) => this.updateMessageReaction(payload)));
    ipcMain.handle('db:get-message-reactions', wrap((payload) => this.getMessageReactions(payload)));
    ipcMain.handle('db:update-message-edit', wrap((payload) => this.updateMessageEdit(payload)));
    ipcMain.handle('db:mark-message-deleted', wrap((payload) => this.markMessageDeleted(payload)));
    ipcMain.handle('db:mark-message-deleted-for-me', wrap((payload) => this.markMessageDeletedForMe(payload)));
    ipcMain.handle('db:save-call-record', wrap((payload) => this.saveCallRecord(payload)));
    ipcMain.handle('db:get-call-records', wrap((payload) => this.getCallRecords(payload)));
    ipcMain.handle('db:get-pending-outbox', wrap((payload) => this.getPendingOutbox(payload)));
    ipcMain.handle('db:save-pending-outbox', wrap((payload) => this.savePendingOutbox(payload)));
    ipcMain.handle('db:update-pending-outbox-attempt', wrap((payload) => this.updatePendingOutboxAttempt(payload)));
    ipcMain.handle('db:clear-pending-outbox-item', wrap((payload) => this.clearPendingOutboxItem(payload)));
    ipcMain.handle('db:get-metadata', wrap((payload) => this.getMetadata(payload)));
    ipcMain.handle('db:set-metadata', wrap((payload) => this.setMetadata(payload)));
    ipcMain.handle('db:get-custom-lists', wrap((payload) => this.getCustomLists(payload)));
    ipcMain.handle('db:save-custom-lists', wrap((payload) => this.saveCustomLists(payload)));
    ipcMain.handle('db:migrate-localstorage', wrap((payload) => this.migrateLocalStorage(payload)));
    ipcMain.handle('db:save-upload-session', wrap((payload) => this.saveUploadSession(payload)));
    ipcMain.handle('db:update-upload-session', wrap((payload) => this.updateUploadSession(payload)));
    ipcMain.handle('db:get-upload-session', wrap((payload) => this.getUploadSession(payload)));
    ipcMain.handle('db:get-pending-upload-sessions', wrap((payload) => this.getPendingUploadSessions(payload)));
    ipcMain.handle('db:delete-upload-session', wrap((payload) => this.deleteUploadSession(payload)));
    ipcMain.handle('db:clean-stale-upload-sessions', wrap((payload) => this.cleanStaleUploadSessions(payload)));
    ipcMain.handle('db:get-cached-contacts', wrap((payload) => this.getCachedContacts(payload)));
    ipcMain.handle('db:save-cached-contacts', wrap((payload) => this.saveCachedContacts(payload)));
    ipcMain.handle('db:get-blocked-users', wrap(() => this.getBlockedUsers()));
    ipcMain.handle('db:save-blocked-users', wrap((payload) => this.saveBlockedUsers(payload)));
    ipcMain.handle('db:add-blocked-user', wrap((payload) => this.addBlockedUser(payload)));
    ipcMain.handle('db:remove-blocked-user', wrap((payload) => this.removeBlockedUser(payload)));
  }
}
