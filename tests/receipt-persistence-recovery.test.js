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

describe('P0 Message Receipts Persistence & Force-Close Recovery Tests', () => {
  let tmpDir;
  let dbService;
  let mockSessionStore;
  const currentUserId = 'user-alice';
  const peerUserId = 'user-bob';
  const roomId = 'room-alpha';
  const otherRoomId = 'room-beta';

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), 'ollachat-recovery-test-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
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

  test('1. Optimistic message marked DELIVERED survives server reconciliation and database force-close/reopen', async () => {
    const optimisticId = 'opt-msg-101';
    const canonicalId = 'srv-msg-101';

    // 1. Initial conversation created
    await dbService.saveConversation({
      roomId,
      peerUserId,
      kind: 'direct',
      displayName: 'Bob'
    });

    // 2. Client sends optimistic message
    const stateSession1 = new RoomMessagesState(currentUserId);
    stateSession1.setInitialMessages(roomId, []);
    stateSession1.addOptimisticMessage({
      id: optimisticId,
      clientMessageId: optimisticId,
      sender_id: currentUserId,
      roomId,
      body: { text: 'Hello Bob' }
    });

    await dbService.saveMessage({
      id: optimisticId,
      clientMessageId: optimisticId,
      roomId,
      senderId: currentUserId,
      content: 'Hello Bob',
      status: 'pending',
      deliveryStatus: 'pending'
    });

    // 3. Receipt DELIVERED arrives for optimistic message before canonical ACK
    stateSession1.updateReceipt(optimisticId, MESSAGE_STATUS.DELIVERED);
    assert.equal(stateSession1.getStatus(optimisticId), MESSAGE_STATUS.DELIVERED);

    await dbService.updateMessageStatus({
      id: optimisticId,
      status: 'delivered',
      recipientId: peerUserId
    });

    // 4. Server canonical ACK arrives (server message has default status: 'sent')
    await dbService.saveMessage({
      id: canonicalId,
      clientMessageId: optimisticId,
      roomId,
      senderId: currentUserId,
      content: 'Hello Bob',
      status: 'sent',
      deliveryStatus: 'sent'
    });

    stateSession1.mergeServerMessages([{
      id: canonicalId,
      clientMessageId: optimisticId,
      sender_id: currentUserId,
      roomId,
      body: { text: 'Hello Bob' },
      status: 'sent'
    }]);

    // In Session 1, state must remain DELIVERED
    assert.equal(stateSession1.getStatus(canonicalId), MESSAGE_STATUS.DELIVERED);

    // 5. SIMULATE FORCE CLOSE: completely close database and tear down in-memory state
    await dbService.databaseManager.close();

    // 6. REOPEN APP: create brand new DatabaseService from disk
    const dbServiceSession2 = new DatabaseService({
      storageDir: tmpDir,
      sessionStore: mockSessionStore
    });
    dbService = dbServiceSession2; // for afterEach cleanup

    // 7. Load messages from SQLite
    const reloadedMessages = await dbServiceSession2.getMessages({ roomId, limit: 50 });
    assert.equal(reloadedMessages.length, 1);
    const loadedMsg = reloadedMessages[0];

    assert.equal(loadedMsg.id, canonicalId);
    assert.equal(loadedMsg.status, 'delivered', 'Database must persist delivered status across restart');

    // 8. Hydrate into new RoomMessagesState
    const stateSession2 = new RoomMessagesState();
    stateSession2.setInitialMessages(roomId, reloadedMessages);
    stateSession2.setCurrentUserId(currentUserId);

    assert.equal(stateSession2.getStatus(canonicalId), MESSAGE_STATUS.DELIVERED);
    const tick = getTickDescriptor(stateSession2.getStatus(canonicalId), true);
    assert.equal(tick.hasTick, true);
    assert.equal(tick.symbol, '✓✓');
    assert.equal(tick.statusClass, 'status-delivered');
  });

  test('2. Optimistic message marked READ survives server reconciliation and database force-close/reopen', async () => {
    const optimisticId = 'opt-msg-202';
    const canonicalId = 'srv-msg-202';

    await dbService.saveConversation({
      roomId,
      peerUserId,
      kind: 'direct',
      displayName: 'Bob'
    });

    // 1. Send optimistic message
    const state1 = new RoomMessagesState(currentUserId);
    state1.setInitialMessages(roomId, []);
    state1.addOptimisticMessage({
      id: optimisticId,
      clientMessageId: optimisticId,
      sender_id: currentUserId,
      roomId,
      body: { text: 'Important notice' }
    });

    await dbService.saveMessage({
      id: optimisticId,
      clientMessageId: optimisticId,
      roomId,
      senderId: currentUserId,
      content: 'Important notice',
      status: 'pending'
    });

    // 2. Receipt progresses to delivered then read
    state1.updateReceipt(optimisticId, MESSAGE_STATUS.DELIVERED);
    await dbService.updateMessageStatus({ id: optimisticId, status: 'delivered', recipientId: peerUserId });

    state1.updateReceipt(optimisticId, MESSAGE_STATUS.READ);
    await dbService.updateMessageStatus({ id: optimisticId, status: 'read', recipientId: peerUserId });

    assert.equal(state1.getStatus(optimisticId), MESSAGE_STATUS.READ);

    // 3. Server canonical message arrives with status 'sent'
    await dbService.saveMessage({
      id: canonicalId,
      clientMessageId: optimisticId,
      roomId,
      senderId: currentUserId,
      content: 'Important notice',
      status: 'sent'
    });

    state1.mergeServerMessages([{
      id: canonicalId,
      clientMessageId: optimisticId,
      sender_id: currentUserId,
      roomId,
      body: { text: 'Important notice' },
      status: 'sent'
    }]);

    assert.equal(state1.getStatus(canonicalId), MESSAGE_STATUS.READ);

    // 4. Force-close and reopen
    await dbService.databaseManager.close();

    const db2 = new DatabaseService({
      storageDir: tmpDir,
      sessionStore: mockSessionStore
    });
    dbService = db2;

    const messagesAfterRestart = await db2.getMessages({ roomId, limit: 50 });
    assert.equal(messagesAfterRestart.length, 1);
    assert.equal(messagesAfterRestart[0].status, 'read', 'Database must persist read status across restart');

    const state2 = new RoomMessagesState();
    state2.setInitialMessages(roomId, messagesAfterRestart);
    state2.setCurrentUserId(currentUserId);

    assert.equal(state2.getStatus(canonicalId), MESSAGE_STATUS.READ);
    const tick = getTickDescriptor(state2.getStatus(canonicalId), true);
    assert.equal(tick.hasTick, true);
    assert.equal(tick.symbol, '✓✓');
    assert.equal(tick.statusClass, 'status-read');
  });

  test('3. History catch-up sync / pagination with older status "sent" cannot downgrade DELIVERED or READ in SQLite or memory', async () => {
    const msgId = 'msg-sync-303';

    await dbService.saveConversation({
      roomId,
      peerUserId,
      kind: 'direct',
      displayName: 'Bob'
    });

    // Initial message delivered in SQLite
    await dbService.saveMessage({
      id: msgId,
      roomId,
      senderId: currentUserId,
      content: 'Catch-up sync test',
      status: 'delivered'
    });
    await dbService.updateMessageStatus({ id: msgId, status: 'delivered', recipientId: peerUserId });

    // Close & reopen to simulate restart
    await dbService.databaseManager.close();
    const db2 = new DatabaseService({
      storageDir: tmpDir,
      sessionStore: mockSessionStore
    });
    dbService = db2;

    const loaded = await db2.getMessages({ roomId, limit: 50 });
    assert.equal(loaded[0].status, 'delivered');

    const state = new RoomMessagesState(currentUserId);
    state.setInitialMessages(roomId, loaded);
    assert.equal(state.getStatus(msgId), 'delivered');

    // History pagination batch arrives from server where status is 'sent'
    const serverHistoryBatch = [{
      id: msgId,
      roomId,
      sender_id: currentUserId,
      body: { text: 'Catch-up sync test' },
      status: 'sent',
      delivery_status: 'sent'
    }];

    // State merge must NOT downgrade
    state.mergeServerMessages(serverHistoryBatch);
    assert.equal(state.getStatus(msgId), 'delivered', 'In-memory status must resist downgrade from server history');

    // SQLite save must NOT downgrade
    for (const m of serverHistoryBatch) {
      await db2.saveMessage({
        id: m.id,
        roomId: m.roomId,
        senderId: m.sender_id,
        content: m.body.text,
        status: m.status,
        deliveryStatus: m.delivery_status
      });
    }

    const dbMsg = await db2.getMessageById(msgId);
    assert.equal(dbMsg.status, 'delivered', 'SQLite status must resist downgrade from saveMessage history batch');
  });

  test('4. Multi-cycle force close and reopen (Sent -> Restart -> Delivered -> Restart -> Read -> Restart)', async () => {
    const msgId = 'msg-multicycle-404';

    await dbService.saveConversation({
      roomId,
      peerUserId,
      kind: 'direct',
      displayName: 'Bob'
    });

    // Cycle 1: Send message (status: sent)
    await dbService.saveMessage({
      id: msgId,
      roomId,
      senderId: currentUserId,
      content: 'Multi-cycle message',
      status: 'sent'
    });
    await dbService.databaseManager.close();

    // Restart 1: Verify sent
    let dbInstance = new DatabaseService({ storageDir: tmpDir, sessionStore: mockSessionStore });
    dbService = dbInstance;
    let msgs = await dbInstance.getMessages({ roomId, limit: 50 });
    assert.equal(msgs[0].status, 'sent');

    // Cycle 2: Advance to delivered
    await dbInstance.updateMessageStatus({ id: msgId, status: 'delivered', recipientId: peerUserId });
    await dbInstance.databaseManager.close();

    // Restart 2: Verify delivered
    dbInstance = new DatabaseService({ storageDir: tmpDir, sessionStore: mockSessionStore });
    dbService = dbInstance;
    msgs = await dbInstance.getMessages({ roomId, limit: 50 });
    assert.equal(msgs[0].status, 'delivered');

    // Cycle 3: Advance to read
    await dbInstance.updateMessageStatus({ id: msgId, status: 'read', recipientId: peerUserId });
    await dbInstance.databaseManager.close();

    // Restart 3: Verify read
    dbInstance = new DatabaseService({ storageDir: tmpDir, sessionStore: mockSessionStore });
    dbService = dbInstance;
    msgs = await dbInstance.getMessages({ roomId, limit: 50 });
    assert.equal(msgs[0].status, 'read');

    // Restart 4 (no-op reload): Verify read is rock-solid
    await dbInstance.databaseManager.close();
    dbInstance = new DatabaseService({ storageDir: tmpDir, sessionStore: mockSessionStore });
    dbService = dbInstance;
    msgs = await dbInstance.getMessages({ roomId, limit: 50 });
    assert.equal(msgs[0].status, 'read');
  });

  test('5. Multi-room isolation across restarts: Room A receipts never bleed into Room B', async () => {
    const msgRoomA = 'msg-room-a';
    const msgRoomB = 'msg-room-b';

    await dbService.saveConversation({ roomId, peerUserId, kind: 'direct', displayName: 'Room A' });
    await dbService.saveConversation({ roomId: otherRoomId, peerUserId: 'user-charlie', kind: 'direct', displayName: 'Room B' });

    await dbService.saveMessage({
      id: msgRoomA,
      roomId,
      senderId: currentUserId,
      content: 'Room A message',
      status: 'sent'
    });
    await dbService.saveMessage({
      id: msgRoomB,
      roomId: otherRoomId,
      senderId: currentUserId,
      content: 'Room B message',
      status: 'sent'
    });

    // Mark Room A delivered
    await dbService.updateMessageStatus({ id: msgRoomA, status: 'delivered', recipientId: peerUserId });

    // Restart database
    await dbService.databaseManager.close();
    const db2 = new DatabaseService({ storageDir: tmpDir, sessionStore: mockSessionStore });
    dbService = db2;

    const msgsA = await db2.getMessages({ roomId, limit: 50 });
    const msgsB = await db2.getMessages({ roomId: otherRoomId, limit: 50 });

    assert.equal(msgsA[0].status, 'delivered', 'Room A message must be delivered');
    assert.equal(msgsB[0].status, 'sent', 'Room B message must remain sent and unaffected');

    // Verify in RoomMessagesState isolation
    const stateA = new RoomMessagesState(currentUserId);
    stateA.setInitialMessages(roomId, msgsA);
    const stateB = new RoomMessagesState(currentUserId);
    stateB.setInitialMessages(otherRoomId, msgsB);

    assert.equal(stateA.getStatus(msgRoomA), 'delivered');
    assert.equal(stateB.getStatus(msgRoomB), 'sent');
  });

  test('6. Post-restart receipt advancement succeeds monotonically', async () => {
    const msgId = 'msg-live-advance';

    await dbService.saveConversation({ roomId, peerUserId, kind: 'direct', displayName: 'Bob' });
    await dbService.saveMessage({
      id: msgId,
      roomId,
      senderId: currentUserId,
      content: 'Live advance test',
      status: 'sent'
    });
    await dbService.updateMessageStatus({ id: msgId, status: 'delivered', recipientId: peerUserId });

    // Force close & reopen
    await dbService.databaseManager.close();
    const db2 = new DatabaseService({ storageDir: tmpDir, sessionStore: mockSessionStore });
    dbService = db2;

    const reloaded = await db2.getMessages({ roomId, limit: 50 });
    const state = new RoomMessagesState(currentUserId);
    state.setInitialMessages(roomId, reloaded);

    assert.equal(state.getStatus(msgId), 'delivered');

    // Live READ receipt arrives after app was restarted
    const updated = state.updateReceipt(msgId, MESSAGE_STATUS.READ);
    assert.equal(updated, true);
    assert.equal(state.getStatus(msgId), MESSAGE_STATUS.READ);

    await db2.updateMessageStatus({ id: msgId, status: 'read', recipientId: peerUserId });

    // Restart again to ensure post-restart advance was persisted
    await db2.databaseManager.close();
    const db3 = new DatabaseService({ storageDir: tmpDir, sessionStore: mockSessionStore });
    dbService = db3;

    const msgsAfterSecondRestart = await db3.getMessages({ roomId, limit: 50 });
    assert.equal(msgsAfterSecondRestart[0].status, 'read');
  });

  test('7. Receipt arriving BEFORE canonical message exists stages safely and reconciles on message save', async () => {
    const canonicalMsgId = 'srv-msg-early-707';

    await dbService.saveConversation({ roomId, peerUserId, kind: 'direct', displayName: 'Bob' });

    // DELIVERED receipt arrives via WebSocket BEFORE canonical message row exists in SQLite
    const stageResult1 = await dbService.updateMessageStatus({
      id: canonicalMsgId,
      status: 'delivered',
      recipientId: peerUserId
    });
    assert.equal(stageResult1.ok, true);
    assert.equal(stageResult1.staged, true);

    // READ receipt also arrives before message is inserted
    const stageResult2 = await dbService.updateMessageStatus({
      id: canonicalMsgId,
      status: 'read',
      recipientId: peerUserId
    });
    assert.equal(stageResult2.ok, true);
    assert.equal(stageResult2.staged, true);

    // Verify receipt was durably staged without violating foreign key constraints
    const stagedRows = await dbService.databaseManager.all(
      'SELECT * FROM staged_receipts WHERE message_id = ?;',
      [canonicalMsgId]
    );
    assert.equal(stagedRows.length, 1);
    assert.equal(stagedRows[0].status, 'read');

    // Canonical message row finally arrives/is saved from server with status 'sent'
    await dbService.saveMessage({
      id: canonicalMsgId,
      roomId,
      senderId: currentUserId,
      content: 'Early receipt message',
      status: 'sent'
    });

    // Check that staged receipt upgraded message status to 'read'
    const msg = await dbService.getMessageById(canonicalMsgId);
    assert.equal(msg.status, 'read');

    // Check that staged receipt was moved to message_receipts
    const receipts = await dbService.databaseManager.all(
      'SELECT * FROM message_receipts WHERE message_id = ?;',
      [canonicalMsgId]
    );
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].status, 'read');

    // Check that staged_receipts was cleaned up
    const remainingStaged = await dbService.databaseManager.all(
      'SELECT * FROM staged_receipts WHERE message_id = ?;',
      [canonicalMsgId]
    );
    assert.equal(remainingStaged.length, 0);

    // Force-close and reopen to verify persistence across restart
    await dbService.databaseManager.close();
    const db2 = new DatabaseService({ storageDir: tmpDir, sessionStore: mockSessionStore });
    dbService = db2;

    const loadedMsgs = await db2.getMessages({ roomId, limit: 50 });
    assert.equal(loadedMsgs.length, 1);
    assert.equal(loadedMsgs[0].status, 'read');

    const loadedReceipts = await db2.databaseManager.all(
      'SELECT * FROM message_receipts WHERE message_id = ?;',
      [canonicalMsgId]
    );
    assert.equal(loadedReceipts.length, 1);
    assert.equal(loadedReceipts[0].status, 'read');
  });

  test('8. Receipt arriving by canonical ID while optimistic message exists with clientMessageId reconciles cleanly', async () => {
    const optId = 'client-cid-808';
    const canonicalId = 'srv-uuid-808';

    await dbService.saveConversation({ roomId, peerUserId, kind: 'direct', displayName: 'Bob' });

    // Client creates optimistic message in SQLite
    await dbService.saveMessage({
      id: optId,
      clientMessageId: optId,
      roomId,
      senderId: currentUserId,
      content: 'Pending outbound',
      status: 'pending'
    });

    // Server sends READ receipt with canonical UUID BEFORE client receives canonical ACK
    const res = await dbService.updateMessageStatus({
      id: canonicalId,
      status: 'read',
      recipientId: peerUserId
    });
    assert.equal(res.ok, true);
    assert.equal(res.staged, true);

    // Now server ACK arrives matching clientMessageId to canonicalId
    await dbService.saveMessage({
      id: canonicalId,
      clientMessageId: optId,
      roomId,
      senderId: currentUserId,
      content: 'Pending outbound',
      status: 'sent'
    });

    // Verify optimistic message was deleted, canonical message has status 'read'
    const loaded = await dbService.getMessageById(canonicalId);
    assert.equal(loaded.status, 'read');

    const optCheck = await dbService.databaseManager.get('SELECT id FROM messages WHERE id = ?;', [optId]);
    assert.equal(optCheck, undefined, 'Optimistic row must be reconciled and cleaned up');

    // Receipt exists in message_receipts
    const receipts = await dbService.databaseManager.all('SELECT * FROM message_receipts WHERE message_id = ?;', [canonicalId]);
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].status, 'read');
  });

  test('9. Downgrades are strictly prevented: received sent status cannot overwrite staged or persisted read/delivered', async () => {
    const msgId = 'srv-msg-monotonic-909';

    await dbService.saveConversation({ roomId, peerUserId, kind: 'direct', displayName: 'Bob' });

    // Stage a delivered receipt
    await dbService.updateMessageStatus({ id: msgId, status: 'delivered', recipientId: peerUserId });

    // Attempt to downgrade with 'sent'
    const downgradeAttempt = await dbService.updateMessageStatus({ id: msgId, status: 'sent', recipientId: peerUserId });
    assert.equal(downgradeAttempt.changes, 0, 'Cannot downgrade staged delivered with sent');

    // Upgrade to read
    await dbService.updateMessageStatus({ id: msgId, status: 'read', recipientId: peerUserId });

    // Attempt to downgrade with 'delivered'
    const downgradeAttempt2 = await dbService.updateMessageStatus({ id: msgId, status: 'delivered', recipientId: peerUserId });
    assert.equal(downgradeAttempt2.changes, 0, 'Cannot downgrade staged read with delivered');

    // Save message with 'sent'
    await dbService.saveMessage({
      id: msgId,
      roomId,
      senderId: currentUserId,
      content: 'Monotonic test',
      status: 'sent'
    });

    const finalMsg = await dbService.getMessageById(msgId);
    assert.equal(finalMsg.status, 'read');
  });

  test('10. Invalid status or invalid identifier raises descriptive validation errors', async () => {
    await dbService.saveConversation({ roomId, peerUserId, kind: 'direct', displayName: 'Bob' });

    await assert.rejects(
      async () => {
        await dbService.updateMessageStatus({ id: 'msg-bad', status: 'bogus_status' });
      },
      /Invalid message status "bogus_status"/
    );

    await assert.rejects(
      async () => {
        await dbService.updateMessageStatus({ id: 'bad id with spaces!', status: 'read' });
      },
      /Invalid id: contains illegal characters/
    );
  });

  test('11. Receipts stored against optimistic message are transferred and resolved when canonical message arrives', async () => {
    const canonicalId = 'canonical-msg-110';
    const clientMsgId = 'local-client-msg-110';

    await dbService.saveConversation({ roomId, peerUserId, kind: 'direct', displayName: 'Bob' });

    // 1. Save optimistic message with clientMsgId
    await dbService.saveMessage({
      id: clientMsgId,
      clientMessageId: clientMsgId,
      roomId,
      senderId: currentUserId,
      content: 'Client ID receipt test',
      status: 'sending'
    });

    // 2. Read receipt arrives and is stored in message_receipts
    await dbService.updateMessageStatus({ id: clientMsgId, status: 'read', recipientId: peerUserId });

    // 3. Server ACK arrives with canonical ID, linking clientMsgId
    await dbService.saveMessage({
      id: canonicalId,
      clientMessageId: clientMsgId,
      roomId,
      senderId: currentUserId,
      content: 'Client ID receipt test',
      status: 'sent'
    });

    // getMessages should resolve read status
    const messages = await dbService.getMessages({ roomId });
    const found = messages.find(m => m.id === canonicalId);
    assert.ok(found, 'Message must be found');
    assert.equal(found.status, 'read', 'getMessages must resolve read status for canonical message');

    // getMessageById should also resolve read status
    const byId = await dbService.getMessageById(canonicalId);
    assert.equal(byId.status, 'read', 'getMessageById must resolve read status for canonical message');

    // Force close and reopen database to ensure durability
    await dbService.databaseManager.close();
    const freshDbService = new DatabaseService({
      storageDir: tmpDir,
      sessionStore: mockSessionStore
    });

    const reopenedMessages = await freshDbService.getMessages({ roomId });
    const reopenedFound = reopenedMessages.find(m => m.id === canonicalId);
    assert.ok(reopenedFound, 'Message must be found after reopen');
    assert.equal(reopenedFound.status, 'read', 'Status must remain read after database restart');

    await freshDbService.databaseManager.close();
  });

  test('11. Exact Reproduction: Optimistic message receives receipt.read before canonical ACK, survives force close and restart mergeServerMessages', async () => {
    const clientMsgId = 'local-repro-' + Date.now();
    const canonicalId = '01a12ed0-fc8d-72e0-bcc2-1d686d904b22';

    await dbService.saveConversation({
      roomId,
      peerUserId,
      kind: 'direct',
      displayName: 'Bob'
    });

    // 1. User sends message: optimistic message saved to SQLite as sending
    await dbService.saveMessage({
      id: clientMsgId,
      clientMessageId: clientMsgId,
      roomId,
      senderId: currentUserId,
      body: { text: 'Hello Bob' },
      status: 'sending'
    });

    // 2. Recipient reads message immediately on remote device!
    // Server delivers receipt.read with canonical message_id before Windows ACK finishes saving
    const receiptRes = await dbService.updateMessageStatus({
      id: canonicalId,
      status: 'read',
      recipientId: peerUserId
    });
    assert.equal(receiptRes.ok, true, 'Receipt write must succeed');

    // 3. Server ACK arrives with canonical message ID
    await dbService.saveMessage({
      id: canonicalId,
      clientMessageId: clientMsgId,
      roomId,
      senderId: currentUserId,
      body: { text: 'Hello Bob' },
      status: 'sent'
    });

    // Verify DB immediately contains 'read' status
    const dbMsgImmediate = await dbService.getMessageById(canonicalId);
    assert.equal(dbMsgImmediate.status, 'read', 'Status must be read after receipt and ACK');

    // 4. User terminates app with Ctrl+C (WAL checkpoint & close)
    await dbService.databaseManager.close();

    // 5. User restarts application: fresh DB connection loaded
    const freshDbService = new DatabaseService({
      storageDir: tmpDir,
      sessionStore: mockSessionStore
    });

    // Step A: loadMessagesFromDb (startup local hydration)
    const localDbMsgs = await freshDbService.getMessages({ roomId });
    const localMsg = localDbMsgs.find(m => m.id === canonicalId || m.client_message_id === clientMsgId);
    assert.ok(localMsg, 'Message must be found in SQLite upon restart');
    assert.equal(localMsg.status, 'read', 'Hydrated message from SQLite must have status = read');

    // Step B: In renderer, targetState.setInitialMessages hydrates from SQLite
    const roomState = new RoomMessagesState(currentUserId);
    roomState.setInitialMessages(roomId, localDbMsgs, false);
    assert.equal(roomState.getStatus(canonicalId), 'read', 'Room state must reflect read');
    assert.equal(getTickDescriptor(roomState.getStatus(canonicalId), true).symbol, '✓✓');
    assert.equal(getTickDescriptor(roomState.getStatus(canonicalId), true).statusClass, 'status-read');

    // Step C: Server history arrives from REST API /rooms/{roomId}/messages where status is 'sent'
    const serverHistoryMsgs = [{
      id: canonicalId,
      clientMessageId: clientMsgId,
      room_id: roomId,
      sender_id: currentUserId,
      body: { text: 'Hello Bob' },
      status: 'sent'
    }];

    // mergeServerMessages runs: must NOT downgrade 'read' to 'sent'
    roomState.mergeServerMessages(serverHistoryMsgs, false);
    assert.equal(roomState.getStatus(canonicalId), 'read', 'mergeServerMessages must not downgrade read to sent');
    assert.equal(getTickDescriptor(roomState.getStatus(canonicalId), true).statusClass, 'status-read');

    // Background persistMessagesToDb runs for server history: SQLite must NOT downgrade read to sent
    for (const sm of serverHistoryMsgs) {
      await freshDbService.saveMessage({
        id: sm.id,
        clientMessageId: sm.clientMessageId,
        roomId: sm.room_id,
        senderId: sm.sender_id,
        body: sm.body,
        status: sm.status
      });
    }

    const finalDbMsg = await freshDbService.getMessageById(canonicalId);
    assert.equal(finalDbMsg.status, 'read', 'Database status must remain read even after background server history sync');

    await freshDbService.databaseManager.close();
  });
});


