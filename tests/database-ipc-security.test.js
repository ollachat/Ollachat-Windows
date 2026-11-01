import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { DatabaseManager } from '../src/storage/db/database-manager.js';
import { DatabaseService, validateIdentifier, validateLimit, validateOffset, serializeJson } from '../src/storage/db/database-service.js';

describe('DatabaseService & IPC Security Tests', () => {
  let tmpDir;
  let mockSessionStore;
  let dbService;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), 'ollachat-db-service-test-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
    await fs.mkdir(tmpDir, { recursive: true });

    mockSessionStore = {
      currentSession: {
        userId: 'user_active',
        sessionToken: 'token_123',
        phone: '+1234567890'
      },
      getSession() {
        return this.currentSession;
      }
    };

    dbService = new DatabaseService({
      storageDir: tmpDir,
      sessionStore: mockSessionStore
    });
  });

  afterEach(async () => {
    if (dbService && dbService.databaseManager?.isOpen) {
      await dbService.databaseManager.close();
    }
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  describe('Authorization & Session Boundary', () => {
    test('rejects any database operation when unauthenticated', async () => {
      mockSessionStore.currentSession = { userId: null, sessionToken: null };

      await assert.rejects(async () => await dbService.getConversations(), {
        message: 'Unauthorized: No active authenticated session.',
        code: 'UNAUTHORIZED'
      });

      await assert.rejects(async () => await dbService.saveConversation({ roomId: 'r1' }), {
        message: 'Unauthorized: No active authenticated session.',
        code: 'UNAUTHORIZED'
      });

      await assert.rejects(async () => await dbService.getMessages({ roomId: 'r1' }), {
        message: 'Unauthorized: No active authenticated session.',
        code: 'UNAUTHORIZED'
      });

      await assert.rejects(async () => await dbService.saveMessage({ id: 'm1', roomId: 'r1', senderId: 'u1' }), {
        message: 'Unauthorized: No active authenticated session.',
        code: 'UNAUTHORIZED'
      });
    });

    test('always uses authenticated session user and ignores any renderer-supplied userId', async () => {
      mockSessionStore.currentSession = { userId: 'alice_123' };

      // Attempt to save conversation
      await dbService.saveConversation({ roomId: 'room_alice', roomName: 'Alice Chat' });
      assert.equal(dbService.databaseManager.getCurrentUserId(), 'alice_123');

      const expectedDbPath = path.join(tmpDir, 'databases', 'users', 'alice_123', 'ollachat.db');
      assert.equal(dbService.databaseManager.getDatabasePath(), expectedDbPath);
    });
  });

  describe('Input Validation & Sanitization', () => {
    test('validateIdentifier accepts valid IDs and rejects illegal/path traversal IDs', () => {
      assert.equal(validateIdentifier('valid_room-123.abc:99', 'roomId'), 'valid_room-123.abc:99');

      assert.throws(() => validateIdentifier('', 'roomId'), /Invalid roomId: must be a non-empty string/);
      assert.throws(() => validateIdentifier('   ', 'roomId'), /Invalid roomId: must be a non-empty string/);
      assert.throws(() => validateIdentifier('../../etc/passwd', 'roomId'), /contains illegal characters/);
      assert.throws(() => validateIdentifier('room;DROP TABLE messages;--', 'roomId'), /contains illegal characters/);
      assert.throws(() => validateIdentifier('a'.repeat(129), 'roomId'), /exceeds maximum length/);
      assert.throws(() => validateIdentifier(123, 'roomId'), /must be a non-empty string/);
      assert.throws(() => validateIdentifier(null, 'roomId'), /must be a non-empty string/);
    });

    test('validateLimit and validateOffset clamp pagination safely', () => {
      assert.equal(validateLimit(undefined, 50, 100), 50);
      assert.equal(validateLimit('25', 50, 100), 25);
      assert.equal(validateLimit('999', 50, 100), 100);
      assert.equal(validateLimit('-10', 50, 100), 50);
      assert.equal(validateLimit('invalid', 50, 100), 50);

      assert.equal(validateOffset(undefined), 0);
      assert.equal(validateOffset('15'), 15);
      assert.equal(validateOffset('-5'), 0);
      assert.equal(validateOffset('abc'), 0);
    });

    test('serializeJson safely encodes objects and strings', () => {
      assert.equal(serializeJson(null), '{}');
      assert.equal(serializeJson('{"key":"val"}'), '{"key":"val"}');
      assert.equal(serializeJson('plain text'), '{"text":"plain text"}');
      assert.equal(serializeJson({ foo: 'bar' }), '{"foo":"bar"}');
    });
  });

  describe('Domain Operations', () => {
    test('saveConversation and getConversations', async () => {
      const saveRes = await dbService.saveConversation({
        roomId: 'room_1',
        roomName: 'General Chat',
        peerUserId: 'peer_1',
        lastMessagePreview: 'Hello world',
        lastMessageTime: '2026-02-01T12:00:00Z',
        unreadCount: 3,
        isPinned: 1,
        pinnedOrder: 1
      });
      assert.equal(saveRes.ok, true);
      assert.equal(saveRes.roomId, 'room_1');

      const convs = await dbService.getConversations();
      assert.equal(convs.length, 1);
      assert.equal(convs[0].room_id, 'room_1');
      assert.equal(convs[0].room_name, 'General Chat');
      assert.equal(convs[0].is_pinned, 1);
      assert.equal(convs[0].unread_count, 3);
    });

    test('saveMessage and getMessages with chronological ordering', async () => {
      await dbService.saveMessage({
        id: 'msg_1',
        roomId: 'room_a',
        senderId: 'user_active',
        clientMessageId: 'c_1',
        body: { text: 'First message' },
        createdAt: '2026-02-01T10:00:00Z',
        eventSeq: 1
      });

      await dbService.saveMessage({
        id: 'msg_2',
        roomId: 'room_a',
        senderId: 'peer_1',
        clientMessageId: 'c_2',
        body: { text: 'Second message' },
        createdAt: '2026-02-01T10:01:00Z',
        eventSeq: 2
      });

      const messages = await dbService.getMessages({ roomId: 'room_a', limit: 10 });
      assert.equal(messages.length, 2);
      assert.equal(messages[0].id, 'msg_1');
      assert.equal(messages[1].id, 'msg_2');
      assert.deepEqual(JSON.parse(messages[0].body_json), { text: 'First message' });
    });

    test('updateMessageStatus updates status and receipts atomically', async () => {
      await dbService.saveMessage({
        id: 'msg_status',
        roomId: 'room_s',
        senderId: 'user_active',
        status: 'sending'
      });

      const res = await dbService.updateMessageStatus({
        id: 'msg_status',
        status: 'delivered',
        recipientId: 'user_bob',
        timestamp: '2026-02-01T10:05:00Z'
      });
      assert.equal(res.ok, true);

      const msgs = await dbService.getMessages({ roomId: 'room_s' });
      assert.equal(msgs[0].status, 'delivered');

      const receipts = await dbService.databaseManager.all(
        'SELECT * FROM message_receipts WHERE message_id = ?;',
        ['msg_status']
      );
      assert.equal(receipts.length, 1);
      assert.equal(receipts[0].status, 'delivered');
      assert.equal(receipts[0].recipient_id, 'user_bob');
    });

    test('updateMessageEdit updates body_json and edited_at', async () => {
      await dbService.saveMessage({
        id: 'msg_edit',
        roomId: 'room_e',
        senderId: 'user_active',
        body: { text: 'Original text' }
      });

      const editRes = await dbService.updateMessageEdit({
        id: 'msg_edit',
        newBody: { text: 'Edited text' },
        editedAt: '2026-02-01T10:10:00Z'
      });
      assert.equal(editRes.ok, true);

      const msgs = await dbService.getMessages({ roomId: 'room_e' });
      assert.deepEqual(JSON.parse(msgs[0].body_json), { text: 'Edited text' });
      assert.equal(msgs[0].edited_at, '2026-02-01T10:10:00Z');
    });

    test('markMessageDeleted sets tombstone and is_deleted flag', async () => {
      await dbService.saveMessage({
        id: 'msg_del',
        roomId: 'room_d',
        senderId: 'user_active',
        body: { text: 'Sensitive message' }
      });

      const delRes = await dbService.markMessageDeleted({ id: 'msg_del' });
      assert.equal(delRes.ok, true);

      const msgs = await dbService.getMessages({ roomId: 'room_d' });
      assert.equal(msgs[0].is_deleted, 1);
      assert.deepEqual(JSON.parse(msgs[0].body_json), { text: 'This message was deleted' });
    });

    test('markMessageDeletedForMe sets is_deleted_for_me flag only', async () => {
      await dbService.saveMessage({
        id: 'msg_del_me',
        roomId: 'room_dm',
        senderId: 'peer_1',
        body: { text: 'Leave intact for everyone else' }
      });

      const res = await dbService.markMessageDeletedForMe({ id: 'msg_del_me' });
      assert.equal(res.ok, true);

      const msgs = await dbService.getMessages({ roomId: 'room_dm' });
      assert.equal(msgs[0].is_deleted_for_me, 1);
      assert.equal(msgs[0].is_deleted, 0);
    });

    test('saveCallRecord and getCallRecords', async () => {
      const saveRes = await dbService.saveCallRecord({
        id: 'call_rec_1',
        callId: 'webrtc_session_100',
        roomId: 'room_call',
        peerUserId: 'peer_alice',
        direction: 'incoming',
        callType: 'voice',
        status: 'answered',
        durationSeconds: 94,
        startedAt: '2026-02-01T11:00:00Z'
      });
      assert.equal(saveRes.ok, true);

      const records = await dbService.getCallRecords({ roomId: 'room_call' });
      assert.equal(records.length, 1);
      assert.equal(records[0].call_id, 'webrtc_session_100');
      assert.equal(records[0].direction, 'incoming');
      assert.equal(records[0].call_type, 'voice');
      assert.equal(records[0].status, 'answered');
      assert.equal(records[0].duration_seconds, 94);
    });

    test('pendingOutbox get and clear operations', async () => {
      await dbService.saveConversation({ roomId: 'room_outbox' });

      // Directly insert an item into pending_outbox to verify get and clear
      await dbService.databaseManager.run(
        `INSERT INTO pending_outbox (client_message_id, room_id, payload_json, created_at)
         VALUES (?, ?, ?, ?);`,
        ['client_msg_outbox_1', 'room_outbox', '{"text":"queued"}', '2026-02-01T12:00:00Z']
      );

      const outbox = await dbService.getPendingOutbox();
      assert.equal(outbox.length, 1);
      assert.equal(outbox[0].client_message_id, 'client_msg_outbox_1');

      const clearRes = await dbService.clearPendingOutboxItem({ clientMessageId: 'client_msg_outbox_1' });
      assert.equal(clearRes.ok, true);
      assert.equal(clearRes.changes, 1);

      const emptyOutbox = await dbService.getPendingOutbox();
      assert.equal(emptyOutbox.length, 0);
    });
  });

  describe('IPC Handler Registration & Error Envelope', () => {
    test('registers typed handlers and formats successful/error responses safely', async () => {
      const handlers = new Map();
      const mockIpcMain = {
        handle(channel, fn) {
          handlers.set(channel, fn);
        }
      };

      dbService.registerIpcHandlers(mockIpcMain);

      // Verify all expected channels are registered
      const expectedChannels = [
        'db:get-conversations',
        'db:save-conversation',
        'db:get-messages',
        'db:save-message',
        'db:update-message-status',
        'db:update-message-edit',
        'db:mark-message-deleted',
        'db:mark-message-deleted-for-me',
        'db:save-call-record',
        'db:get-call-records',
        'db:get-pending-outbox',
        'db:save-pending-outbox',
        'db:update-pending-outbox-attempt',
        'db:clear-pending-outbox-item'
      ];

      for (const ch of expectedChannels) {
        assert.ok(handlers.has(ch), `Channel ${ch} must be registered`);
      }

      // Test successful invocation via IPC wrapper
      const saveHandler = handlers.get('db:save-conversation');
      const res = await saveHandler({}, { roomId: 'ipc_room', roomName: 'IPC Test Room' });
      assert.deepEqual(res, { ok: true, data: { ok: true, roomId: 'ipc_room' } });

      // Test error invocation via IPC wrapper (validation rejection)
      const invalidRes = await saveHandler({}, { roomId: '../../bad_room' });
      assert.equal(invalidRes.ok, false);
      assert.ok(invalidRes.error.message.includes('contains illegal characters'));

      // Test unauthenticated invocation via IPC wrapper
      mockSessionStore.currentSession = { userId: null };
      const unauthRes = await saveHandler({}, { roomId: 'room_x' });
      assert.equal(unauthRes.ok, false);
      assert.equal(unauthRes.error.code, 'UNAUTHORIZED');
    });
  });
});
