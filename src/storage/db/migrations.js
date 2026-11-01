/**
 * Schema migrations definition for OllaChat Windows local SQLite database.
 * Each migration object must provide:
 * - version: integer uniquely identifying the migration step
 * - description: human-readable purpose of the migration
 * - up: async function(db) executing the DDL/DML statements
 */

export const MIGRATIONS = [
  {
    version: 1,
    description: 'Initial schema: conversations, messages, message_receipts, attachments, pending_outbox, call_records, custom_lists, and app_metadata',
    up: async (db) => {
      await db.exec(`
        -- 1. Conversations Table
        CREATE TABLE IF NOT EXISTS conversations (
          room_id TEXT PRIMARY KEY,
          kind TEXT NOT NULL DEFAULT 'direct',
          room_name TEXT,
          peer_user_id TEXT,
          peer_phone TEXT,
          peer_display_name TEXT,
          last_message_id TEXT,
          last_message_preview TEXT,
          last_message_time TEXT,
          last_event_seq INTEGER DEFAULT 0,
          unread_count INTEGER DEFAULT 0,
          is_archived INTEGER DEFAULT 0,
          is_pinned INTEGER DEFAULT 0,
          pinned_order INTEGER DEFAULT 0,
          is_favourite INTEGER DEFAULT 0,
          is_marked_unread INTEGER DEFAULT 0,
          draft_text TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_conversations_updated ON conversations(updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_conversations_pinned ON conversations(is_pinned, pinned_order);

        -- 2. Messages Table
        CREATE TABLE IF NOT EXISTS messages (
          id TEXT PRIMARY KEY,
          room_id TEXT NOT NULL,
          sender_id TEXT NOT NULL,
          client_message_id TEXT UNIQUE,
          kind TEXT NOT NULL DEFAULT 'text',
          body_json TEXT NOT NULL,
          reply_to_id TEXT,
          event_seq INTEGER DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'sent',
          is_deleted INTEGER DEFAULT 0,
          is_starred INTEGER DEFAULT 0,
          is_deleted_for_me INTEGER DEFAULT 0,
          edited_at TEXT,
          created_at TEXT NOT NULL,
          local_received_at TEXT NOT NULL,
          FOREIGN KEY (room_id) REFERENCES conversations(room_id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_messages_room_created ON messages(room_id, created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_messages_room_seq ON messages(room_id, event_seq ASC);
        CREATE INDEX IF NOT EXISTS idx_messages_client_msg_id ON messages(client_message_id);
        CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);

        -- 3. Message Receipts Table
        CREATE TABLE IF NOT EXISTS message_receipts (
          message_id TEXT NOT NULL,
          recipient_id TEXT NOT NULL,
          status TEXT NOT NULL,
          receipt_timestamp TEXT NOT NULL,
          PRIMARY KEY (message_id, recipient_id),
          FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_receipts_message ON message_receipts(message_id);

        -- 4. Attachments Metadata Table (Metadata only, binaries stay in disk cache)
        CREATE TABLE IF NOT EXISTS attachments (
          id TEXT PRIMARY KEY,
          message_id TEXT NOT NULL,
          room_id TEXT NOT NULL,
          file_name TEXT NOT NULL,
          mime_type TEXT NOT NULL,
          file_size INTEGER NOT NULL,
          remote_url TEXT,
          local_cache_path TEXT,
          download_status TEXT DEFAULT 'pending',
          created_at TEXT NOT NULL,
          FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE,
          FOREIGN KEY (room_id) REFERENCES conversations(room_id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_attachments_msg ON attachments(message_id);

        -- 5. Pending Outbox Table (Offline resilience)
        CREATE TABLE IF NOT EXISTS pending_outbox (
          client_message_id TEXT PRIMARY KEY,
          room_id TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          retry_count INTEGER DEFAULT 0,
          last_attempt_at TEXT,
          created_at TEXT NOT NULL,
          FOREIGN KEY (room_id) REFERENCES conversations(room_id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_outbox_created ON pending_outbox(created_at ASC);

        -- 6. Call Records Table (Replacing localStorage call rings)
        CREATE TABLE IF NOT EXISTS call_records (
          id TEXT PRIMARY KEY,
          call_id TEXT NOT NULL,
          room_id TEXT NOT NULL,
          peer_user_id TEXT NOT NULL,
          direction TEXT NOT NULL,
          call_type TEXT NOT NULL,
          status TEXT NOT NULL,
          duration_seconds INTEGER DEFAULT 0,
          started_at TEXT NOT NULL,
          FOREIGN KEY (room_id) REFERENCES conversations(room_id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_call_records_room ON call_records(room_id, started_at DESC);
        CREATE INDEX IF NOT EXISTS idx_call_records_global ON call_records(started_at DESC);

        -- 7. Custom Lists Tables
        CREATE TABLE IF NOT EXISTS custom_lists (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS custom_list_members (
          list_id TEXT NOT NULL,
          room_id TEXT NOT NULL,
          PRIMARY KEY (list_id, room_id),
          FOREIGN KEY (list_id) REFERENCES custom_lists(id) ON DELETE CASCADE,
          FOREIGN KEY (room_id) REFERENCES conversations(room_id) ON DELETE CASCADE
        );

        -- 8. Application & Sync Metadata Table
        CREATE TABLE IF NOT EXISTS app_metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
    }
  },
  {
    version: 2,
    description: 'Add upload_sessions table for bounded and resumable multipart media uploads',
    up: async (db) => {
      await db.exec(`
        -- 9. Upload Sessions Table (Resumable & Bounded Multipart Uploads)
        CREATE TABLE IF NOT EXISTS upload_sessions (
          id TEXT PRIMARY KEY,
          room_id TEXT NOT NULL,
          file_path TEXT NOT NULL,
          filename TEXT NOT NULL,
          mime_type TEXT NOT NULL,
          byte_size INTEGER NOT NULL,
          is_multipart INTEGER NOT NULL DEFAULT 0,
          attachment_id TEXT,
          upload_id TEXT,
          part_size INTEGER DEFAULT 8388608,
          total_parts INTEGER DEFAULT 1,
          part_urls_json TEXT,
          completed_parts_json TEXT,
          status TEXT NOT NULL DEFAULT 'pending',
          error_message TEXT,
          expires_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (room_id) REFERENCES conversations(room_id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_upload_sessions_room ON upload_sessions(room_id, status);
        CREATE INDEX IF NOT EXISTS idx_upload_sessions_status ON upload_sessions(status);
        CREATE INDEX IF NOT EXISTS idx_upload_sessions_updated ON upload_sessions(updated_at DESC);
      `);
    }
  },
  {
    version: 3,
    description: 'Add contact_cache table with indices and seed from existing direct conversations',
    up: async (db) => {
      await db.exec(`
        -- 10. Contact Cache Table (Offline resilience, cached-first directory lookups)
        CREATE TABLE IF NOT EXISTS contact_cache (
          phone TEXT PRIMARY KEY,
          user_id TEXT,
          display_name TEXT,
          is_registered INTEGER NOT NULL DEFAULT 1,
          cached_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_contact_cache_user_id ON contact_cache(user_id);
        CREATE INDEX IF NOT EXISTS idx_contact_cache_updated_at ON contact_cache(updated_at DESC);
      `);

      // Seed direct-chat contacts from conversations so existing contacts are immediately available offline
      await db.exec(`
        INSERT OR IGNORE INTO contact_cache (phone, user_id, display_name, is_registered, cached_at, updated_at)
        SELECT DISTINCT peer_phone, peer_user_id, peer_display_name, 1, updated_at, updated_at
        FROM conversations
        WHERE peer_phone IS NOT NULL AND trim(peer_phone) != '' AND peer_user_id IS NOT NULL;
      `);
    }
  },
  {
    version: 4,
    description: 'Add muted_until column to conversations and create blocked_users table',
    up: async (db) => {
      // 1. Add muted_until to conversations if not already present
      const tableInfo = await db.all("PRAGMA table_info('conversations');");
      const hasMutedUntil = Array.isArray(tableInfo) && tableInfo.some((col) => col.name === 'muted_until');
      if (!hasMutedUntil) {
        await db.exec('ALTER TABLE conversations ADD COLUMN muted_until TEXT;');
      }

      // 2. Create blocked_users table
      await db.exec(`
        CREATE TABLE IF NOT EXISTS blocked_users (
          user_id TEXT PRIMARY KEY,
          display_name TEXT,
          phone TEXT,
          since TEXT,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_blocked_users_updated ON blocked_users(updated_at DESC);
      `);
    }
  },
  {
    version: 5,
    description: 'Add separate delivered_at and read_at columns to message_receipts and staged_receipts',
    up: async (db) => {
      const receiptCols = await db.all("PRAGMA table_info('message_receipts');").catch(() => []);
      const hasDeliveredAt = Array.isArray(receiptCols) && receiptCols.some((c) => c.name === 'delivered_at');
      if (!hasDeliveredAt) {
        await db.exec('ALTER TABLE message_receipts ADD COLUMN delivered_at TEXT;');
      }
      const hasReadAt = Array.isArray(receiptCols) && receiptCols.some((c) => c.name === 'read_at');
      if (!hasReadAt) {
        await db.exec('ALTER TABLE message_receipts ADD COLUMN read_at TEXT;');
      }

      await db.exec(`
        UPDATE message_receipts SET delivered_at = receipt_timestamp WHERE status = 'delivered' AND delivered_at IS NULL;
        UPDATE message_receipts SET read_at = receipt_timestamp WHERE status = 'read' AND read_at IS NULL;
      `);

      const stagedCols = await db.all("PRAGMA table_info('staged_receipts');").catch(() => []);
      if (Array.isArray(stagedCols) && stagedCols.length > 0) {
        const hasStagedDelivered = stagedCols.some((c) => c.name === 'delivered_at');
        if (!hasStagedDelivered) {
          await db.exec('ALTER TABLE staged_receipts ADD COLUMN delivered_at TEXT;');
        }
        const hasStagedRead = stagedCols.some((c) => c.name === 'read_at');
        if (!hasStagedRead) {
          await db.exec('ALTER TABLE staged_receipts ADD COLUMN read_at TEXT;');
        }
      }
    }
  }
];
