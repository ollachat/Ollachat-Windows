import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { DatabaseManager } from '../src/storage/db/database-manager.js';
import { DatabaseService } from '../src/storage/db/database-service.js';
import { OutboxManager } from '../src/renderer/outbox-manager.js';
import {
  RoomMessagesState,
  ChatShellState,
  createOptimisticMessage,
  validateComposerText,
  getTickDescriptor,
  MESSAGE_STATUS,
  STATUS_RANKS
} from '../src/renderer/chat-shell-state.js';
import { sqliteRowToMessage, messageToSqlitePayload } from '../src/renderer/db-sync.js';

describe('Reliable WhatsApp-Style Offline Messaging & Resynchronization', () => {
  let tmpDir;
  let mockSessionStore;
  let dbService;
  let outbox;
  const currentUserId = 'user_offline_alice';

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), 'ollachat-offline-resync-test-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
    await fs.mkdir(tmpDir, { recursive: true });

    mockSessionStore = {
      currentSession: {
        userId: currentUserId,
        sessionToken: 'token_secret_alice_999',
        phone: '+15551234567'
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

  // 1. Connection status detection
  test('1. connection loss reflects disconnected/reconnecting status, never connected', () => {
    const shellState = new ChatShellState();
    shellState.setWsState('connected');
    assert.equal(shellState.wsState, 'connected');

    // Network disconnection
    shellState.setWsState('disconnected', { message: 'Waiting for network' });
    assert.equal(shellState.wsState, 'disconnected');
    assert.notEqual(shellState.wsState, 'connected');

    // Reconnecting state
    shellState.setWsState('reconnecting', { message: 'Reconnecting...' });
    assert.equal(shellState.wsState, 'reconnecting');
    assert.notEqual(shellState.wsState, 'connected');
  });

  // 2. Message composition is never blocked when offline
  test('2. message composition validation succeeds regardless of network status', () => {
    const normalText = 'Hello while offline!';
    const validation = validateComposerText(normalText);
    assert.equal(validation.valid, true);
    assert.equal(validation.text, normalText);
    assert.equal(validation.error, null);

    const multilineText = 'Line 1\nLine 2\nLine 3';
    const multilineValidation = validateComposerText(multilineText);
    assert.equal(multilineValidation.valid, true);
    assert.equal(multilineValidation.text, multilineText);
  });

  // 3. Optimistic rendering with pending clock indicator (🕒)
  test('3. offline outgoing message renders with pending status and clock indicator (🕒)', () => {
    const roomId = 'room_offline_1';
    const roomState = new RoomMessagesState(currentUserId);
    roomState.roomId = roomId;

    const clientMsgId = 'local-offline-msg-1';
    const optMsg = createOptimisticMessage(roomId, currentUserId, 'Testing offline message', clientMsgId);
    optMsg.status = 'pending';
    optMsg.deliveryStatus = 'pending';

    roomState.addOptimisticMessage(optMsg);
    roomState.updateReceipt(clientMsgId, 'pending');

    assert.equal(roomState.getStatus(clientMsgId), 'pending');

    const tick = getTickDescriptor(roomState.getStatus(clientMsgId), true);
    assert.equal(tick.hasTick, true);
    assert.equal(tick.symbol, '🕒');
    assert.equal(tick.statusClass, 'status-pending');
    assert.equal(tick.title, 'Pending');
    assert.notEqual(tick.symbol, '✓', 'Pending message must not display single tick');
  });

  // 4. Persistence to both SQLite messages and pending_outbox with client_message_id
  test('4. offline message is saved to both SQLite messages table and pending_outbox', async () => {
    const roomId = 'room_offline_db';
    const clientMsgId = 'local-offline-uuid-4';
    const text = 'Offline durable message';

    const wirePayload = {
      client_message_id: clientMsgId,
      kind: 'text',
      body: { text },
      reply_to: null,
      attachment_ids: []
    };

    const optMsg = {
      id: clientMsgId,
      clientMessageId: clientMsgId,
      roomId,
      senderId: currentUserId,
      kind: 'text',
      body: { text },
      status: 'pending',
      createdAt: new Date().toISOString()
    };

    // 1. Enqueue to pending_outbox
    const enqueued = await outbox.enqueue({
      clientMessageId: clientMsgId,
      roomId,
      wirePayload,
      optimisticMsg: optMsg,
      dbBridge: dbService
    });
    assert.equal(enqueued, true);

    // 2. Persist to messages table
    const dbPayload = messageToSqlitePayload(optMsg, roomId);
    await dbService.saveMessage(dbPayload);

    // Verify outbox entry
    const outboxItems = await dbService.getPendingOutbox();
    assert.equal(outboxItems.length, 1);
    assert.equal(outboxItems[0].client_message_id, clientMsgId);
    assert.equal(outboxItems[0].room_id, roomId);

    // Verify messages entry
    const savedMsg = await dbService.getMessageById(clientMsgId);
    assert.ok(savedMsg);
    assert.equal(savedMsg.client_message_id, clientMsgId);
    assert.equal(savedMsg.status, 'pending');
  });

  // 5. Preservation of text, destination room, ordering, and metadata
  test('5. payload preservation in outbox retains exact text, roomId, and structure', async () => {
    const roomId = 'room_metadata_test';
    const clientMsgId = 'local-meta-uuid-5';
    const text = 'Special payload with symbols: 🚀 & <XML> & emoji';

    const wirePayload = {
      client_message_id: clientMsgId,
      kind: 'text',
      body: { text, is_forwarded: false },
      reply_to: 'ref-msg-123',
      attachment_ids: []
    };

    await outbox.enqueue({
      clientMessageId: clientMsgId,
      roomId,
      wirePayload,
      dbBridge: dbService
    });

    const pending = await dbService.getPendingOutbox();
    assert.equal(pending.length, 1);
    const parsed = JSON.parse(pending[0].payload_json);
    assert.equal(parsed.client_message_id, clientMsgId);
    assert.equal(parsed.roomId, roomId);
    assert.equal(parsed.wirePayload.body.text, text);
    assert.equal(parsed.wirePayload.reply_to, 'ref-msg-123');
  });

  // 6. Switching chats and returning keeps the pending message visible with pending indicator
  test('6. switching rooms and returning preserves pending optimistic message and clock indicator', () => {
    const roomA = 'room_switch_A';
    const roomB = 'room_switch_B';
    const stateA = new RoomMessagesState(currentUserId);
    stateA.roomId = roomA;

    const clientMsgId = 'local-switch-1';
    const optMsg = createOptimisticMessage(roomA, currentUserId, 'Switching chat test', clientMsgId);
    optMsg.status = 'pending';
    stateA.addOptimisticMessage(optMsg);
    stateA.updateReceipt(clientMsgId, 'pending');

    // Switch to Room B
    const stateB = new RoomMessagesState(currentUserId);
    stateB.roomId = roomB;
    assert.equal(stateB.messages.length, 0);

    // Switch back to Room A and load initial messages (simulating re-selection)
    stateA.setInitialMessages(roomA, []);
    assert.equal(stateA.messages.length, 1);
    assert.equal(stateA.messages[0].clientMessageId, clientMsgId);
    assert.equal(stateA.getStatus(clientMsgId), 'pending');

    const tick = getTickDescriptor(stateA.getStatus(clientMsgId), true);
    assert.equal(tick.symbol, '🕒');
    assert.equal(tick.statusClass, 'status-pending');
  });

  // 7. Simulating app restart rehydrates pending outbox messages as pending (clock indicator)
  test('7. startup recovery rehydrates pending outbox messages with status pending and clock indicator', async () => {
    const roomId = 'room_restart_1';
    const clientMsgId = 'local-restart-msg-7';

    await outbox.enqueue({
      clientMessageId: clientMsgId,
      roomId,
      wirePayload: { client_message_id: clientMsgId, kind: 'text', body: { text: 'Restarted pending' } },
      optimisticMsg: {
        id: clientMsgId,
        clientMessageId: clientMsgId,
        roomId,
        senderId: currentUserId,
        kind: 'text',
        body: { text: 'Restarted pending' },
        status: 'pending'
      },
      dbBridge: dbService
    });

    const shellState = new ChatShellState();
    shellState.setCurrentUser({ userId: currentUserId });
    const statesMap = new Map();
    const getRoomState = (rId) => {
      if (!statesMap.has(rId)) {
        const s = new RoomMessagesState(rId);
        s.setCurrentUserId(currentUserId);
        statesMap.set(rId, s);
      }
      return statesMap.get(rId);
    };

    const restored = await outbox.recoverOnStartup({
      shellState,
      getOrCreateRoomMessagesState: getRoomState,
      dbBridge: dbService,
      defaultStatus: 'pending'
    });

    assert.equal(restored, 1);
    const roomState = statesMap.get(roomId);
    assert.ok(roomState);
    assert.equal(roomState.messages.length, 1);
    assert.equal(roomState.messages[0].id, clientMsgId);
    assert.equal(roomState.getStatus(clientMsgId), 'pending');

    const tick = getTickDescriptor(roomState.getStatus(clientMsgId), true);
    assert.equal(tick.symbol, '🕒');
    assert.equal(tick.statusClass, 'status-pending');
  });

  // 8. Network restoration triggers automatic outbox flush without manual user intervention
  test('8. flush automatically dispatches eligible pending messages over chat bridge', async () => {
    const roomId = 'room_flush_auto';
    const clientMsgId = 'local-flush-auto-8';

    await outbox.enqueue({
      clientMessageId: clientMsgId,
      roomId,
      wirePayload: { client_message_id: clientMsgId, kind: 'text', body: { text: 'Auto flush test' } },
      dbBridge: dbService
    });

    const sentRequests = [];
    const mockChat = {
      getState: async () => 'connected',
      send: async (action, payload, rId) => {
        sentRequests.push({ action, payload, rId });
        return { ok: true, requestId: 'req-auto-8' };
      }
    };

    const statusUpdates = [];
    const flushedCount = await outbox.flush({
      dbBridge: dbService,
      chatBridge: mockChat,
      onStatusUpdate: (cid, st, rId) => {
        statusUpdates.push({ cid, st, rId });
      }
    });

    assert.equal(flushedCount, 1);
    assert.equal(sentRequests.length, 1);
    assert.equal(sentRequests[0].action, 'message.send');
    assert.equal(sentRequests[0].payload.client_message_id, clientMsgId);
    assert.equal(sentRequests[0].rId, roomId);
    assert.ok(statusUpdates.some((u) => u.cid === clientMsgId && u.st === 'sending'));
  });

  // 9. Chronological flush ordering (ORDER BY created_at ASC)
  test('9. multiple queued messages are flushed in strict chronological order', async () => {
    const roomId = 'room_ordered_flush';
    const cids = ['msg-order-1', 'msg-order-2', 'msg-order-3'];

    // Enqueue 3 messages with sequential timestamps
    for (let i = 0; i < cids.length; i++) {
      const cid = cids[i];
      await dbService.savePendingOutbox({
        clientMessageId: cid,
        roomId,
        payloadJson: JSON.stringify({
          client_message_id: cid,
          roomId,
          wirePayload: { client_message_id: cid, text: `Order msg ${i + 1}` }
        }),
        retryCount: 0,
        createdAt: new Date(Date.now() + i * 1000).toISOString()
      });
    }

    const dispatchedOrder = [];
    const mockChat = {
      getState: async () => 'connected',
      send: async (_action, payload) => {
        dispatchedOrder.push(payload.client_message_id);
        return { ok: true, requestId: `req-${payload.client_message_id}` };
      }
    };

    const flushed = await outbox.flush({
      dbBridge: dbService,
      chatBridge: mockChat
    });

    assert.equal(flushed, 3);
    assert.deepEqual(dispatchedOrder, cids, 'Messages must flush in chronological order');
  });

  // 10. Server acknowledgment transitions message to Sent (single tick ✓) and clears outbox
  test('10. server ack transitions message to Sent (✓) and clears item from outbox', async () => {
    const roomId = 'room_ack_10';
    const clientMsgId = 'local-ack-msg-10';

    await outbox.enqueue({
      clientMessageId: clientMsgId,
      roomId,
      wirePayload: { client_message_id: clientMsgId, text: 'Ack test' },
      dbBridge: dbService
    });

    const roomState = new RoomMessagesState(currentUserId);
    roomState.roomId = roomId;
    const opt = createOptimisticMessage(roomId, currentUserId, 'Ack test', clientMsgId);
    opt.status = 'pending';
    roomState.addOptimisticMessage(opt);
    roomState.updateReceipt(clientMsgId, 'pending');

    assert.equal(roomState.getStatus(clientMsgId), 'pending');
    assert.equal(getTickDescriptor(roomState.getStatus(clientMsgId), true).symbol, '🕒');

    // Simulate server ACK / message.created confirmation
    roomState.updateReceipt(clientMsgId, 'sent');
    await outbox.clear({ clientMessageId: clientMsgId, dbBridge: dbService });

    assert.equal(roomState.getStatus(clientMsgId), 'sent');
    const tick = getTickDescriptor(roomState.getStatus(clientMsgId), true);
    assert.equal(tick.hasTick, true);
    assert.equal(tick.symbol, '✓');
    assert.equal(tick.statusClass, 'status-sent');
    assert.equal(tick.title, 'Sent');

    const remainingOutbox = await dbService.getPendingOutbox();
    assert.equal(remainingOutbox.length, 0, 'Outbox item must be cleared after acknowledgment');
  });

  // 11. Delivery receipt progression: sent -> delivered (double grey tick ✓✓)
  test('11. receipt.delivered updates message from sent to delivered (✓✓)', () => {
    const roomState = new RoomMessagesState(currentUserId);
    roomState.roomId = 'room_receipt_11';
    const clientMsgId = 'msg-receipt-11';

    const opt = createOptimisticMessage('room_receipt_11', currentUserId, 'Delivery test', clientMsgId);
    roomState.addOptimisticMessage(opt);
    roomState.updateReceipt(clientMsgId, 'sent');
    assert.equal(getTickDescriptor(roomState.getStatus(clientMsgId), true).symbol, '✓');

    const updated = roomState.updateReceipt(clientMsgId, 'delivered');
    assert.equal(updated, true);
    assert.equal(roomState.getStatus(clientMsgId), 'delivered');

    const tick = getTickDescriptor(roomState.getStatus(clientMsgId), true);
    assert.equal(tick.hasTick, true);
    assert.equal(tick.symbol, '✓✓');
    assert.equal(tick.statusClass, 'status-delivered');
    assert.equal(tick.title, 'Delivered');
  });

  // 12. Read receipt progression: delivered -> read (double blue tick ✓✓)
  test('12. receipt.read updates message to read (double blue tick ✓✓, status-read)', () => {
    const roomState = new RoomMessagesState(currentUserId);
    roomState.roomId = 'room_receipt_12';
    const clientMsgId = 'msg-receipt-12';

    const opt = createOptimisticMessage('room_receipt_12', currentUserId, 'Read test', clientMsgId);
    roomState.addOptimisticMessage(opt);
    roomState.updateReceipt(clientMsgId, 'delivered');

    const updated = roomState.updateReceipt(clientMsgId, 'read');
    assert.equal(updated, true);
    assert.equal(roomState.getStatus(clientMsgId), 'read');

    const tick = getTickDescriptor(roomState.getStatus(clientMsgId), true);
    assert.equal(tick.hasTick, true);
    assert.equal(tick.symbol, '✓✓');
    assert.equal(tick.statusClass, 'status-read');
    assert.equal(tick.title, 'Read');
  });

  // 13. Monotonic invariant rejects downgrades
  test('13. monotonic invariant rejects downgrades from read or delivered back to sent/pending/failed', () => {
    const roomState = new RoomMessagesState(currentUserId);
    roomState.roomId = 'room_monotonic_13';
    const clientMsgId = 'msg-mono-13';

    const opt = createOptimisticMessage('room_monotonic_13', currentUserId, 'Monotonic test', clientMsgId);
    roomState.addOptimisticMessage(opt);
    roomState.updateReceipt(clientMsgId, 'sent');
    roomState.updateReceipt(clientMsgId, 'delivered');
    roomState.updateReceipt(clientMsgId, 'read');

    assert.equal(roomState.getStatus(clientMsgId), 'read');

    // Attempt downgrades
    assert.equal(roomState.updateReceipt(clientMsgId, 'delivered'), false);
    assert.equal(roomState.updateReceipt(clientMsgId, 'sent'), false);
    assert.equal(roomState.updateReceipt(clientMsgId, 'sending'), false);
    assert.equal(roomState.updateReceipt(clientMsgId, 'pending'), false);
    assert.equal(roomState.updateReceipt(clientMsgId, 'failed'), false);

    assert.equal(roomState.getStatus(clientMsgId), 'read');
    assert.equal(getTickDescriptor(roomState.getStatus(clientMsgId), true).symbol, '✓✓');
  });

  // 14. Lost-ACK handling: already-confirmed messages are cleared without re-sending
  test('14. lost-ACK reconciliation: flush clears already-confirmed message without duplicate network send', async () => {
    const roomId = 'room_lost_ack_14';
    const clientMsgId = 'msg-lost-ack-14';

    // Item stuck in outbox because client lost connection before ACK arrived
    await outbox.enqueue({
      clientMessageId: clientMsgId,
      roomId,
      wirePayload: { client_message_id: clientMsgId, text: 'Lost ACK message' },
      dbBridge: dbService
    });

    // In memory or SQLite, the server catchup already brought this message in as 'sent'
    const roomState = new RoomMessagesState(currentUserId);
    roomState.roomId = roomId;
    const confirmedMsg = createOptimisticMessage(roomId, currentUserId, 'Lost ACK message', clientMsgId);
    confirmedMsg.status = 'sent';
    roomState.addOptimisticMessage(confirmedMsg);
    roomState.updateReceipt(clientMsgId, 'sent');

    let sendCalled = false;
    const mockChat = {
      getState: async () => 'connected',
      send: async () => {
        sendCalled = true;
        return { ok: true };
      }
    };

    const count = await outbox.flush({
      dbBridge: dbService,
      chatBridge: mockChat,
      getRoomState: () => roomState
    });

    assert.equal(sendCalled, false, 'Should not re-transmit message that is already confirmed');
    assert.equal(count, 0);

    const pending = await dbService.getPendingOutbox();
    assert.equal(pending.length, 0, 'Reconciled outbox item must be cleared');
  });

  // 15. Failure resilience: one permanently failed item does not block other queued items
  test('15. failure resilience: permanent error on one item does not block subsequent queued items', async () => {
    const roomId = 'room_resilience_15';
    const failCid = 'msg-fail-item';
    const successCid = 'msg-success-item';

    await dbService.savePendingOutbox({
      clientMessageId: failCid,
      roomId,
      payloadJson: JSON.stringify({
        client_message_id: failCid,
        roomId,
        wirePayload: { client_message_id: failCid, text: 'Broken payload' }
      }),
      retryCount: 0,
      createdAt: '2026-10-09T00:00:01.000Z'
    });

    await dbService.savePendingOutbox({
      clientMessageId: successCid,
      roomId,
      payloadJson: JSON.stringify({
        client_message_id: successCid,
        roomId,
        wirePayload: { client_message_id: successCid, text: 'Valid message' }
      }),
      retryCount: 0,
      createdAt: '2026-10-09T00:00:02.000Z'
    });

    const mockChat = {
      getState: async () => 'connected',
      send: async (_action, payload) => {
        if (payload.client_message_id === failCid) {
          return { ok: false, code: 'PAYLOAD_REJECTED', error: 'Schema validation rejected' };
        }
        return { ok: true, requestId: 'req-success-15' };
      }
    };

    const statusUpdates = [];
    const count = await outbox.flush({
      dbBridge: dbService,
      chatBridge: mockChat,
      onStatusUpdate: (cid, st) => {
        statusUpdates.push({ cid, st });
      }
    });

    assert.equal(count, 1, 'Success message must be dispatched despite earlier failure');
    assert.ok(statusUpdates.some((u) => u.cid === failCid && u.st === 'failed'));
    assert.ok(statusUpdates.some((u) => u.cid === successCid && u.st === 'sending'));
  });
});
