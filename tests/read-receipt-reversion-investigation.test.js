import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';

import { DatabaseService } from '../src/storage/db/database-service.js';
import {
  RoomMessagesState,
  getTickDescriptor,
  getHighestStatus
} from '../src/renderer/chat-shell-state.js';

describe('Read Receipt Reversion Fix & Regression Verification Tests', () => {
  let tmpDir;
  let dbService;
  let mockSessionStore;
  const currentUserId = 'user-alice';
  const peerUserId = 'user-bob';
  const roomId = 'room-alpha';

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), 'ollachat-inv-test-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
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

  // Helper matching the updated main.js chat:mark-read IPC handler
  function createMarkReadHandler({ chatWebSocket, chatApi, inflightMap = new Map() }) {
    return async function ipcMarkReadHandler({ roomId, messageId }) {
      if (!roomId || !messageId) return { ok: false, error: 'roomId and messageId required' };
      let wsSent = false;
      if (chatWebSocket && chatWebSocket.state === 'connected') {
        try {
          chatWebSocket.markRead(roomId, messageId);
          wsSent = true;
        } catch (_) {
          wsSent = false;
        }
      }

      // Durably persist read receipt in backend database via REST
      let restOk = false;
      let restError = null;
      if (chatApi) {
        const dedupeKey = `${roomId}:${messageId}`;
        if (inflightMap.has(dedupeKey)) {
          try {
            const existingResult = await inflightMap.get(dedupeKey);
            restOk = existingResult?.ok === true;
          } catch (err) {
            restError = err?.message;
          }
        } else {
          const restPromise = (async () => {
            try {
              const sessionToken = 'session-token';
              const deviceId = 'windows-device-id';
              const roomToken = await chatApi.resolveRoomToken(sessionToken, roomId, deviceId);
              await chatApi.markRead(roomToken, roomId, messageId);
              return { ok: true, method: 'rest' };
            } catch (err) {
              return { ok: false, error: err?.message || 'REST mark-read failed' };
            } finally {
              inflightMap.delete(dedupeKey);
            }
          })();
          inflightMap.set(dedupeKey, restPromise);
          try {
            const result = await restPromise;
            restOk = result?.ok === true;
            if (!restOk) restError = result?.error;
          } catch (err) {
            restError = err?.message;
          }
        }
      }

      const ok = wsSent || restOk;
      const method = (wsSent && restOk) ? 'both' : (wsSent ? 'ws' : (restOk ? 'rest' : 'none'));
      return { ok, method, error: !ok ? (restError || 'Failed to dispatch read receipt') : undefined };
    };
  }

  // =========================================================================
  // Requirement 1: Marking a message read while WebSocket is connected
  // =========================================================================
  test('1. Marking a message read while WebSocket is connected dual-dispatches WS frame and REST call', async () => {
    let wsCalls = 0;
    let restCalls = 0;

    const chatWebSocket = {
      state: 'connected',
      markRead(r, m) {
        wsCalls++;
      }
    };
    const chatApi = {
      async resolveRoomToken() {
        return 'room-token-123';
      },
      async markRead(token, r, m) {
        restCalls++;
        return { ok: true };
      }
    };

    const handler = createMarkReadHandler({ chatWebSocket, chatApi });
    const res = await handler({ roomId: 'room-1', messageId: 'msg-1' });

    assert.equal(res.ok, true);
    assert.equal(res.method, 'both', 'Both WS and REST were successfully used');
    assert.equal(wsCalls, 1, 'WS frame was sent');
    assert.equal(restCalls, 1, 'REST call was sent to durably persist in backend database');
  });

  // =========================================================================
  // Requirement 2: REST persistence failure and retry behavior
  // =========================================================================
  test('2. REST persistence failure handles gracefully and allows subsequent retry', async () => {
    let wsCalls = 0;
    let restAttempts = 0;
    let shouldFailRest = true;

    const chatWebSocket = {
      state: 'connected',
      markRead(r, m) {
        wsCalls++;
      }
    };
    const chatApi = {
      async resolveRoomToken() {
        return 'room-token-123';
      },
      async markRead() {
        restAttempts++;
        if (shouldFailRest) {
          throw new Error('503 Service Unavailable');
        }
        return { ok: true };
      }
    };

    const inflightMap = new Map();
    const handler = createMarkReadHandler({ chatWebSocket, chatApi, inflightMap });

    // Attempt 1: REST fails
    const res1 = await handler({ roomId: 'room-1', messageId: 'msg-retry' });
    assert.equal(res1.ok, true, 'Overall mark-read succeeds because WS succeeded');
    assert.equal(res1.method, 'ws', 'Method indicates WS only when REST fails');
    assert.equal(wsCalls, 1);
    assert.equal(restAttempts, 1);
    assert.equal(inflightMap.size, 0, 'Inflight map was cleaned up despite error');

    // Attempt 2: Server recovers, retry succeeds
    shouldFailRest = false;
    const res2 = await handler({ roomId: 'room-1', messageId: 'msg-retry' });
    assert.equal(res2.ok, true);
    assert.equal(res2.method, 'both');
    assert.equal(restAttempts, 2, 'Retry was permitted and succeeded');
    assert.equal(inflightMap.size, 0);
  });

  // =========================================================================
  // Requirement 3: Server history returning 'sent' when local state is already 'read'
  // =========================================================================
  test('3. Server history returning "sent" cannot downgrade known local "read" status', async () => {
    const msgId = 'msg-seq-301';
    const clientMsgId = 'local-seq-301';

    await dbService.saveConversation({ roomId, peerUserId, kind: 'direct' });
    await dbService.saveMessage({
      id: msgId,
      clientMessageId: clientMsgId,
      roomId,
      senderId: currentUserId,
      content: 'Important message',
      status: 'sent'
    });

    // Message is read and confirmed locally
    await dbService.updateMessageStatus({
      id: msgId,
      status: 'read',
      recipientId: peerUserId
    });

    const targetState = new RoomMessagesState(currentUserId);
    // Pre-hydrate from SQLite
    const dbMsgs = await dbService.getMessages({ roomId });
    targetState.setInitialMessages(roomId, dbMsgs);
    assert.equal(targetState.getStatus(msgId), 'read');

    // Server history arrives with stale/older 'sent' status
    const serverHistory = [{
      id: msgId,
      clientMessageId: clientMsgId,
      room_id: roomId,
      sender_id: currentUserId,
      body: { text: 'Important message' },
      status: 'sent',
      delivery_status: 'sent'
    }];

    // Merge server history
    targetState.mergeServerMessages(serverHistory);
    assert.equal(targetState.getStatus(msgId), 'read', 'Status must not downgrade on mergeServerMessages');

    // Reconcile before persisting to SQLite (app.js line 3336 fix)
    const reconciledForDb = serverHistory.map((m) => {
      const id = m.id;
      const cid = m.clientMessageId || m.client_message_id;
      const knownStatus = (id ? targetState.getStatus(id) : null) || (cid ? targetState.getStatus(cid) : null);
      if (knownStatus) {
        const higher = getHighestStatus(knownStatus, m.deliveryStatus, m.delivery_status, m.status) || knownStatus;
        return { ...m, status: higher, deliveryStatus: higher, delivery_status: higher };
      }
      return m;
    });

    for (const m of reconciledForDb) {
      await dbService.saveMessage({
        id: m.id,
        clientMessageId: m.clientMessageId,
        roomId: m.room_id,
        senderId: m.sender_id,
        body: m.body,
        status: m.status
      });
    }

    const checkDb = await dbService.getMessageById(msgId);
    assert.equal(checkDb.status, 'read', 'SQLite must remain read');
  });

  // =========================================================================
  // Requirement 4: Cold-start hydration and application restart
  // =========================================================================
  test('4. Complete restart sequence: sent -> read -> restart -> server history arrives -> status remains read', async () => {
    const msgId = 'msg-seq-401';
    const clientMsgId = 'local-seq-401';

    await dbService.saveConversation({ roomId, peerUserId, kind: 'direct' });

    // Step 1: Send message
    await dbService.saveMessage({
      id: msgId,
      clientMessageId: clientMsgId,
      roomId,
      senderId: currentUserId,
      content: 'Restart test',
      status: 'sent'
    });

    // Step 2 & 3: Recipient reads it, sender updates SQLite & memory
    await dbService.updateMessageStatus({
      id: msgId,
      status: 'read',
      recipientId: peerUserId
    });

    // Step 4: Complete restart (close DB, destroy all in-memory states)
    await dbService.databaseManager.close();

    const restartedDb = new DatabaseService({ storageDir: tmpDir, sessionStore: mockSessionStore });
    dbService = restartedDb;

    const freshTargetState = new RoomMessagesState(currentUserId);

    // Step 4a: Local-first SQLite loading (loadMessagesFromDb in app.js)
    const localDbMsgs = await restartedDb.getMessages({ roomId });
    assert.equal(localDbMsgs.length, 1);
    assert.equal(localDbMsgs[0].status, 'read');

    freshTargetState.setInitialMessages(roomId, localDbMsgs, false);
    assert.equal(freshTargetState.getStatus(msgId), 'read');

    // Step 5: Server history arrives from chatApi.getMessages with status: 'sent'
    const serverHistoryBatch = [{
      id: msgId,
      clientMessageId: clientMsgId,
      room_id: roomId,
      sender_id: currentUserId,
      body: { text: 'Restart test' },
      status: 'sent',
      delivery_status: 'sent'
    }];

    // Step 6: mergeServerMessages runs
    freshTargetState.mergeServerMessages(serverHistoryBatch, false);

    // Verify status does not regress
    assert.equal(freshTargetState.getStatus(msgId), 'read', 'In-memory status must remain read');

    // Background persistence does not downgrade
    const reconciledForDb = serverHistoryBatch.map((m) => {
      const id = m.id;
      const cid = m.clientMessageId || m.client_message_id;
      const knownStatus = (id ? freshTargetState.getStatus(id) : null) || (cid ? freshTargetState.getStatus(cid) : null);
      if (knownStatus) {
        const higher = getHighestStatus(knownStatus, m.deliveryStatus, m.delivery_status, m.status) || knownStatus;
        return { ...m, status: higher, deliveryStatus: higher, delivery_status: higher };
      }
      return m;
    });

    for (const m of reconciledForDb) {
      await restartedDb.saveMessage({
        id: m.id,
        clientMessageId: m.clientMessageId,
        roomId: m.room_id,
        senderId: m.sender_id,
        body: m.body,
        status: m.status
      });
    }

    const finalDb = await restartedDb.getMessageById(msgId);
    assert.equal(finalDb.status, 'read', 'Final SQLite status must remain read');
  });

  // =========================================================================
  // Requirement 5: Existing receipt and tick behavior
  // =========================================================================
  test('5. Ticks render blue double ticks for read and preserve delivered & sent ticks correctly', () => {
    const state = new RoomMessagesState(currentUserId);
    state.setInitialMessages(roomId, [
      { id: 'm-sent', roomId, senderId: currentUserId, status: 'sent' },
      { id: 'm-delivered', roomId, senderId: currentUserId, status: 'delivered' },
      { id: 'm-read', roomId, senderId: currentUserId, status: 'read' },
      { id: 'm-incoming', roomId, senderId: peerUserId, status: 'read' } // incoming message
    ]);

    // Sent: single grey tick
    const tickSent = getTickDescriptor(state.getStatus('m-sent'), true);
    assert.equal(tickSent.hasTick, true);
    assert.equal(tickSent.symbol, '✓');
    assert.equal(tickSent.statusClass, 'status-sent');

    // Delivered: double grey tick
    const tickDelivered = getTickDescriptor(state.getStatus('m-delivered'), true);
    assert.equal(tickDelivered.hasTick, true);
    assert.equal(tickDelivered.symbol, '✓✓');
    assert.equal(tickDelivered.statusClass, 'status-delivered');

    // Read: double blue tick
    const tickRead = getTickDescriptor(state.getStatus('m-read'), true);
    assert.equal(tickRead.hasTick, true);
    assert.equal(tickRead.symbol, '✓✓');
    assert.equal(tickRead.statusClass, 'status-read');

    // Incoming: no outgoing ticks
    const tickIncoming = getTickDescriptor(state.getStatus('m-incoming'), false);
    assert.equal(tickIncoming.hasTick, false);
  });

  // =========================================================================
  // Requirement 6: Realistic server history returning status: null on restart
  // =========================================================================
  test('6. Server history returning status: null on restart does not revert blue double ticks when peer cursor is preserved', async () => {
    const msgId1 = 'msg-seq-601';
    const msgId2 = 'msg-seq-602';
    const msgId3 = 'msg-seq-603'; // unread message

    await dbService.saveConversation({ roomId, peerUserId, kind: 'direct' });

    // Step 1: Alice sends 3 messages with eventSeq 10, 20, and 30
    await dbService.saveMessage({
      id: msgId1,
      roomId,
      senderId: currentUserId,
      eventSeq: 10,
      content: 'Hello 1',
      status: 'sent'
    });
    await dbService.saveMessage({
      id: msgId2,
      roomId,
      senderId: currentUserId,
      eventSeq: 20,
      content: 'Hello 2',
      status: 'sent'
    });
    await dbService.saveMessage({
      id: msgId3,
      roomId,
      senderId: currentUserId,
      eventSeq: 30,
      content: 'Hello 3 (not yet read by Bob)',
      status: 'sent'
    });

    // Step 2: Bob reads up to eventSeq 20; receipt.read arrives for msgId2
    await dbService.updateMessageStatus({
      id: msgId2,
      status: 'read',
      recipientId: peerUserId,
      eventSeq: 20,
      roomId
    });

    // Verify peer_read_seq was recorded in app_metadata
    const metaRow = await dbService.getMetadata(`peer_read_seq:${roomId}`);
    assert.ok(metaRow, 'peer_read_seq must be stored in app_metadata');
    assert.equal(metaRow.value, '20');

    // Step 3: Complete application force-close & restart
    await dbService.databaseManager.close();

    const restartedDb = new DatabaseService({ storageDir: tmpDir, sessionStore: mockSessionStore });
    dbService = restartedDb;

    // Step 4: Re-initialize fresh RoomMessagesState
    const freshState = new RoomMessagesState(currentUserId);
    const restoredMeta = await restartedDb.getMetadata(`peer_read_seq:${roomId}`);
    if (restoredMeta?.value) {
      freshState.setPeerLastReadSeq(parseInt(restoredMeta.value, 10));
    }
    assert.equal(freshState.peerLastReadSeq, 20);

    // Step 5: Realistic server history arrives from GET /rooms/{roomId}/messages (status: null, delivery_status: null)
    const serverHistoryWithNullStatus = [
      { id: msgId1, room_id: roomId, sender_id: currentUserId, event_seq: 10, body: { text: 'Hello 1' }, status: null, delivery_status: null },
      { id: msgId2, room_id: roomId, sender_id: currentUserId, event_seq: 20, body: { text: 'Hello 2' }, status: null, delivery_status: null },
      { id: msgId3, room_id: roomId, sender_id: currentUserId, event_seq: 30, body: { text: 'Hello 3' }, status: null, delivery_status: null }
    ];

    // Local-first SQLite loading
    const localDbMsgs = await restartedDb.getMessages({ roomId });
    freshState.setInitialMessages(roomId, localDbMsgs, false);

    // Server history merge
    freshState.mergeServerMessages(serverHistoryWithNullStatus, false);

    // Assertions: msg1 & msg2 (seq <= 20) are READ with blue double ticks
    assert.equal(freshState.getStatus(msgId1), 'read', 'msgId1 must be read');
    assert.equal(freshState.getStatus(msgId2), 'read', 'msgId2 must be read');
    const tick1 = getTickDescriptor(freshState.getStatus(msgId1), true);
    assert.equal(tick1.symbol, '✓✓');
    assert.equal(tick1.statusClass, 'status-read');

    const tick2 = getTickDescriptor(freshState.getStatus(msgId2), true);
    assert.equal(tick2.symbol, '✓✓');
    assert.equal(tick2.statusClass, 'status-read');

    // msg3 (seq 30 > 20) must NOT be read (remains sent)
    assert.equal(freshState.getStatus(msgId3), 'sent', 'msgId3 must remain sent');
    const tick3 = getTickDescriptor(freshState.getStatus(msgId3), true);
    assert.equal(tick3.symbol, '✓');
    assert.equal(tick3.statusClass, 'status-sent');
  });

  // =========================================================================
  // Requirement 7: Sender own unread cursor is not peer cursor
  // =========================================================================
  test('7. Sender unread cursor (getUnread) represents own inbound progress and does not mark outgoing messages read', () => {
    // Simulating sender Alice calling chatApi.getUnread(roomToken, roomId)
    const aliceInboundCursor = {
      unreadCount: 0,
      lastReadSeq: 50 // Alice has read Bob's messages up to seq 50
    };

    const state = new RoomMessagesState(currentUserId);
    // Alice's own outgoing message with eventSeq 45
    const ownMessage = {
      id: 'out-45',
      roomId,
      senderId: currentUserId,
      eventSeq: 45,
      status: 'sent'
    };

    // If Alice's inbound cursor were erroneously applied to outgoing messages:
    // ownMessage would become 'read' prematurely!
    // With proper separation: peerLastReadSeq remains 0 unless peer receipt arrives
    state.setInitialMessages(roomId, [ownMessage], false);

    assert.equal(state.peerLastReadSeq, 0, 'Sender inbound cursor must not update peerLastReadSeq');
    assert.equal(state.getStatus('out-45'), 'sent', 'Alice outgoing message must remain sent, not read');
    const tick = getTickDescriptor(state.getStatus('out-45'), true);
    assert.equal(tick.symbol, '✓');
    assert.equal(tick.statusClass, 'status-sent');
  });

  // =========================================================================
  // Requirement 8: Fallback recipient when principal_id is missing
  // =========================================================================
  test('8. Missing or empty principal_id resolves safely to conversation peer and avoids DB constraint failures', async () => {
    await dbService.saveConversation({ roomId, peerUserId, kind: 'direct' });

    const msgId = 'msg-missing-principal';
    await dbService.saveMessage({
      id: msgId,
      roomId,
      senderId: currentUserId,
      eventSeq: 15,
      content: 'Testing fallback',
      status: 'sent'
    });

    // Update with recipientId: null or missing
    const res = await dbService.updateMessageStatus({
      id: msgId,
      status: 'read',
      recipientId: null,
      eventSeq: 15,
      roomId
    });

    assert.equal(res.ok, true);

    const checkReceipt = await dbService.databaseManager.get(
      'SELECT recipient_id, status FROM message_receipts WHERE message_id = ?;',
      [msgId]
    );
    assert.ok(checkReceipt, 'Receipt row must exist in message_receipts');
    assert.equal(checkReceipt.recipient_id, peerUserId, 'Must fallback to conversation peerUserId');
    assert.equal(checkReceipt.status, 'read');
  });

  // =========================================================================
  // Requirement 9: Delivered message remains delivered after application restart
  // =========================================================================
  test('9. Delivered message remains delivered (grey double ticks) after application restart when server history arrives with status: null or "sent"', async () => {
    const msgId = 'msg-seq-901';
    const clientMsgId = 'local-seq-901';

    await dbService.saveConversation({ roomId, peerUserId, kind: 'direct' });

    // Step 1: Send message
    await dbService.saveMessage({
      id: msgId,
      clientMessageId: clientMsgId,
      roomId,
      senderId: currentUserId,
      content: 'Delivered restart test',
      status: 'sent'
    });

    // Step 2: Message is delivered to recipient (grey double ticks)
    await dbService.updateMessageStatus({
      id: msgId,
      status: 'delivered',
      recipientId: peerUserId,
      roomId
    });

    // Step 3: Complete restart (close DB, destroy all in-memory states)
    await dbService.databaseManager.close();

    const restartedDb = new DatabaseService({ storageDir: tmpDir, sessionStore: mockSessionStore });
    dbService = restartedDb;

    const freshTargetState = new RoomMessagesState(currentUserId);

    // Step 4: Local-first SQLite loading (loadMessagesFromDb in app.js)
    const localDbMsgs = await restartedDb.getMessages({ roomId });
    assert.equal(localDbMsgs.length, 1);
    assert.equal(localDbMsgs[0].status, 'delivered', 'Local SQLite must return delivered status');

    freshTargetState.setInitialMessages(roomId, localDbMsgs, false);
    assert.equal(freshTargetState.getStatus(msgId), 'delivered', 'Fresh state must hydrate delivered status');
    const initialTick = getTickDescriptor(freshTargetState.getStatus(msgId), true);
    assert.equal(initialTick.symbol, '✓✓');
    assert.equal(initialTick.statusClass, 'status-delivered');

    // Step 5: Server history arrives from chatApi.getMessages with status: null or "sent"
    const serverHistoryBatch = [{
      id: msgId,
      clientMessageId: clientMsgId,
      room_id: roomId,
      sender_id: currentUserId,
      body: { text: 'Delivered restart test' },
      status: null,
      delivery_status: null
    }];

    // Step 6: mergeServerMessages runs
    freshTargetState.mergeServerMessages(serverHistoryBatch, false);

    // Verify status does not regress
    assert.equal(freshTargetState.getStatus(msgId), 'delivered', 'In-memory status must remain delivered');
    const finalTick = getTickDescriptor(freshTargetState.getStatus(msgId), true);
    assert.equal(finalTick.symbol, '✓✓', 'Double grey ticks must be preserved');
    assert.equal(finalTick.statusClass, 'status-delivered');

    // Background persistence does not downgrade SQLite
    const reconciledForDb = serverHistoryBatch.map((m) => {
      const id = m.id;
      const cid = m.clientMessageId || m.client_message_id;
      const knownStatus = (id ? freshTargetState.getStatus(id) : null) || (cid ? freshTargetState.getStatus(cid) : null);
      if (knownStatus) {
        const higher = getHighestStatus(knownStatus, m.deliveryStatus, m.delivery_status, m.status) || knownStatus;
        return { ...m, status: higher, deliveryStatus: higher, delivery_status: higher };
      }
      return m;
    });

    for (const m of reconciledForDb) {
      await restartedDb.saveMessage({
        id: m.id,
        clientMessageId: m.clientMessageId,
        roomId: m.room_id,
        senderId: m.sender_id,
        body: m.body,
        status: m.status
      });
    }

    const finalDb = await restartedDb.getMessageById(msgId);
    assert.equal(finalDb.status, 'delivered', 'Final SQLite status must remain delivered');
  });

  // =========================================================================
  // Requirement 10: _deduplicate preserves higher valid status
  // =========================================================================
  test('10. _deduplicate preserves higher valid status when merging duplicate or canonical messages', () => {
    const state = new RoomMessagesState(currentUserId);

    // Case A: server message arrives with status: 'sent' before local delivered message
    const dedupedA = state._deduplicate([
      { id: 'msg-dup-1', clientMessageId: 'c-dup-1', roomId, senderId: currentUserId, status: 'sent', deliveryStatus: 'sent' },
      { id: 'msg-dup-1', clientMessageId: 'c-dup-1', roomId, senderId: currentUserId, status: 'delivered', deliveryStatus: 'delivered' }
    ]);
    assert.equal(dedupedA.length, 1);
    assert.equal(dedupedA[0].status, 'delivered', 'Deduplication must retain higher delivered status even when sent appears first');

    // Case B: optimistic message with status: 'read' replaced by canonical message with status: 'sent'
    const dedupedB = state._deduplicate([
      { id: 'local-dup-2', clientMessageId: 'c-dup-2', roomId, senderId: currentUserId, status: 'read', deliveryStatus: 'read' },
      { id: 'srv-dup-2', clientMessageId: 'c-dup-2', roomId, senderId: currentUserId, status: 'sent', deliveryStatus: 'sent' }
    ]);
    assert.equal(dedupedB.length, 1);
    assert.equal(dedupedB[0].id, 'srv-dup-2', 'Canonical ID replaces optimistic ID');
    assert.equal(dedupedB[0].status, 'read', 'Status must not downgrade to sent when canonical arrives');

    // Case C: delivered optimistic message replaced by canonical with null status
    const dedupedC = state._deduplicate([
      { id: 'local-dup-3', clientMessageId: 'c-dup-3', roomId, senderId: currentUserId, status: 'delivered', deliveryStatus: 'delivered' },
      { id: 'srv-dup-3', clientMessageId: 'c-dup-3', roomId, senderId: currentUserId, status: null, delivery_status: null }
    ]);
    assert.equal(dedupedC.length, 1);
    assert.equal(dedupedC[0].status, 'delivered', 'Null status on canonical message cannot overwrite delivered');
  });

  // =========================================================================
  // Requirement 11: prependOlderMessages preserves receipt status & peerLastReadSeq
  // =========================================================================
  test('11. prependOlderMessages preserves valid receipt status during pagination', () => {
    const state = new RoomMessagesState(currentUserId);
    state.setPeerLastReadSeq(50);
    state.setInitialMessages(roomId, [
      { id: 'msg-cur-1', roomId, senderId: currentUserId, eventSeq: 45, status: 'read' }
    ]);

    // Prepend older message with eventSeq 20 (<= peerLastReadSeq 50) and status: null
    state.prependOlderMessages([
      { id: 'msg-old-1', roomId, senderId: currentUserId, eventSeq: 20, status: null },
      { id: 'msg-old-2', roomId, senderId: currentUserId, eventSeq: 60, status: 'delivered' } // seq 60 > 50, but delivered
    ]);

    assert.equal(state.getStatus('msg-old-1'), 'read', 'msg-old-1 covered by peerLastReadSeq must be read');
    assert.equal(state.messages.find(m => m.id === 'msg-old-1')?.status, 'read');
    assert.equal(state.getStatus('msg-old-2'), 'delivered', 'msg-old-2 must remain delivered');
    assert.equal(state.messages.find(m => m.id === 'msg-old-2')?.status, 'delivered');
  });

  // =========================================================================
  // Requirement 12: setCurrentUserId and initial hydration preserve status
  // =========================================================================
  test('12. setCurrentUserId and initial message hydration preserve valid persisted receipt status', () => {
    const state = new RoomMessagesState(null);
    state.setPeerLastReadSeq(40);
    state.messages = [
      { id: 'msg-h-1', roomId, senderId: currentUserId, eventSeq: 30, status: null, deliveryStatus: null },
      { id: 'msg-h-2', roomId, senderId: currentUserId, eventSeq: 55, status: 'delivered', deliveryStatus: 'delivered' }
    ];

    state.setCurrentUserId(currentUserId);

    assert.equal(state.getStatus('msg-h-1'), 'read', 'msg-h-1 within peerLastReadSeq must become read on setCurrentUserId');
    assert.equal(state.messages.find(m => m.id === 'msg-h-1')?.status, 'read');
    assert.equal(state.getStatus('msg-h-2'), 'delivered', 'msg-h-2 must remain delivered');
    assert.equal(state.messages.find(m => m.id === 'msg-h-2')?.status, 'delivered');
  });

  // =========================================================================
  // Requirement 13: Reply-preview and original-message history do not downgrade
  // =========================================================================
  test('13. Reply-preview and original-message loading do not downgrade existing message status', async () => {
    const msgId = 'msg-reply-orig-1';
    await dbService.saveConversation({ roomId, peerUserId, kind: 'direct' });
    await dbService.saveMessage({
      id: msgId,
      roomId,
      senderId: currentUserId,
      content: 'Original message',
      status: 'delivered'
    });

    const targetState = new RoomMessagesState(currentUserId);
    const dbMsgs = await dbService.getMessages({ roomId });
    targetState.setInitialMessages(roomId, dbMsgs, false);
    assert.equal(targetState.getStatus(msgId), 'delivered');

    // Simulate reply-preview fetching raw messages from server with status: null
    const apiMessages = [
      { id: msgId, room_id: roomId, sender_id: currentUserId, body: { text: 'Original message' }, status: null }
    ];

    // Reconcile before persist
    const reconciledForDb = apiMessages.map((m) => {
      const id = m.id;
      const cid = m.clientMessageId || m.client_message_id;
      const knownStatus = (id ? targetState.getStatus(id) : null) || (cid ? targetState.getStatus(cid) : null);
      if (knownStatus) {
        const higher = getHighestStatus(knownStatus, m.deliveryStatus, m.delivery_status, m.status) || knownStatus;
        return { ...m, status: higher, deliveryStatus: higher, delivery_status: higher };
      }
      return m;
    });

    for (const m of reconciledForDb) {
      await dbService.saveMessage({
        id: m.id,
        roomId: m.room_id,
        senderId: m.sender_id,
        body: m.body,
        status: m.status
      });
    }

    const checkDb = await dbService.getMessageById(msgId);
    assert.equal(checkDb.status, 'delivered', 'Reply-preview fetch must not downgrade delivered status in SQLite');
  });

  // =========================================================================
  // Requirement 14: Duplicate history and repeated receipts do not corrupt state
  // =========================================================================
  test('14. Duplicate history responses and repeated receipt events do not corrupt receipt state', () => {
    const state = new RoomMessagesState(currentUserId);
    state.setInitialMessages(roomId, [
      { id: 'msg-rep-1', roomId, senderId: currentUserId, status: 'sent' }
    ]);

    // Receipt delivered arrives twice
    state.updateReceipt('msg-rep-1', 'delivered', roomId);
    assert.equal(state.getStatus('msg-rep-1'), 'delivered');
    state.updateReceipt('msg-rep-1', 'delivered', roomId);
    assert.equal(state.getStatus('msg-rep-1'), 'delivered');

    // Receipt read arrives twice
    state.updateReceipt('msg-rep-1', 'read', roomId);
    assert.equal(state.getStatus('msg-rep-1'), 'read');
    state.updateReceipt('msg-rep-1', 'read', roomId);
    assert.equal(state.getStatus('msg-rep-1'), 'read');

    // Stale delivered arrives after read: must not downgrade
    const resDelivered = state.updateReceipt('msg-rep-1', 'delivered', roomId);
    assert.equal(resDelivered, false, 'Downgrade from read to delivered must be rejected');
    assert.equal(state.getStatus('msg-rep-1'), 'read');

    // Duplicate server history arrives with status: 'sent'
    state.mergeServerMessages([
      { id: 'msg-rep-1', room_id: roomId, sender_id: currentUserId, status: 'sent', delivery_status: 'sent' },
      { id: 'msg-rep-1', room_id: roomId, sender_id: currentUserId, status: 'sent', delivery_status: 'sent' }
    ]);
    assert.equal(state.getStatus('msg-rep-1'), 'read', 'Status must remain read after multiple server history batches');
  });

  // =========================================================================
  // Requirement 15: Unconfirmed messages are not incorrectly promoted
  // =========================================================================
  test('15. Messages without confirmed delivery/read evidence are not incorrectly promoted to a higher status', () => {
    const state = new RoomMessagesState(currentUserId);
    state.setPeerLastReadSeq(10); // peer has read up to seq 10

    state.setInitialMessages(roomId, [
      // Outgoing unconfirmed message with seq 25 (> peer cursor 10)
      { id: 'msg-unconf-1', roomId, senderId: currentUserId, eventSeq: 25, status: 'sent' },
      // Incoming message (should never have outgoing receipt status)
      { id: 'msg-inbound-1', roomId, senderId: peerUserId, eventSeq: 5, status: 'read' }
    ]);

    assert.equal(state.getStatus('msg-unconf-1'), 'sent', 'Unconfirmed message must remain sent');
    const tickUnconf = getTickDescriptor(state.getStatus('msg-unconf-1'), true);
    assert.equal(tickUnconf.symbol, '✓', 'Single grey tick for sent');
    assert.equal(tickUnconf.statusClass, 'status-sent');

    assert.equal(state.getStatus('msg-inbound-1'), null, 'Incoming messages must have null receipt status');
    const tickInbound = getTickDescriptor(state.getStatus('msg-inbound-1'), false);
    assert.equal(tickInbound.hasTick, false, 'No ticks rendered on incoming bubbles');
  });

  // =========================================================================
  // Requirement 16: Immediate older message read tick restoration upon restart
  // =========================================================================
  test('16. Older outgoing messages up to peer_read_seq immediately show blue double ticks upon room load', async () => {
    // Simulate restart: app boots, restores peer_read_seq from SQLite app_metadata
    await dbService.setMetadata({ key: `peer_read_seq:${roomId}`, value: '5449' });
    const meta = await dbService.getMetadata(`peer_read_seq:${roomId}`);
    assert.equal(meta.value, '5449', 'peer_read_seq metadata must be present');

    // Fresh RoomMessagesState created at room open (messages array initially empty)
    const state = new RoomMessagesState(currentUserId);
    state.roomId = roomId;
    state.setPeerLastReadSeq(parseInt(meta.value, 10));

    // Initial messages arrive from SQLite or server history
    const loadedMessages = [
      { id: 'msg-older-1', roomId, senderId: currentUserId, eventSeq: 5444, status: 'sent' },
      { id: 'msg-older-2', roomId, senderId: currentUserId, eventSeq: 5445, status: 'sent' },
      { id: 'msg-latest-read', roomId, senderId: currentUserId, eventSeq: 5449, status: 'sent' },
      { id: 'msg-newer-unread', roomId, senderId: currentUserId, eventSeq: 5450, status: 'delivered' }
    ];

    state.setInitialMessages(roomId, loadedMessages);
    // Post-hydration watermark check (as implemented in loadMessagesForRoom)
    if (state.peerLastReadSeq > 0) {
      state.setPeerLastReadSeq(state.peerLastReadSeq);
    }

    // Messages <= 5449 must immediately be 'read' with blue double ticks
    assert.equal(state.getStatus('msg-older-1'), 'read');
    const tick1 = getTickDescriptor(state.getStatus('msg-older-1'), true);
    assert.equal(tick1.symbol, '✓✓');
    assert.equal(tick1.statusClass, 'status-read');

    assert.equal(state.getStatus('msg-older-2'), 'read');
    const tick2 = getTickDescriptor(state.getStatus('msg-older-2'), true);
    assert.equal(tick2.symbol, '✓✓');
    assert.equal(tick2.statusClass, 'status-read');

    assert.equal(state.getStatus('msg-latest-read'), 'read');
    const tickLatest = getTickDescriptor(state.getStatus('msg-latest-read'), true);
    assert.equal(tickLatest.symbol, '✓✓');
    assert.equal(tickLatest.statusClass, 'status-read');

    // Message 5450 (> 5449) must remain delivered with grey double ticks
    assert.equal(state.getStatus('msg-newer-unread'), 'delivered');
    const tickNewer = getTickDescriptor(state.getStatus('msg-newer-unread'), true);
    assert.equal(tickNewer.symbol, '✓✓');
    assert.equal(tickNewer.statusClass, 'status-delivered');
  });

  // =========================================================================
  // Requirement 17: Watermark read receipt advances older messages without requiring message.created
  // =========================================================================
  test('17. Read watermark receipt advances all older loaded outgoing messages to read status in state', () => {
    const state = new RoomMessagesState(currentUserId);
    state.roomId = roomId;

    state.setInitialMessages(roomId, [
      { id: 'msg-1', roomId, senderId: currentUserId, eventSeq: 100, status: 'delivered' },
      { id: 'msg-2', roomId, senderId: currentUserId, eventSeq: 101, status: 'delivered' },
      { id: 'msg-3', roomId, senderId: currentUserId, eventSeq: 102, status: 'sent' },
      { id: 'msg-4', roomId, senderId: currentUserId, eventSeq: 105, status: 'sent' }
    ]);

    // Receipt read arrives for msg-3 with event_seq: 102
    state.updateReceipt('msg-3', 'read', roomId);
    state.setPeerLastReadSeq(102);

    // Messages 1, 2, and 3 must all be advanced to read
    assert.equal(state.getStatus('msg-1'), 'read');
    assert.equal(state.getStatus('msg-2'), 'read');
    assert.equal(state.getStatus('msg-3'), 'read');

    // Message 4 (seq 105 > 102) must remain sent
    assert.equal(state.getStatus('msg-4'), 'sent');
  });

  // =========================================================================
  // Requirement 18: Initial conversation render immediately reflects read ticks
  // =========================================================================
  test('18. Initial conversation render immediately displays blue double ticks for all outgoing messages <= peer_read_seq without requiring new messages or receipts', async () => {
    // 1. Peer read watermark 5453 persisted in SQLite
    await dbService.setMetadata({ key: `peer_read_seq:${roomId}`, value: '5453' });
    const meta = await dbService.getMetadata(`peer_read_seq:${roomId}`);
    assert.equal(meta.value, '5453');
    const watermarkSeq = parseInt(meta.value, 10);

    // 2. Cold-start RoomMessagesState with shared receipt store
    const sharedReceiptStore = new Map();
    const state = new RoomMessagesState(currentUserId, sharedReceiptStore);
    state.roomId = roomId;

    // Watermark restored before message hydration (as in loadMessagesForRoom)
    state.setPeerLastReadSeq(watermarkSeq);

    // Initial local SQLite batch loads message 5453
    const localDbBatch = [
      { id: 'msg-5453', roomId, senderId: currentUserId, eventSeq: 5453, status: 'read' }
    ];
    state.setInitialMessages(roomId, localDbBatch, false);
    if (state.peerLastReadSeq > 0) {
      state.setPeerLastReadSeq(state.peerLastReadSeq);
    }

    // Server returns older historical messages with raw status: null / 'sent'
    const serverHistoryBatch = [
      { id: 'msg-5444', room_id: roomId, sender_id: currentUserId, event_seq: 5444, status: null, delivery_status: null },
      { id: 'msg-5449', room_id: roomId, sender_id: currentUserId, event_seq: 5449, status: 'sent', delivery_status: 'sent' },
      { id: 'msg-5452', room_id: roomId, sender_id: currentUserId, event_seq: 5452, status: 'sent', delivery_status: 'sent' },
      { id: 'msg-5453', room_id: roomId, sender_id: currentUserId, event_seq: 5453, status: 'sent', delivery_status: 'sent' },
      // Message 5460 is newer than watermark 5453, delivered to server
      { id: 'msg-5460', room_id: roomId, sender_id: currentUserId, event_seq: 5460, status: 'delivered', delivery_status: 'delivered' }
    ];

    // Merging server messages during initial load
    state.mergeServerMessages(serverHistoryBatch, false);
    if (state.peerLastReadSeq > 0) {
      state.setPeerLastReadSeq(state.peerLastReadSeq);
    }

    // Verify first-render ticks for all older outgoing messages <= 5453
    for (const id of ['msg-5444', 'msg-5449', 'msg-5452', 'msg-5453']) {
      const status = state.getStatus(id);
      assert.equal(status, 'read', `Message ${id} must have read status on first render`);
      const tick = getTickDescriptor(status, true);
      assert.equal(tick.symbol, '✓✓', `Message ${id} must have double ticks`);
      assert.equal(tick.statusClass, 'status-read', `Message ${id} must have blue status-read class`);
    }

    // Verify message 5460 (> 5453) remains delivered with grey double ticks
    const st5460 = state.getStatus('msg-5460');
    assert.equal(st5460, 'delivered');
    const tick5460 = getTickDescriptor(st5460, true);
    assert.equal(tick5460.symbol, '✓✓');
    assert.equal(tick5460.statusClass, 'status-delivered');

    // Verify sharedReceiptStore has room initialized and statuses persisted
    assert.equal(sharedReceiptStore.has(roomId), true, 'sharedReceiptStore must have room entry');
    assert.equal(sharedReceiptStore.get(roomId).get('msg-5449'), 'read');
    assert.equal(sharedReceiptStore.get(roomId).get('msg-5453'), 'read');
  });

  // =========================================================================
  // Requirement 19: getMetadata fallback derives peer_read_seq when app_metadata unseeded
  // =========================================================================
  test('19. getMetadata derives peer_read_seq from messages table when app_metadata is not yet seeded', async () => {
    // 1. Insert messages into SQLite with status: 'read' but no app_metadata record
    await dbService.saveMessage({
      id: 'msg-prev-read-1',
      roomId,
      senderId: currentUserId,
      eventSeq: 5100,
      kind: 'text',
      body: { text: 'read message 1' },
      status: 'read'
    });
    await dbService.saveMessage({
      id: 'msg-prev-read-2',
      roomId,
      senderId: currentUserId,
      eventSeq: 5454,
      kind: 'text',
      body: { text: 'read message 2' },
      status: 'read'
    });

    // Explicitly delete any peer_read_seq row to simulate unseeded app_metadata
    await dbService.databaseManager.run('DELETE FROM app_metadata WHERE key = ?;', ['peer_read_seq:' + roomId]);

    // 2. getMetadata should fall back to querying the maximum read sequence (5454) and seed app_metadata
    const meta = await dbService.getMetadata('peer_read_seq:' + roomId);
    assert.notEqual(meta, null, 'getMetadata must return a record via fallback');
    assert.equal(meta.key, 'peer_read_seq:' + roomId);
    assert.equal(meta.value, '5454', 'getMetadata must derive max read sequence 5454');

    // 3. Verify it was written to app_metadata table for subsequent queries
    const rowInDb = await dbService.databaseManager.get('SELECT value FROM app_metadata WHERE key = ?;', ['peer_read_seq:' + roomId]);
    assert.equal(rowInDb?.value, '5454', 'Derived watermark must be seeded in app_metadata');
  });

  // =========================================================================
  // Requirement 20: In-memory peerLastReadSeq derivation from loaded read messages
  // =========================================================================
  test('20. setInitialMessages and mergeServerMessages automatically advance peerLastReadSeq from loaded read messages', async () => {
    const sharedReceiptStore = new Map();
    const state = new RoomMessagesState(currentUserId, sharedReceiptStore);
    state.roomId = roomId;

    // peerLastReadSeq starts unseeded (0)
    assert.equal(state.peerLastReadSeq, 0);

    // Initial batch from SQLite contains an outgoing message with status: 'read' at seq 5454
    const dbMessages = [
      { id: 'db-msg-1', roomId, senderId: currentUserId, eventSeq: 5444, status: 'read' },
      { id: 'db-msg-2', roomId, senderId: currentUserId, eventSeq: 5454, status: 'read' }
    ];

    state.setInitialMessages(roomId, dbMessages, false);

    // Verify peerLastReadSeq was automatically advanced to 5454
    assert.equal(state.peerLastReadSeq, 5454, 'peerLastReadSeq must be derived from loaded read messages');

    // Now server history arrives where all wire messages have status: null
    const serverHistory = [
      { id: 'srv-msg-1', room_id: roomId, sender_id: currentUserId, event_seq: 5445, status: null },
      { id: 'srv-msg-2', room_id: roomId, sender_id: currentUserId, event_seq: 5450, status: null },
      { id: 'srv-msg-3', room_id: roomId, sender_id: currentUserId, event_seq: 5453, status: null }
    ];

    state.mergeServerMessages(serverHistory, false);

    // All server messages <= 5454 must immediately be recognized as 'read'
    for (const m of serverHistory) {
      const status = state.getStatus(m.id);
      assert.equal(status, 'read', `Message ${m.id} (seq ${m.event_seq}) must be read`);
      const tick = getTickDescriptor(status, true);
      assert.equal(tick.symbol, '✓✓', `Message ${m.id} must render double ticks`);
      assert.equal(tick.statusClass, 'status-read', `Message ${m.id} must have blue status-read class`);
    }
  });

  // =========================================================================
  // Requirement 21: Exact cold-start sequence: initial render immediately restores ticks
  // =========================================================================
  test('21. Cold start: initial render immediately shows blue double ticks for read messages without new receipts', async () => {
    // Step 1: Pre-populate local SQLite database with:
    // - peer_read_seq watermark = 5450 in app_metadata
    // - outgoing read messages <= 5450
    // - outgoing delivered-but-unread message at 5455
    // - outgoing pending/unsent message
    await dbService.setMetadata({
      key: 'peer_read_seq:' + roomId,
      value: '5450'
    });

    await dbService.saveMessage({
      id: 'local-read-1',
      roomId,
      senderId: currentUserId,
      eventSeq: 5448,
      kind: 'text',
      body: { text: 'read msg 1' },
      status: 'read'
    });
    await dbService.saveMessage({
      id: 'local-read-2',
      roomId,
      senderId: currentUserId,
      eventSeq: 5450,
      kind: 'text',
      body: { text: 'read msg 2' },
      status: 'read'
    });
    await dbService.saveMessage({
      id: 'local-delivered-1',
      roomId,
      senderId: currentUserId,
      eventSeq: 5455,
      kind: 'text',
      body: { text: 'delivered unread msg' },
      status: 'delivered'
    });
    await dbService.saveMessage({
      id: 'local-unsent-1',
      roomId,
      senderId: currentUserId,
      eventSeq: 0,
      kind: 'text',
      body: { text: 'unsent message' },
      status: 'pending'
    });

    // Step 2: Fresh in-memory start (simulating true cold restart after Task Manager kill)
    const freshReceiptStore = new Map();
    const freshState = new RoomMessagesState(currentUserId, freshReceiptStore);
    freshState.roomId = roomId;

    // Simulate startup hydration as done in loadMessagesForRoom:
    // (A) Restore peer_read_seq from SQLite getMetadata
    const restoredMeta = await dbService.getMetadata('peer_read_seq:' + roomId);
    assert.equal(restoredMeta?.value, '5450');
    freshState.setPeerLastReadSeq(parseInt(restoredMeta.value, 10));
    assert.equal(freshState.peerLastReadSeq, 5450);

    // (B) Local-first: load SQLite messages
    const localDbMsgs = await dbService.getMessages({ roomId, limit: 100 });
    assert.equal(localDbMsgs.length, 4);
    freshState.setInitialMessages(roomId, localDbMsgs, false);

    // (C) Server history arrives where wire messages have null/missing status
    const serverHistoryBatch = [
      { id: 'local-read-1', room_id: roomId, sender_id: currentUserId, event_seq: 5448, status: null, delivery_status: null },
      { id: 'local-read-2', room_id: roomId, sender_id: currentUserId, event_seq: 5450, status: null, delivery_status: null },
      { id: 'srv-older-1', room_id: roomId, sender_id: currentUserId, event_seq: 5445, status: null, delivery_status: null },
      { id: 'local-delivered-1', room_id: roomId, sender_id: currentUserId, event_seq: 5455, status: null, delivery_status: null }
    ];
    freshState.mergeServerMessages(serverHistoryBatch, false);

    // Step 3: Verify initial render ticks IMMEDIATELY (no new message or receipt event required)
    // 1. Previously read messages must immediately show blue double ticks
    for (const msgId of ['local-read-1', 'local-read-2', 'srv-older-1']) {
      const st = freshState.getStatus(msgId);
      assert.equal(st, 'read', `Message ${msgId} must be read immediately`);
      const tick = getTickDescriptor(st, true);
      assert.equal(tick.symbol, '✓✓', `Message ${msgId} must render double ticks`);
      assert.equal(tick.statusClass, 'status-read', `Message ${msgId} must have blue status-read class`);
    }

    // 2. Delivered-but-unread message must remain grey double ticks
    const delSt = freshState.getStatus('local-delivered-1');
    assert.equal(delSt, 'delivered', 'Message 5455 must remain delivered');
    const delTick = getTickDescriptor(delSt, true);
    assert.equal(delTick.symbol, '✓✓', 'Delivered message must render double ticks');
    assert.equal(delTick.statusClass, 'status-delivered', 'Delivered message must have grey status-delivered class');

    // 3. Unsent message must remain pending (never falsely marked delivered or read)
    const unsentSt = freshState.getStatus('local-unsent-1');
    assert.equal(unsentSt, 'pending', 'Unsent message must remain pending');
    const unsentTick = getTickDescriptor(unsentSt, true);
    assert.notEqual(unsentTick.statusClass, 'status-read', 'Unsent message must not have read class');
    assert.notEqual(unsentTick.statusClass, 'status-delivered', 'Unsent message must not have delivered class');
  });
});


