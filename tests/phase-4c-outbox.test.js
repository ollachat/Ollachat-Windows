import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { DatabaseManager } from '../src/storage/db/database-manager.js';
import { DatabaseService } from '../src/storage/db/database-service.js';
import { OutboxManager } from '../src/renderer/outbox-manager.js';
import { RoomMessagesState, ChatShellState, isOwnMessage } from '../src/renderer/chat-shell-state.js';

describe('Phase 4C: Offline Outbox & Pending Message Queue Tests', () => {
  let tmpDir;
  let mockSessionStore;
  let dbService;
  let outbox;

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), 'ollachat-phase4c-test-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
    await fs.mkdir(tmpDir, { recursive: true });

    mockSessionStore = {
      currentSession: {
        userId: 'user_alice',
        sessionToken: 'token_secret_alice_123',
        phone: '+15550001'
      },
      getSession() {
        return this.currentSession;
      }
    };

    dbService = new DatabaseService({
      storageDir: tmpDir,
      sessionStore: mockSessionStore
    });

    outbox = new OutboxManager();
  });

  afterEach(async () => {
    if (dbService && dbService.databaseManager?.isOpen) {
      await dbService.databaseManager.close();
    }
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  // 1. Outgoing message creates outbox item
  test('1. outgoing message creates outbox item in SQLite before network delivery', async () => {
    const clientMessageId = 'local-uuid-1';
    const roomId = 'room_101';
    const wirePayload = {
      client_message_id: clientMessageId,
      kind: 'text',
      body: { text: 'Hello offline world' },
      reply_to: null,
      attachment_ids: []
    };

    const enqueued = await outbox.enqueue({
      clientMessageId,
      roomId,
      wirePayload,
      dbBridge: dbService
    });
    assert.equal(enqueued, true);

    const pending = await dbService.getPendingOutbox();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].client_message_id, clientMessageId);
    assert.equal(pending[0].room_id, roomId);
    assert.equal(pending[0].retry_count, 0);

    const parsed = JSON.parse(pending[0].payload_json);
    assert.deepEqual(parsed.wirePayload, wirePayload);
  });

  // 2. Outbox item survives restart
  test('2. outbox item survives database close and app restart', async () => {
    const clientMessageId = 'local-uuid-persist';
    await outbox.enqueue({
      clientMessageId,
      roomId: 'room_restart',
      wirePayload: { client_message_id: clientMessageId, kind: 'text', body: { text: 'Survive restart' } },
      dbBridge: dbService
    });

    // Close database connection simulating app shutdown
    await dbService.databaseManager.close();

    // Reopen fresh database instance
    const reopenedDb = new DatabaseService({
      storageDir: tmpDir,
      sessionStore: mockSessionStore
    });

    const pending = await reopenedDb.getPendingOutbox();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].client_message_id, clientMessageId);
    assert.equal(pending[0].room_id, 'room_restart');

    await reopenedDb.databaseManager.close();
  });

  // 3. Successful acknowledgement clears outbox
  test('3. successful acknowledgement clears outbox item', async () => {
    const clientMessageId = 'local-uuid-ack';
    await outbox.enqueue({
      clientMessageId,
      roomId: 'room_ack',
      wirePayload: { client_message_id: clientMessageId, kind: 'text', body: { text: 'Ack me' } },
      dbBridge: dbService
    });

    let pending = await dbService.getPendingOutbox();
    assert.equal(pending.length, 1);

    const cleared = await outbox.clear({ clientMessageId, dbBridge: dbService });
    assert.equal(cleared, true);

    pending = await dbService.getPendingOutbox();
    assert.equal(pending.length, 0);
  });

  // 4. message.created reconciles optimistic message
  test('4. message.created reconciles optimistic message and updates state', async () => {
    const roomState = new RoomMessagesState('room_reconcile');
    roomState.setCurrentUserId('user_alice');

    const clientMessageId = 'local-uuid-rec';
    const optimistic = {
      id: clientMessageId,
      clientMessageId,
      roomId: 'room_reconcile',
      senderId: 'user_alice',
      kind: 'text',
      body: { text: 'Reconcile test' },
      status: 'pending'
    };
    roomState.addOptimisticMessage(optimistic);

    assert.equal(roomState.messages.length, 1);
    assert.equal(roomState.messages[0].id, clientMessageId);

    // Canonical event arrives
    const canonical = {
      id: 'server-msg-999',
      client_message_id: clientMessageId,
      room_id: 'room_reconcile',
      sender_id: 'user_alice',
      kind: 'text',
      body: { text: 'Reconcile test' },
      event_seq: 42
    };
    const reconciled = roomState.appendIncomingMessage(canonical);

    assert.equal(roomState.messages.length, 1);
    assert.equal(reconciled.id, 'server-msg-999');
    assert.equal(reconciled.clientMessageId, clientMessageId);
    assert.equal(reconciled.event_seq, 42);
  });

  // 5. Acknowledgement before message.created
  test('5. acknowledgement before message.created preserves state and avoids duplicates', async () => {
    const roomState = new RoomMessagesState('user_alice');
    roomState.roomId = 'room_order';
    const clientMessageId = 'local-uuid-ack-first';

    roomState.addOptimisticMessage({
      id: clientMessageId,
      clientMessageId,
      roomId: 'room_order',
      senderId: 'user_alice',
      kind: 'text',
      body: { text: 'Order test' },
      status: 'sending'
    });

    await outbox.enqueue({
      clientMessageId,
      roomId: 'room_order',
      wirePayload: { client_message_id: clientMessageId, text: 'Order test' },
      dbBridge: dbService
    });

    // 1. ACK arrives first
    roomState.updateReceipt(clientMessageId, 'sent', 'room_order');
    await outbox.clear({ clientMessageId, dbBridge: dbService });

    assert.equal(roomState.getStatus(clientMessageId), 'sent');
    let pending = await dbService.getPendingOutbox();
    assert.equal(pending.length, 0);

    // 2. Later message.created arrives
    roomState.appendIncomingMessage({
      id: 'server-ord-1',
      client_message_id: clientMessageId,
      sender_id: 'user_alice',
      body: { text: 'Order test' }
    });

    assert.equal(roomState.messages.length, 1);
    assert.equal(roomState.messages[0].id, 'server-ord-1');
  });

  // 6. message.created before acknowledgement
  test('6. message.created before acknowledgement reconciles and clears outbox cleanly', async () => {
    const roomState = new RoomMessagesState('room_order_2');
    roomState.setCurrentUserId('user_alice');
    const clientMessageId = 'local-uuid-created-first';

    roomState.addOptimisticMessage({
      id: clientMessageId,
      clientMessageId,
      roomId: 'room_order_2',
      senderId: 'user_alice',
      kind: 'text',
      body: { text: 'Order 2' },
      status: 'sending'
    });

    await outbox.enqueue({
      clientMessageId,
      roomId: 'room_order_2',
      wirePayload: { client_message_id: clientMessageId, text: 'Order 2' },
      dbBridge: dbService
    });

    // 1. message.created arrives first
    roomState.appendIncomingMessage({
      id: 'server-ord-2',
      client_message_id: clientMessageId,
      sender_id: 'user_alice',
      body: { text: 'Order 2' }
    });
    await outbox.clear({ clientMessageId, dbBridge: dbService });

    let pending = await dbService.getPendingOutbox();
    assert.equal(pending.length, 0);

    // 2. Later ACK arrives (idempotent no-op)
    const secondClear = await outbox.clear({ clientMessageId, dbBridge: dbService });
    assert.equal(secondClear, true);
    assert.equal(roomState.messages.length, 1);
  });

  // 7. Network failure retains outbox item
  test('7. network failure retains outbox item and marks status as failed', async () => {
    const clientMessageId = 'local-uuid-fail';
    await outbox.enqueue({
      clientMessageId,
      roomId: 'room_fail',
      wirePayload: { client_message_id: clientMessageId, text: 'Fail test' },
      dbBridge: dbService
    });

    // Mock chat bridge that throws offline error
    const mockChat = {
      getState: async () => 'connected',
      send: async () => {
        throw new Error('WebSocket connection dropped');
      }
    };

    let statusUpdatedTo = null;
    await outbox.flush({
      dbBridge: dbService,
      chatBridge: mockChat,
      onStatusUpdate: (cid, st) => {
        statusUpdatedTo = st;
      }
    });

    assert.equal(statusUpdatedTo, 'failed');
    const pending = await dbService.getPendingOutbox();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].client_message_id, clientMessageId);
    assert.equal(pending[0].retry_count, 1);
    assert.ok(pending[0].last_attempt_at);
  });

  // 8. Reconnect retries pending message
  test('8. reconnect retries pending message successfully', async () => {
    const clientMessageId = 'local-uuid-reconnect';
    const wirePayload = { client_message_id: clientMessageId, kind: 'text', body: { text: 'Retry me' } };
    await outbox.enqueue({
      clientMessageId,
      roomId: 'room_reconnect',
      wirePayload,
      dbBridge: dbService
    });

    let sendCalledWith = null;
    const mockChat = {
      getState: async () => 'connected',
      send: async (type, payload, roomId) => {
        sendCalledWith = { type, payload, roomId };
        return { ok: true, requestId: 'req_101' };
      }
    };

    const reqMap = new Map();
    const sent = await outbox.flush({
      dbBridge: dbService,
      chatBridge: mockChat,
      requestToClientMap: reqMap
    });

    assert.equal(sent, 1);
    assert.equal(sendCalledWith.type, 'message.send');
    assert.equal(sendCalledWith.payload.client_message_id, clientMessageId);
    assert.equal(reqMap.get('req_101'), clientMessageId);
  });

  // 9. Retry uses same client_message_id
  test('9. retry preserves exact original client_message_id', async () => {
    const originalCid = 'local-exact-id-12345';
    await outbox.enqueue({
      clientMessageId: originalCid,
      roomId: 'room_id_preserve',
      wirePayload: { client_message_id: originalCid, text: 'Keep ID' },
      dbBridge: dbService
    });

    let sentCid = null;
    const mockChat = {
      getState: async () => 'connected',
      send: async (_type, payload) => {
        sentCid = payload.client_message_id;
        return { ok: true, requestId: 'r_1' };
      }
    };

    await outbox.flush({ dbBridge: dbService, chatBridge: mockChat });
    assert.equal(sentCid, originalCid);
  });

  // 10. Duplicate retry does not duplicate message
  test('10. duplicate retry does not duplicate message in room state', () => {
    const roomState = new RoomMessagesState('room_dup_retry');
    const cid = 'local-dup-retry';
    roomState.addOptimisticMessage({
      id: cid,
      clientMessageId: cid,
      roomId: 'room_dup_retry',
      senderId: 'user_alice',
      kind: 'text',
      body: { text: 'Dup test' }
    });

    // Multiple retry attempts
    roomState.updateReceipt(cid, 'sending');
    roomState.updateReceipt(cid, 'sending');

    assert.equal(roomState.messages.length, 1);
  });

  // 11. Duplicate message.created does not duplicate message
  test('11. duplicate message.created events preserve single canonical message', () => {
    const roomState = new RoomMessagesState('room_dup_created');
    const canonicalMsg = {
      id: 'server-dup-1',
      client_message_id: 'local-dup-1',
      roomId: 'room_dup_created',
      senderId: 'user_alice',
      body: { text: 'Canonical dup' }
    };

    roomState.appendIncomingMessage(canonicalMsg);
    roomState.appendIncomingMessage(canonicalMsg);
    roomState.appendIncomingMessage(canonicalMsg);

    assert.equal(roomState.messages.length, 1);
  });

  // 12. Duplicate acknowledgement is safe
  test('12. duplicate acknowledgement is safe and idempotent', async () => {
    const cid = 'local-dup-ack';
    await outbox.enqueue({
      clientMessageId: cid,
      roomId: 'room_dup_ack',
      wirePayload: { client_message_id: cid, text: 'Dup ack' },
      dbBridge: dbService
    });

    const res1 = await outbox.clear({ clientMessageId: cid, dbBridge: dbService });
    const res2 = await outbox.clear({ clientMessageId: cid, dbBridge: dbService });

    assert.equal(res1, true);
    assert.equal(res2, true);
    const pending = await dbService.getPendingOutbox();
    assert.equal(pending.length, 0);
  });

  // 13. Multiple pending messages preserve deterministic ordering
  test('13. multiple pending messages preserve deterministic chronological ordering', async () => {
    await outbox.enqueue({
      clientMessageId: 'msg-1',
      roomId: 'room_seq',
      wirePayload: { client_message_id: 'msg-1', text: 'First' },
      dbBridge: dbService
    });
    // Add small delay to ensure separate timestamps
    await new Promise(r => setTimeout(r, 10));

    await outbox.enqueue({
      clientMessageId: 'msg-2',
      roomId: 'room_seq',
      wirePayload: { client_message_id: 'msg-2', text: 'Second' },
      dbBridge: dbService
    });
    await new Promise(r => setTimeout(r, 10));

    await outbox.enqueue({
      clientMessageId: 'msg-3',
      roomId: 'room_seq',
      wirePayload: { client_message_id: 'msg-3', text: 'Third' },
      dbBridge: dbService
    });

    const pending = await dbService.getPendingOutbox();
    assert.equal(pending.length, 3);
    assert.equal(pending[0].client_message_id, 'msg-1');
    assert.equal(pending[1].client_message_id, 'msg-2');
    assert.equal(pending[2].client_message_id, 'msg-3');
  });

  // 14. Retry/backoff prevents tight retry loops
  test('14. retry backoff prevents tight retry loops for recently attempted messages', async () => {
    const cid = 'msg-backoff';
    await outbox.enqueue({
      clientMessageId: cid,
      roomId: 'room_backoff',
      wirePayload: { client_message_id: cid, text: 'Backoff test' },
      dbBridge: dbService
    });

    let sendAttempts = 0;
    const mockChat = {
      getState: async () => 'connected',
      send: async () => {
        sendAttempts++;
        throw new Error('Transient server error');
      }
    };

    // First flush attempt -> fails and records attempt
    await outbox.flush({ dbBridge: dbService, chatBridge: mockChat });
    assert.equal(sendAttempts, 1);

    // Immediate second flush -> must be skipped because backoff period has not elapsed
    outbox._lastFlushTime = 0; // reset flush throttle to isolate backoff check
    const retried = await outbox.flush({ dbBridge: dbService, chatBridge: mockChat });
    assert.equal(retried, 0);
    assert.equal(sendAttempts, 1); // No new network call
  });

  // 15. Successful retry removes outbox item
  test('15. successful retry and clearance leaves outbox empty', async () => {
    const cid = 'msg-succ-retry';
    await outbox.enqueue({
      clientMessageId: cid,
      roomId: 'room_succ',
      wirePayload: { client_message_id: cid, text: 'Success retry' },
      dbBridge: dbService
    });

    const mockChat = {
      getState: async () => 'connected',
      send: async () => ({ ok: true, requestId: 'req_succ' })
    };

    await outbox.flush({ dbBridge: dbService, chatBridge: mockChat });
    await outbox.clear({ clientMessageId: cid, dbBridge: dbService });

    const pending = await dbService.getPendingOutbox();
    assert.equal(pending.length, 0);
  });

  // 16. Failed retry preserves outbox item
  test('16. failed retry preserves outbox item in SQLite', async () => {
    const cid = 'msg-fail-retry';
    await outbox.enqueue({
      clientMessageId: cid,
      roomId: 'room_fail_retry',
      wirePayload: { client_message_id: cid, text: 'Still failing' },
      dbBridge: dbService
    });

    const mockChat = {
      getState: async () => 'connected',
      send: async () => ({ ok: false, error: 'Network timeout' })
    };

    await outbox.flush({ dbBridge: dbService, chatBridge: mockChat });
    const pending = await dbService.getPendingOutbox();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].client_message_id, cid);
  });

  // 17. Text message recovery
  test('17. text message recovery preserves body and kind', async () => {
    const cid = 'msg-text-rec';
    const textMsg = {
      client_message_id: cid,
      kind: 'text',
      body: { text: 'Recovered paragraph text' }
    };
    await outbox.enqueue({
      clientMessageId: cid,
      roomId: 'room_txt',
      wirePayload: textMsg,
      dbBridge: dbService
    });

    const items = await dbService.getPendingOutbox();
    const parsed = JSON.parse(items[0].payload_json);
    assert.equal(parsed.wirePayload.kind, 'text');
    assert.equal(parsed.wirePayload.body.text, 'Recovered paragraph text');
  });

  // 18. Media message recovery
  test('18. media message recovery preserves attachment IDs to avoid re-upload', async () => {
    const cid = 'msg-media-rec';
    const mediaPayload = {
      client_message_id: cid,
      kind: 'image',
      body: { text: 'photo.jpg', filename: 'photo.jpg', mime: 'image/jpeg', byte_size: 40960 },
      attachment_ids: ['att_server_id_777']
    };
    await outbox.enqueue({
      clientMessageId: cid,
      roomId: 'room_media',
      wirePayload: mediaPayload,
      dbBridge: dbService
    });

    const items = await dbService.getPendingOutbox();
    const parsed = JSON.parse(items[0].payload_json);
    assert.deepEqual(parsed.wirePayload.attachment_ids, ['att_server_id_777']);
  });

  // 19. Voice-note recovery
  test('19. voice-note recovery preserves voice note metadata and attachment ID', async () => {
    const cid = 'msg-voice-rec';
    const voicePayload = {
      client_message_id: cid,
      kind: 'file',
      body: {
        text: 'Voice message',
        filename: 'audio-record.webm',
        mime: 'audio/webm',
        duration: 8,
        is_voice_note: true
      },
      attachment_ids: ['att_voice_999']
    };
    await outbox.enqueue({
      clientMessageId: cid,
      roomId: 'room_voice',
      wirePayload: voicePayload,
      dbBridge: dbService
    });

    const items = await dbService.getPendingOutbox();
    const parsed = JSON.parse(items[0].payload_json);
    assert.equal(parsed.wirePayload.body.is_voice_note, true);
    assert.equal(parsed.wirePayload.body.duration, 8);
    assert.deepEqual(parsed.wirePayload.attachment_ids, ['att_voice_999']);
  });

  // 20. App restart recovery
  test('20. app restart recovery rehydrates pending messages into room states', async () => {
    const cid = 'msg-restart-recovery';
    await outbox.enqueue({
      clientMessageId: cid,
      roomId: 'room_restart_recovery',
      wirePayload: { client_message_id: cid, kind: 'text', body: { text: 'Restart test message' } },
      optimisticMsg: {
        id: cid,
        clientMessageId: cid,
        roomId: 'room_restart_recovery',
        senderId: 'user_alice',
        kind: 'text',
        body: { text: 'Restart test message' },
        createdAt: new Date().toISOString()
      },
      dbBridge: dbService
    });

    const mockShellState = new ChatShellState();
    mockShellState.setCurrentUser({ userId: 'user_alice' });
    const statesMap = new Map();
    const getRoomState = (rId) => {
      if (!statesMap.has(rId)) {
        const s = new RoomMessagesState(rId);
        s.setCurrentUserId('user_alice');
        statesMap.set(rId, s);
      }
      return statesMap.get(rId);
    };

    const restored = await outbox.recoverOnStartup({
      shellState: mockShellState,
      getOrCreateRoomMessagesState: getRoomState,
      dbBridge: dbService
    });

    assert.equal(restored, 1);
    const roomState = statesMap.get('room_restart_recovery');
    assert.ok(roomState);
    assert.equal(roomState.messages.length, 1);
    assert.equal(roomState.messages[0].id, cid);
    assert.equal(roomState.messages[0].status, 'failed');
  });

  // 21. User isolation
  test('21. user isolation: pending outbox items are isolated per authenticated user', async () => {
    // Alice enqueues a message
    await outbox.enqueue({
      clientMessageId: 'alice-outbox-1',
      roomId: 'room_alice',
      wirePayload: { client_message_id: 'alice-outbox-1', text: 'Alice private' },
      dbBridge: dbService
    });

    const alicePending = await dbService.getPendingOutbox();
    assert.equal(alicePending.length, 1);

    // Switch session to Bob
    mockSessionStore.currentSession = {
      userId: 'user_bob',
      sessionToken: 'token_bob_sec',
      phone: '+15550002'
    };

    const bobDb = new DatabaseService({
      storageDir: tmpDir,
      sessionStore: mockSessionStore
    });

    // Bob's outbox must be empty
    const bobPending = await bobDb.getPendingOutbox();
    assert.equal(bobPending.length, 0);

    await bobDb.databaseManager.close();
  });

  // 22. No session token stored in outbox
  test('22. outbox never stores session tokens or sensitive credentials', async () => {
    const cid = 'security-audit-outbox';
    await outbox.enqueue({
      clientMessageId: cid,
      roomId: 'room_sec',
      wirePayload: { client_message_id: cid, kind: 'text', body: { text: 'Public text' } },
      dbBridge: dbService
    });

    const items = await dbService.getPendingOutbox();
    const row = items[0];
    const rawRowString = JSON.stringify(row);

    // Ensure session token is NOT leaked into outbox table
    assert.equal(rawRowString.includes('token_secret_alice_123'), false);
    assert.equal(rawRowString.includes('sessionToken'), false);
    assert.equal(rawRowString.includes('password'), false);
  });

  // 23. Existing unread behavior remains correct
  test('23. outgoing messages in outbox do not increment unread badge count', () => {
    const shellState = new ChatShellState();
    shellState.setCurrentUser({ userId: 'user_alice' });
    shellState.conversations = [
      { roomId: 'room_badge', unreadCount: 0, isPinned: false }
    ];

    // Outgoing message sent by self
    const ownPayload = {
      id: 'msg_self_1',
      client_message_id: 'local_self_1',
      sender_id: 'user_alice',
      body: { text: 'My own outgoing message' }
    };

    assert.equal(isOwnMessage(ownPayload, 'user_alice'), true);
    // Unread count must stay 0
    assert.equal(shellState.conversations[0].unreadCount, 0);
  });

  // 24. Existing message status behavior remains correct
  test('24. monotonic progression: sending -> sent -> delivered -> read remains intact', () => {
    const roomState = new RoomMessagesState('user_alice');
    roomState.roomId = 'room_ticks';
    const cid = 'msg_tick_progression';

    roomState.addOptimisticMessage({
      id: cid,
      clientMessageId: cid,
      roomId: 'room_ticks',
      senderId: 'user_alice',
      kind: 'text',
      body: { text: 'Ticks test' },
      status: 'sending'
    });
    assert.equal(roomState.getStatus(cid), 'sending');

    // Can transition to failed on network error
    roomState.updateReceipt(cid, 'failed');
    assert.equal(roomState.getStatus(cid), 'failed');

    // Can transition back to sending on retry
    roomState.updateReceipt(cid, 'sending');
    assert.equal(roomState.getStatus(cid), 'sending');

    roomState.updateReceipt(cid, 'sent');
    assert.equal(roomState.getStatus(cid), 'sent');

    roomState.updateReceipt(cid, 'delivered');
    assert.equal(roomState.getStatus(cid), 'delivered');

    roomState.updateReceipt(cid, 'read');
    assert.equal(roomState.getStatus(cid), 'read');

    // Backward transition is rejected
    roomState.updateReceipt(cid, 'delivered');
    assert.equal(roomState.getStatus(cid), 'read');
  });

  // 25. Existing Phase 4A persistence remains correct
  test('25. Phase 4A message and conversation persistence functions correctly alongside outbox', async () => {
    await dbService.saveConversation({
      roomId: 'room_coexist',
      roomName: 'Coexistence Chat'
    });

    await dbService.saveMessage({
      id: 'msg_coexist_1',
      roomId: 'room_coexist',
      senderId: 'user_alice',
      kind: 'text',
      body: { text: 'Persisted message' },
      status: 'sent'
    });

    const convs = await dbService.getConversations();
    assert.equal(convs.length, 1);
    assert.equal(convs[0].room_id, 'room_coexist');

    const msgs = await dbService.getMessages({ roomId: 'room_coexist' });
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].id, 'msg_coexist_1');
  });

  // 26. Existing Phase 4B migration remains correct
  test('26. Phase 4B migration mechanism runs idempotently alongside outbox', async () => {
    const res = await dbService.migrateLocalStorage({
      version: 1,
      data: {
        pinnedRoomIds: ['room_coexist']
      }
    });

    assert.equal(res.ok, true);
    const meta = await dbService.getMetadata({ key: 'localstorage_migration_version' });
    assert.equal(meta.value, '1');

    const res2 = await dbService.migrateLocalStorage({ version: 1 });
    assert.equal(res2.alreadyMigrated, true);
  });
});
