import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { DatabaseService } from '../src/storage/db/database-service.js';
import {
  RoomMessagesState,
  MESSAGE_STATUS,
  STATUS_RANKS,
  getTickDescriptor,
  getHighestStatus,
  isOwnMessage
} from '../src/renderer/chat-shell-state.js';

describe('Message Receipt Lifecycle & Monotonicity (15 Core Scenarios)', () => {
  let tmpDir;
  let dbService;
  let mockSessionStore;
  const currentUserId = 'user-alice';
  const peerUserId = 'user-bob';
  const roomId = 'room-101';

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), 'ollachat-receipt-test-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
    await fs.mkdir(tmpDir, { recursive: true });
    mockSessionStore = {
      currentSession: { userId: currentUserId },
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

  // 1. sent -> delivered
  test('1. sent -> delivered advances status in memory and SQLite', async () => {
    const msgId = 'msg-1';
    const state = new RoomMessagesState(currentUserId);
    state.setInitialMessages(roomId, []);
    state.addOptimisticMessage({ id: msgId, sender_id: currentUserId, roomId, text: 'Hello' });
    
    state.updateReceipt(msgId, MESSAGE_STATUS.SENT);
    assert.equal(state.getStatus(msgId), MESSAGE_STATUS.SENT);

    // Save to DB as sent
    await dbService.saveMessage({ id: msgId, roomId, senderId: currentUserId, content: 'Hello', status: 'sent', deliveryStatus: 'sent' });
    let dbMsg = await dbService.getMessageById(msgId);
    assert.equal(dbMsg.status, 'sent');

    // Advance to delivered
    const updated = state.updateReceipt(msgId, MESSAGE_STATUS.DELIVERED);
    assert.equal(updated, true);
    assert.equal(state.getStatus(msgId), MESSAGE_STATUS.DELIVERED);

    await dbService.updateMessageStatus({ id: msgId, status: 'delivered', recipientId: peerUserId });
    dbMsg = await dbService.getMessageById(msgId);
    assert.equal(dbMsg.status, 'delivered');
  });

  // 2. delivered -> read
  test('2. delivered -> read advances status in memory and SQLite', async () => {
    const msgId = 'msg-2';
    const state = new RoomMessagesState(currentUserId);
    state.setInitialMessages(roomId, []);
    state.addOptimisticMessage({ id: msgId, sender_id: currentUserId, roomId, text: 'Hello 2' });
    state.updateReceipt(msgId, MESSAGE_STATUS.DELIVERED);

    await dbService.saveMessage({ id: msgId, roomId, senderId: currentUserId, content: 'Hello 2', status: 'delivered', deliveryStatus: 'delivered' });
    await dbService.updateMessageStatus({ id: msgId, status: 'delivered', recipientId: peerUserId });

    const updated = state.updateReceipt(msgId, MESSAGE_STATUS.READ);
    assert.equal(updated, true);
    assert.equal(state.getStatus(msgId), MESSAGE_STATUS.READ);

    await dbService.updateMessageStatus({ id: msgId, status: 'read', recipientId: peerUserId });
    const dbMsg = await dbService.getMessageById(msgId);
    assert.equal(dbMsg.status, 'read');
    assert.equal(dbMsg.deliveryStatus, 'read');
  });

  // 3. read cannot downgrade to delivered
  test('3. read cannot downgrade to delivered in memory or SQLite', async () => {
    const msgId = 'msg-3';
    const state = new RoomMessagesState(currentUserId);
    state.setInitialMessages(roomId, []);
    state.addOptimisticMessage({ id: msgId, sender_id: currentUserId, roomId, text: 'Hello 3' });
    state.updateReceipt(msgId, MESSAGE_STATUS.READ);

    await dbService.saveMessage({ id: msgId, roomId, senderId: currentUserId, content: 'Hello 3', status: 'read', deliveryStatus: 'read' });
    await dbService.updateMessageStatus({ id: msgId, status: 'read', recipientId: peerUserId });

    // Attempt downgrade in memory
    const downgraded = state.updateReceipt(msgId, MESSAGE_STATUS.DELIVERED);
    assert.equal(downgraded, false);
    assert.equal(state.getStatus(msgId), MESSAGE_STATUS.READ);

    // Attempt downgrade via updateMessageStatus
    await dbService.updateMessageStatus({ id: msgId, status: 'delivered', recipientId: peerUserId });
    let dbMsg = await dbService.getMessageById(msgId);
    assert.equal(dbMsg.status, 'read');

    // Attempt downgrade via saveMessage
    await dbService.saveMessage({ id: msgId, roomId, senderId: currentUserId, content: 'Hello 3', status: 'delivered', deliveryStatus: 'delivered' });
    dbMsg = await dbService.getMessageById(msgId);
    assert.equal(dbMsg.status, 'read');
  });

  // 4. read cannot downgrade to sent
  test('4. read cannot downgrade to sent in memory or SQLite', async () => {
    const msgId = 'msg-4';
    const state = new RoomMessagesState(currentUserId);
    state.setInitialMessages(roomId, []);
    state.addOptimisticMessage({ id: msgId, sender_id: currentUserId, roomId, text: 'Hello 4' });
    state.updateReceipt(msgId, MESSAGE_STATUS.READ);

    await dbService.saveMessage({ id: msgId, roomId, senderId: currentUserId, content: 'Hello 4', status: 'read', deliveryStatus: 'read' });
    await dbService.updateMessageStatus({ id: msgId, status: 'read', recipientId: peerUserId });

    // Attempt memory downgrade
    const downgraded = state.updateReceipt(msgId, MESSAGE_STATUS.SENT);
    assert.equal(downgraded, false);
    assert.equal(state.getStatus(msgId), MESSAGE_STATUS.READ);

    // Attempt SQLite downgrade via saveMessage with default 'sent'
    await dbService.saveMessage({ id: msgId, roomId, senderId: currentUserId, content: 'Hello 4', status: 'sent' });
    const dbMsg = await dbService.getMessageById(msgId);
    assert.equal(dbMsg.status, 'read');
    assert.equal(dbMsg.deliveryStatus, 'read');
  });

  // 5. persisted READ receipt survives restart
  test('5. persisted READ receipt survives database restart', async () => {
    const msgId = 'msg-restart-5';
    await dbService.saveMessage({
      id: msgId,
      roomId,
      senderId: currentUserId,
      content: 'Persistent message',
      status: 'read',
      deliveryStatus: 'read'
    });
    await dbService.updateMessageStatus({ id: msgId, status: 'read', recipientId: peerUserId });

    // Close database completely
    await dbService.databaseManager.close();

    // Reopen database with fresh DatabaseService
    const reopenedService = new DatabaseService({
      storageDir: tmpDir,
      sessionStore: mockSessionStore
    });

    const reloaded = await reopenedService.getMessageById(msgId);
    assert.ok(reloaded);
    assert.equal(reloaded.status, 'read');
    assert.equal(reloaded.deliveryStatus, 'read');

    await reopenedService.databaseManager.close();
  });

  // 6. SQLite hydration preserves READ
  test('6. SQLite hydration preserves READ into fresh RoomMessagesState', async () => {
    const msgId = 'msg-hyd-6';
    await dbService.saveMessage({
      id: msgId,
      roomId,
      senderId: currentUserId,
      content: 'Hydrate message',
      status: 'read',
      deliveryStatus: 'read'
    });

    const messagesFromDb = await dbService.getMessages({ roomId });
    assert.equal(messagesFromDb.length, 1);
    assert.equal(messagesFromDb[0].status, 'read');

    // Fresh RoomMessagesState with empty roomReceiptStore (simulating app restart)
    const freshState = new RoomMessagesState(currentUserId, new Map());
    freshState.setInitialMessages(roomId, messagesFromDb);

    assert.equal(freshState.getStatus(msgId), 'read');
    const msgObj = freshState.messages.find(m => m.id === msgId);
    assert.equal(msgObj.status, 'read');
    assert.equal(msgObj.deliveryStatus, 'read');
  });

  // 7. WebSocket delivered event cannot overwrite READ
  test('7. WebSocket delivered event cannot overwrite READ', async () => {
    const msgId = 'msg-ws-7';
    const state = new RoomMessagesState(currentUserId);
    state.setInitialMessages(roomId, [
      { id: msgId, sender_id: currentUserId, roomId, text: 'WS Msg', status: 'read', deliveryStatus: 'read' }
    ]);
    assert.equal(state.getStatus(msgId), 'read');

    // Simulate WebSocket DELIVERED receipt event arriving
    const updated = state.updateReceipt(msgId, 'delivered');
    assert.equal(updated, false);
    assert.equal(state.getStatus(msgId), 'read');
  });

  // 8. WebSocket sent event cannot overwrite READ
  test('8. WebSocket sent event cannot overwrite READ', async () => {
    const msgId = 'msg-ws-8';
    const state = new RoomMessagesState(currentUserId);
    state.setInitialMessages(roomId, [
      { id: msgId, sender_id: currentUserId, roomId, text: 'WS Msg 8', status: 'read', deliveryStatus: 'read' }
    ]);
    assert.equal(state.getStatus(msgId), 'read');

    // Simulate server ACK/SENT arriving late
    const updated = state.updateReceipt(msgId, 'sent');
    assert.equal(updated, false);
    assert.equal(state.getStatus(msgId), 'read');
  });

  // 9. pagination cannot downgrade READ
  test('9. pagination cannot downgrade READ in memory or database', async () => {
    const msgId = 'msg-page-9';
    await dbService.saveMessage({
      id: msgId,
      roomId,
      senderId: currentUserId,
      content: 'Older message',
      status: 'read',
      deliveryStatus: 'read'
    });

    const state = new RoomMessagesState(currentUserId);
    state.setInitialMessages(roomId, [
      { id: 'newer-msg', sender_id: currentUserId, roomId, text: 'Newer', status: 'sent' }
    ]);

    // Prepend older messages from server pagination payload where deliveryStatus is missing/sent
    const olderFromServer = [
      { id: msgId, sender_id: currentUserId, roomId, text: 'Older message', status: 'read' }
    ];
    state.prependOlderMessages(olderFromServer);

    assert.equal(state.getStatus(msgId), 'read');

    // Now simulate syncing paginated page to SQLite with raw server payload
    await dbService.saveMessage({
      id: msgId,
      roomId,
      senderId: currentUserId,
      content: 'Older message',
      status: 'sent' // Server didn't include delivery status
    });

    const dbMsg = await dbService.getMessageById(msgId);
    assert.equal(dbMsg.status, 'read');
  });

  // 10. message deduplication preserves READ
  test('10. message deduplication preserves READ', () => {
    const msgId = 'msg-dedup-10';
    const state = new RoomMessagesState(currentUserId);
    state.setInitialMessages(roomId, [
      { id: msgId, sender_id: currentUserId, roomId, text: 'Original', status: 'read', deliveryStatus: 'read' }
    ]);
    assert.equal(state.getStatus(msgId), 'read');

    // Incoming duplicate message payload with no status
    const reconciled = state.appendIncomingMessage({
      id: msgId,
      sender_id: currentUserId,
      roomId,
      text: 'Original',
      status: 'sent'
    });

    assert.equal(state.getStatus(msgId), 'read');
    assert.equal(reconciled.status, 'read');
  });

  // 11. room switching preserves READ
  test('11. room switching preserves READ', () => {
    const sharedStore = new Map();
    const stateRoom1 = new RoomMessagesState(currentUserId, sharedStore);
    stateRoom1.setInitialMessages('room-A', [
      { id: 'msg-A', sender_id: currentUserId, roomId: 'room-A', text: 'Msg A', status: 'read' }
    ]);
    assert.equal(stateRoom1.getStatus('msg-A'), 'read');

    // Switch to room B
    const stateRoom2 = new RoomMessagesState(currentUserId, sharedStore);
    stateRoom2.setInitialMessages('room-B', [
      { id: 'msg-B', sender_id: currentUserId, roomId: 'room-B', text: 'Msg B', status: 'sent' }
    ]);
    assert.equal(stateRoom2.getStatus('msg-B'), 'sent');

    // Switch back to room A
    const stateRoom1Again = new RoomMessagesState(currentUserId, sharedStore);
    stateRoom1Again.setInitialMessages('room-A', [
      { id: 'msg-A', sender_id: currentUserId, roomId: 'room-A', text: 'Msg A' }
    ]);
    assert.equal(stateRoom1Again.getStatus('msg-A'), 'read');
  });

  // 12. reconnect/catch-up preserves READ
  test('12. reconnect/catch-up preserves READ', () => {
    const state = new RoomMessagesState(currentUserId);
    state.setInitialMessages(roomId, [
      { id: 'msg-12', sender_id: currentUserId, roomId, text: 'Catchup Msg', status: 'read' }
    ]);
    assert.equal(state.getStatus('msg-12'), 'read');

    // Server catch-up syncs historical messages where status is unpopulated or 'sent'
    state.mergeServerMessages([
      { id: 'msg-12', sender_id: currentUserId, roomId, text: 'Catchup Msg', status: 'sent' }
    ]);

    assert.equal(state.getStatus('msg-12'), 'read');
  });

  // 13. UI renders READ as blue double-check
  test('13. UI renders READ as blue double-check', () => {
    const tick = getTickDescriptor(MESSAGE_STATUS.READ, true);
    assert.equal(tick.hasTick, true);
    assert.equal(tick.symbol, '✓✓');
    assert.equal(tick.statusClass, 'status-read');
    assert.equal(tick.title, 'Read');
  });

  // 14. UI renders DELIVERED as grey double-check
  test('14. UI renders DELIVERED as grey double-check', () => {
    const tick = getTickDescriptor(MESSAGE_STATUS.DELIVERED, true);
    assert.equal(tick.hasTick, true);
    assert.equal(tick.symbol, '✓✓');
    assert.equal(tick.statusClass, 'status-delivered');
    assert.equal(tick.title, 'Delivered');
  });

  // 15. UI renders SENT as single grey check
  test('15. UI renders SENT as single grey check', () => {
    const tick = getTickDescriptor(MESSAGE_STATUS.SENT, true);
    assert.equal(tick.hasTick, true);
    assert.equal(tick.symbol, '✓');
    assert.equal(tick.statusClass, 'status-sent');
    assert.equal(tick.title, 'Sent');
  });

  // Real full lifecycle: READ -> close app -> reopen -> open conversation -> READ / blue double-check
  test('16. Real full lifecycle: READ -> close app -> reopen -> open conversation -> blue double-check', async () => {
    const msgId = 'real-msg-99';
    // 1. Initial outgoing message
    await dbService.saveMessage({
      id: msgId,
      roomId,
      senderId: currentUserId,
      content: 'Can you see this?',
      status: 'sent',
      deliveryStatus: 'sent'
    });

    // 2. Peer delivers message
    await dbService.updateMessageStatus({ id: msgId, status: 'delivered', recipientId: peerUserId });

    // 3. Peer reads message
    await dbService.updateMessageStatus({ id: msgId, status: 'read', recipientId: peerUserId });

    // Verify it is READ in DB before shutdown
    let dbMsg = await dbService.getMessageById(msgId);
    assert.equal(dbMsg.status, 'read');

    // 4. Close app / database
    await dbService.databaseManager.close();

    // 5. Reopen app / database
    const appRestartDbService = new DatabaseService({
      storageDir: tmpDir,
      sessionStore: mockSessionStore
    });

    // 6. Open conversation / hydrate messages
    const hydratedMessages = await appRestartDbService.getMessages({ roomId });
    assert.equal(hydratedMessages.length, 1);
    assert.equal(hydratedMessages[0].id, msgId);
    assert.equal(hydratedMessages[0].status, 'read');

    // 7. Mount into RoomMessagesState
    const appState = new RoomMessagesState(currentUserId);
    appState.setInitialMessages(roomId, hydratedMessages);

    // 8. Query status for UI
    const finalStatus = appState.getStatus(msgId);
    assert.equal(finalStatus, 'read');

    // 9. Render tick
    const tick = getTickDescriptor(finalStatus, true);
    assert.equal(tick.hasTick, true);
    assert.equal(tick.symbol, '✓✓');
    assert.equal(tick.statusClass, 'status-read');

    await appRestartDbService.databaseManager.close();
  });

  // 17. Migration 2 repairs messages downgraded in SQLite messages table
  test('17. Migration 2 repairs messages downgraded in SQLite messages table', async () => {
    // Manually simulate a situation where message_receipts recorded 'read',
    // but messages table had status downgraded to 'sent'
    await dbService.saveMessage({
      id: 'pre-init',
      roomId,
      senderId: currentUserId,
      content: 'init table',
      status: 'sent'
    });

    const downgradedId = 'downgraded-msg-1';
    await dbService.databaseManager.run(`
      INSERT INTO messages (id, room_id, sender_id, body_json, status, created_at, local_received_at)
      VALUES (?, ?, ?, ?, 'sent', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    `, [downgradedId, roomId, currentUserId, JSON.stringify({ text: 'Downgraded text' })]);

    await dbService.databaseManager.run(`
      INSERT INTO message_receipts (message_id, recipient_id, status, receipt_timestamp)
      VALUES (?, ?, 'read', '2026-01-01T00:00:00Z');
    `, [downgradedId, peerUserId]);

    // Run getMessages or getMessageById
    const fetched = await dbService.getMessageById(downgradedId);
    assert.equal(fetched.status, 'read', 'Should join message_receipts and reflect read status');
  });
});
